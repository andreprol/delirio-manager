# Acesso Remoto — Server (dados, watchlist, log de atividade, relay de sessão ao vivo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir, no `server/` do Delirio Manager, a base de dados + rotas HTTP + relay WebSocket
que suportam log de atividade pesquisável, screenshot sob gatilho de watchlist, e sessão ao vivo
(Normal/Shadow) — tudo testável via Jest/supertest sem precisar do agente real nem do dashboard.

**Architecture:** Segue os padrões já existentes no projeto: `db.js` concentra schema (migração
idempotente `CREATE TABLE IF NOT EXISTS`) e funções de acesso via `better-sqlite3`; cada rota é um
`express.Router()` em `routes/<nome>.js` montado em `app.js`; testes usam `jest.mock('../db')` +
`supertest` contra o router isolado (padrão visto em `routes/relatorio.generate.test.js`). A sessão
ao vivo usa um `WebSocketServer` novo em `/live` (mesma lib `ws` já usada em `/ws`), com um Map em
memória ligando `sessionId` ao par `companionWs`/`dashboardWs` — o ponto crítico de segurança
(sessão Shadow nunca repassa input) fica isolado num serviço próprio, testável sem rede real.

**Tech Stack:** Node.js, Express, better-sqlite3, `ws`, Jest + supertest.

---

## Referência — spec e decisões já fechadas

Ver `docs/superpowers/specs/2026-10-23-acesso-remoto-design.md`. Resumo do que este plano cobre:
- `activity_log` (texto, log de atividade), `watchlist_keywords` (CRUD), `live_sessions` (auditoria).
- Watchlist match = substring case-insensitive, sem regex.
- Screenshot sob gatilho reaproveita a fila de comando existente (`commands`), tipo `capture-screenshot`.
- Sessão ao vivo: `start-live-session`/`stop-live-session` como comandos pro agente; relay WS
  ponto-a-ponto por `sessionId`, nunca broadcast.
- Shadow nunca repassa input — bloqueio no relay do servidor, teste obrigatório.
- Auth: mesmo padrão `X-Admin-Secret` de `routes/machines.js` (`POST /:id/run`), não o
  `x-internal-key` (esse é só pros endpoints que chamam a API paga da Anthropic).
- Atrás de feature flag `FEATURE_LIVE_ACCESS` (convenção do `CLAUDE.md` do projeto).

---

### Task 1: Schema — tabelas novas em `db.js`

**Files:**
- Modify: `server/db.js` (dentro da função `migrate(db)`, perto do fim do bloco de `db.exec`)
- Test: `server/db.test.js` (criar — ainda não existe teste direto de `db.js` no projeto, mas é o
  jeito mais simples de confirmar que a migração roda sem erro e cria as tabelas certas)

- [ ] **Step 1: Escrever o teste que falha**

```js
// server/db.test.js
'use strict';

const fs   = require('fs');
const path = require('path');

describe('migração de schema — acesso remoto', () => {
  const TMP_DB = path.join(__dirname, 'data', 'test-migration.db');

  beforeEach(() => {
    jest.resetModules();
    fs.rmSync(TMP_DB, { force: true });
    fs.rmSync(TMP_DB + '-wal', { force: true });
    fs.rmSync(TMP_DB + '-shm', { force: true });
    process.env.DB_PATH = TMP_DB;
  });

  afterAll(() => {
    fs.rmSync(TMP_DB, { force: true });
    fs.rmSync(TMP_DB + '-wal', { force: true });
    fs.rmSync(TMP_DB + '-shm', { force: true });
    delete process.env.DB_PATH;
  });

  it('cria watchlist_keywords, activity_log e live_sessions', () => {
    const { getDb } = require('./db');
    const db = getDb();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('watchlist_keywords','activity_log','live_sessions')
    `).all().map(r => r.name).sort();
    expect(tables).toEqual(['activity_log', 'live_sessions', 'watchlist_keywords']);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `cd server && npx jest db.test.js`
Expected: FAIL — `tables` vem vazio (tabelas ainda não existem).

- [ ] **Step 3: Adicionar as tabelas na migração**

Em `server/db.js`, dentro de `migrate(db)`, logo antes do fechamento da template string do
`db.exec(...)` (depois do último `CREATE TABLE`/`CREATE INDEX` existente), adicionar:

