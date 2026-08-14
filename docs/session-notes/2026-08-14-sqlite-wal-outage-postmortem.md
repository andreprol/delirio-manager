# Post-Mortem — 2026-08-14 — SQLite WAL 275GB / Outage 3 Dias

## Sumário

O servidor DT Manager ficou indisponível por aproximadamente 3 dias (≈ 11–14/08/2026). Root cause: WAL do SQLite acumulou 275 GB sem nunca ser checkpointado, fazendo todos os SELECTs travarem indefinidamente. O sistema entrou em crash loop PM2 por EADDRINUSE. A recuperação exigiu checkpoint manual via Portal Azure + `safe-restart.sh`. Um fix permanente foi deployado no commit `a6812e0d`.

---

## Timeline

| Hora (BRT) | Evento |
|---|---|
| ≈ 11/08 | Servidor para de responder. Dashboard mostra "Sem conexão". |
| 14/08 18:20 | Diagnóstico iniciado. `/health` retorna 200 (stub Nginx), `/api/machines` timeout 15s. |
| 14/08 18:25 | PM2 list via Portal Azure: `dt-manager` id=82, **34 restarts**, uptime 4m — crash loop confirmado. |
| 14/08 18:30 | Error log: `EADDRINUSE :::3847` em loop — ghost process clássico. |
| 14/08 18:35 | `bash /opt/dt-manager/infra/safe-restart.sh` via Portal: elimina ghost, PM2 sobe (id=84, 0 restarts). |
| 14/08 18:40 | `/api/machines` ainda timeout. SSH na VM: `ls -lh data/` revela **WAL de 275 GB**. |
| 14/08 18:45 | `pm2 stop dt-manager` + `sqlite3 db 'PRAGMA wal_checkpoint(TRUNCATE)'` + `safe-restart.sh`. WAL cai para 53 MB. |
| 14/08 18:50 | `/api/machines` retorna 130 máquinas. Servidor OK. |
| 14/08 18:51 | Push commit `a6812e0d` (`wal_autocheckpoint = 1000` + scheduler diário). CI/CD deploy iniciado. |
| 14/08 19:00 | CI/CD concluiu. Safe-restart automático. Server warmup (~3min page cache). |
| 14/08 19:03 | Dashboard conecta. **Incidente encerrado.** |

---

## Root Cause

### Causa Direta

`journal_mode = WAL` configurado sem `wal_autocheckpoint`. O SQLite em WAL mode escreve todas as transações no arquivo `.db-wal`. O checkpoint (merge do WAL de volta para o `.db`) é disparado automaticamente só se `wal_autocheckpoint > 0` (padrão = 1000 páginas). O `db.js` definia `wal_autocheckpoint` como 0 implicitamente ao não configurá-lo — **não, o padrão do SQLite é 1000**. Porém, `better-sqlite3` v7+ reseta `wal_autocheckpoint = 0` quando `journal_mode = WAL` é aplicado após o banco já ter sido aberto em modo default. Resultado: WAL cresceu indefinidamente de 04/07 até 14/08 (≈ 40 dias).

### Causa Raiz Real

A partir de 04/07/2026 (último log de stdout), o processo entrou em um estado onde escritas acumulavam no WAL mas o checkpoint automático nunca disparava. Hipóteses:

1. **busy_timeout interagindo com WAL checkpoint**: o `PRAGMA busy_timeout = 10000` pode ter causado contenção durante tentativas de checkpoint, fazendo-o falhar silenciosamente.
2. **PM2 cluster mode + better-sqlite3**: em modo cluster, o PM2 God Daemon distribui conexões. Se workers reiniciavam frequentemente sem fechar o banco corretamente, o WAL ficava "em uso" e não podia ser checkpointado.
3. **Volume de escrita**: 130 máquinas × heartbeat 30s × métricas horárias = alto volume de INSERTs. Sem checkpoint, o WAL cresce indefinidamente.

### Cascata de Falhas

```
WAL 275GB → SELECT faz full-scan do WAL → timeout >15s →
→ Nginx 502 (proxy_read_timeout) → Dashboard "Sem conexão" →
→ Agentes recebem 502 em /api/heartbeat → retentativas acumulam →
→ PM2 restarts acumulam → EADDRINUSE (ghost process) →
→ Crash loop 34 restarts/hora → indisponibilidade total
```

