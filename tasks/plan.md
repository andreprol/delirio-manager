# Plano: NCR Monitor — Check de Encomendas
**Data:** 2026-07-08

## Objetivo
Monitorar `andre@delirio.com.br` a cada 2 min por emails `TEST NCR` (remetente `delirio@i9vando.com.br`). Para cada novo email: identificar loja → enviar comando ao agente BOH → verificar se NFC-e foi gerada → enviar email de resultado com XML em anexo (encontrada) ou alerta (não encontrada).

---

## O que já existe (não alterar)

| Componente | Relevante |
|---|---|
| `agent/nfce.go` | `parseNFCeFile()`, `indexNFCeDay()`, todos os structs XML — reutilizar sem tocar |
| `agent/commands.go` | switch `executeCommand` — adicionar 1 case novo |
| `server/db.js` | `createCommand()`, `getCommandById()`, `ackCommand()` — reutilizar |
| `server/routes/agent.js` | ACK handler `POST /commands/ack` — adicionar post-process para 1 type novo |
| `server/services/metricsEmailReport.js` | `getAccessToken()` — copiar para ncrMonitor (não extrair shared) |
| `server/server.js` | Padrão de import + start de serviço |

---

## Grafo de Dependências

```
[A] nfce.go: findNFCeForOrder()
    └─ reutiliza: parseNFCeFile(), indexNFCeDay() (já existem, SEM modificação)

[B] commands.go: case "aloha-find-nfce"
    └─ depende de: A

[C] Build binário Go + upload via /api/update/publish
    └─ depende de: A + B

[D] db.js: migration + 5 funções NCR
    └─ independente

[E] ncrMonitor.js: serviço principal
    └─ depende de: D (tabela ncr_monitor_emails)
    └─ chama: db.createCommand() → fluxo ACK existente

[F] agent.js: post-process ACK "aloha-find-nfce"
    └─ depende de: D
    └─ chama: ncrMonitor.sendNcrResultEmail()

[G] server.js: wire-up do monitor
    └─ depende de: E
```

**Ordem de deploy obrigatória:** C (agente) → D+E+F+G (JS) → PM2 restart

---

## Decisões de Design

### Match de NFC-e
- **Valor**: `Math.abs(record.VNF - targetTotal) <= 0.02`
- **Data**: `dateCreated` UTC → BRT (UTC-3, fixo — sem DST desde 2019) → YYYY/MM/DD para path
- Se múltiplos XMLs com valor igual: retornar o primeiro match (NFC-e gerada no intervalo)

### Retry (event-driven, não polling)
- Tentativa 0: imediata ao chegar email
- Tentativa 1: 5 minutos após ACK negativo
- Tentativa 2: 15 minutos após ACK negativo
- Após 3 falhas: enviar email de alerta e setar `notified_at`
- ACK chegando após `notified_at` preenchido: ignorar (não duplicar email)

### Tabela `ncr_monitor_emails`
```
message_id       TEXT UNIQUE  — dedup de emails
received_at      TEXT         — quando chegou
order_ref        TEXT         — número do pedido (ex: "311")
enterprise_unit_id TEXT       — ID da loja do email JSON
store_name       TEXT         — nome legível da loja
boh_hostname     TEXT         — ex: TIJUCABOH
machine_id       TEXT         — FK para tabela machines
total_value      REAL         — valor Net do pedido
date_brt         TEXT         — data BRT (YYYY-MM-DD) para busca NFC-e
products_json    TEXT         — JSON array de descrições
command_id       TEXT         — link para última tentativa em commands
retry_count      INTEGER      — 0, 1, 2
next_retry_at    TEXT         — quando re-enviar comando
danfe_found      INTEGER      — NULL=pendente, 1=encontrada, 0=não encontrada
danfe_chave      TEXT         — chave de acesso NFC-e (quando found)
xml_b64          TEXT         — XML em base64 (quando found)
notified_at      TEXT         — timestamp do email de resultado enviado
created_at       TEXT         — auto datetime('now')
```

### Mapeamento enterpriseUnitId → BOH
```js
const UNIT_TO_BOH = {
  '5106287247014b1d82f07eacb9ce6b94': 'TIJUCABOH',
  '961508b0b4434c8fbc69800fea190502': 'BSHOPBOH',
  '01202dac19534f59addff2945c49450e': 'RSULBOH',
  '9debb4dc0abb4b61b2e33b1c74f48460': 'IPANEMABOH',
  '3f72f66c92ef4029b575b01c5fdab9a0': 'ASSBOH',
  '0eef4431966744f9911b75d5ce1cb39c': 'METROBOH',
  'aa75a7efad3e467ba666d5a48c9f8ccb': 'GAVEABOH',
  // PLAZABOH, CITTABOH: fallback via texto da storeName
}
const STORE_NAME_TO_BOH = {
  'niteroi plaza': 'PLAZABOH',
  'niterói plaza': 'PLAZABOH',
  'citta': 'CITTABOH',
  'città': 'CITTABOH',
}
```