```sql
    CREATE TABLE IF NOT EXISTS watchlist_keywords (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword    TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id    TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      window_title  TEXT NOT NULL DEFAULT '',
      process_name  TEXT NOT NULL DEFAULT '',
      captured_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_activity_log_machine_ts
      ON activity_log(machine_id, captured_at);

    CREATE TABLE IF NOT EXISTS watchlist_matches (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_log_id   INTEGER NOT NULL REFERENCES activity_log(id) ON DELETE CASCADE,
      keyword           TEXT NOT NULL,
      screenshot_blob   TEXT,
      matched_at        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_watchlist_matches_log
      ON watchlist_matches(activity_log_id);

    CREATE TABLE IF NOT EXISTS live_sessions (
      id         TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      mode       TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      recorded   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_live_sessions_machine
      ON live_sessions(machine_id, started_at);
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `cd server && npx jest db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/db.test.js
git commit -m "feat(server): schema de watchlist, activity_log e live_sessions"
```

---

### Task 2: `db.js` — funções de watchlist

**Files:**
- Modify: `server/db.js` (adicionar funções + exportá-las)
- Test: `server/db.test.js` (adicionar describe block)

- [ ] **Step 1: Escrever o teste que falha**

Adicionar em `server/db.test.js`, dentro do mesmo arquivo (reaproveita o `beforeEach`/`afterAll`
que já zera o banco de teste):

```js
describe('watchlist_keywords CRUD', () => {
  it('cria, lista, desativa e deleta uma keyword', () => {
    const db = require('./db');
    const id = db.createWatchlistKeyword('vaga de emprego');

    let all = db.getWatchlistKeywords();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id, keyword: 'vaga de emprego', active: 1 });

    db.setWatchlistKeywordActive(id, false);
    all = db.getWatchlistKeywords();
    expect(all[0].active).toBe(0);

    const active = db.getActiveWatchlistKeywords();
    expect(active).toHaveLength(0);

    db.deleteWatchlistKeyword(id);
    expect(db.getWatchlistKeywords()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest db.test.js -t "watchlist_keywords"`
Expected: FAIL — `db.createWatchlistKeyword is not a function`

- [ ] **Step 3: Implementar as funções**

Em `server/db.js`, adicionar perto das outras funções de CRUD simples (ex.: perto de
`createGroup`/`deleteGroup`):

```js
function createWatchlistKeyword(keyword) {
  const now = new Date().toISOString();
  const info = getDb().prepare(
    'INSERT INTO watchlist_keywords (keyword, active, created_at) VALUES (?, 1, ?)'
  ).run(keyword, now);
  return info.lastInsertRowid;
}

function getWatchlistKeywords() {
  return getDb().prepare('SELECT * FROM watchlist_keywords ORDER BY id DESC').all();
}

function getActiveWatchlistKeywords() {
  return getDb().prepare('SELECT * FROM watchlist_keywords WHERE active = 1').all();
}

function setWatchlistKeywordActive(id, active) {
  getDb().prepare('UPDATE watchlist_keywords SET active = ? WHERE id = ?')
    .run(active ? 1 : 0, id);
}

function deleteWatchlistKeyword(id) {
  getDb().prepare('DELETE FROM watchlist_keywords WHERE id = ?').run(id);
}
```

Adicionar ao final do `module.exports`, numa seção nova:

```js
  // acesso remoto — watchlist
  createWatchlistKeyword, getWatchlistKeywords, getActiveWatchlistKeywords,
  setWatchlistKeywordActive, deleteWatchlistKeyword,
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest db.test.js -t "watchlist_keywords"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/db.test.js
git commit -m "feat(server): CRUD de watchlist_keywords em db.js"
```

---

### Task 3: Rota `routes/watchlist.js`

**Files:**
- Create: `server/routes/watchlist.js`
- Create: `server/routes/watchlist.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// server/routes/watchlist.test.js
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../db', () => ({
  getWatchlistKeywords:      jest.fn(() => []),
  createWatchlistKeyword:    jest.fn(() => 1),
  setWatchlistKeywordActive: jest.fn(),
  deleteWatchlistKeyword:    jest.fn(),
}));

function makeApp() {
  const router = require('./watchlist');
  const app = express();
  app.use(express.json());
  app.use('/api/watchlist', router);
  return app;
}

describe('GET /api/watchlist', () => {
  it('lista as keywords', async () => {
    const db = require('../db');
    db.getWatchlistKeywords.mockReturnValue([{ id: 1, keyword: 'vaga', active: 1 }]);
    const app = makeApp();
    const res = await request(app).get('/api/watchlist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, keyword: 'vaga', active: 1 }]);
  });
});

describe('POST /api/watchlist', () => {
  it('400 quando keyword vazia', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/watchlist').send({ keyword: '   ' });
    expect(res.status).toBe(400);
  });

  it('201 e cria a keyword quando válida', async () => {
    const db = require('../db');
    const app = makeApp();
    const res = await request(app).post('/api/watchlist').send({ keyword: 'vaga de emprego' });
    expect(res.status).toBe(201);
    expect(db.createWatchlistKeyword).toHaveBeenCalledWith('vaga de emprego');
  });
});

describe('PUT /api/watchlist/:id', () => {
  it('ativa/desativa a keyword', async () => {
    const db = require('../db');
    const app = makeApp();
    const res = await request(app).put('/api/watchlist/1').send({ active: false });
    expect(res.status).toBe(200);
    expect(db.setWatchlistKeywordActive).toHaveBeenCalledWith('1', false);
  });
});

