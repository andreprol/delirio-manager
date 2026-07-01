# Bare Metal Recovery — Design Spec

**Projeto:** Delirio Manager (adendo)
**Data:** 2026-06-30
**Status:** Aprovado

---

## Contexto

O Delirio Manager já gerencia ~224 PCs Windows 11 da Delirio Tropical em 10 localidades via agente Go. A Zamak (fornecedor atual de DR) cobre apenas 74 máquinas por custo — as ~150 restantes ficam sem proteção. Este adendo usa a infraestrutura existente do DM (agente Go, servidor Azure, dashboard Electron) para entregar bare metal recovery em toda a frota, com custo zero de licença além do Azure Blob Storage.

**Objetivo:** HD queimou → traz a máquina para casa → HD novo → boot USB → digita credenciais → Windows sobe idêntico ao último backup.

---

## Decisões de Arquitetura

| Decisão | Escolha | Motivo |
|---|---|---|
| Motor de backup | Veeam Agent for Windows FREE | Incremental nativo, Azure Blob nativo, recovery media incluído, gratuito |
| Armazenamento | Azure Blob Storage (conta `dtmanagerdr`) | Acessível de qualquer lugar; André faz manutenção sempre em casa, não na loja |
| Orquestração | Agente DM (Go) | Já instalado em todas as máquinas; evita segundo console de gerenciamento |
| Gerenciamento central | Dashboard DM (módulo DR) | Substitui console Veeam pago (~R$179k para 224 máquinas) |
| Opt-in por máquina | Sim | DR configurado individualmente via botão "Configurar DR" por máquina |

---

## Arquitetura

```
[PC Loja — DelirioAgent.exe + Veeam Agent Free]
        ↑ heartbeat com dr_status
        ↓ comandos dr-setup / dr-backup-now
[VM Azure — servidor DM (Node.js + SQLite)]
        ↑↓ HTTPS/WebSocket
[Dashboard Electron — módulo DR]

[Veeam Agent] → upload direto → [Azure Blob Storage — dtmanagerdr]
  (não passa pelo servidor DM)
```

**Ponto crítico:** as imagens de backup sobem diretamente do PC para o Azure Blob — não transitam pela VM Azure (evita saturar a VM e gera custo de egresso desnecessário).

---

## Fluxo de Backup (diário, automático)