### Parse do email (body HTML → JSON)
1. `msg.body.content` (HTML) → strip tags → decode HTML entities
2. Regex `\{"channel":.*?\}` — extrair JSON blob
3. `JSON.parse(match)` → `{dateCreated, totals[{type:"Net",value}], orderLines[{description}], enterpriseUnitId, referenceId}`
4. Total: `payload.totals.find(t => t.type === 'Net')?.value`
5. Produtos: `payload.orderLines.map(l => l.description)`
6. Data BRT: `new Date(dateCreated) - 3h` → `YYYY-MM-DD`

### Token MS Graph
- `ncrMonitor.js` tem `getAccessToken()` própria (copiada de `metricsEmailReport.js`)
- Scope adicional: `Mail.ReadWrite` (para ler emails)
- Token atual em config.json já tem `Mail.ReadWrite` (confirmado em sessão anterior)

---

## TAREFA 1: Go — `findNFCeForOrder` + case `aloha-find-nfce`

### 1a — `agent/nfce.go` — adicionar função + structs

```go
type FindNFCeParams struct {
    Date     string   `json:"date"`     // "2026-07-06" (BRT)
    Total    float64  `json:"total"`
    Products []string `json:"products"`
}

type FindNFCeResult struct {
    Found  bool    `json:"found"`
    Chave  string  `json:"chave,omitempty"`
    XMLB64 string  `json:"xml_b64,omitempty"`
    DhEmi  string  `json:"dh_emi,omitempty"`
    VNF    float64 `json:"v_nf,omitempty"`
}

func findNFCeForOrder(params FindNFCeParams) FindNFCeResult
```

Lógica:
1. Parse `params.Date` → `yyyy`, `mm`, `dd`
2. `dayPath = alohaNFCePath + "\" + yyyy + "\" + mm + "\" + dd + "\NFCe\"`
3. `os.ReadDir(dayPath)` → listar `.xml`
4. Para cada arquivo: `parseNFCeFile(xmlPath, dd)` → checar `math.Abs(rec.VNF - params.Total) <= 0.02`
5. Se match: ler bytes raw → `base64.StdEncoding.EncodeToString` → retornar `{Found:true,...}`
6. Sem match: `{Found:false}`
7. Erro de pasta não encontrada: `{Found:false}` (sem panic)

### 1b — `agent/commands.go` — adicionar case

```go
case "aloha-find-nfce":
    var params FindNFCeParams
    if err := json.Unmarshal([]byte(cmd.Params), &params); err != nil {
        return "", fmt.Errorf("params inválidos: %w", err)
    }
    result := findNFCeForOrder(params)
    data, _ := json.Marshal(result)
    return string(data), nil
```

**Critérios de aceitação:**
- [ ] `go build ./...` sem erros
- [ ] Retorna `{found:false}` para data/valor inexistentes
- [ ] Retorna `{found:true, chave:"...", xml_b64:"..."}` para match real
- [ ] base64 decoded = XML válido

---

## TAREFA 2: Build + Deploy do Agente

```powershell
cd F:\RichClub\agent
$env:GOOS="windows"; $env:GOARCH="amd64"
go build -ldflags="-s -w" -o ..\delirio-agent.exe .
```

Upload via endpoint existente `/api/update/publish` (multipart ou raw bytes conforme implementação atual em `routes/update.js`).

**Critérios de aceitação:**
- [ ] Upload OK, versão bump confirmado
- [ ] BOHs online auto-atualizam em < 2 min (heartbeat 30s)
- [ ] Logs VM: `[Update] HOSTNAME updated to vX.X.XX`

---

## TAREFA 3: DB migration + funções (`server/db.js`)

Adicionar na função de init (após todas as outras tabelas CREATE TABLE IF NOT EXISTS):

