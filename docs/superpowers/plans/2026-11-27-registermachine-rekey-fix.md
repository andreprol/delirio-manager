# Re-key de Máquina Trava o Banco Inteiro — Plano 4/4

> **For agentic workers:** este plano corrige um incidente de produção REAL e
> ATIVO (não hipotético) achado em 27/11/2026 enquanto se validava o
> `/api/healthz` do Plano 1. Mitigação de emergência já aplicada
> (`statement_timeout=180000` no Postgres + conexões travadas finalizadas
> + restart da app) — este plano é o conserto definitivo, pra nunca mais
> precisar repetir a mitigação manual.

**Goal:** Fazer o re-key de UUID de máquina (`_rekeyAndMergeMachine`)
parar de travar por dezenas de minutos a mais de uma hora, saturando o
pool de conexões do Postgres e derrubando o `/api/healthz` (e, por
extensão, qualquer health probe de Load Balancer no Plano 2) —
independente de quantas linhas de histórico a máquina acumulou.

**Architecture:** Hoje o re-key reescreve `machine_id` em TODAS as
tabelas filhas (10 via `ON UPDATE CASCADE`, 5 manuais) dentro da MESMA
transação que segura o advisory lock por hostname — incluindo
`activity_log`, que tem **59 milhões de linhas / 23GB** depois de só 3
meses de produção. Reescrever a fatia de uma máquina nessa tabela é
proporcional ao volume histórico dela, não a um número fixo — por isso
trava de 1 a 71+ minutos dependendo da máquina, nunca é "rápido". A
correção separa duas coisas que hoje são uma só: (1) o registro em si
(rápido, poucas linhas, pode continuar síncrono) de (2) a
reescrita do histórico em tabelas grandes (lenta, deve sair da
transação crítica e idealmente nem ser síncrona).

**Tech Stack:** `server/db-pg.js`, migração SQL (índice), Postgres
(`statement_timeout`, `pg_stat_activity`), mesmo padrão de
`deleteInBatches` já usado em `activityRetention.js`.

**Spec:** nenhuma — achado ao vivo, não fazia parte do design original
de HA. Referenciar este plano a partir de
`docs/superpowers/specs/2026-11-27-ha-watchdog-design.md` se o Plano 1/2
quiserem apontar pra ele.

## O que já foi feito (mitigação de emergência, 27/11/2026)

- `pg_terminate_backend` em 9 conexões travadas (1-71min presas em
  `UPDATE machines SET id=$1 WHERE id=$2` / `UPDATE metrics SET
  machine_id=...`), todas com rollback seguro (transação, sem corromper
  nada — o agente tenta de novo no próximo heartbeat)
- `safe-restart.sh` na VM pra limpar o pool da aplicação, que tinha
  ficado com estado interno preso mesmo depois do banco já estar livre
- `statement_timeout = 180000` (3min) aplicado no servidor Postgres
  (`psql-dt-manager-prod`), dinâmico, sem restart do banco — rede de
  segurança: nenhuma query trava mais que 3min, protege o pool mesmo
  antes do conserto definitivo

**Isso é paliativo, não solução.** Minutos depois da mitigação, o MESMO
padrão de 9 conexões travadas reapareceu sozinho, confirmando que é um
**loop ativo e contínuo**, não um acúmulo histórico pontual: um punhado
de máquinas está preso tentando re-key a cada heartbeat, nunca
termina a tempo, e tenta de novo.

## Achados da investigação ao vivo (27/11/2026)

- **Causa raiz confirmada**: `_rekeyAndMergeMachine`
  (`server/db-pg.js:1083`) reescreve `machine_id` em 5 tabelas manuais
  (`MACHINE_CHILD_TABLES_NO_FK`) + 10 via cascade, tudo dentro de uma
  transação que já segura o advisory lock do hostname inteiro
  (`db-pg.js:1036`)
- **`activity_log`: 59.040.708 linhas, 23GB** — maior de longe entre as
  tabelas envolvidas (`metrics` 45K linhas/164MB com índice OK,
  `commands` 29K linhas mas 2,3GB — bloat, ver Review Focus)
- **Confirmado que reproduz na hora**: minutos depois do restart de
  mitigação, as MESMAS ~9 máquinas já estavam de novo travadas na
  mesma linha, com idade de poucos segundos — não é histórico antigo
  reaparecendo, é um loop ativo