1. Veeam Agent dispara às 23h (configurado no `dr-setup`)
2. VSS snapshot do disco inteiro
3. Incremental comprimido → upload direto para Azure Blob (`dtmanagerdr/{hostname}/`)
4. Veeam grava log de conclusão em `C:\ProgramData\Veeam\Endpoint\Log\`
5. Agente DM lê o log e envia `dr_status` no próximo heartbeat (30s)
6. Servidor DM salva em `dr_backups` e faz broadcast WebSocket para o dashboard

**Primeiro backup:** full (~150 GB em média por máquina). Backups seguintes: incremental (~2–5 GB/dia).

---

## Fluxo de Recovery

1. HD queima em alguma loja
2. André traz a máquina para casa e coloca HD novo
3. Boot pelo pendrive **Veeam Recovery Media** (gerado uma única vez, serve para qualquer máquina protegida)
4. No ambiente Veeam PE: adiciona o repositório Azure Blob (credenciais salvas no pendrive)
5. Seleciona a máquina pelo hostname → escolhe o restore point desejado
6. Restaura — Windows sobe idêntico ao último backup bem-sucedido

---

## Componentes

### 1. Agent — `agent/dr.go` (novo arquivo)

Isolado dos arquivos existentes. Integração: 3 entradas no `switch` de `handleCommand` em `agent.go` + campo `DRStatus` no struct de heartbeat.

**Funções:**

| Função | Responsabilidade |
|---|---|
| `installVeeam(serverURL string)` | Baixa `VeeamAgentWindows.exe` do servidor DM, instala silencioso (`/silent /norestart`), aguarda serviço `VeeamEndpointBackupSvc` subir, retorna versão |
| `configureJob(creds DrCreds)` | Gera XML de config com hostname como nome do container Azure Blob, chama `VeeamAgent.exe /config /f:config.xml`, schedule diário 23h, retenção 7 restore points |
| `triggerBackupNow()` | Chama `VeeamAgent.exe /backup`, retorna imediatamente (job roda async no Veeam) |
| `readStatus() DRStatus` | Lê logs em `C:\ProgramData\Veeam\Endpoint\Log\`, extrai último backup, status OK/falha, duração, GB transferidos |

**Novos comandos:**

| Comando | Params | ACK |
|---|---|---|
| `dr-setup` | `{ azure_account, sas_token, schedule_hour }` | `{ veeam_version, setup_ok, error? }` |
| `dr-backup-now` | — | `{ job_started }` |
| `dr-status` | — | objeto `DRStatus` completo |

**Campo novo no heartbeat:**

```json
"dr_status": {
  "setup": "configured",
  "last_backup_at": "2026-06-30T23:01:44Z",
  "last_backup_ok": true,
  "is_running": false,
  "storage_gb": 147.3,
  "veeam_version": "6.1.0.123"
}
```

Valores de `setup`: `not_installed` | `installed` | `configured` | `error`

Máquinas sem Veeam omitem o campo — servidor trata ausência como `not_installed`. Nenhum heartbeat existente quebra.

---

### 2. Servidor — `server/routes/dr.js` (novo arquivo)

| Rota | Descrição |
|---|---|
| `POST /api/dr/:id/setup` | Enfileira `dr-setup` para a máquina. Credenciais Azure Blob vêm do `config.json` do servidor — não expostas no dashboard. |
| `POST /api/dr/:id/backup-now` | Enfileira `dr-backup-now`. |
| `GET /api/dr/overview` | Resumo da frota: total protegidas, % backup <24h, total storage GB, máquinas com falha. |
| `GET /api/dr/:id/history` | Histórico dos últimos 28 dias da máquina (array de `dr_backups`). |

**Heartbeat handler (`server/routes/agent.js`) — mudanças:**
- Ao receber heartbeat com `dr_status`: atualiza colunas `dr_*` na tabela `machines`
- Se `last_backup_ok = true` e é backup novo → insere registro em `dr_backups`
- Broadcast WebSocket `{ type: 'dr_update', machineId, drStatus }` → dashboard atualiza em tempo real

**`config.json` — nova seção:**
```json
"dr": {
  "azure_account_name": "dtmanagerdr",
  "sas_token": "sv=2023-...",
  "schedule_hour": 23,
  "alert_after_hours": 24,
  "alert_cooldown_hours": 6
}
```

---

### 3. Banco de Dados — `server/db.js` (mudanças)

**Nova tabela `dr_backups`:**

```sql
CREATE TABLE dr_backups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id  INTEGER NOT NULL REFERENCES machines(id),
  backed_at   DATETIME NOT NULL,
  status      TEXT NOT NULL,  -- ok | failed | running
  storage_gb  REAL,
  duration_min INTEGER,
  error_msg   TEXT
);
CREATE INDEX idx_dr_backups_machine ON dr_backups(machine_id, backed_at DESC);
```

Retenção de histórico no servidor: 90 dias. As imagens reais ficam no Azure Blob com retenção de 7 restore points (configurado pelo Veeam).

**Novas colunas em `machines`** (migration):

```sql
ALTER TABLE machines ADD COLUMN dr_setup      TEXT DEFAULT 'not_installed';
ALTER TABLE machines ADD COLUMN dr_last_ok    DATETIME;
ALTER TABLE machines ADD COLUMN dr_storage_gb REAL;
ALTER TABLE machines ADD COLUMN dr_version    TEXT;
```

---

### 4. Alertas — `server/services/alertEngine.js` (mudanças)

**Alerta: backup atrasado**
- Trigger: máquina com `dr_setup = configured` e `dr_last_ok` há mais de `alert_after_hours` (padrão: 24h)
- Canais: in-app toast + email
- Cooldown: `alert_cooldown_hours` (padrão: 6h) — evita spam

**Alerta: falha no backup**
- Trigger: heartbeat com `last_backup_ok = false`
- Canais: in-app toast + email
- Mensagem inclui `error_msg` retornado pelo Veeam

---

### 5. Dashboard — mudanças no Electron/React

**Nova aba "🔒 DR" em `MachineCard.jsx`:**

- Badge de status: `✅ Protegida` / `⚙️ Configurando...` / `❌ Erro` / `— Sem DR`
- Último backup com timestamp relativo ("hoje às 23:01", "há 2 dias")
- Barras dos últimos 28 dias (verde = ok, vermelho = falha, cinza = sem dados)
- Storage usado em GB
- Botão **"⚙️ Configurar DR"** (quando `dr_setup = not_installed`)
- Botão **"▶ Forçar Backup"** (quando `dr_setup = configured`)
- Botão **"📋 Ver Log"** (abre log do Veeam via comando `dr-status`)

**Pill no topbar (ao lado de RH e Aloha):**

- `🔒 X/224` — X = máquinas com `dr_setup = configured`
- Clique abre o módulo DR
- Cor: roxo/indigo (igual à identidade visual existente do DM)

**Novo componente `DRModule.jsx`:**

Full-screen overlay (mesmo padrão do `RhModule.jsx`). Estrutura:
- 4 cards de resumo: protegidas / % backup <24h / total Azure GB / falhas
- Filtros: Todas / Protegidas / Sem DR / Com falha
- Tabela: Máquina | Status DR | Último backup | 28 dias (barrinhas) | Storage
- Rodapé: botão "📥 Exportar CSV" + custo estimado Azure Blob do mês

**Novos endpoints em `api.js`:**

```javascript
dr: {
  setup:     (id)  => request('POST', `/api/dr/${id}/setup`),
  backupNow: (id)  => request('POST', `/api/dr/${id}/backup-now`),
  overview:  ()    => request('GET',  '/api/dr/overview'),
  history:   (id)  => request('GET',  `/api/dr/${id}/history`),
}
```

**WebSocket:** novo evento `dr_update` atualiza o estado em tempo real sem reload.

---

## Azure Blob Storage

- **Conta:** `dtmanagerdr` (criar na mesma subscription da VM: GARCIA TROP RESTAURANTE LTDA)
- **Tier:** LRS (Locally Redundant), Hot
- **Estrutura:** um container por máquina nomeado pelo hostname em minúsculas (ex: `termmetro1`, `bshopboh`)
- **Credenciais — dois SAS Tokens distintos:**
  - **Token de escrita** (`rwdl`): salvo em `config.json` no servidor DM. Enviado ao agente no `dr-setup`. Usado pelo Veeam para fazer upload dos backups.
  - **Token de leitura** (`rl`): gerado separadamente, salvo no pendrive de recovery. Usado apenas para baixar a imagem durante o restore. Nunca sai do pendrive.
- **Custo estimado:** ~R$15/mês por máquina protegida (150 GB × R$0,10/GB LRS Hot). Para 74 máquinas: ~R$1.110/mês.

---

## Pendrive de Recovery

Gerado uma única vez. Serve para qualquer máquina protegida da frota.

**Conteúdo:**
- ISO do Veeam Recovery Media (baixar em veeam.com — gratuito, sem conta necessária)
- Arquivo `azure-credentials.txt` com `account_name` e o **SAS token de leitura** (`rl`) — permissão mínima suficiente para restore, sem capacidade de sobrescrever backups
- Arquivo `hostnames.txt` com lista de todas as máquinas protegidas e seus restore points

**Processo de criação (único):**
1. Baixar Veeam Recovery Media em qualquer máquina com Veeam instalado: `VeeamAgent.exe /create-recovery-media /path:D:\`
2. Gravar a ISO em pendrive ≥ 2 GB com Rufus ou similar
3. Salvar `azure-credentials.txt` na raiz do pendrive

---

## Instalador Veeam no Servidor DM

O instalador `VeeamAgentWindows.exe` (~150 MB) fica hospedado em `/opt/dt-manager/public/downloads/` — mesma estratégia do `lhm.zip` (LibreHardwareMonitor) e do `delirio-agent.exe`. O agente baixa diretamente do servidor DM no `dr-setup`, sem depender do site da Veeam nas máquinas das lojas.

---

## Escopo Fora do Design (não implementar agora)

- Agendamento de backup configurável por máquina (sempre 23h fixo nesta versão)
- Restore remoto orquestrado pelo DM (recovery é sempre manual com pendrive)
- Integração ou leitura de status da Zamak (as máquinas cobertas pela Zamak continuam na Zamak)
- Notificação por Teams (só email + in-app nesta versão, igual ao padrão do DM)

---

## Rollout Sugerido

1. Criar conta Azure Blob `dtmanagerdr` e gerar SAS token
2. Hospedar instalador Veeam no servidor DM
3. Implementar `agent/dr.go` + 3 comandos + campo heartbeat
4. Implementar `server/routes/dr.js` + migrations DB + alertas
5. Implementar UI: aba DR no card + pill topbar + `DRModule.jsx`
6. Gerar pendrive Veeam Recovery Media
7. Configurar DR nas primeiras 5 máquinas (teste piloto)
8. Expandir gradualmente para as 224 máquinas