```sql
CREATE TABLE IF NOT EXISTS ncr_monitor_emails (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id         TEXT UNIQUE NOT NULL,
  received_at        TEXT NOT NULL,
  order_ref          TEXT,
  enterprise_unit_id TEXT,
  store_name         TEXT,
  boh_hostname       TEXT,
  machine_id         TEXT,
  total_value        REAL,
  date_brt           TEXT,
  products_json      TEXT,
  command_id         TEXT,
  retry_count        INTEGER DEFAULT 0,
  next_retry_at      TEXT,
  danfe_found        INTEGER,
  danfe_chave        TEXT,
  xml_b64            TEXT,
  notified_at        TEXT,
  created_at         TEXT DEFAULT (datetime('now'))
)
```

Funções a adicionar e exportar:
```js
db.ncrInsertEmail(row)          // INSERT OR IGNORE, retorna changes
db.ncrGetByMessageId(msgId)     // SELECT * WHERE message_id=?
db.ncrGetByCommandId(cmdId)     // SELECT * WHERE command_id=?
db.ncrUpdate(id, fields)        // UPDATE por campos dinâmicos (usar Object.keys)
db.ncrGetPendingRetries()       // WHERE danfe_found IS NULL AND retry_count < 3
                                //   AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
```

**Critérios de aceitação:**
- [ ] Tabela criada ao reiniciar PM2 (verificar via `sqlite3`)
- [ ] `ncrInsertEmail` idempotente (mesmo message_id → 0 changes na segunda chamada)
- [ ] `ncrGetPendingRetries` retorna rows com `next_retry_at` vencido

---

## TAREFA 4: `server/services/ncrMonitor.js` — serviço principal (CRIAR)

```
Responsabilidades:
  getAccessToken(cfg)          — cópia local, scope Mail.ReadWrite offline_access Mail.Send
  fetchNewNcrEmails(token)     — Graph $search="subject:NCR", filtrar from
  parseNcrEmail(msg)           — decode entities, extrair JSON, retornar campos
  dispatchNcrCheck(emailRow)   — db.createCommand + db.ncrUpdate
  sendNcrResultEmail(row, res) — Graph sendMail com ou sem attachment
  processRetries()             — db.ncrGetPendingRetries + dispatchNcrCheck
  tick()                       — fetch + processRetries, cada 2min
  start()                      — setInterval(tick, 120000) + tick() imediato
```

Email de resultado:
- Encontrada: `✅ NFC-e confirmada — Pedido #311 | Tijuca`
  - HTML com loja, valor, data, chave
  - Attachment: `{chave}-nfce.xml` base64
- Não encontrada: `⚠️ NFC-e NÃO gerada — Pedido #311 | Tijuca`
  - HTML com detalhes do pedido + timestamps das tentativas

Attachment MS Graph:
```json
{
  "@odata.type": "#microsoft.graph.fileAttachment",
  "name": "{chave}-nfce.xml",
  "contentType": "application/xml",
  "contentBytes": "<base64>"
}
```

**Critérios de aceitação:**
- [ ] `tick()` não lança exceção com emails malformados (try/catch por email)
- [ ] Email com `message_id` já em DB é ignorado
- [ ] `parseNcrEmail` extrai `orderRef`, `totalValue`, `dateBRT`, `products` do email de teste
- [ ] `dispatchNcrCheck` cria command na tabela `commands` e atualiza `ncr_monitor_emails.command_id`
- [ ] Emails de resultado chegam em `andre@delirio.com.br` (fase de teste)

---

## TAREFA 5: `server/routes/agent.js` — ACK handler `aloha-find-nfce`

Adicionar no bloco post-process do `POST /commands/ack` (após handlers existentes):

```js
if (cmd && cmd.type === 'aloha-find-nfce' && message) {
  try {
    const result = JSON.parse(message);
    const emailRow = db.ncrGetByCommandId(commandId);
    if (emailRow && !emailRow.notified_at) {
      if (result.found) {
        db.ncrUpdate(emailRow.id, { danfe_found: 1, danfe_chave: result.chave, xml_b64: result.xml_b64 });
        ncrMonitor.sendNcrResultEmail(emailRow, result).catch(e =>
          console.error('[NCR] Falha ao enviar email confirmação:', e.message)
        );
      } else {
        const retryDelays = [5, 15];
        if (emailRow.retry_count < 2) {
          const nextAt = new Date(Date.now() + retryDelays[emailRow.retry_count] * 60000).toISOString();
          db.ncrUpdate(emailRow.id, { retry_count: emailRow.retry_count + 1, next_retry_at: nextAt });
        } else {
          db.ncrUpdate(emailRow.id, { danfe_found: 0 });
          ncrMonitor.sendNcrResultEmail(emailRow, result).catch(e =>
            console.error('[NCR] Falha ao enviar alerta:', e.message)
          );
        }
      }
    }
  } catch (e) {
    console.error('[NCR] Falha ao processar ACK aloha-find-nfce:', e.message);
  }
}
```