describe('DELETE /api/watchlist/:id', () => {
  it('remove a keyword', async () => {
    const db = require('../db');
    const app = makeApp();
    const res = await request(app).delete('/api/watchlist/1');
    expect(res.status).toBe(200);
    expect(db.deleteWatchlistKeyword).toHaveBeenCalledWith('1');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest routes/watchlist.test.js`
Expected: FAIL — `Cannot find module './watchlist'`

- [ ] **Step 3: Implementar a rota**

```js
// server/routes/watchlist.js
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/watchlist
router.get('/', (req, res) => {
  res.json(db.getWatchlistKeywords());
});

// POST /api/watchlist  { keyword: "vaga de emprego" }
router.post('/', (req, res) => {
  const { keyword } = req.body;
  if (!keyword || !keyword.trim()) {
    return res.status(400).json({ error: 'keyword e obrigatoria' });
  }
  const id = db.createWatchlistKeyword(keyword.trim());
  res.status(201).json({ ok: true, id, keyword: keyword.trim() });
});

// PUT /api/watchlist/:id  { active: true|false }
router.put('/:id', (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active deve ser boolean' });
  }
  db.setWatchlistKeywordActive(req.params.id, active);
  res.json({ ok: true });
});

// DELETE /api/watchlist/:id
router.delete('/:id', (req, res) => {
  db.deleteWatchlistKeyword(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest routes/watchlist.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes/watchlist.js server/routes/watchlist.test.js
git commit -m "feat(server): rota CRUD de watchlist"
```

---

### Task 4: `services/watchlistMatcher.js` — matching puro

**Files:**
- Create: `server/services/watchlistMatcher.js`
- Create: `server/services/watchlistMatcher.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// server/services/watchlistMatcher.test.js
'use strict';

const { findMatch } = require('./watchlistMatcher');

describe('findMatch', () => {
  const keywords = [
    { id: 1, keyword: 'vaga de emprego' },
    { id: 2, keyword: 'LinkedIn' },
  ];

  it('acha match case-insensitive no título da janela', () => {
    const result = findMatch('Vagas de Emprego - LinkedIn - Google Chrome', keywords);
    expect(result).toEqual({ id: 1, keyword: 'vaga de emprego' });
  });

  it('retorna null quando não bate nenhuma keyword', () => {
    const result = findMatch('Planilha de custos - Excel', keywords);
    expect(result).toBeNull();
  });

  it('retorna null quando a lista de keywords está vazia', () => {
    expect(findMatch('qualquer coisa', [])).toBeNull();
  });

  it('ignora keyword vazia na lista sem quebrar', () => {
    const result = findMatch('tela qualquer', [{ id: 3, keyword: '' }]);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest services/watchlistMatcher.test.js`
Expected: FAIL — `Cannot find module './watchlistMatcher'`

- [ ] **Step 3: Implementar**

```js
// server/services/watchlistMatcher.js
'use strict';

// Match por substring, case-insensitive, sem regex (YAGNI — ver spec 2026-10-23).
function findMatch(text, keywords) {
  if (!text || !keywords || keywords.length === 0) return null;
  const haystack = text.toLowerCase();
  for (const k of keywords) {
    if (!k.keyword || !k.keyword.trim()) continue;
    if (haystack.includes(k.keyword.toLowerCase())) {
      return { id: k.id, keyword: k.keyword };
    }
  }
  return null;
}

module.exports = { findMatch };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest services/watchlistMatcher.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/watchlistMatcher.js server/services/watchlistMatcher.test.js
git commit -m "feat(server): matcher puro de watchlist (substring case-insensitive)"
```

---

### Task 5: `db.js` — funções de activity log

**Files:**
- Modify: `server/db.js`
- Modify: `server/db.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
describe('activity_log', () => {
  it('insere e lista por máquina, mais recente primeiro', () => {
    const db = require('./db');
    db.createMachine_forTest(); // ver nota abaixo
  });
});
```

> Nota: pra este teste não depender de criar uma máquina completa, inserir direto a linha de
> `machines` necessária via SQL cru dentro do próprio teste (não existe helper
> `createMachine_forTest` no projeto — usar `getDb()` e `INSERT INTO machines` manual). Escrever
> assim:

```js
describe('activity_log', () => {
  function insertTestMachine(db, id) {
    const now = new Date().toISOString();
    db.getDb().prepare(`
      INSERT INTO machines (id, hostname, token, registered_at)
      VALUES (?, 'TESTE', ?, ?)
    `).run(id, 'token-' + id, now);
  }

  it('insere e lista por máquina, mais recente primeiro', () => {
    const db = require('./db');
    insertTestMachine(db, 'm1');

    db.insertActivityLog('m1', 'Excel - planilha.xlsx', 'EXCEL.EXE');
    db.insertActivityLog('m1', 'Vagas - LinkedIn', 'chrome.exe');

    const rows = db.getActivityLog('m1', 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].window_title).toBe('Vagas - LinkedIn');
    expect(rows[1].window_title).toBe('Excel - planilha.xlsx');
  });

  it('purgeActivityLog remove linhas mais antigas que N dias', () => {
    const db = require('./db');
    insertTestMachine(db, 'm2');
    const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.getDb().prepare(
      'INSERT INTO activity_log (machine_id, window_title, process_name, captured_at) VALUES (?,?,?,?)'
    ).run('m2', 'janela antiga', 'app.exe', oldTs);
    db.insertActivityLog('m2', 'janela recente', 'app.exe');

    const removed = db.purgeActivityLog(90);
    expect(removed).toBe(1);
    expect(db.getActivityLog('m2', 10)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest db.test.js -t "activity_log"`
Expected: FAIL — `db.insertActivityLog is not a function`

- [ ] **Step 3: Implementar**

```js
function insertActivityLog(machineId, windowTitle, processName) {
  const now = new Date().toISOString();
  const info = getDb().prepare(`
    INSERT INTO activity_log (machine_id, window_title, process_name, captured_at)
    VALUES (?, ?, ?, ?)
  `).run(machineId, windowTitle || '', processName || '', now);
  return { id: info.lastInsertRowid, capturedAt: now };
}

function getActivityLog(machineId, limit = 100) {
  return getDb().prepare(`
    SELECT * FROM activity_log WHERE machine_id = ?
    ORDER BY captured_at DESC LIMIT ?
  `).all(machineId, limit);
}

function purgeActivityLog(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const info = getDb().prepare('DELETE FROM activity_log WHERE captured_at < ?').run(cutoff);
  return info.changes;
}
```

Adicionar ao `module.exports`:

```js
  // acesso remoto — activity log
  insertActivityLog, getActivityLog, purgeActivityLog,
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest db.test.js -t "activity_log"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/db.test.js
git commit -m "feat(server): activity_log — insert, list, purge 90 dias"
```

---

### Task 6: Rota `routes/activity.js` — ingestão + gatilho de watchlist

**Files:**
- Create: `server/routes/activity.js`
- Create: `server/routes/activity.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// server/routes/activity.test.js
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../db', () => ({
  getMachineByToken:        jest.fn(),
  insertActivityLog:        jest.fn(() => ({ id: 42, capturedAt: '2026-10-23T12:00:00.000Z' })),
  getActiveWatchlistKeywords: jest.fn(() => []),
  createCommand:            jest.fn(() => 'cmd-id-1'),
}));

function makeApp() {
  const router = require('./activity');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

describe('POST /api/activity', () => {
  it('401 com token inválido', async () => {
    const db = require('../db');
    db.getMachineByToken.mockReturnValue(null);
    const app = makeApp();
    const res = await request(app).post('/api/activity')
      .send({ machineId: 'm1', token: 'xxx', windowTitle: 'Chrome', processName: 'chrome.exe' });
    expect(res.status).toBe(401);
  });

  it('400 quando falta machineId/token', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/activity').send({ windowTitle: 'Chrome' });
    expect(res.status).toBe(400);
  });

  it('salva o log e não dispara comando quando não bate watchlist', async () => {
    const db = require('../db');
    db.getMachineByToken.mockReturnValue({ id: 'm1' });
    db.getActiveWatchlistKeywords.mockReturnValue([{ id: 1, keyword: 'vaga' }]);
    const app = makeApp();

    const res = await request(app).post('/api/activity')
      .send({ machineId: 'm1', token: 'tok', windowTitle: 'Excel', processName: 'EXCEL.EXE' });

    expect(res.status).toBe(200);
    expect(db.insertActivityLog).toHaveBeenCalledWith('m1', 'Excel', 'EXCEL.EXE');
    expect(db.createCommand).not.toHaveBeenCalled();
  });

  it('dispara capture-screenshot quando bate a watchlist', async () => {
    const db = require('../db');
    db.getMachineByToken.mockReturnValue({ id: 'm1' });
    db.getActiveWatchlistKeywords.mockReturnValue([{ id: 1, keyword: 'vaga' }]);
    const app = makeApp();

    const res = await request(app).post('/api/activity')
      .send({ machineId: 'm1', token: 'tok', windowTitle: 'Vagas - LinkedIn', processName: 'chrome.exe' });

    expect(res.status).toBe(200);
    expect(db.createCommand).toHaveBeenCalledWith('m1', 'capture-screenshot', { activityLogId: 42 });
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest routes/activity.test.js`
Expected: FAIL — `Cannot find module './activity'`

- [ ] **Step 3: Implementar**

```js
// server/routes/activity.js
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { findMatch } = require('../services/watchlistMatcher');

// POST /api/activity — ingestão do companion (título de janela + processo)
router.post('/activity', (req, res) => {
  const { machineId, token, windowTitle, processName } = req.body;

  if (!machineId || !token) {
    return res.status(400).json({ error: 'machineId e token são obrigatórios' });
  }

  const machine = db.getMachineByToken(token);
  if (!machine || machine.id !== machineId) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const { id: activityLogId } = db.insertActivityLog(machineId, windowTitle || '', processName || '');

  const keywords = db.getActiveWatchlistKeywords();
  const match = findMatch(`${windowTitle || ''} ${processName || ''}`, keywords);
  if (match) {
    db.createCommand(machineId, 'capture-screenshot', { activityLogId });
  }

  res.json({ ok: true, activityLogId, matched: !!match });
});

module.exports = router;
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest routes/activity.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes/activity.js server/routes/activity.test.js
git commit -m "feat(server): ingestão de activity log + gatilho de screenshot por watchlist"
```

---

### Task 7: `db.js` — funções de live session

**Files:**
- Modify: `server/db.js`
- Modify: `server/db.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
describe('live_sessions', () => {
  function insertTestMachine(db, id) {
    const now = new Date().toISOString();
    db.getDb().prepare(`
      INSERT INTO machines (id, hostname, token, registered_at)
      VALUES (?, 'TESTE', ?, ?)
    `).run(id, 'token-' + id, now);
  }

  it('cria, encerra e marca gravação', () => {
    const db = require('./db');
    insertTestMachine(db, 'm3');

    const sessionId = db.createLiveSession('m3', 'shadow');
    expect(typeof sessionId).toBe('string');

    let session = db.getLiveSession(sessionId);
    expect(session.mode).toBe('shadow');
    expect(session.ended_at).toBeNull();

    db.setLiveSessionRecorded(sessionId);
    db.endLiveSession(sessionId);

    session = db.getLiveSession(sessionId);
    expect(session.recorded).toBe(1);
    expect(session.ended_at).not.toBeNull();
  });

  it('rejeita mode inválido', () => {
    const db = require('./db');
    insertTestMachine(db, 'm4');
    expect(() => db.createLiveSession('m4', 'invalido')).toThrow();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest db.test.js -t "live_sessions"`
Expected: FAIL — `db.createLiveSession is not a function`

- [ ] **Step 3: Implementar**

```js
function createLiveSession(machineId, mode) {
  if (mode !== 'normal' && mode !== 'shadow') {
    throw new Error(`mode inválido: ${mode}`);
  }
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO live_sessions (id, machine_id, mode, started_at)
    VALUES (?, ?, ?, ?)
  `).run(id, machineId, mode, now);
  return id;
}

function getLiveSession(sessionId) {
  return getDb().prepare('SELECT * FROM live_sessions WHERE id = ?').get(sessionId);
}

function endLiveSession(sessionId) {
  const now = new Date().toISOString();
  getDb().prepare('UPDATE live_sessions SET ended_at = ? WHERE id = ?').run(now, sessionId);
}

function setLiveSessionRecorded(sessionId) {
  getDb().prepare('UPDATE live_sessions SET recorded = 1 WHERE id = ?').run(sessionId);
}
```

Adicionar ao `module.exports`:

```js
  // acesso remoto — live sessions
  createLiveSession, getLiveSession, endLiveSession, setLiveSessionRecorded,
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest db.test.js -t "live_sessions"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/db.test.js
git commit -m "feat(server): live_sessions — create/get/end/setRecorded"
```

---

### Task 8: `services/liveSessionRelay.js` — estado em memória + bloqueio de input em Shadow

Este é o serviço central de segurança da feature. Fica separado da camada de WebSocket/HTTP pra
ser testável sem precisar abrir socket real.

**Files:**
- Create: `server/services/liveSessionRelay.js`
- Create: `server/services/liveSessionRelay.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// server/services/liveSessionRelay.test.js
'use strict';

const {
  registerSession, getSession, unregisterSession, routeMessage,
} = require('./liveSessionRelay');

function fakeSocket() {
  const sent = [];
  return { send: (data) => sent.push(data), _sent: sent, readyState: 1, OPEN: 1 };
}

describe('liveSessionRelay', () => {
  afterEach(() => unregisterSession('s1'));

  it('registra e recupera uma sessão', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc' });
    const session = getSession('s1');
    expect(session.machineId).toBe('m1');
    expect(session.mode).toBe('normal');
  });

  it('Normal: input do dashboard é repassado pro companion', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc' });
    const companionWs = fakeSocket();
    const session = getSession('s1');
    session.companionWs = companionWs;

    routeMessage('s1', 'dashboard', JSON.stringify({ type: 'input', key: 'a' }));

    expect(companionWs._sent).toHaveLength(1);
  });

  it('Shadow: input do dashboard NUNCA é repassado pro companion', () => {
    registerSession('s1', { machineId: 'm1', mode: 'shadow', companionToken: 'tok-abc' });
    const companionWs = fakeSocket();
    const session = getSession('s1');
    session.companionWs = companionWs;

    routeMessage('s1', 'dashboard', JSON.stringify({ type: 'input', key: 'a' }));

    expect(companionWs._sent).toHaveLength(0);
  });

  it('frame de vídeo do companion é sempre repassado pro dashboard, nos dois modos', () => {
    registerSession('s1', { machineId: 'm1', mode: 'shadow', companionToken: 'tok-abc' });
    const dashboardWs = fakeSocket();
    const session = getSession('s1');
    session.dashboardWs = dashboardWs;

    routeMessage('s1', 'companion', Buffer.from([1, 2, 3]));

    expect(dashboardWs._sent).toHaveLength(1);
  });

  it('unregisterSession remove a sessão', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc' });
    unregisterSession('s1');
    expect(getSession('s1')).toBeUndefined();
  });

  it('routeMessage em sessão inexistente não lança erro', () => {
    expect(() => routeMessage('nao-existe', 'dashboard', 'x')).not.toThrow();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest services/liveSessionRelay.test.js`
Expected: FAIL — `Cannot find module './liveSessionRelay'`

- [ ] **Step 3: Implementar**

```js
// server/services/liveSessionRelay.js
'use strict';

// Estado em memória das sessões ao vivo ativas. Não persiste — histórico/auditoria
// fica em db.js (tabela live_sessions). Ver spec 2026-10-23: Shadow nunca repassa
// input, mesmo que o dashboard mande por engano/bug — bloqueio aqui, não só na UI.

const sessions = new Map();

function registerSession(sessionId, { machineId, mode, companionToken }) {
  sessions.set(sessionId, {
    machineId, mode, companionToken,
    companionWs: null,
    dashboardWs: null,
  });
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function unregisterSession(sessionId) {
  sessions.delete(sessionId);
}

// origin: 'dashboard' | 'companion'
function routeMessage(sessionId, origin, data) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (origin === 'companion') {
    // Frame de vídeo (ou qualquer mensagem do companion) — sempre repassa pro dashboard,
    // em qualquer modo. Quem está vendo a tela sempre recebe a imagem.
    if (session.dashboardWs && session.dashboardWs.readyState === session.dashboardWs.OPEN) {
      session.dashboardWs.send(data);
    }
    return;
  }

  // origin === 'dashboard'
  if (session.mode !== 'normal') return; // Shadow: descarta qualquer input, sempre.
  if (session.companionWs && session.companionWs.readyState === session.companionWs.OPEN) {
    session.companionWs.send(data);
  }
}

module.exports = { registerSession, getSession, unregisterSession, routeMessage };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest services/liveSessionRelay.test.js`
Expected: PASS — inclui o teste crítico de bloqueio de input em Shadow.

- [ ] **Step 5: Commit**

```bash
git add server/services/liveSessionRelay.js server/services/liveSessionRelay.test.js
git commit -m "feat(server): liveSessionRelay — estado em memória + bloqueio de input em Shadow"
```

---

### Task 9: WebSocketServer em `/live` — wiring real

Conecta o serviço do Task 8 a um `WebSocketServer` de verdade, mesmo padrão de
`server/services/websocket.js` (que já roda em `/ws`).

**Files:**
- Modify: `server/services/liveSessionRelay.js` (adicionar `initLiveRelay`)
- Modify: `server/server.js` (chamar `initLiveRelay(server)`)
- Test: `server/services/liveSessionRelay.test.js` (adicionar describe block)

- [ ] **Step 1: Escrever o teste que falha**

```js
describe('initLiveRelay — conexão real', () => {
  const http = require('http');
  const WebSocket = require('ws');
  const { registerSession, initLiveRelay, unregisterSession } = require('./liveSessionRelay');

  let server;
  let port;

  beforeAll((done) => {
    server = http.createServer();
    initLiveRelay(server);
    server.listen(0, () => { port = server.address().port; done(); });
  });

  afterAll((done) => { server.close(done); });
  afterEach(() => unregisterSession('s-real'));

  it('companion autenticado consegue conectar e dashboard recebe o frame', (done) => {
    registerSession('s-real', { machineId: 'm1', mode: 'shadow', companionToken: 'tok-123' });

    const dashboardWs = new WebSocket(`ws://localhost:${port}/live?sessionId=s-real&role=dashboard`);
    dashboardWs.on('message', (data) => {
      expect(data.toString()).toBe('frame-de-teste');
      dashboardWs.close();
      companionWs.close();
      done();
    });

    dashboardWs.on('open', () => {
      const companionWs = new WebSocket(
        `ws://localhost:${port}/live?sessionId=s-real&role=companion&token=tok-123`
      );
      companionWs.on('open', () => companionWs.send('frame-de-teste'));
      this.companionWs = companionWs; // acessível no escopo externo via closure abaixo
    });

    var companionWs; // eslint-disable-line no-var
  });

  it('companion com token errado é desconectado', (done) => {
    registerSession('s-real', { machineId: 'm1', mode: 'shadow', companionToken: 'tok-correto' });
    const ws = new WebSocket(`ws://localhost:${port}/live?sessionId=s-real&role=companion&token=errado`);
    ws.on('close', (code) => {
      expect(code).toBe(4001);
      done();
    });
  });
});
```

> Nota de implementação do teste: o primeiro teste usa `var companionWs` fora do `done()` por
> limitação de closure do callback do `ws` — escrever exatamente como acima, sem reestruturar.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest services/liveSessionRelay.test.js -t "initLiveRelay"`
Expected: FAIL — `initLiveRelay is not a function`

- [ ] **Step 3: Implementar `initLiveRelay`**

Adicionar em `server/services/liveSessionRelay.js`, antes do `module.exports`:

```js
const { WebSocketServer } = require('ws');
const { URL } = require('url');

function initLiveRelay(server) {
  const wss = new WebSocketServer({ server, path: '/live' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const role       = url.searchParams.get('role');
    const token      = url.searchParams.get('token');

    const session = sessions.get(sessionId);
    if (!session) {
      ws.close(4000, 'sessão inexistente');
      return;
    }

    if (role === 'companion') {
      if (token !== session.companionToken) {
        ws.close(4001, 'token inválido');
        return;
      }
      session.companionWs = ws;
    } else if (role === 'dashboard') {
      session.dashboardWs = ws;
    } else {
      ws.close(4002, 'role inválido');
      return;
    }

    ws.on('message', (data) => routeMessage(sessionId, role, data));
    ws.on('close', () => {
      if (role === 'companion' && session.companionWs === ws) session.companionWs = null;
      if (role === 'dashboard' && session.dashboardWs === ws) session.dashboardWs = null;
    });
  });

  return wss;
}
```

Atualizar o `module.exports` do arquivo:

```js
module.exports = {
  registerSession, getSession, unregisterSession, routeMessage, initLiveRelay,
};
```

Em `server/server.js`, logo depois da linha `initWebSocket(server);`:

```js
const { initLiveRelay } = require('./services/liveSessionRelay');
initLiveRelay(server);
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest services/liveSessionRelay.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/liveSessionRelay.js server/server.js
git commit -m "feat(server): WebSocketServer real em /live, autenticação do companion por token"
```

---

### Task 10: Rota `routes/live.js` — start/stop de sessão

**Files:**
- Create: `server/routes/live.js`
- Create: `server/routes/live.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// server/routes/live.test.js
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../db', () => ({
  getMachineById:      jest.fn(),
  createLiveSession:   jest.fn(() => 'session-1'),
  getLiveSession:      jest.fn(),
  endLiveSession:      jest.fn(),
  setLiveSessionRecorded: jest.fn(),
  createCommand:       jest.fn(() => 'cmd-1'),
}));

jest.mock('../services/liveSessionRelay', () => ({
  registerSession:   jest.fn(),
  unregisterSession: jest.fn(),
  getSession:        jest.fn(),
}));

function makeApp() {
  process.env.ADMIN_SECRET_FOR_TEST = 'segredo-123';
  jest.doMock('../routes/live.js.config', () => ({}), { virtual: true });
  const router = require('./live');
  const app = express();
  app.use(express.json());
  app.use('/api/live', router);
  return app;
}

const ORIGINAL_SECRET = process.env.ADMIN_SECRET;
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIGINAL_SECRET;
});

describe('POST /api/live/:machineId/start', () => {
  it('401 sem X-Admin-Secret', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const app = makeApp();
    const res = await request(app).post('/api/live/m1/start').send({ mode: 'shadow' });
    expect(res.status).toBe(401);
  });

  it('400 com mode inválido', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const db = require('../db');
    db.getMachineById.mockReturnValue({ id: 'm1' });
    const app = makeApp();
    const res = await request(app).post('/api/live/m1/start')
      .set('x-admin-secret', 'segredo-123')
      .send({ mode: 'turbo' });
    expect(res.status).toBe(400);
  });

  it('404 quando a máquina não existe', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const db = require('../db');
    db.getMachineById.mockReturnValue(null);
    const app = makeApp();
    const res = await request(app).post('/api/live/m1/start')
      .set('x-admin-secret', 'segredo-123')
      .send({ mode: 'shadow' });
    expect(res.status).toBe(404);
  });

  it('200 e cria sessão + comando pro agente', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const db = require('../db');
    const relay = require('../services/liveSessionRelay');
    db.getMachineById.mockReturnValue({ id: 'm1' });
    const app = makeApp();

    const res = await request(app).post('/api/live/m1/start')
      .set('x-admin-secret', 'segredo-123')
      .send({ mode: 'normal' });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('session-1');
    expect(relay.registerSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
      machineId: 'm1', mode: 'normal',
    }));
    expect(db.createCommand).toHaveBeenCalledWith('m1', 'start-live-session', expect.objectContaining({
      sessionId: 'session-1', mode: 'normal',
    }));
  });
});

describe('POST /api/live/:sessionId/stop', () => {
  it('404 quando a sessão não existe', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const db = require('../db');
    db.getLiveSession.mockReturnValue(null);
    const app = makeApp();
    const res = await request(app).post('/api/live/session-x/stop')
      .set('x-admin-secret', 'segredo-123')
      .send({});
    expect(res.status).toBe(404);
  });

  it('200, encerra sessão e envia comando de stop', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const db = require('../db');
    db.getLiveSession.mockReturnValue({ id: 'session-1', machine_id: 'm1', ended_at: null });
    const app = makeApp();

    const res = await request(app).post('/api/live/session-1/stop')
      .set('x-admin-secret', 'segredo-123')
      .send({ recorded: true });

    expect(res.status).toBe(200);
    expect(db.setLiveSessionRecorded).toHaveBeenCalledWith('session-1');
    expect(db.endLiveSession).toHaveBeenCalledWith('session-1');
    expect(db.createCommand).toHaveBeenCalledWith('m1', 'stop-live-session', { sessionId: 'session-1' });
  });
});
```

> Nota: o `jest.doMock('../routes/live.js.config', ...)` da função `makeApp` é lixo de rascunho —
> **não incluir essa linha**. `makeApp` deve só fazer `require('./live')` e montar o router, igual
> ao padrão dos outros testes de rota deste plano.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest routes/live.test.js`
Expected: FAIL — `Cannot find module './live'`

- [ ] **Step 3: Implementar**

```js
// server/routes/live.js
'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../db');
const relay   = require('../services/liveSessionRelay');

function loadAdminSecret() {
  if (process.env.ADMIN_SECRET) return process.env.ADMIN_SECRET;
  try {
    const fs   = require('fs');
    const path = require('path');
    const cfg  = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return cfg.adminSecret || null;
  } catch {
    return null;
  }
}

function adminAuth(req, res, next) {
  const secret = loadAdminSecret();
  if (!secret || req.headers['x-admin-secret'] !== secret) {
    return res.status(401).json({ error: 'X-Admin-Secret inválido ou não configurado' });
  }
  next();
}

// POST /api/live/:machineId/start  { mode: 'normal'|'shadow' }
router.post('/:machineId/start', adminAuth, (req, res) => {
  const { mode } = req.body;
  if (mode !== 'normal' && mode !== 'shadow') {
    return res.status(400).json({ error: "mode deve ser 'normal' ou 'shadow'" });
  }

  const machine = db.getMachineById(req.params.machineId);
  if (!machine) {
    return res.status(404).json({ error: 'Máquina não encontrada' });
  }

  const sessionId      = db.createLiveSession(machine.id, mode);
  const companionToken = crypto.randomBytes(32).toString('hex');

  relay.registerSession(sessionId, { machineId: machine.id, mode, companionToken });
  db.createCommand(machine.id, 'start-live-session', { sessionId, mode, companionToken });

  res.json({ ok: true, sessionId, mode });
});

// POST /api/live/:sessionId/stop  { recorded?: boolean }
router.post('/:sessionId/stop', adminAuth, (req, res) => {
  const session = db.getLiveSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }

  if (req.body && req.body.recorded) {
    db.setLiveSessionRecorded(session.id);
  }
  db.endLiveSession(session.id);
  relay.unregisterSession(session.id);
  db.createCommand(session.machine_id, 'stop-live-session', { sessionId: session.id });

  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest routes/live.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes/live.js server/routes/live.test.js
git commit -m "feat(server): rotas de start/stop de sessão ao vivo"
```

---

### Task 11: Montar rotas em `app.js` atrás da feature flag

**Files:**
- Modify: `server/app.js`

- [ ] **Step 1: Escrever o teste que falha**

Adicionar em `server/app.test.js` (no describe de rotas montadas, perto de onde outras rotas são
testadas por presença — se não existir um describe assim, criar um novo bloco no final do
arquivo, antes do último `});`):

```js
describe('feature flag FEATURE_LIVE_ACCESS', () => {
  const ORIGINAL = process.env.FEATURE_LIVE_ACCESS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FEATURE_LIVE_ACCESS;
    else process.env.FEATURE_LIVE_ACCESS = ORIGINAL;
  });

  it('404 em /api/live/* quando a flag está desligada', async () => {
    delete process.env.FEATURE_LIVE_ACCESS;
    jest.resetModules();
    const request = require('supertest');
    const app = require('./app');
    const res = await request(app).post('/api/live/m1/start').send({ mode: 'shadow' });
    expect(res.status).toBe(404);
  });

  it('rota existe quando a flag está ligada (não 404)', async () => {
    process.env.FEATURE_LIVE_ACCESS = 'true';
    jest.resetModules();
    const request = require('supertest');
    const app = require('./app');
    const res = await request(app).post('/api/live/m1/start').send({ mode: 'shadow' });
    expect(res.status).not.toBe(404);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest app.test.js -t "FEATURE_LIVE_ACCESS"`
Expected: FAIL — ambos retornam 404 (rota ainda não existe)

- [ ] **Step 3: Montar as rotas em `app.js`**

Em `server/app.js`, adicionar nos `require` do topo (perto dos outros `const xxxRoutes = require(...)`):

```js
const watchlistRoutes = require('./routes/watchlist');
const activityRoutes  = require('./routes/activity');
const liveRoutes      = require('./routes/live');
```

E na seção `// ── Rotas ──`, adicionar:

```js
if (process.env.FEATURE_LIVE_ACCESS === 'true') {
  app.use('/api/watchlist', watchlistRoutes);
  app.use('/api',           activityRoutes);
  app.use('/api/live',      liveRoutes);
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest app.test.js -t "FEATURE_LIVE_ACCESS"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/app.js server/app.test.js
git commit -m "feat(server): monta rotas de acesso remoto atrás de FEATURE_LIVE_ACCESS"
```

---

### Task 12: Scheduler de retenção (purge 90 dias)

Segue o mesmo padrão de scheduler diário já usado no projeto (`_scheduleWalCheckpoint` em
`db.js`/`server.js`).

**Files:**
- Create: `server/services/activityRetention.js`
- Create: `server/services/activityRetention.test.js`
- Modify: `server/server.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// server/services/activityRetention.test.js
'use strict';

jest.mock('../db', () => ({
  purgeActivityLog: jest.fn(() => 3),
}));

const { runPurgeOnce } = require('./activityRetention');

describe('runPurgeOnce', () => {
  it('chama purgeActivityLog com 90 dias e retorna quantas linhas removeu', () => {
    const db = require('../db');
    const removed = runPurgeOnce();
    expect(db.purgeActivityLog).toHaveBeenCalledWith(90);
    expect(removed).toBe(3);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest services/activityRetention.test.js`
Expected: FAIL — `Cannot find module './activityRetention'`

- [ ] **Step 3: Implementar**

```js
// server/services/activityRetention.js
'use strict';

const db     = require('../db');
const logger = require('./logger');

const RETENTION_DAYS = 90;

function runPurgeOnce() {
  const removed = db.purgeActivityLog(RETENTION_DAYS);
  if (removed > 0) {
    logger.info(`[ActivityRetention] ${removed} linhas de activity_log removidas (> ${RETENTION_DAYS}d)`);
  }
  return removed;
}

function scheduleDailyPurge() {
  runPurgeOnce();
  setInterval(runPurgeOnce, 24 * 60 * 60 * 1000);
}

module.exports = { runPurgeOnce, scheduleDailyPurge, RETENTION_DAYS };
```

Em `server/server.js`, perto de onde outros serviços de background são iniciados
(`alertEngine.start()`, `insightEngine.start()`):

```js
const activityRetention = require('./services/activityRetention');
if (process.env.FEATURE_LIVE_ACCESS === 'true') {
  activityRetention.scheduleDailyPurge();
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest services/activityRetention.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/activityRetention.js server/services/activityRetention.test.js server/server.js
git commit -m "feat(server): purge diário de activity_log após 90 dias"
```

---

## Self-review (feito antes de entregar este plano)

- **Cobertura da spec**: data model (Task 1), watchlist CRUD (Tasks 2-3), matcher (Task 4),
  activity log + gatilho de screenshot (Tasks 5-6), live session lifecycle (Task 7, 10), relay com
  bloqueio de input em Shadow (Task 8-9), feature flag (Task 11), retenção 90 dias (Task 12). O
  armazenamento do screenshot em si no Azure Blob e a configuração de lifecycle policy do Blob
  ficam fora deste plano — são infraestrutura (conta de storage, policy no portal/CLI do Azure),
  não código; tratar como passo manual de deploy, documentado na spec.
- **Placeholder scan**: removida a linha de rascunho (`jest.doMock('../routes/live.js.config'...)`)
  da Task 10, deixada como nota explícita de "não incluir" pro implementador não copiar por engano.
- **Consistência de tipos**: `createLiveSession(machineId, mode)` retorna `string` (UUID) em todas
  as tasks que o usam (7, 9, 10); `routeMessage(sessionId, origin, data)` com `origin` sempre
  `'dashboard'|'companion'` igual nas Tasks 8 e 9; `findMatch(text, keywords)` retorna
  `{id, keyword}|null` igual nas Tasks 4 e 6.
