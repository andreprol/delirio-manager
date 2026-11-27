# Eleição de Líder + Healthz Profundo — Plano 1/3 (base de aplicação)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o `server/` seguro pra rodar em 2 instâncias ativas ao
mesmo tempo — só o líder roda jobs de fundo (nunca duplicado), e existe
um endpoint de saúde que distingue "app travado" de "Postgres com
problema" (pré-requisito pro health probe do Load Balancer e pro agente
de vigilância dos próximos planos).

**Architecture:** Um módulo novo (`leaderElection.js`) mantém uma conexão
Postgres dedicada e disputa um advisory lock (`pg_try_advisory_lock`) —
quem conseguir é o líder enquanto aquela conexão ficar viva; se cair, o
Postgres libera o lock sozinho e a outra réplica assume no próximo
retry, sem necessidade de heartbeat/TTL manual. Todo job de fundo
existente passa a checar `isLeader()` antes de rodar. Um endpoint novo
(`/api/healthz`) faz um `SELECT 1` com timeout curto e responde 200/503
de forma que quem chama saiba se é o app ou o banco que está com
problema.

**Tech Stack:** Node.js, Express, `pg` (driver Postgres), Jest + Supertest
(mesmos já usados no `server/`).

**Spec:** [docs/superpowers/specs/2026-11-27-ha-watchdog-design.md](../specs/2026-11-27-ha-watchdog-design.md)
(seções "C. Sem efeito duplicado — eleição de líder" e health probe em
"B. Camada de computação")

## Global Constraints

- Nenhuma mudança de schema/migration — advisory lock não usa tabela
- `DATABASE_URL` é a mesma variável de ambiente já usada por `db-pg.js`
  (`new Pool({ connectionString: process.env.DATABASE_URL })`) — a
  conexão dedicada do leader election usa a mesma string
- Todo job gateado continua funcionando hoje sozinho (1 instância = 1
  líder sempre) — nenhuma mudança de comportamento observável até a 2ª
  VM existir de verdade (Plano 2)
- `/api/healthz` responde em até 2s mesmo com Postgres fora do ar
  (timeout próprio, nunca espera o timeout do driver `pg`)

## Review Focus

- **Postgres lento mas não totalmente fora** (query demora mais que o
  timeout, mas eventualmente responderia) — `/api/healthz` tem que
  responder 503 no prazo, não esperar a query terminar
- **Dois processos chamando `tryAcquire()` ao mesmo tempo** (startup
  simultâneo das 2 VMs) — só um pode virar líder; `pg_try_advisory_lock`
  já garante isso no Postgres, mas o teste precisa provar que o segundo
  `tryAcquire()` retorna `false` sem travar
- **Conexão dedicada do líder cai no meio da operação** (rede, restart
  do Postgres) — `isLeader()` tem que virar `false` depois disso, não
  ficar preso em `true` achando que ainda é líder
- **Job de fundo que já estava rodando quando deixa de ser líder** — fora
  de escopo resolver interrupção no meio de uma execução em andamento
  (jobs daqui são todos idempotentes/baseados em cron diário, não
  streaming); o que importa é a PRÓXIMA execução agendada checar
  `isLeader()` de novo, não assumir o estado antigo
- **`leaderElection` nunca chamado (`start()` esquecido no boot)** —
  `isLeader()` deve retornar `false` por padrão (fail-safe: nenhum job
  roda em vez de todos rodarem), nunca `true`/`undefined` tratado como
  verdadeiro

---

## Task 1: `leaderElection.js` — módulo central

**Files:**
- Create: `server/services/leaderElection.js`
- Test: `server/services/leaderElection.test.js`

**Interfaces:**
- Produces: `start(): void`, `stop(): Promise<void>`, `isLeader(): boolean`
  — é isso que as Tasks 3 e 4 (e os planos seguintes) importam.
  `require('../services/leaderElection')`.

- [ ] **Step 1: Escrever os testes que falham**