Requer `const ncrMonitor = require('../services/ncrMonitor')` no topo do arquivo.

**Critérios de aceitação:**
- [ ] ACK `found:true` → `danfe_found=1` + email com XML
- [ ] ACK `found:false` (retry_count < 2) → agenda retry, sem email
- [ ] ACK `found:false` (retry_count == 2) → `danfe_found=0` + email alerta
- [ ] ACK com `notified_at` preenchido → ignorado silenciosamente

---

## TAREFA 6: `server/server.js` — wire-up + deploy final

```js
// Adicionar import (junto com outros requires no topo)
const ncrMonitor = require('./services/ncrMonitor');

// Adicionar no server.listen callback (após metricsEmail.scheduleDailyMetricsEmail())
ncrMonitor.start();
console.log('[NCR] Monitor de encomendas iniciado (intervalo: 2min)');
```

### Sequência de deploy (ordem obrigatória)

1. Deploy agente Go (Tarefa 2) — BOHs auto-atualizam
2. Deploy JS em bundle:
   - `db.js` (migration + funções)
   - `services/ncrMonitor.js` (novo arquivo)
   - `routes/agent.js` (ACK handler)
   - `server.js` (wire-up)
3. PM2 restart seguindo padrão `ecosystem.config.js` (não `pm2 restart` simples — risco de perder DB_PATH)

**Critérios de aceitação:**
- [ ] `pm2 logs dt-manager` mostra `[NCR] Monitor de encomendas iniciado`
- [ ] Logs mostram `[NCR] tick:` a cada 2 min
- [ ] Nenhuma exceção no boot

---

## Checkpoints

### Checkpoint A — Agente deployado
- Testar via sqlite3: `INSERT INTO commands (id,machine_id,type,params,status) VALUES (...,'TIJUCABOH','aloha-find-nfce','{"date":"2026-07-08","total":0.01,"products":["Teste"]}','pending')`
- Verificar ACK com `{found:false}` em < 60s

### Checkpoint B — Monitor rodando
- `ncrMonitor.start()` sem erros
- Logs mostram tick a cada 2 min
- Email TEST NCR manual enviado de `delirio@i9vando.com.br` → verificar linha em `ncr_monitor_emails`

### Checkpoint C — Fluxo completo ponta a ponta
- Email chega → agente recebe comando → ACK → email de resultado em `andre@delirio.com.br`
- Verificar subject e XML attachment (quando found=true)

---

## Armadilhas Conhecidas

1. **UTC-3 no Go**: `time.LoadLocation("America/Sao_Paulo")` pode falhar no Windows (sem tzdata). Usar `t.UTC().Add(-3 * time.Hour)` fixo — Brasil sem DST desde 2019.

2. **XML base64 no ACK**: campo `result` em `commands` é TEXT. NFC-e típica: 5-30 KB → base64: 7-40 KB. Dentro do limite SQLite TEXT (1 GB). OK.

3. **`$search` Graph não suporta AND com outros campos**: filtrar `from === 'delirio@i9vando.com.br'` no código JS após receber resultados.

4. **`getMachineByHostname` pode não existir em db.js**: verificar antes de implementar Tarefa 3. Se não existir, adicionar junto.

5. **BOH offline**: comando fica em `pending`. Se BOH voltar após `notified_at` preenchido → ACK handler tem guard `!emailRow.notified_at`. OK.

6. **Emails duplicados de teste**: `UNIQUE` em `message_id` garante cada email processado só uma vez, mesmo com múltiplos emails com mesmo `orderRef`.

7. **Double-encode no ACK**: `message` na tabela `commands` é o resultado JSON do agente Go. Verificar se `JSON.parse(message)` funciona diretamente (sem double-escape).

8. **`cmd.Params` no Go**: verificar se é `[]byte` ou `string` na struct `Command`. O `json.Unmarshal` aceita `[]byte`; se for `string`, converter com `[]byte(cmd.Params)`.

---

## Resumo de Arquivos

| Ação | Arquivo | Estimativa |
|---|---|---|
| MODIFY | `agent/nfce.go` | +55 linhas |
| MODIFY | `agent/commands.go` | +12 linhas |
| MODIFY | `server/db.js` | +85 linhas (migration + 5 funções) |
| CREATE | `server/services/ncrMonitor.js` | ~210 linhas |
| MODIFY | `server/routes/agent.js` | +32 linhas |
| MODIFY | `server/server.js` | +3 linhas |

Total: ~397 linhas novas/modificadas.