---

## Diagnóstico — Comandos Utilizados

```bash
# 1. Verificar PM2
pm2 list

# 2. Error log (NÃO usar pm2 logs — trava 90min)
tail -100 /root/.pm2/logs/dt-manager-error.log

# 3. WAL size
ls -lh /opt/dt-manager/data/

# 4. Curl interno (confirmar se Node.js responde localmente)
curl -s --max-time 5 http://localhost:3847/api/machines

# 5. Porta 3847 (quem está segurando)
ss -tlnp | grep 3847

# 6. Processo Node.js
ps aux | grep node | grep -v grep

# 7. Syscall bloqueante do processo (folio_wait_bit_common = I/O de página)
cat /proc/<PID>/wchan
```

---

## Recovery

### Passo 1 — Checkpoint WAL
```bash
pm2 stop dt-manager
sqlite3 /opt/dt-manager/data/dt-manager.db 'PRAGMA wal_checkpoint(TRUNCATE);'
ls -lh /opt/dt-manager/data/  # confirmar WAL encolheu
```

### Passo 2 — Safe-Restart (elimina ghosts)
```bash
cd /opt/dt-manager && bash infra/safe-restart.sh
```

### Passo 3 — Aguardar Page Cache Warmup
Após restart com DB de 29 GB, o processo fica em `folio_wait_bit_common` (I/O de disco) por **2–3 minutos** antes de servir requests. Normal. Não restartar durante este período.

### Verificação Final (de fora da VM)
```powershell
Invoke-WebRequest -Uri "https://dt-manager.brazilsouth.cloudapp.azure.com/api/machines" -TimeoutSec 30 -UseBasicParsing
```

---

## Fix Permanente — Commit `a6812e0d`

### `server/db.js`
```js
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');
db.pragma('foreign_keys = ON');
db.pragma('wal_autocheckpoint = 1000'); // checkpoint automático a cada 1000 páginas (~4MB)
```

### `server/server.js`
```js
// Chamado no callback do server.listen()
_scheduleWalCheckpoint();

// Função — checkpoint diário às próximas 24h após boot
function _scheduleWalCheckpoint() {
  const { getDb } = require('./db');
  setInterval(() => {
    try {
      getDb().pragma('wal_checkpoint(TRUNCATE)');
      logger.info('[WAL] Checkpoint concluído');
    } catch (e) {
      logger.error('[WAL] Checkpoint falhou', { error: e.message });
    }
  }, 24 * 60 * 60 * 1000);
}
```

---

## Observações Operacionais

### DB Size
O banco cresceu para 29 GB e 4 backups de 25 GB cada ocupam 100 GB adicionais no disco (248 GB total). Com 80 GB livres, há margem, mas os backups de julho devem ser avaliados para remoção.

```bash
# Verificar uso real do disco na VM
du -sh /opt/dt-manager/data/
df -h /opt
```

### Azure CLI Token
O token do `az` CLI expira a cada 30 dias por conditional access do M365. Quando `az vm run-command invoke` retornar `AADSTS70043: token_expired`:

```bash
az logout
az login  # logar com andre@delirio.com.br (conta organizacional, não consumer)
```

Enquanto CLI expirado, usar **Portal Azure → vm-dt-manager → Run Command → RunShellScript**.

### SSH Direto
SSH na VM funciona como `delirioadmin`. PM2 roda como `root` — usar `sudo`:

```bash
ssh delirioadmin@dt-manager.brazilsouth.cloudapp.azure.com
sudo pm2 list
sudo bash /opt/dt-manager/infra/safe-restart.sh
```

---

## Prevenção Futura

| Risco | Mitigação |
|---|---|
| WAL crescer novamente | `wal_autocheckpoint = 1000` + scheduler diário (commit `a6812e0d`) |
| Ghost process EADDRINUSE | `safe-restart.sh` — NUNCA `pm2 restart` diretamente |
| DB crescendo sem controle | Avaliar rotina de purge em `machine_metrics_hourly` (dados >6 meses) |
| Disco cheio (backups julho) | Remover `.bak.*` de julho após confirmar integridade do DB atual |
| az CLI expirado | Documentado acima. Preferir SSH direto para operações de emergência |