```js
// server/services/leaderElection.test.js
'use strict';

jest.mock('pg', () => ({ Client: jest.fn() }));
const { Client } = require('pg');

function makeFakeClient({ acquired = true } = {}) {
  const handlers = {};
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    query:   jest.fn().mockResolvedValue({ rows: [{ acquired }] }),
    end:     jest.fn().mockResolvedValue(undefined),
    on:      jest.fn((event, cb) => { handlers[event] = cb; }),
    _emit:   (event, ...args) => handlers[event]?.(...args),
  };
}

describe('leaderElection', () => {
  let leaderElection;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    leaderElection = require('./leaderElection');
  });

  afterEach(async () => {
    await leaderElection.stop();
    jest.useRealTimers();
  });

  it('isLeader() comeca false antes de start()', () => {
    expect(leaderElection.isLeader()).toBe(false);
  });

  it('vira lider quando pg_try_advisory_lock retorna true', async () => {
    const fake = makeFakeClient({ acquired: true });
    Client.mockImplementation(() => fake);

    leaderElection.start();
    await Promise.resolve(); // deixa a Promise interna do tryAcquire resolver
    await Promise.resolve();

    expect(leaderElection.isLeader()).toBe(true);
    expect(fake.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      expect.any(Array)
    );
  });

  it('nao vira lider quando pg_try_advisory_lock retorna false', async () => {
    const fake = makeFakeClient({ acquired: false });
    Client.mockImplementation(() => fake);

    leaderElection.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(leaderElection.isLeader()).toBe(false);
  });

  it('perde lideranca quando a conexao emite erro', async () => {
    const fake = makeFakeClient({ acquired: true });
    Client.mockImplementation(() => fake);

    leaderElection.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(leaderElection.isLeader()).toBe(true);

    fake._emit('error', new Error('connection lost'));
    expect(leaderElection.isLeader()).toBe(false);
  });

  it('stop() encerra a conexao e isLeader() volta a false', async () => {
    const fake = makeFakeClient({ acquired: true });
    Client.mockImplementation(() => fake);

    leaderElection.start();
    await Promise.resolve();
    await Promise.resolve();

    await leaderElection.stop();

    expect(fake.end).toHaveBeenCalled();
    expect(leaderElection.isLeader()).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest services/leaderElection.test.js`
Expected: FAIL — `Cannot find module './leaderElection'`

- [ ] **Step 3: Implementar `server/services/leaderElection.js`**

Exporta `{ start, stop, isLeader }`.

- `LOCK_KEY`: constante numérica fixa e arbitrária (ex. `915006`) —
  comentário dizendo que o único requisito é nunca reusar esse número
  pra outro `pg_advisory_lock` no mesmo banco.
- `RETRY_INTERVAL_MS = 30000` — de quanto em quanto tempo quem NÃO é
  líder tenta de novo.
- Estado interno do módulo: `client` (instância de `pg.Client` ou
  `null`), `leaderFlag` (boolean), `retryTimer`.
- `async function tryAcquire()`: se `client` for `null`, cria
  `new Client({ connectionString: process.env.DATABASE_URL })`,
  `await client.connect()`, registra `client.on('error', ...)` que
  seta `leaderFlag = false` e `client = null` (conexão morta não serve
  mais). Depois roda
  `const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [LOCK_KEY])`
  e seta `leaderFlag = rows[0].acquired === true`.
- `function start()`: chama `tryAcquire()` uma vez (não-bloqueante,
  `.catch` loga erro via `logger.error`), e arma
  `retryTimer = setInterval(..., RETRY_INTERVAL_MS)` que só chama
  `tryAcquire()` de novo quando `leaderFlag` for `false` (quem já é
  líder não precisa redisputar). `retryTimer.unref()`.
- `async function stop()`: `clearInterval(retryTimer)`; se `client`
  existir, `await client.end().catch(() => {})`; zera `client` e
  `leaderFlag = false`.