- **4 das 9 máquinas identificadas** (hash reverso via
  `hashtext(upper(hostname))`): `GERENTE-CITTA`, `AUXILIAR-CITTA`,
  `TERMCITTA1` (3 de 4 na loja **Città**), `DTMETROIFOOD02`
  (Metropolitano) — `last_seen` de 25/11 e 27/11, ou seja, já recorre
  há pelo menos 2 dias, não é de hoje
- **Postgres com `statement_timeout=0`** (sem teto) era o que permitia
  a query travar indefinidamente em vez de falhar rápido — já corrigido
  como mitigação, mas precisa virar parte do provisionamento oficial
  (Terraform/script/doc), não ficar só como `az` manual
- **Pergunta em aberto do André, não respondida ainda**: por que
  `activity_log` chegou a 59 milhões de linhas em só 3 meses de
  produção — precisa de auditoria própria (ver Task 1)

## Global Constraints

- **Nenhuma migração que trave `activity_log` inteira** (23GB — um
  `CREATE INDEX` sem `CONCURRENTLY`, ou um `ALTER TABLE` que reescreva
  a tabela, trava todo mundo por muito tempo). Toda migração nesta
  tabela usa `CONCURRENTLY` ou roda em janela de baixo tráfego
  combinada com o André antes
- `statement_timeout=180000` já está em produção — qualquer mudança de
  comportamento desta task não pode depender de removê-lo; é rede de
  segurança permanente, não só temporária
- As 9 máquinas presas no loop hoje continuam tentando re-key a cada
  heartbeat — qualquer fix precisa ser validado contra ELAS
  especificamente (não só em teste sintético), já que são o caso real
  reproduzindo agora
- Esse re-key é literalmente o motivo de existir do `MACHINE_CHILD_TABLES_NO_FK`
  comment: "config.json corrompido/reinstall" — qualquer redesenho
  continua precisando resolver o mesmo problema de negócio (agente
  reinstalado, hostname igual, UUID novo), só não pode mais ser O(linhas
  históricas da máquina)

## Review Focus

- **`commands`: 29K linhas mas 2,3GB** — tamanho desproporcional ao
  número de linhas (bloat real, provavelmente payload grande por linha
  ou dead tuples não compactados) — vale um `VACUUM`/investigação
  separada, fora do escopo central deste plano mas achado no caminho
- **As 5 máquinas restantes do loop** (9 identificadas por objid, só 4
  resolvidas pro hostname atual) — as outras 5 objids não bateram com
  nenhum hostname ATUAL em `machines` — podem ser hostnames que já
  nem existem mais na tabela (duplicata já removida por uma tentativa
  anterior que completou o suficiente antes de travar) — investigar
  antes de assumir que são as mesmas 4 lojas
- **Padrão geográfico**: 3 de 4 identificadas são da loja Città — pode
  ser coincidência (Città tem várias máquinas) ou pode ser rede local
  instável lá causando reinstalls/reboots frequentes do agente — vale
  perguntar pro André se Città teve incidente de rede/hardware recente
- **O que acontece com o agente enquanto o re-key nunca completa**: ele
  tenta de novo no próximo heartbeat, criando uma NOVA tentativa
  igualmente cara, sem nunca progredir — qualquer fix precisa quebrar
  esse ciclo, não só tornar uma tentativa mais rápida
- **Replicar a correção de índice ausente da Task 3 do achado de hoje**
  (`insights.machine_id` sem índice, achado no meio da investigação de
  Plano 2 Task 3) — pequeno, mas real, incluir aqui já que é a mesma
  categoria de problema (FK sem índice)

---

## Task 1: Por que `activity_log` tem 59M linhas em 3 meses — RESPONDIDO

**Causa confirmada, não é bug de duplicação, é o próprio desenho**:
`agent/companion.go:98-123` manda `POST /api/activity` a cada
**4 segundos**, por máquina, o tempo todo — e `server/routes/activity.js:18`
insere uma linha NOVA em `activity_log` em TODA chamada, sem checar se
`windowTitle`/`processName` mudou desde a última. Alguém parado na
mesma janela por 1 hora gera 900 linhas idênticas.

Conta bate: `59.040.708 / 130 máquinas ≈ 454K linhas/máquina`. Num
comércio com ~12h/dia de operação, isso é consistente com meses de
captura sem dedupe — **não precisa de mais auditoria, a causa já está
clara**: falta dedupe no insert. Vira a Task 2 abaixo (mover pro código,
a parte que realmente dá pra consertar agora).

