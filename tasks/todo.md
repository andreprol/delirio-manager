# TODO — NCR Monitor (Check de Encomendas)
**Data:** 2026-07-08

## Fase 1 — Agente Go

- [ ] **1a** `agent/nfce.go`: adicionar structs `FindNFCeParams`, `FindNFCeResult` + função `findNFCeForOrder()`
- [ ] **1b** `agent/commands.go`: adicionar `case "aloha-find-nfce":` no switch `executeCommand`
- [ ] **1c** Build: `GOOS=windows GOARCH=amd64 go build -o delirio-agent.exe` sem erros
- [ ] **1d** Upload binário via `/api/update/publish` + confirmar versão nos BOHs online

### Checkpoint A
- [ ] Inserir command manual no sqlite3 → BOH responde ACK `{found:false}` em < 60s

## Fase 2 — DB (`server/db.js`)

- [ ] **2a** Adicionar `CREATE TABLE IF NOT EXISTS ncr_monitor_emails (...)` na inicialização do DB
- [ ] **2b** Adicionar e exportar: `ncrInsertEmail`, `ncrGetByMessageId`, `ncrGetByCommandId`, `ncrUpdate`, `ncrGetPendingRetries`
- [ ] **2c** Verificar se `getMachineByHostname` existe; se não, adicionar

## Fase 3 — Serviço (`server/services/ncrMonitor.js`)

- [ ] **3a** Criar arquivo com `getAccessToken()` (scope Mail.ReadWrite)
- [ ] **3b** Implementar `fetchNewNcrEmails()` via Graph `$search="subject:NCR"`
- [ ] **3c** Implementar `parseNcrEmail()` — strip HTML, decode entities, extrair JSON, converter UTC→BRT
- [ ] **3d** Implementar `dispatchNcrCheck()` — `createCommand` + `ncrUpdate(command_id)`
- [ ] **3e** Implementar `sendNcrResultEmail()` — Graph sendMail, attachment XML quando found
- [ ] **3f** Implementar `processRetries()` — `ncrGetPendingRetries` + re-dispatch
- [ ] **3g** Implementar `tick()` + `start()` com `setInterval(tick, 120000)`
- [ ] **3h** Exportar: `{ start, sendNcrResultEmail }`

## Fase 4 — ACK Handler (`server/routes/agent.js`)

- [ ] **4a** Adicionar `const ncrMonitor = require('../services/ncrMonitor')` no topo
- [ ] **4b** Adicionar bloco `if (cmd.type === 'aloha-find-nfce')` no post-process do `/commands/ack`

## Fase 5 — Wire-up + Deploy (`server/server.js`)

- [ ] **5a** Adicionar `const ncrMonitor = require('./services/ncrMonitor')` no topo
- [ ] **5b** Adicionar `ncrMonitor.start()` no callback do `server.listen`
- [ ] **5c** Deploy todos os JS para Azure VM (base64 patch via run-command)
- [ ] **5d** PM2 restart com ecosystem.config.js (não `pm2 restart` simples)

### Checkpoint B
- [ ] `pm2 logs dt-manager` mostra `[NCR] Monitor de encomendas iniciado`
- [ ] Logs mostram `[NCR] tick:` a cada 2 min

### Checkpoint C — Fluxo ponta a ponta
- [ ] Email TEST NCR chega → agente recebe comando → ACK → email resultado em `andre@delirio.com.br`
- [ ] Email com XML attachment quando `found:true`
- [ ] Email de alerta quando 3 tentativas falharam

## Descoberto durante implementação

_(anotar armadilhas e ajustes aqui)_