- `function isLeader()`: retorna `leaderFlag`.
- Usar `logger` de `./logger` (mesmo padrão de `rhHealthMonitor.js`)
  pra toda falha de `tryAcquire`/erro de conexão.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest services/leaderElection.test.js`
Expected: PASS (5 testes)

- [ ] **Step 5: Commit**

```bash
git add server/services/leaderElection.js server/services/leaderElection.test.js
git commit -m "feat(server): modulo de eleicao de lider via advisory lock do Postgres"
```

---

## Task 2: Ligar `leaderElection` no boot/shutdown do servidor

**Files:**
- Modify: `server/server.js` (onde o servidor sobe e onde o `SIGTERM`
  já chama `process.exit(0)` — mesmo ponto citado no builder-check desta
  spec, `server.js:283`/`:286`)

**Interfaces:**
- Consumes: `leaderElection.start()`, `leaderElection.stop()` (Task 1)

- [ ] **Step 1: Ler o `server.js` atual perto do boot e do handler de
  `SIGTERM`** pra achar os pontos exatos (não adivinhar — o arquivo já
  tem `server.listen(...)` e um handler de sinal existente, citado no
  builder-check).

- [ ] **Step 2: Adicionar `leaderElection.start()`** logo depois que o
  servidor confirma que está ouvindo (mesmo bloco onde outros serviços
  — `ncrMonitor.start()`, `rhHealthMonitor.start()` etc. — já são
  iniciados hoje, se for esse o padrão encontrado no Step 1; seguir o
  padrão existente, não inventar um novo).

- [ ] **Step 3: Adicionar `await leaderElection.stop()`** no handler de
  `SIGTERM`, antes do `process.exit(0)` — pra VM saindo de propósito
  (deploy) liberar o advisory lock rápido em vez de esperar o timeout de
  conexão do Postgres.

- [ ] **Step 4: Rodar a suíte completa do server pra confirmar que nada
  quebrou**

Run: `cd server && npx jest`
Expected: PASS (nenhum teste existente deve falhar)

- [ ] **Step 5: Commit**

```bash
git add server/server.js
git commit -m "feat(server): inicia e encerra eleicao de lider no boot/shutdown"
```

---

## Task 3: `GET /api/healthz` — health check profundo com timeout

**Files:**
- Create: `server/routes/healthz.js`
- Test: `server/routes/healthz.test.js`
- Modify: `server/app.js` (adicionar mount, junto dos outros
  `app.use('/api/...')` listados em `app.js:138-152`)

**Interfaces:**
- Consumes: `getPool` de `../db-pg` (já existe, `db-pg.js:117`)
- Produces: rota `GET /api/healthz` — `200 {"ok": true}` quando o
  Postgres responde dentro do timeout; `503 {"ok": false, "db": false,
  "error": "..."}` quando não responde ou estoura o timeout. Usada pelo
  health probe do Load Balancer (Plano 2) e pelo agente de vigilância
  (Plano 3) — ambos tratam "resposta HTTP qualquer" como "app vivo" e
  "sem resposta" como "app morto" (ver seção B do spec).

- [ ] **Step 1: Escrever o teste que falha**

```js
// server/routes/healthz.test.js
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../db-pg', () => ({ getPool: jest.fn() }));
const { getPool } = require('../db-pg');

function makeApp() {
  const router = require('./healthz');
  const app = express();
  app.use('/api/healthz', router);
  return app;
}

describe('GET /api/healthz', () => {
  it('200 { ok: true } quando o Postgres responde', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) });
    const res = await request(makeApp()).get('/api/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('503 { ok: false, db: false } quando a query rejeita', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockRejectedValue(new Error('connection refused')) });
    const res = await request(makeApp()).get('/api/healthz');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.db).toBe(false);
  });

  it('503 quando a query demora mais que o timeout (nao trava a resposta)', async () => {
    getPool.mockReturnValue({
      query: jest.fn(() => new Promise(() => {})), // nunca resolve
    });
    const res = await request(makeApp()).get('/api/healthz');
    expect(res.status).toBe(503);
  }, 5000);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest routes/healthz.test.js`
Expected: FAIL — `Cannot find module './healthz'`

- [ ] **Step 3: Implementar `server/routes/healthz.js`**

```js
'use strict';
const express = require('express');
const { getPool } = require('../db-pg');
const router = express.Router();