- [ ] Confirmar com o André (não bloqueante pro resto): Città teve
  mais reinstalls/reboots de agente que outras lojas no período? (pista
  pro padrão geográfico achado na Task 3 de identificação das máquinas
  presas, ver Review Focus) — pergunta assíncrona, não impede seguir

## Task 2: Dedupe no insert de `activity_log` (resolve a causa da Task 1)

**Produces:** `insertActivityLog` muda de assinatura (ver Interfaces) —
Task 3/4 não dependem disso, é independente.

- [ ] **Step 1: Escrever o teste que falha**

Em `server/db-pg.test.js` (ou arquivo de teste equivalente de
`insertActivityLog` já existente — verificar antes de criar um novo):

```js
it('nao insere linha nova quando windowTitle e processName sao iguais aos da ultima captura dessa maquina', async () => {
  const first = await db.insertActivityLog(machineId, 'Chrome - abc', 'chrome.exe');
  const second = await db.insertActivityLog(machineId, 'Chrome - abc', 'chrome.exe');
  expect(second.id).toBe(first.id); // mesma linha, nao criou outra
  const { rows } = await pool.query('SELECT count(*) c FROM activity_log WHERE machine_id=$1', [machineId]);
  expect(Number(rows[0].c)).toBe(1);
});

it('insere linha nova quando windowTitle muda', async () => {
  const first = await db.insertActivityLog(machineId, 'Chrome - abc', 'chrome.exe');
  const second = await db.insertActivityLog(machineId, 'Excel - xyz', 'excel.exe');
  expect(second.id).not.toBe(first.id);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest db-pg.test.js -t "dedupe"` (ou nome do describe
correspondente)
Expected: FAIL — hoje toda chamada cria linha nova

- [ ] **Step 3: Implementar o dedupe em `insertActivityLog`
  (`server/db-pg.js:1214`)**

