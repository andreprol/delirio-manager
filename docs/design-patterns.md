# Catálogo de Padrões de Design — Delirio Manager

Padrões identificados no código-fonte real do projeto. Referência: Cap. 6 Engenharia de Software Moderna (Valente).

---

## Singleton — `server/db.js`

**Onde:** `db.js:getDb()`
**Como:** Variável de módulo `let db` inicializada uma única vez — `if (!db)` instancia `new Database(DB_PATH)` e executa `migrate(db)`. Todas as chamadas subsequentes retornam a mesma conexão SQLite, garantindo ponto único de acesso ao banco.

---

## Strategy (via mapa de despacho) — `server/routes/agent.js`

**Onde:** `agent.js:ACK_POST_PROCESSORS` (linha 395) e `agent.js:commands/ack` (linha 419)
**Como:** O objeto `ACK_POST_PROCESSORS` mapeia cada tipo de comando (`'aloha-index-nfce-day'`, `'aloha-find-nfce'`, etc.) a uma função-estratégia independente. Ao receber um ACK, a rota seleciona e invoca `processor(commandId, machineId, success, message)` em tempo de execução, sem `switch/case` — cada estratégia encapsula o comportamento pós-confirmação de um tipo diferente de comando.

---

## Observador — `server/services/alertEngine.js`

**Onde:** `alertEngine.js:fireAlert()` (linha 621) e `alertEngine.js:checkOffline()` (linha 133)
**Como:** O `alertEngine` atua como Sujeito: ao detectar eventos (máquina offline, CPU alta, DR atrasado), chama `broadcast()` do serviço WebSocket, notificando todos os clientes conectados (Observadores — a UI do dashboard) sem acoplamento direto. `fireAlert` centraliza a notificação, gravando no banco e disparando o evento para todos os assinantes do canal WebSocket simultaneamente.

---

## Template Method — `server/services/alertEngine.js`

**Onde:** `alertEngine.js:checkAll()` (linha 97) e funções `checkOffline`, `checkMetricThresholds`, `checkWolTests`, `checkWolAutoTests`, `checkAutoWake`, `checkDRBackups`
**Como:** `checkAll()` define o esqueleto fixo do ciclo de verificação, delegando cada passo a uma função especializada. O `setInterval` invoca `checkAll` a cada 30 s; a ordem e o conjunto de verificações são imutáveis, mas cada `check*` implementa a lógica específica daquele domínio (rede, métricas, WoL, DR) de forma independente.

---

## Fachada — `server/services/reportEngine.js`

**Onde:** módulo `reportEngine.js` consumido por `server/routes/relatorio.js:11`
**Como:** O módulo expõe uma API coesa (`buildStoreContext → callClaude → parseClaudeScore → generateDocx → generatePdf`) que oculta a complexidade de: consultas SQL em múltiplas tabelas, chamada à API Claude com prompt caching, geração de DOCX via `docx`, conversão para PDF via LibreOffice e leitura de configuração do `config.json`. A rota `relatorio.js` orquestra o pipeline chamando essas funções em sequência, sem conhecer os detalhes de nenhum subsistema.