const DB_CHECK_TIMEOUT_MS = 2000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout apos ${ms}ms`)), ms)),
  ]);
}

router.get('/', async (req, res) => {
  try {
    await withTimeout(getPool().query('SELECT 1'), DB_CHECK_TIMEOUT_MS);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, db: false, error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: Rodar o teste da rota e confirmar que passa**

Run: `npx jest routes/healthz.test.js`
Expected: PASS (3 testes)

- [ ] **Step 5: Montar a rota em `server/app.js`**

Adicionar `const healthzRoutes = require('./routes/healthz');` junto
dos outros `require('./routes/...')` (`app.js:10-28`) e
`app.use('/api/healthz', healthzRoutes);` junto dos outros
`app.use('/api/...')` (`app.js:138-152`).

- [ ] **Step 6: Rodar a suíte completa do server**

Run: `cd server && npx jest`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/routes/healthz.js server/routes/healthz.test.js server/app.js
git commit -m "feat(server): endpoint GET /api/healthz com timeout proprio, distingue app vs banco"
```

---

## Task 4: Gatear todos os jobs de fundo existentes atrás de `isLeader()`

**Files:**
- Modify: `server/services/rhHealthMonitor.js` (worked example completo)
- Modify: `server/services/alertEngine.js`
- Modify: `server/services/insightEngine.js`
- Modify: `server/services/ncrMonitor.js`
- Modify: `server/services/serviceStatusEmail.js`
- Modify: `server/services/zamak.js`
- Modify: `server/services/activityRetention.js`
- Modify: `server/services/dbSizeMonitor.js`
- Test: o arquivo `.test.js` já existente de cada serviço acima ganha 1
  caso novo (mesmo padrão do worked example)

**Interfaces:**
- Consumes: `isLeader()` de `../services/leaderElection` (Task 1)

**Regra única, aplicada em todos os arquivos**: a checagem
`if (!leaderElection.isLeader()) return;` (ou `return;` equivalente em
função `async`) entra como **primeira linha da função que faz o
trabalho de verdade** — nunca na função que só agenda (`scheduleNext`,
`start`, `setInterval(...)`). Isso garante que tanto a chamada
imediata-no-boot quanto a recorrente agendada respeitem a liderança.

### Worked example completo — `rhHealthMonitor.js`

- [ ] **Step 1: Escrever o teste que falha** (adicionar em
  `server/services/rhHealthMonitor.test.js`)

```js
it('nao leva adiante o check quando nao e o lider', async () => {
  jest.doMock('./leaderElection', () => ({ isLeader: () => false }));
  jest.resetModules();
  const freshMonitor = require('./rhHealthMonitor');
  const sendAlertFresh = require('./resendAlert').sendAlert;

  mockServer = await startMock((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'CLOCK_PROXY_TOKEN nao configurado' }));
  });
  port = mockServer.address().port;

  await freshMonitor.start(port);
  await new Promise(r => setTimeout(r, 100));

  expect(sendAlertFresh).not.toHaveBeenCalled();
  freshMonitor.stop();
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest services/rhHealthMonitor.test.js -t "nao leva adiante"`
Expected: FAIL (hoje `checkOnce` roda sempre, ignora liderança)

- [ ] **Step 3: Implementar o guard em `server/services/rhHealthMonitor.js`**