Schema atual confirmado (sem migration necessária): `activity_log
(machine_id, window_title, process_name, captured_at)`. Antes do
`INSERT`, buscar a última linha dessa `machine_id`
(`SELECT id, window_title, process_name FROM activity_log WHERE
machine_id=$1 ORDER BY captured_at DESC, id DESC LIMIT 1` — usa o
índice existente em `machine_id`, não varre a tabela). Se
`window_title` e `process_name` baterem com essa última linha, **não
insere uma nova** — em vez disso faz
`UPDATE activity_log SET captured_at=$1 WHERE id=$2` na MESMA linha
(estende o "visto por último" sem criar coluna nova; `getActivityLog`
já ordena por `captured_at`, continua funcionando igual). Se não
houver linha anterior, ou os valores mudaram, insere normalmente como
hoje. Retorno da função continua `{ id, capturedAt }` nos dois casos
(builder decide se `id` no caso de update é o id da linha existente —
deve ser).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest db-pg.test.js -t "dedupe"`
Expected: PASS

- [ ] **Step 5: Rodar a suíte completa do server**

Run: `cd server && npx jest`
Expected: PASS, nenhum teste existente quebrado (checar
especialmente `activity.test.js`, que testa a rota que chama essa
função)

- [ ] **Step 6: Commit**

```bash
git add server/db-pg.js server/db-pg.test.js
git commit -m "fix(server): dedupe insert de activity_log quando janela/processo nao muda"
```

## Task 3: Parar o loop ativo das máquinas presas

- [ ] **Step 1**: reidentificar as 9 máquinas presas agora (os objids
  mudam a cada nova tentativa, repetir a query de hash reverso)
- [ ] **Step 2**: pra cada uma, investigar POR QUE elas têm um UUID
  "novo" tentando re-key contra um hostname conhecido — checar
  `agent/config.go`/logs locais dessas máquinas (via Acesso Remoto ou
  pedir pro André olhar fisicamente) — reinstall genuíno? bug gerando
  UUID novo a cada boot? `config.json` não persistindo?
- [ ] **Step 3**: se for um bug local do agente (não persiste UUID),
  esse é o fix de verdade que quebra o loop — corrigir lá, não só no
  servidor
- [ ] **Step 4**: enquanto isso não é corrigido, considerar um
  circuit-breaker simples no agente ou no servidor: depois de N
  tentativas de re-key fracassadas/sem resposta a tempo pro mesmo
  hostname numa janela curta, parar de tentar e alertar (em vez de
  martelar o banco a cada heartbeat)

## Task 4: Tornar o re-key rápido independente do volume histórico

**A correção estrutural de verdade** — sem isso, qualquer máquina
antiga/ativa vai travar de novo no dia que precisar re-key, não importa
o que a Task 3 resolva (a Task 2/dedupe reduz o RITMO de crescimento
futuro, mas o histórico já acumulado continua existindo e ainda precisa
ser rekeyável sem travar).

**Tamanho real de cada tabela envolvida (medido ao vivo, 27/11/2026)** —
isso MUDA o desenho original deste plano, não é só `activity_log`:

| Tabela | Linhas (aprox) | Tamanho | Tipo | Fase |
|---|---|---|---|---|
| `activity_log` | 59,0M | 23 GB | FK (cascade) | **B** |
| `nfce_index` | 3,97M | 7,5 GB | FK (cascade) | **B** |
| `events` | 83K | 3,1 GB | manual | **B** |
| `commands` | 30K | 2,3 GB | manual | **B** |
| `metrics` | 78K | 164 MB | manual | A |
| `machine_metrics_hourly` | 298K | 101 MB | FK | A |
| `reading_miss_events` | 40K | 14 MB | FK | A |
| `insights` | 13,6K | 10 MB | FK (sem índice — Task 5) | A |
| demais (6 tabelas) | <4K cada | <1,2 MB cada | FK/manual | A |

**Achado importante que muda a arquitetura**: `activity_log` e
`nfce_index` são FK com `ON UPDATE CASCADE` — o Postgres dispara a
reescrita das DUAS junto com as outras 8 FK tables **na mesma instrução
`UPDATE machines SET id=$1 WHERE id=$2`**, atomicamente, não dá pra
"adiar só uma parte do cascade". Então não dá pra manter esse UPDATE
síncrono e só adiar a tabela grande — **o UPDATE em `machines.id` em si
precisa virar assíncrono** quando qualquer tabela grande estiver
envolvida (hoje, sempre, já que `activity_log` cresce sem parar).

- [ ] **Step 1**: criar uma tabela nova `machine_rekey_queue (old_id,
  new_id, hostname, status, created_at, completed_at)` via migration
  (tabela pequena, sem risco)
**Ruling (investigado ao vivo 27/11/2026, antes de dispatchar — resolve o
Step 5 original, que ficava em aberto "builder confirma"):** 3 rotas
comparam `machine.id` (PK interna, resolvida via `getMachineByToken` —
só muda quando a Fase B commitar) direto contra o `machineId` que o
PRÓPRIO AGENTE manda na URL/body (o UUID novo, já ativo no agente desde
o instante em que `registerMachine` respondeu 201) — `agent.js:329`
(`GET /api/commands/:machineId`), `agent.js:495`, `winEvents.js:18`. Sem
ajuste, essas 3 rotas respondem 403 ("Token não corresponde ao
machineId") pra QUALQUER máquina que re-chaveou enquanto a Fase B ainda
não processou — ou seja, sempre, já que a Fase B é assíncrona por
design. Isso quebraria o agente imediatamente depois de todo re-key —
regressão pior que o travamento atual. Custo de estar errado: baixo
(isolado a essas 3 comparações, teste de Task 4 cobre) — custo de
ignorar: alto (volta o incidente, disfarçado de 403 em vez de timeout).
Fix: `getMachineByToken` (único ponto usado pelos 3 call-sites, via
`req.machine`) passa a trazer também `pending_rekey_new_id` (LEFT JOIN
em `machine_rekey_queue` WHERE `old_id = machines.id` AND `status IN
('pending','processing')`, no máx 1 linha por `old_id` dada a UNIQUE
parcial abaixo); as 3 comparações trocam `machine.id !== params` por
`machine.id !== params && machine.pending_rekey_new_id !== params`.

- [ ] **Step 2**: migration cria `machine_rekey_queue` com schema exato:
  ```sql
  CREATE TABLE machine_rekey_queue (
    id            SERIAL PRIMARY KEY,
    old_id        UUID NOT NULL,
    new_id        UUID NOT NULL,
    hostname      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX idx_rekey_queue_hostname_active ON machine_rekey_queue (hostname)
    WHERE status IN ('pending', 'processing');
  CREATE INDEX idx_rekey_queue_old_id_active ON machine_rekey_queue (old_id)
    WHERE status IN ('pending', 'processing');
  ```
  O índice único parcial por `hostname` é a garantia de idempotência: um
  segundo `registerMachine` pro MESMO hostname enquanto um job já está
  `pending`/`processing` NUNCA insere linha nova — ver Step 3.
- [ ] **Step 3**: reescrever `_rekeyAndMergeMachine` em duas fases —
  **Fase A (síncrona, ainda dentro da transação com o advisory lock,
  deve ser questão de milissegundos)**: atualiza as tabelas pequenas
  (`metrics`, `nfce_auto_email_log`, `service_status` + as 6 FK
  pequenas — a Fase A NÃO toca `machines.id` ainda, já que isso
  dispara o cascade nas 2 tabelas grandes). Antes de inserir na fila,
  `SELECT ... FOR UPDATE` em `machine_rekey_queue WHERE hostname=$1 AND
  status IN ('pending','processing')` (já sob o advisory lock do
  hostname, então sem race): se não existe linha, `INSERT ... status
  ='pending'`; se existe com `status='pending'`, `UPDATE` só o `new_id`
  pro valor recebido agora (agente reinstalou de novo antes do worker
  pegar o job antigo — o `new_id` mais recente é o que deve prevalecer,
  o antigo nunca chegou a ser aplicado); se existe com
  `status='processing'`, NÃO toca na linha (deixa o worker terminar o
  que já começou — o próximo `registerMachine` desse hostname, depois
  que a Fase B commitar e `machines.id` já for o novo, cai no caso 1
  normal — `UPDATE` direto, sem fila). Responde 201 pro agente
  imediatamente após o commit da Fase A.
  **Fase B (worker separado — reaproveita o padrão `setTimeout`
  auto-reagendável + `isLeader()` de `rhHealthMonitor.js`/
  `dbSizeMonitor.js`, roda fora de qualquer transação/lock HTTP,
  processa 1 job por vez)**: pega o `pending` mais antigo, marca
  `status='processing'` — **PRIMEIRO** faz `UPDATE` em lotes (helper
  novo `updateInBatches`, mesmo padrão de `deleteInBatches` em
  `db-pg.js:430`, reaproveitando `PURGE_BATCH_SIZE`/
  `PURGE_BATCH_SLEEP_MS`) nas 4 tabelas grandes — `activity_log`,
  `nfce_index` (FK, mas pré-processadas manualmente aqui pra não
  depender do cascade pra elas), `events`, `commands` (manuais) —
  `SET machine_id=$new WHERE machine_id=$old AND id IN (SELECT id
  FROM <tabela> WHERE machine_id=$old LIMIT $batchSize)`, cedendo o
  loop entre lotes. **SÓ DEPOIS**, numa transação curta, reaquire
  `pg_advisory_xact_lock(hashtext(upper(hostname)))`: roda `UPDATE
  machines SET id=$new WHERE id=$old` (o cascade agora só processa o
  resíduo — linhas inseridas nas 4 tabelas grandes DURANTE a janela
  entre o último lote e este UPDATE, não o histórico inteiro — por
  isso rápido mesmo com `activity_log` em 23GB), atualiza
  hostname/agent_version/last_seen/online_since/status na linha já
  re-chaveada, roda o `UPDATE`/`DELETE` das 3 tabelas no-FK pequenas
  restantes (`metrics`, `nfce_auto_email_log`, `service_status`) e os
  `DELETE` de duplicatas (mesmo loop de `dupes` que já existe hoje),
  marca `status='done', completed_at=now()`, COMMIT.
- [ ] **Step 4**: aplicar o ruling acima — `getMachineByToken` traz
  `pending_rekey_new_id`; as 3 comparações (`agent.js:329`,
  `agent.js:495`, `winEvents.js:18`) aceitam os dois valores
- [ ] **Step 5**: escrever teste provando que Fase A completa em
  milissegundos independente do tamanho de `activity_log`/`nfce_index`
  (mock/fixture simulando as tabelas grandes já populadas)
- [ ] **Step 6**: escrever teste provando que Fase B processa a fila,
  é idempotente (retomável se o processo cair no meio — rodar duas
  vezes seguidas no mesmo item `pending`/`processing` não duplica nem
  corrompe) e marca `done` só depois de TODAS as tabelas terem sido
  atualizadas
- [ ] **Step 7**: teste cobrindo o ruling do Step 4 — `GET
  /api/commands/:machineId` (ou rota equivalente) autentica com sucesso
  usando o `new_id` enquanto o job ainda está `pending`/`processing`,
  e continua autenticando com o `new_id` depois de `done`
- [ ] **Step 8**: teste cobrindo a idempotência por hostname do Step 3 —
  dois `registerMachine` concorrentes pro mesmo hostname (segundo
  chamado com job já `pending`) resultam em 1 única linha na fila, com
  o `new_id` do segundo chamado

### Revisão pós-implementação (27/11/2026) — redesenho da Fase B

Implementado (Steps 1-8 acima), validado ao vivo contra Postgres de dev
(corrigiu 4 bugs reais: tipo TEXT vs UUID, FK ativa impedindo o
pré-processamento em lote de `activity_log`/`nfce_index`, teste
pré-existente com hostname fixo, race entre arquivos de teste) e então
revisado por um revisor independente (Opus). **O revisor achou 1 CRÍTICO
real**: o design acima (Fase B faz `UPDATE machines SET id=$new WHERE
id=$old` segurando o advisory lock durante TODO o cascade residual de
`activity_log`/`nfce_index`) ainda reproduz o incidente original — só
que de dentro do worker, não do request HTTP. Enquanto essa transação
roda, o `UPDATE machines SET ... WHERE id=$old` de QUALQUER heartbeat
do MESMO agente (`setMachineStatus`/`updateMachine` em
`routes/agent.js:253,257`) fica bloqueado esperando o row lock da linha
`old_id` — mesmo padrão de conexões presas no pool que derrubou
`/api/healthz` em 27/11, só que agora a cada re-key, não só nos 9
casos do incidente original.

**Causa raiz do erro de desenho**: pré-processar em lote só funciona pra
tabelas SEM FK (`events`/`commands`) porque elas não exigem que `new_id`
já exista em `machines`. Para as tabelas COM FK (as 10, incluindo
`activity_log`/`nfce_index`), a única forma de pré-processá-las em lote
ANTES do UPDATE final é fazer `new_id` existir em `machines` ANTES
delas — ou seja, **não trocar a PK da linha existente, e sim clonar a
linha pra um novo id, migrar todos os filhos pro novo id em lotes (agora
permitido, já que o novo id existe), e só então apagar a linha antiga**
(cujo cascade de `DELETE`, nesse ponto, já está vazio ou quase vazio).

Mais 4 achados reais do revisor, todos corrigidos pelo mesmo redesenho
abaixo ou por ajustes pontuais:

- **ALTO** — `events`/`commands` escritos durante a janela pendente
  (`machine_id=old_id`, via `req.machine.id` nas rotas) nunca migram:
  a Fase A só moveu as 3 tabelas pequenas pro novo id, a Fase B só
  move o que já existia no momento do claim. Corrigido: nenhuma tabela
  filha migra na Fase A (só a fila); a Fase B faz um passe final de
  resíduo (Step 3 abaixo) que captura tudo que chegou durante a janela.
- **ALTO** — `routes/winEvents.js:18` e a rota de `service-status`
  (`routes/agent.js:507`, `_upsertServiceEntries`) aceitam
  `pending_rekey_new_id` pra autorizar, mas gravam usando o id DA
  REQUEST (o novo id) em vez de `machine.id` (o id que de fato existe
  em `machines` até a Fase B comitar) — `win_events` tem FK ativa pra
  `machines(id)`, então isso vira 500 (FK violation) em vez do 401
  original. Corrigido: as duas rotas gravam com `machine.id`, nunca com
  o id do payload/params.
- **ALTO** — claim da fila (`_claimNextJob`) lê `new_id` num `SELECT`
  separado do `UPDATE status='processing'`, sem lock — uma 2ª chamada de
  `registerMachine` pro mesmo hostname pode atualizar `new_id` nesse meio
  tempo (o `UPDATE` da Fase A não tem `AND status='pending'`) e o worker
  aplica o `new_id` desatualizado. Corrigido: claim atômico via `UPDATE
  ... WHERE id = (SELECT id FROM machine_rekey_queue WHERE status='pending'
  ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, e
  `_finalizeRekey` relê `new_id` da fila (não do objeto `job` capturado no
  claim) depois de adquirir o advisory lock.
- **ALTO** — nenhum job preso em `'processing'` (crash, SIGTERM, restart,
  troca de líder no meio) nunca se recupera — a UNIQUE parcial por
  hostname trava esse hostname pra sempre. Corrigido: coluna
  `claimed_at`; no início de cada ciclo (e no `start()`), `UPDATE
  machine_rekey_queue SET status='pending' WHERE status='processing' AND
  claimed_at < now() - interval '5 minutes'`.
- **MÉDIO** — a UNIQUE parcial e o `SELECT` da Fase A comparam `hostname`
  exato (case-sensitive), mas o resto do sistema usa `UPPER(hostname)` —
  hostname chegando em case diferente cria um 2º job ativo pro mesmo
  `old_id`. Corrigido: índice único em `UPPER(hostname)`, Fase A usa
  `UPPER($1)` na checagem.
- Sem `rowCount` check depois do `UPDATE machines SET id=...` original —
  resolvido por construção no redesenho (o `UPDATE machines` virou
  `DELETE FROM machines WHERE id=$old_id`, e o código checa `rowCount`
  antes de prosseguir pro dedup).

**Novo desenho da Fase B** (substitui integralmente o `_finalizeRekey`
antigo — a Fase A muda só no que NÃO faz mais, ver abaixo):

- [ ] **Step 9**: migração nova adiciona `claimed_at TIMESTAMPTZ` e
  `attempts INTEGER NOT NULL DEFAULT 0` em `machine_rekey_queue`, e troca
  `idx_rekey_queue_hostname_active` pra `UNIQUE (UPPER(hostname)) WHERE
  status IN ('pending','processing')`
- [ ] **Step 10**: Fase A (`_rekeyAndMergeMachine`) para de mover
  QUALQUER tabela filha — só faz o UPDATE de estado na linha antiga
  (hostname/agent_version/last_seen/online_since/status) e o
  upsert idempotente na fila (agora comparando `UPPER(hostname)`).
  `MACHINE_REKEY_PHASE_A_TABLES` deixa de existir.
- [ ] **Step 11**: `_claimNextJob` vira atômico (`UPDATE ... WHERE id =
  (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`), seta `claimed_at =
  now()`. No início de `runCycleOnce`/`start()`, reset de jobs
  `processing` com `claimed_at` velho (> 5min) de volta pra `pending`
  (incrementando `attempts`); acima de `attempts >= 5`, marca `'failed'`
  em vez de `'pending'` (job para de ser reclamado; fica pra
  investigação manual — `'failed'` entra no CHECK constraint do Step 9).
- [ ] **Step 12**: novo passo, fora de transação, ANTES de qualquer
  outra coisa: clona a linha `old_id` pra `new_id` em `machines` — gera
  um token placeholder (`crypto.randomUUID()`), descobre as colunas
  reais de `machines` via `information_schema.columns` (nunca hardcoded
  — sobrevive a uma coluna nova no schema sem precisar mexer aqui),
  exclui `id`/`token` da lista, e roda `INSERT INTO machines (id, token,
  <demais colunas>) SELECT $1, $2, <demais colunas> FROM machines WHERE
  id=$3`. Se `old_id` já não existir (rowCount 0 — máquina apagada no
  meio da janela), marca o job `'done'` sem erro e sai (nada a fazer).
- [ ] **Step 13**: pré-processamento em lotes (`updateMachineIdInBatches`,
  fora de transação) para TODAS as tabelas filhas agora — as 10 com FK
  MAIS as 5 sem FK (`activity_log`/`nfce_index` incluídas, já que `new_id`
  agora existe em `machines` e o `UPDATE <t> SET machine_id=new WHERE
  machine_id=old` não dispara cascade nenhum, só respeita a FK
  normalmente). Nenhuma tabela fica de fora.
- [ ] **Step 14**: transação final curta, sob `pg_advisory_xact_lock
  (hashtext(upper(hostname)))`: `SELECT new_id FROM machine_rekey_queue
  WHERE id=$jobId` de novo (pega o valor mais recente, não o capturado no
  claim — cobre o Achado ALTO do claim); `SELECT * FROM machines WHERE
  id=$old_id FOR UPDATE` (trava a linha antiga só por esta transação
  curta); copia pra `new_id` os campos mutáveis mais recentes da linha
  antiga (token real, hostname, status, last_seen, online_since,
  agent_version — a lista completa, não um subconjunto); roda MAIS UM
  passe de `UPDATE <t> SET machine_id=new WHERE machine_id=old` (sem
  lotes — deve ser só o resíduo chegado durante a janela entre o Step 13
  e agora) nas 15 tabelas; processa duplicatas de hostname (mesma lógica
  de antes, com `rowCount` check); `DELETE FROM machines WHERE
  id=$old_id` (cascade agora vazio ou quase); marca o job `'done'`.
- [ ] **Step 15**: `routes/winEvents.js` e `_upsertServiceEntries`
  (`routes/agent.js`) passam a gravar com `machine.id`, nunca com o id
  do payload/params — mesmo quando `machine.pending_rekey_new_id` bateu
  com esse id pra fins de autorização.
- [ ] **Step 16**: reescrever os testes das Fases A/B (Steps 5-8 antigos
  ficam incorretos com o novo desenho — refletir o clone-and-swap) +
  teste novo cobrindo: heartbeat do MESMO agente não trava durante a
  Fase B (medir que o heartbeat completa em < 1s mesmo com a Fase B em
  andamento — usar uma tabela pequena como proxy, não precisa simular
  23GB de verdade); job preso em `'processing'` por > 5min é resetado
  pro próximo ciclo; `winEvents`/`service-status` gravam com `machine.id`
  durante a janela pendente, não com o id novo; `attempts` incrementa e
  o job vira `'failed'` depois de 5 tentativas.

## Task 5: Índice ausente + teto de timeout oficializado

- [ ] **Step 1**: `CREATE INDEX CONCURRENTLY idx_insights_machine_id ON
  insights (machine_id);` (achado na investigação do Plano 2 Task 3,
  mesma categoria de problema — FK sem índice)
- [ ] **Step 2**: documentar `statement_timeout=180000` como parte do
  provisionamento oficial do Postgres (script/README do projeto, não só
  um `az` rodado manualmente hoje) — pra sobreviver a um rebuild do
  servidor
- [ ] **Step 3**: considerar `idle_in_transaction_session_timeout`
  também (mesma categoria de proteção, pra transação que abre e nunca
  faz nada)

## Task 6: Monitoramento — nunca mais descobrir isso por acidente

- [ ] **Step 1**: um alerta (reaproveitar `resendAlert.js`, mesmo
  padrão do `rhHealthMonitor`) quando alguma transação ficar "active"
  por mais de N minutos (`pg_stat_activity` + `now()-xact_start`) —
  teria avisado sobre isso há dias, não só quando o healthz do Plano 1
  por acaso expôs o sintoma
- [ ] **Step 2**: o `/api/healthz` (Plano 1) já detecta o sintoma
  (timeout) — considerar enriquecer o corpo da resposta com o motivo
  quando for especificamente timeout de query vs banco genuinamente
  fora do ar (nice-to-have, não bloqueia o resto)

## Self-Review

**Cobertura**: a pergunta do André ("por que 59M linhas em 3 meses")
tem task própria (Task 1), não foi varrida pra debaixo do tapete. O
loop ativo das 9 máquinas tem task própria (Task 2, fix na origem, não
só sintoma). A correção estrutural que evita recorrência em QUALQUER
máquina futura (não só as 9 de hoje) é a Task 3 — essa é a que garante
"nunca mais aconteça de novo" que o André pediu, não só tratar o
sintoma de hoje.

**Proporção**: plano nasceu de investigação ao vivo, não de spec
prévia — tasks refletem exatamente o que foi encontrado, sem
especulação além do que os dados mostraram.

## Status final (28/11/2026) -- implementado, revisado, mergeado, deployado

Todas as 4 tasks implementadas via subagent-driven-development, 5 rodadas de revisao
independente (3 na Task 4, redesenho da Fase B em "clone-and-swap"; 2 na Task 6, monitor
de transacao longa) + 1 revisao final de branch inteiro (achou 2 ALTO novos, so visiveis
com as 4 tasks juntas -- ver PR) + 1 revisao de confirmacao do fix-wave resultante. PR
[#22](https://github.com/andreprol/delirio-manager/pull/22) mergeado em `master` e
deployado em producao no mesmo dia.

Validacao em producao aconteceu ao vivo, por acidente feliz: ao retomar o trabalho pra
seguir pro Plano 2, `/api/healthz` estava reportando `db:false`/timeout persistente.
Investigacao achou 9 transacoes simultaneas `UPDATE machines SET id=$1 WHERE id=$2`
travadas -- o EXATO codigo antigo que este plano corrige, reproduzindo o incidente
original ao vivo, no momento exato em que o fix (ja revisado, so nao deployado ainda)
estava disponivel. Migrations aplicadas manualmente em producao antes do merge, PR
mergeado, deploy automatico via `ci-server.yml` rodou, `/api/healthz` confirmado
`{"ok":true}` estavel. Detalhe completo da investigacao e do incidente na memoria:
`project_delirio_registermachine_rekey_fix.md`.