No topo do arquivo, `const leaderElection = require('./leaderElection');`.
Na função `checkOnce(port)` (linha ~92), primeira linha do corpo:
`if (!leaderElection.isLeader()) return;`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest services/rhHealthMonitor.test.js`
Expected: PASS (todos os testes, incluindo o novo)

- [ ] **Step 5: Commit**

```bash
git add server/services/rhHealthMonitor.js server/services/rhHealthMonitor.test.js
git commit -m "feat(server): rhHealthMonitor so roda no lider"
```

### Tabela — repetir o mesmo padrão (guard + 1 teste análogo ao do Step 1-4 acima) nos demais arquivos

| Arquivo | Função(ões) que recebem o guard | Observação |
|---|---|---|
| `alertEngine.js` | `checkAll` (chamada dentro do `setInterval` em `alertEngine.js:36`) | função já nomeada, localizar sua definição no arquivo |
| `insightEngine.js` | `runNow` (chamada por `setInterval(runNow, ...)` em `insightEngine.js:28`) | |
| `ncrMonitor.js` | `tick` (chamada em `start()`, `ncrMonitor.js:688-691`) **e** o callback do `setInterval` de `startWatchdog()` (`ncrMonitor.js:77-79`, inline, sem nome — guard entra como 1ª linha de dentro do callback) | 2 pontos de guard nesse arquivo |
| `serviceStatusEmail.js` | corpo do callback do `setInterval` em `scheduleServiceStatusEmails` (`serviceStatusEmail.js:234-245`) — guard antes do `if (utcMin <= 1 ...)` | callback inline, sem nome |
| `zamak.js` | `syncIfStale` (chamada no startup em `scheduleDailySync`, `zamak.js:601`) **e** `runDailySync` (chamada dentro de `scheduleNext`, `zamak.js:614`) | 2 funções nesse arquivo |
| `activityRetention.js` | `runPurgeOnce`, `runCommandsPurgeOnce`, `runNcrXmlPurgeOnce` (as 3, chamadas tanto em `scheduleDailyPurge` quanto dentro de `scheduleNext`, `activityRetention.js:71-75` e `:79-86`) | 3 funções nesse arquivo |
| `dbSizeMonitor.js` | `runSnapshotOnce`, `runGrowthCheckOnce`, `runPurgeSnapshotsOnce` (mesmo padrão, `dbSizeMonitor.js:205-210` e `:217-222`) | 3 funções nesse arquivo |

- [ ] **Step 6: Pra cada linha da tabela** — escrever o teste análogo
  (mockando `./leaderElection` com `isLeader: () => false` e
  confirmando que o efeito observável do job — e-mail, insight gravado,
  snapshot gravado, etc. — não acontece), rodar pra confirmar que falha,
  implementar o guard, rodar pra confirmar que passa, commitar. Um
  commit por arquivo, mesma mensagem no padrão
  `feat(server): <nome do servico> so roda no lider`.

- [ ] **Step 7: Rodar a suíte inteira do server uma última vez**

Run: `cd server && npx jest`
Expected: PASS — nenhum teste existente quebrado, todos os novos
passando.

---

## Self-Review

**Cobertura do spec**: as duas peças da seção "C. Sem efeito duplicado"
e o health probe da seção "B" (parte de distinguir app-morto vs
banco-com-problema, já resolvida no builder-check) estão cobertas pelas
4 tasks. VPN Gateway, Load Balancer, 2ª VM e o Agente de Vigilância
ficam pros Planos 2 e 3 (este documento é só a base de aplicação, por
desenho — ver Scope Check da skill de planos).

**Consistência de tipos**: `isLeader()` retorna `boolean` em todo lugar
usado (Tasks 2, 4); `start()`/`stop()` sem argumento em todo lugar.

**Review Focus**: as 5 situações listadas no topo têm teste dedicado
(Postgres lento → Task 3 Step 1 terceiro teste; disputa simultânea →
Task 1 Step 1 segundo/terceiro teste; conexão cai → Task 1 Step 1 quarto
teste; job em andamento perdendo liderança → fora de escopo, anotado
explicitamente; `start()` nunca chamado → Task 1 Step 1 primeiro teste).

**Proporção**: a Task 4 evita repetir o mesmo bloco de teste 8 vezes —
mostra o padrão completo uma vez e usa tabela pras repetições
mecânicas, como pede a seção de proporcionalidade da skill.
