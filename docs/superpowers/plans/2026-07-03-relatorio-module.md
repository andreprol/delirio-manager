# Módulo Relatório — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar o módulo Relatório ao Delirio Manager — registro de tópicos por loja, sync Freshdesk, score de risco via Claude AI, e geração de .docx + .pdf mensais.

**Architecture:** Backend Node.js na Azure VM com 5 novas tabelas SQLite, serviço Freshdesk com cache 4h, e engine de relatório que chama Claude API uma vez por geração. Frontend React com overlay full-screen idêntico ao padrão DRModule/AlohaModule.

**Tech Stack:** Node.js 22 + Express + better-sqlite3 (existente) | `docx` npm (geração Word) | LibreOffice headless (PDF) | `@anthropic-ai/sdk` (existente) | React 19 + Vite (dashboard)

---

## Mapa de Arquivos

**Criar (servidor):**
- `server/services/freshdesk.js` — sync tickets Freshdesk, cache 4h
- `server/services/reportEngine.js` — buildStoreContext, callClaude, generateDocx, generatePdf
- `server/routes/relatorio.js` — 7 endpoints REST do módulo
- `server/templates/logo-delirio.png` — logo copiado de I:\CENTRAL\MARKETING\LOGO\Nova\

**Modificar (servidor):**
- `server/db.js` — 5 novas tabelas + helpers CRUD
- `server/server.js` — registrar rota `/api/relatorio`
- `server/config.json` — seções freshdesk + relatorio

**Criar (dashboard):**
- `dashboard/src/components/report/ScoreWidget.jsx`
- `dashboard/src/components/report/TopicForm.jsx`
- `dashboard/src/components/report/TopicList.jsx`
- `dashboard/src/components/report/StoreList.jsx`
- `dashboard/src/components/report/GenerateModal.jsx`
- `dashboard/src/components/report/StoreDashboard.jsx`
- `dashboard/src/components/ReportModule.jsx`

**Modificar (dashboard):**
- `dashboard/src/api.js` — namespace `api.relatorio.*`
- `dashboard/src/App.jsx` — pill 📊 Relatório + estado showRelatorio

---

## Task 1: Dependências e Configuração

**Files:**
- Modify: `server/package.json`
- Modify: `server/config.json`
- Create: `server/templates/` (diretório)

- [ ] **Step 1: Instalar dependência docx**

```bash
cd server
npm install docx@9
```

Expected: `added 1 package` (ou similar), sem erros.

- [ ] **Step 2: Copiar logo para templates**

```powershell
New-Item -ItemType Directory -Force "F:\RichClub\server\templates"
Copy-Item "I:\CENTRAL\MARKETING\LOGO\Nova\Logo Delirio Tropical PNG.png" `
  "F:\RichClub\server\templates\logo-delirio.png"
```

- [ ] **Step 3: Adicionar seções freshdesk e relatorio ao config.json**

Editar `server/config.json` e adicionar ao objeto raiz:

```json
{
  "alerts": { ... },
  "insights": { ... },
  "freshdesk": {
    "domain": "deliriotropical",
    "api_key": "",
    "cache_hours": 4
  },
  "relatorio": {
    "claude_api_key": "",
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 1500
  }
}
```

> **Nota:** As chaves `claude_api_key` serão preenchidas com o mesmo valor de `insights.claude_api_key`. O `api_key` do Freshdesk será fornecido pelo André.

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/package-lock.json server/config.json server/templates/
git commit -m "chore(relatorio): install docx dep, add config sections, copy logo"
```

---

## Task 2: Migrações de Banco de Dados

**Files:**
- Modify: `server/db.js`

- [ ] **Step 1: Adicionar 5 novas tabelas ao array `migrations` em db.js**

Localizar o trecho `const migrations = [` em `server/db.js` (linha ~206) e adicionar ao final do array, antes do `];`:

```javascript
    // ── Módulo Relatório ──────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS report_topics (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      store_name         TEXT NOT NULL,
      description        TEXT NOT NULL,
      severity           TEXT NOT NULL CHECK(severity IN ('baixa','media','alta','critica')),
      machine_mention    TEXT,
      is_critical_machine INTEGER DEFAULT 0,
      photo_path         TEXT,
      created_at         TEXT NOT NULL,
      created_by         TEXT NOT NULL DEFAULT 'TI'
    )`,
    `CREATE TABLE IF NOT EXISTS report_topics_history (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      original_topic_id  INTEGER,
      store_name         TEXT NOT NULL,
      description        TEXT NOT NULL,
      severity           TEXT NOT NULL,
      machine_mention    TEXT,
      is_critical_machine INTEGER DEFAULT 0,
      photo_path         TEXT,
      created_at         TEXT NOT NULL,
      resolved_at        TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS freshdesk_cache (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id   INTEGER UNIQUE NOT NULL,
      store_name  TEXT,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL,
      priority    TEXT,
      created_at  TEXT,
      resolved_at TEXT,
      cached_at   TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS report_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      store_name          TEXT NOT NULL,
      month               TEXT NOT NULL,
      generated_at        TEXT NOT NULL,
      score_total         INTEGER,
      score_hardware      INTEGER,
      score_software      INTEGER,
      score_connectivity  INTEGER,
      score_security      INTEGER,
      score_incidents     INTEGER,
      ai_narrative        TEXT,
      ai_recommendations  TEXT,
      docx_path           TEXT,
      pdf_path            TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS report_feedback (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      report_run_id  INTEGER,
      store_name     TEXT NOT NULL,
      month          TEXT NOT NULL,
      feedback_text  TEXT NOT NULL,
      created_at     TEXT NOT NULL
    )`,
```

- [ ] **Step 2: Verificar que o servidor sobe sem erros**

```bash
cd server
node -e "const db = require('./db'); db.getDb(); console.log('migrations OK')"
```

Expected: `migrations OK`

- [ ] **Step 3: Confirmar tabelas criadas**

```bash
node -e "
const db = require('./db').getDb();
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'report%' OR name LIKE 'freshdesk%'\").all();
console.log(tables.map(t => t.name));
"
```

Expected: `[ 'report_topics', 'report_topics_history', 'freshdesk_cache', 'report_runs', 'report_feedback' ]`

- [ ] **Step 4: Adicionar helpers CRUD ao db.js**

Adicionar ao final de `server/db.js`, antes do `module.exports`:

```javascript
// ── Módulo Relatório ──────────────────────────────────────────────────────────

const CRITICAL_RE = /^(TERM|BOH)/i;

function isCriticalMachine(mention) {
  return mention ? CRITICAL_RE.test(mention.trim()) : false;
}

// Topics
function getTopics(storeName) {
  return getDb().prepare(
    `SELECT * FROM report_topics WHERE store_name = ? ORDER BY
     CASE severity WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, created_at DESC`
  ).all(storeName);
}

function getAllStoresTopicCount() {
  return getDb().prepare(
    `SELECT store_name, COUNT(*) as count FROM report_topics GROUP BY store_name`
  ).all();
}

function createTopic({ store_name, description, severity, machine_mention, photo_path, created_by }) {
  const critical = isCriticalMachine(machine_mention);
  const now = new Date().toISOString();
  const info = getDb().prepare(
    `INSERT INTO report_topics (store_name, description, severity, machine_mention, is_critical_machine, photo_path, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(store_name, description, severity, machine_mention || null, critical ? 1 : 0, photo_path || null, now, created_by || 'TI');
  return getDb().prepare('SELECT * FROM report_topics WHERE id = ?').get(info.lastInsertRowid);
}

function resolveTopic(id) {
  const topic = getDb().prepare('SELECT * FROM report_topics WHERE id = ?').get(id);
  if (!topic) return null;
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO report_topics_history (original_topic_id, store_name, description, severity, machine_mention, is_critical_machine, photo_path, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(topic.id, topic.store_name, topic.description, topic.severity, topic.machine_mention, topic.is_critical_machine, topic.photo_path, topic.created_at, now);
  getDb().prepare('DELETE FROM report_topics WHERE id = ?').run(id);
  return { resolved: true };
}

function getTopicsHistory(storeName, months = 6) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  return getDb().prepare(
    `SELECT * FROM report_topics_history WHERE store_name = ? AND resolved_at >= ? ORDER BY resolved_at DESC`
  ).all(storeName, since.toISOString());
}

// Freshdesk cache
function getFreshdeskCacheAge(storeName) {
  const row = getDb().prepare(
    `SELECT cached_at FROM freshdesk_cache WHERE store_name = ? ORDER BY cached_at DESC LIMIT 1`
  ).get(storeName);
  if (!row) return Infinity;
  return (Date.now() - new Date(row.cached_at).getTime()) / 3600000; // hours
}

function upsertFreshdeskTickets(tickets) {
  const stmt = getDb().prepare(
    `INSERT OR REPLACE INTO freshdesk_cache (ticket_id, store_name, title, status, priority, created_at, resolved_at, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  const insert = getDb().transaction((rows) => {
    for (const t of rows) stmt.run(t.ticket_id, t.store_name, t.title, t.status, t.priority, t.created_at, t.resolved_at, now);
  });
  insert(tickets);
}

function getFreshdeskActive(storeName, month) {
  // month = YYYY-MM
  return getDb().prepare(
    `SELECT * FROM freshdesk_cache
     WHERE store_name = ? AND status IN ('open','pending')
     AND substr(created_at, 1, 7) <= ? ORDER BY created_at DESC`
  ).all(storeName, month);
}

function getFreshdeskClosed(storeName, month) {
  return getDb().prepare(
    `SELECT * FROM freshdesk_cache
     WHERE store_name = ? AND status = 'closed'
     AND substr(resolved_at, 1, 7) = ? ORDER BY resolved_at DESC`
  ).all(storeName, month);
}

// Report runs
function saveReportRun(data) {
  const info = getDb().prepare(
    `INSERT INTO report_runs (store_name, month, generated_at, score_total, score_hardware, score_software,
     score_connectivity, score_security, score_incidents, ai_narrative, ai_recommendations, docx_path, pdf_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.store_name, data.month, new Date().toISOString(),
    data.score_total, data.score_hardware, data.score_software,
    data.score_connectivity, data.score_security, data.score_incidents,
    data.ai_narrative, JSON.stringify(data.ai_recommendations || []),
    data.docx_path || null, data.pdf_path || null
  );
  return info.lastInsertRowid;
}

function getReportHistory(storeName) {
  return getDb().prepare(
    `SELECT * FROM report_runs WHERE store_name = ? ORDER BY generated_at DESC LIMIT 12`
  ).all(storeName);
}

// Feedback
function saveFeedback({ store_name, month, feedback_text, report_run_id }) {
  getDb().prepare(
    `INSERT INTO report_feedback (report_run_id, store_name, month, feedback_text, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(report_run_id || null, store_name, month, feedback_text, new Date().toISOString());
}

function getRecentFeedback(storeName, limit = 5) {
  return getDb().prepare(
    `SELECT * FROM report_feedback WHERE store_name = ? ORDER BY created_at DESC LIMIT ?`
  ).all(storeName, limit);
}

// Stores list with score + open topics
function getStoresOverview() {
  const topicCounts = getAllStoresTopicCount();
  const runs = getDb().prepare(
    `SELECT store_name, score_total, generated_at FROM report_runs r1
     WHERE generated_at = (SELECT MAX(generated_at) FROM report_runs r2 WHERE r2.store_name = r1.store_name)`
  ).all();
  const countMap = Object.fromEntries(topicCounts.map(r => [r.store_name, r.count]));
  const scoreMap = Object.fromEntries(runs.map(r => [r.store_name, { score: r.score_total, generatedAt: r.generated_at }]));
  return { countMap, scoreMap };
}
```

- [ ] **Step 5: Commit**

```bash
git add server/db.js
git commit -m "feat(relatorio): add 5 SQLite tables + CRUD helpers"
```

---

## Task 3: Serviço Freshdesk

**Files:**
- Create: `server/services/freshdesk.js`

- [ ] **Step 1: Criar freshdesk.js**

```javascript
// server/services/freshdesk.js
'use strict';

const https = require('https');
const db    = require('../db');

function loadConfig() {
  try { return require('../config.json').freshdesk || {}; }
  catch { return {}; }
}

// Mapeia status numérico do Freshdesk para string legível
function mapStatus(num) {
  const MAP = { 2: 'open', 3: 'pending', 4: 'resolved', 5: 'closed' };
  return MAP[num] || 'open';
}

// Determina se um ticket é de TI baseado nos custom fields
function isTiTicket(ticket) {
  const cf = ticket.custom_fields || {};
  const setor = (cf.cf_setor || '').toLowerCase();
  const grupo  = (cf.cf_grupo  || '').toLowerCase();
  return setor === 'ti' || grupo === 'ti';
}

function getStoreName(ticket) {
  const cf = ticket.custom_fields || {};
  return cf.cf_nome_de_loja || null;
}

function mapTicket(ticket) {
  return {
    ticket_id:  ticket.id,
    store_name: getStoreName(ticket),
    title:      ticket.subject || '',
    status:     mapStatus(ticket.status),
    priority:   ticket.priority ? String(ticket.priority) : null,
    created_at: ticket.created_at || null,
    resolved_at: ticket.resolved_at || null,
  };
}

function fetchPage(domain, apiKey, page) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${apiKey}:X`).toString('base64');
    const path = `/api/v2/tickets?per_page=100&page=${page}&include=custom_fields&updated_since=2024-01-01T00:00:00Z`;
    const req = https.request({
      hostname: `${domain}.freshdesk.com`,
      path,
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Freshdesk HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function syncAll() {
  const cfg = loadConfig();
  if (!cfg.api_key || !cfg.domain) throw new Error('Freshdesk não configurado (config.json: freshdesk.domain + freshdesk.api_key)');

  const allTickets = [];
  let page = 1;
  while (true) {
    const tickets = await fetchPage(cfg.domain, cfg.api_key, page);
    if (!Array.isArray(tickets) || tickets.length === 0) break;
    allTickets.push(...tickets);
    if (tickets.length < 100) break;
    page++;
    await new Promise(r => setTimeout(r, 300)); // respeitar rate limit
  }

  const tiTickets = allTickets.filter(isTiTicket).map(mapTicket);
  db.upsertFreshdeskTickets(tiTickets);
  return tiTickets.length;
}

// Sincroniza apenas se cache estiver vencido (default: 4h)
async function syncIfStale(storeName) {
  const cfg = loadConfig();
  const cacheHours = cfg.cache_hours || 4;
  const ageHours = db.getFreshdeskCacheAge(storeName);
  if (ageHours < cacheHours) return { synced: false, cached: true };
  const count = await syncAll();
  return { synced: true, count };
}

module.exports = { syncIfStale, syncAll, isTiTicket, mapStatus, mapTicket };
```

- [ ] **Step 2: Testar filtro de TI manualmente**

```bash
node -e "
const { isTiTicket } = require('./services/freshdesk');
console.assert(isTiTicket({ custom_fields: { cf_setor: 'TI' } }), 'setor TI deve passar');
console.assert(isTiTicket({ custom_fields: { cf_grupo: 'ti' } }), 'grupo ti deve passar (case insensitive)');
console.assert(!isTiTicket({ custom_fields: { cf_setor: 'Manutencao' } }), 'manutencao deve ser filtrado');
console.assert(!isTiTicket({ custom_fields: {} }), 'sem campos deve ser filtrado');
console.log('isTiTicket: OK');
" 2>&1
```

Expected: `isTiTicket: OK`

- [ ] **Step 3: Commit**

```bash
git add server/services/freshdesk.js
git commit -m "feat(relatorio): add Freshdesk service with TI filter and 4h cache"
```

---

## Task 4: Report Engine — Context Builder e Claude AI

**Files:**
- Create: `server/services/reportEngine.js`

- [ ] **Step 1: Criar reportEngine.js com buildStoreContext e callClaude**

```javascript
// server/services/reportEngine.js
'use strict';

const path = require('path');
const db   = require('../db');

function loadConfig() {
  try { return require('../config.json').relatorio || {}; }
  catch { return {}; }
}

// Detecta padrões recorrentes no histórico de tópicos resolvidos
function detectRecurrences(history) {
  const counts = {};
  for (const h of history) {
    const key = h.description.toLowerCase().slice(0, 40);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, c]) => c >= 2)
    .map(([desc, count]) => `"${desc}..." (${count}x nos últimos 6 meses)`);
}

function buildStoreContext(storeName, month) {
  // Tópicos abertos — pesam no score
  const openTopics = db.getTopics(storeName);

  // Histórico de resolvidos — apenas insights
  const history = db.getTopicsHistory(storeName, 6);
  const recurrences = detectRecurrences(history);

  // Chamados Freshdesk
  const fdActive = db.getFreshdeskActive(storeName, month);
  const fdClosed = db.getFreshdeskClosed(storeName, month);

  // Métricas DM — últimos 30 dias
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const machines = db.getMachines().filter(m => m.location === storeName);
  const machineData = machines.map(m => {
    const recent = db.getDb().prepare(
      `SELECT AVG(cpu_pct) as avg_cpu, AVG((ram_total_mb - ram_free_mb)*100.0/ram_total_mb) as avg_ram,
       AVG(disk_free_gb) as avg_disk_free, AVG(cpu_temp_c) as avg_temp
       FROM metrics WHERE machine_id = ? AND ts >= ?`
    ).get(m.id, since.toISOString());
    return {
      name:       m.hostname,
      isCritical: /^(TERM|BOH)/i.test(m.hostname),
      os:         m.agent_version || 'unknown',
      status:     m.status,
      avg_cpu:    recent?.avg_cpu    ? Math.round(recent.avg_cpu)    : null,
      avg_ram:    recent?.avg_ram    ? Math.round(recent.avg_ram)    : null,
      avg_temp:   recent?.avg_temp   ? Math.round(recent.avg_temp)   : null,
      disk_free:  recent?.avg_disk_free ? Math.round(recent.avg_disk_free) : null,
    };
  });

  // Alertas de OS — Windows 10 (build < 19045 indica Win10)
  const win10Machines = db.getDb().prepare(
    `SELECT hostname FROM machines WHERE location = ? AND (agent_version LIKE '%Win 10%' OR agent_version LIKE '%10.0.%')`
  ).all(storeName).map(m => m.hostname);

  // Feedback histórico para calibração da IA
  const recentFeedback = db.getRecentFeedback(storeName, 5);

  return {
    storeName, month, openTopics, history: history.slice(0, 20),
    recurrences, fdActive, fdClosed, machineData, win10Machines, recentFeedback,
  };
}

function buildPrompt(ctx) {
  const { storeName, month, openTopics, history, recurrences, fdActive, fdClosed, machineData, win10Machines, recentFeedback } = ctx;

  const fmtTopic = t =>
    `  [${t.severity.toUpperCase()}${t.is_critical_machine ? ' 🔴BOH/TERM' : ''}] ${t.description}`;

  const fmtTicket = t =>
    `  [${t.status}] ${t.title}${t.resolved_at ? ` (resolvido: ${t.resolved_at.slice(0,10)})` : ''}`;

  const fmtMachine = m =>
    `  ${m.name}${m.isCritical ? ' [CRÍTICA]' : ''} — CPU ${m.avg_cpu ?? '?'}% RAM ${m.avg_ram ?? '?'}% Temp ${m.avg_temp ?? '?'}°C DiskFree ${m.disk_free ?? '?'}GB status:${m.status}`;

  const fmtFeedback = f =>
    `  [${f.month}] "${f.feedback_text}"`;

  return `Você é um analista de TI da Delírio Tropical. Avalie o risco da loja abaixo e retorne SOMENTE um objeto JSON válido, sem texto adicional.

LOJA: ${storeName} | MÊS: ${month}

REGRA CRÍTICA: Qualquer problema em máquina TERM* (terminal Aloha) ou BOH* (servidor Aloha) = severidade máxima. Essas máquinas geram o faturamento da loja.

TÓPICOS ABERTOS (problemas ativos — pesam no score):
${openTopics.length ? openTopics.map(fmtTopic).join('\n') : '  Nenhum'}

CHAMADOS FRESHDESK ATIVOS (abertos/pendentes — pesam no score):
${fdActive.length ? fdActive.map(fmtTicket).join('\n') : '  Nenhum'}

TÓPICOS RESOLVIDOS NO MÊS (histórico — NÃO pesam no score):
${history.filter(h => h.resolved_at?.slice(0,7) === month).slice(0,10).map(t => `  [resolvido] ${t.description}`).join('\n') || '  Nenhum'}

CHAMADOS FRESHDESK FECHADOS NO MÊS (histórico — NÃO pesam no score):
${fdClosed.length ? fdClosed.map(fmtTicket).join('\n') : '  Nenhum'}

PROBLEMAS RECORRENTES DETECTADOS (contribuem para score de incidentes):
${recurrences.length ? recurrences.map(r => '  ' + r).join('\n') : '  Nenhum padrão recorrente'}

SAÚDE DAS MÁQUINAS:
${machineData.length ? machineData.map(fmtMachine).join('\n') : '  Sem dados de máquinas'}

MÁQUINAS WINDOWS 10 (sem suporte — risco de segurança):
${win10Machines.length ? win10Machines.join(', ') : '  Nenhuma'}

FEEDBACK HISTÓRICO DO GESTOR (calibre seu julgamento com base nisto):
${recentFeedback.length ? recentFeedback.map(fmtFeedback).join('\n') : '  Nenhum feedback anterior'}

Retorne JSON com este formato exato:
{
  "score": <0-100>,
  "hardware": <0-100>,
  "software": <0-100>,
  "conectividade": <0-100>,
  "seguranca": <0-100>,
  "incidentes": <0-100>,
  "narrativa": "<2-3 parágrafos explicando o risco>",
  "recomendacoes": ["<ação 1>", "<ação 2>", "<ação 3>"]
}`;
}

async function callClaude(ctx) {
  const cfg = loadConfig();
  // Fallback: usa insights.claude_api_key se relatorio.claude_api_key não estiver configurado
  let apiKey = cfg.claude_api_key;
  if (!apiKey) {
    try { apiKey = require('../config.json').insights?.claude_api_key; } catch {}
  }
  if (!apiKey) throw new Error('Claude API key não configurada em config.json (relatorio.claude_api_key)');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey });
  const prompt = buildPrompt(ctx);

  const msg = await client.messages.create({
    model:      cfg.model || 'claude-haiku-4-5-20251001',
    max_tokens: cfg.max_tokens || 1500,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = msg.content[0].text.trim();
  // Extrair JSON mesmo se vier com texto extra
  const jsonMatch = text.match(/\{[\s\S]+\}/);
  if (!jsonMatch) throw new Error('Claude retornou resposta sem JSON válido');
  return JSON.parse(jsonMatch[0]);
}

function parseClaudeScore(aiResult) {
  return {
    score_total:       Math.min(100, Math.max(0, Math.round(aiResult.score        || 0))),
    score_hardware:    Math.min(100, Math.max(0, Math.round(aiResult.hardware     || 0))),
    score_software:    Math.min(100, Math.max(0, Math.round(aiResult.software     || 0))),
    score_connectivity:Math.min(100, Math.max(0, Math.round(aiResult.conectividade|| 0))),
    score_security:    Math.min(100, Math.max(0, Math.round(aiResult.seguranca    || 0))),
    score_incidents:   Math.min(100, Math.max(0, Math.round(aiResult.incidentes   || 0))),
    ai_narrative:      aiResult.narrativa || '',
    ai_recommendations: Array.isArray(aiResult.recomendacoes) ? aiResult.recomendacoes : [],
  };
}

module.exports = { buildStoreContext, callClaude, parseClaudeScore, detectRecurrences, buildPrompt };
```

- [ ] **Step 2: Testar parseClaudeScore**

```bash
node -e "
const { parseClaudeScore, detectRecurrences } = require('./services/reportEngine');

// Test parseClaudeScore clamps values
const r1 = parseClaudeScore({ score: 150, hardware: -5, software: 80, conectividade: 20, seguranca: 55, incidentes: 70, narrativa: 'test', recomendacoes: ['a'] });
console.assert(r1.score_total === 100, 'deve clampar 150 para 100');
console.assert(r1.score_hardware === 0, 'deve clampar -5 para 0');
console.assert(r1.score_software === 80, 'deve manter 80');
console.assert(r1.ai_recommendations.length === 1, 'deve manter recomendações');
console.log('parseClaudeScore: OK');

// Test detectRecurrences
const history = [
  { description: 'Nobreak sem bateria — caixa 2' },
  { description: 'Nobreak sem bateria — caixa 2' },
  { description: 'Impressora travando' },
];
const rec = detectRecurrences(history);
console.assert(rec.length === 1, 'deve detectar 1 recorrência');
console.assert(rec[0].includes('2x'), 'deve indicar 2 ocorrências');
console.log('detectRecurrences: OK');
" 2>&1
```

Expected: `parseClaudeScore: OK` e `detectRecurrences: OK`

- [ ] **Step 3: Commit**

```bash
git add server/services/reportEngine.js
git commit -m "feat(relatorio): add reportEngine with context builder and Claude AI scoring"
```

---

## Task 5: Geração de Documentos (.docx + .pdf)

**Files:**
- Modify: `server/services/reportEngine.js`

- [ ] **Step 1: Adicionar generateDocx ao reportEngine.js**

Adicionar ao final de `server/services/reportEngine.js`, antes do `module.exports`:

```javascript
async function generateDocx(ctx, scores, month) {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
          ImageRun, HeadingLevel, AlignmentType, BorderStyle, WidthType,
          ShadingType } = require('docx');
  const fs   = require('fs');
  const path = require('path');

  const LOGO_PATH = path.join(__dirname, '..', 'templates', 'logo-delirio.png');
  const logoData  = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;

  const SCORE_COLOR = scores.score_total >= 60 ? 'DC2626' : scores.score_total >= 30 ? 'EA580C' : '16A34A';
  const SCORE_LABEL = scores.score_total >= 60 ? 'RISCO ALTO' : scores.score_total >= 30 ? 'RISCO MÉDIO' : 'RISCO BAIXO';

  const dim = (label, val) => new TableRow({ children: [
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 18 })] })], width: { size: 50, type: WidthType.PERCENTAGE } }),
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(val), size: 18 })] })], width: { size: 50, type: WidthType.PERCENTAGE } }),
  ]});

  const topicRow = (t) => new TableRow({ children: [
    new TableCell({ children: [new Paragraph(t.severity.toUpperCase())] }),
    new TableCell({ children: [new Paragraph(t.is_critical_machine ? '🔴 BOH/TERM' : '—')] }),
    new TableCell({ children: [new Paragraph(t.description)] }),
    new TableCell({ children: [new Paragraph(t.created_at.slice(0,10))] }),
  ]});

  const fdRow = (t) => new TableRow({ children: [
    new TableCell({ children: [new Paragraph(t.title)] }),
    new TableCell({ children: [new Paragraph(t.status)] }),
    new TableCell({ children: [new Paragraph(t.created_at?.slice(0,10) || '—')] }),
    new TableCell({ children: [new Paragraph(t.resolved_at?.slice(0,10) || '—')] }),
  ]});

  const sections = [];

  // Capa
  if (logoData) {
    sections.push(new Paragraph({
      children: [new ImageRun({ data: logoData, transformation: { width: 180, height: 60 } })],
      alignment: AlignmentType.CENTER,
    }));
  }
  sections.push(new Paragraph({ text: `Relatório Mensal de TI`, heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }));
  sections.push(new Paragraph({ children: [new TextRun({ text: `${ctx.storeName} — ${month}`, size: 28 })] , alignment: AlignmentType.CENTER}));
  sections.push(new Paragraph({ children: [new TextRun({ text: `Score de Risco: ${scores.score_total}/100 — ${SCORE_LABEL}`, bold: true, color: SCORE_COLOR, size: 28 })], alignment: AlignmentType.CENTER }));
  sections.push(new Paragraph(''));

  // Score detalhado
  sections.push(new Paragraph({ text: '2. Score de Risco', heading: HeadingLevel.HEADING_2 }));
  sections.push(new Table({ rows: [
    dim('Hardware',        scores.score_hardware),
    dim('Software / OS',   scores.score_software),
    dim('Conectividade',   scores.score_connectivity),
    dim('Segurança',       scores.score_security),
    dim('Incidentes',      scores.score_incidents),
    dim('TOTAL',           scores.score_total),
  ], width: { size: 60, type: WidthType.PERCENTAGE } }));
  sections.push(new Paragraph(''));
  sections.push(new Paragraph(scores.ai_narrative || ''));
  sections.push(new Paragraph(''));

  // Tópicos abertos
  sections.push(new Paragraph({ text: '3. Tópicos Abertos', heading: HeadingLevel.HEADING_2 }));
  if (ctx.openTopics.length) {
    sections.push(new Table({ rows: [
      new TableRow({ children: ['Severidade','Máquina Crítica','Descrição','Abertura'].map(h =>
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })
      )}),
      ...ctx.openTopics.map(topicRow),
    ]}));
  } else {
    sections.push(new Paragraph('Nenhum tópico aberto neste mês.'));
  }
  sections.push(new Paragraph(''));

  // Chamados Freshdesk
  sections.push(new Paragraph({ text: '5. Chamados TI — Freshdesk', heading: HeadingLevel.HEADING_2 }));
  const allFd = [...ctx.fdActive, ...ctx.fdClosed];
  if (allFd.length) {
    sections.push(new Table({ rows: [
      new TableRow({ children: ['Título','Status','Abertura','Resolução'].map(h =>
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })
      )}),
      ...allFd.map(fdRow),
    ]}));
  } else {
    sections.push(new Paragraph('Nenhum chamado TI registrado.'));
  }
  sections.push(new Paragraph(''));

  // Máquinas
  sections.push(new Paragraph({ text: '6. Saúde das Máquinas', heading: HeadingLevel.HEADING_2 }));
  if (ctx.machineData.length) {
    sections.push(new Table({ rows: [
      new TableRow({ children: ['Máquina','CPU%','RAM%','Temp°C','Disco Livre GB','Status'].map(h =>
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })
      )}),
      ...ctx.machineData.map(m => new TableRow({ children: [
        new TableCell({ children: [new Paragraph(`${m.name}${m.isCritical ? ' 🔴' : ''}`)] }),
        new TableCell({ children: [new Paragraph(String(m.avg_cpu ?? '—'))] }),
        new TableCell({ children: [new Paragraph(String(m.avg_ram ?? '—'))] }),
        new TableCell({ children: [new Paragraph(String(m.avg_temp ?? '—'))] }),
        new TableCell({ children: [new Paragraph(String(m.disk_free ?? '—'))] }),
        new TableCell({ children: [new Paragraph(m.status || '—')] }),
      ]})),
    ]}));
  } else {
    sections.push(new Paragraph('Sem dados de máquinas para este período.'));
  }
  sections.push(new Paragraph(''));

  // Windows 10
  sections.push(new Paragraph({ text: '7. Alertas de Sistema Operacional', heading: HeadingLevel.HEADING_2 }));
  if (ctx.win10Machines.length) {
    sections.push(new Paragraph(`As seguintes máquinas estão com Windows 10 (sem suporte de segurança): ${ctx.win10Machines.join(', ')}`));
    sections.push(new Paragraph('Recomendação: agendar upgrade para Windows 11 com urgência.'));
  } else {
    sections.push(new Paragraph('Nenhuma máquina com OS fora de suporte detectada.'));
  }
  sections.push(new Paragraph(''));

  // Zamak placeholder
  sections.push(new Paragraph({ text: '8. Segurança — Zamak', heading: HeadingLevel.HEADING_2 }));
  sections.push(new Paragraph('[Pendente — integração Zamak em andamento. Incluir relatório de tentativas de invasão quando disponível.]'));
  sections.push(new Paragraph(''));

  // Recomendações
  sections.push(new Paragraph({ text: '9. Recomendações e Próximos Passos', heading: HeadingLevel.HEADING_2 }));
  for (const rec of (scores.ai_recommendations || [])) {
    sections.push(new Paragraph({ text: `• ${rec}`, bullet: { level: 0 } }));
  }

  const doc = new Document({ sections: [{ children: sections }] });
  const DOWNLOADS = path.join(__dirname, '..', '..', 'downloads', 'relatorios');
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const filename = `relatorio_${ctx.storeName.replace(/\s+/g, '_')}_${month}.docx`;
  const filepath = path.join(DOWNLOADS, filename);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

async function generatePdf(docxPath) {
  const { execSync } = require('child_process');
  const path = require('path');
  const dir  = path.dirname(docxPath);
  try {
    execSync(`soffice --headless --convert-to pdf --outdir "${dir}" "${docxPath}"`, { timeout: 30000 });
    return docxPath.replace(/\.docx$/, '.pdf');
  } catch (err) {
    console.error('[reportEngine] PDF conversion failed:', err.message);
    return null;
  }
}
```

- [ ] **Step 2: Atualizar o module.exports**

Substituir o `module.exports` existente:

```javascript
module.exports = { buildStoreContext, callClaude, parseClaudeScore, detectRecurrences, buildPrompt, generateDocx, generatePdf };
```

- [ ] **Step 3: Verificar que o docx module carrega**

```bash
node -e "require('docx'); console.log('docx OK')"
```

Expected: `docx OK`

- [ ] **Step 4: Commit**

```bash
git add server/services/reportEngine.js
git commit -m "feat(relatorio): add docx and pdf generation to reportEngine"
```

---

## Task 6: Rota REST do Módulo Relatório

**Files:**
- Create: `server/routes/relatorio.js`
- Modify: `server/server.js`

- [ ] **Step 1: Criar routes/relatorio.js**

```javascript
// server/routes/relatorio.js
'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const router   = express.Router();
const db       = require('../db');
const freshdesk = require('../services/freshdesk');
const { buildStoreContext, callClaude, parseClaudeScore, generateDocx, generatePdf } = require('../services/reportEngine');

// GET /api/relatorio/stores
// Retorna todas as lojas com score mais recente e contagem de tópicos abertos
router.get('/stores', (req, res) => {
  try {
    const { countMap, scoreMap } = db.getStoresOverview();
    // Pegar lista de lojas únicas de machines + topics
    const storeSet = new Set();
    db.getMachines().forEach(m => { if (m.location) storeSet.add(m.location); });
    db.getDb().prepare('SELECT DISTINCT store_name FROM report_topics').all()
      .forEach(r => storeSet.add(r.store_name));
    db.getDb().prepare('SELECT DISTINCT store_name FROM freshdesk_cache WHERE store_name IS NOT NULL').all()
      .forEach(r => storeSet.add(r.store_name));

    const stores = [...storeSet].sort().map(name => ({
      name,
      openTopics: countMap[name] || 0,
      score: scoreMap[name]?.score ?? null,
      lastReport: scoreMap[name]?.generatedAt ?? null,
    }));
    res.json(stores);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/relatorio/topics/:store
router.get('/topics/:store', (req, res) => {
  try {
    const topics = db.getTopics(decodeURIComponent(req.params.store));
    res.json(topics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/relatorio/topics
router.post('/topics', (req, res) => {
  try {
    const { store_name, description, severity, machine_mention, photo_path, created_by } = req.body;
    if (!store_name || !description || !severity) {
      return res.status(400).json({ error: 'store_name, description e severity são obrigatórios' });
    }
    const topic = db.createTopic({ store_name, description, severity, machine_mention, photo_path, created_by });
    res.status(201).json(topic);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/relatorio/topics/:id  — soft delete → history
router.delete('/topics/:id', (req, res) => {
  try {
    const result = db.resolveTopic(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Tópico não encontrado' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/relatorio/generate
router.post('/generate', async (req, res) => {
  try {
    const { store, month } = req.body;
    if (!store || !month) return res.status(400).json({ error: 'store e month são obrigatórios' });

    // 1. Sync Freshdesk se cache vencido
    await freshdesk.syncIfStale(store).catch(e => console.warn('[relatorio] Freshdesk sync failed:', e.message));

    // 2. Montar contexto
    const ctx = buildStoreContext(store, month);

    // 3. Chamar Claude
    const aiRaw   = await callClaude(ctx);
    const scores  = parseClaudeScore(aiRaw);

    // 4. Gerar documentos
    const docxPath = await generateDocx(ctx, scores, month);
    const pdfPath  = await generatePdf(docxPath).catch(() => null);

    // 5. Salvar run
    const runId = db.saveReportRun({
      store_name:        store,
      month,
      ...scores,
      docx_path: docxPath,
      pdf_path:  pdfPath,
    });

    // 6. Responder com URLs de download
    const base = '/downloads/relatorios';
    res.json({
      runId,
      score:   scores.score_total,
      docxUrl: `${base}/${path.basename(docxPath)}`,
      pdfUrl:  pdfPath ? `${base}/${path.basename(pdfPath)}` : null,
      scores,
      narrative:       scores.ai_narrative,
      recommendations: scores.ai_recommendations,
    });
  } catch (err) {
    console.error('[relatorio/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/relatorio/feedback
router.post('/feedback', (req, res) => {
  try {
    const { store_name, month, feedback_text, report_run_id } = req.body;
    if (!store_name || !month || !feedback_text) {
      return res.status(400).json({ error: 'store_name, month e feedback_text são obrigatórios' });
    }
    db.saveFeedback({ store_name, month, feedback_text, report_run_id });
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/relatorio/history/:store
router.get('/history/:store', (req, res) => {
  try {
    const history = db.getReportHistory(decodeURIComponent(req.params.store));
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 2: Registrar rota em server.js**

Em `server/server.js`, adicionar após as imports existentes (linha ~23):

```javascript
const relatorioRoutes = require('./routes/relatorio');
```

E após linha `app.use('/api/dr', drRoutes);` (linha ~76):

```javascript
app.use('/api/relatorio', relatorioRoutes);
```

- [ ] **Step 3: Verificar que o servidor sobe sem erro**

```bash
node --check server.js && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 4: Testar endpoints básicos com curl (servidor deve estar parado ou em outra porta)**

```bash
node -e "
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/relatorio', require('./routes/relatorio'));
const s = app.listen(9876, () => {
  const http = require('http');
  http.get('http://localhost:9876/api/relatorio/stores', r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => { console.log('stores OK:', JSON.parse(d).length >= 0); s.close(); });
  }).on('error', e => { console.error(e.message); s.close(); });
});
"
```

Expected: `stores OK: true`

- [ ] **Step 5: Registrar o diretório de downloads de relatórios em server.js**

Verificar que `server.js` já serve `/downloads` (linha ~89). Se não, adicionar:

```javascript
app.use('/downloads/relatorios', express.static(path.join(__dirname, '..', 'downloads', 'relatorios')));
```

- [ ] **Step 6: Commit**

```bash
git add server/routes/relatorio.js server/server.js
git commit -m "feat(relatorio): add REST routes for topics, generate, feedback, history"
```

---

## Task 7: Dashboard — api.js namespace

**Files:**
- Modify: `dashboard/src/api.js`

- [ ] **Step 1: Adicionar namespace relatorio ao final do objeto api em api.js**

Localizar o fechamento `}` do objeto `api` (última linha antes do `}`) e adicionar:

```javascript
  // Relatório TI por loja
  relatorio: {
    getStores:    ()                           => request('GET',    '/api/relatorio/stores'),
    getTopics:    (store)                      => request('GET',    `/api/relatorio/topics/${encodeURIComponent(store)}`),
    createTopic:  (data)                       => request('POST',   '/api/relatorio/topics', data),
    resolveTopic: (id)                         => request('DELETE', `/api/relatorio/topics/${id}`),
    generate:     (store, month)               => request('POST',   '/api/relatorio/generate', { store, month }),
    saveFeedback: (store, month, text, runId)  => request('POST',   '/api/relatorio/feedback', { store_name: store, month, feedback_text: text, report_run_id: runId }),
    getHistory:   (store)                      => request('GET',    `/api/relatorio/history/${encodeURIComponent(store)}`),
    downloadDocx: async (store, month) => {
      const res = await fetch(`${serverUrl}/downloads/relatorios/relatorio_${encodeURIComponent(store.replace(/\s+/g,'_'))}_${month}.docx`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.blob()
    },
  },
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/api.js
git commit -m "feat(relatorio): add api.relatorio namespace"
```

---

## Task 8: ScoreWidget

**Files:**
- Create: `dashboard/src/components/report/ScoreWidget.jsx`

- [ ] **Step 1: Criar ScoreWidget.jsx**

```jsx
// dashboard/src/components/report/ScoreWidget.jsx
import { useMemo } from 'react'

const DIMS = [
  { key: 'score_hardware',     label: 'Hardware' },
  { key: 'score_software',     label: 'Software / OS' },
  { key: 'score_connectivity', label: 'Conectividade' },
  { key: 'score_security',     label: 'Segurança' },
  { key: 'score_incidents',    label: 'Incidentes' },
]

function scoreColor(s) {
  if (s >= 60) return '#e53e3e'
  if (s >= 30) return '#ed8936'
  return '#48bb78'
}

function scoreLabel(s) {
  if (s >= 60) return 'RISCO ALTO'
  if (s >= 30) return 'RISCO MÉDIO'
  return 'RISCO BAIXO'
}

export function ScoreWidget({ scores }) {
  const total = scores?.score_total ?? null
  const color = total !== null ? scoreColor(total) : '#4a5568'
  const label = total !== null ? scoreLabel(total) : 'SEM DADOS'

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 12, background: '#1a202c', borderRadius: 8, padding: 12, alignItems: 'center' }}>
      <div style={{ textAlign: 'center', padding: '0 12px' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '1.5rem', fontWeight: 800, margin: '0 auto' }}>
          {total ?? '—'}
        </div>
        <div style={{ fontSize: '0.7rem', color, fontWeight: 700, marginTop: 4 }}>{label}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {DIMS.map(({ key, label }) => {
          const val = scores?.[key] ?? null
          const c   = val !== null ? scoreColor(val) : '#4a5568'
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 110, fontSize: '0.72rem', color: '#a0aec0' }}>{label}</span>
              <div style={{ flex: 1, height: 8, background: '#2d3748', borderRadius: 4 }}>
                <div style={{ width: `${val ?? 0}%`, height: '100%', background: c, borderRadius: 4 }} />
              </div>
              <span style={{ fontSize: '0.7rem', color: c, width: 32, textAlign: 'right' }}>{val ?? '—'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/report/ScoreWidget.jsx
git commit -m "feat(relatorio): add ScoreWidget component"
```

---

## Task 9: TopicForm

**Files:**
- Create: `dashboard/src/components/report/TopicForm.jsx`

- [ ] **Step 1: Criar TopicForm.jsx**

```jsx
// dashboard/src/components/report/TopicForm.jsx
import { useState } from 'react'
import { api } from '../../api'

const SEVERITIES = ['baixa', 'media', 'alta', 'critica']
const SEV_COLOR  = { baixa: '#4299e1', media: '#ed8936', alta: '#e53e3e', critica: '#9f7aea' }

export function TopicForm({ storeName, onCreated, onCancel }) {
  const [description,     setDescription]     = useState('')
  const [severity,        setSeverity]         = useState('media')
  const [machineMention,  setMachineMention]   = useState('')
  const [saving,          setSaving]           = useState(false)
  const [error,           setError]            = useState(null)

  const isCritical = /^(TERM|BOH)/i.test(machineMention.trim())

  async function handleSubmit(e) {
    e.preventDefault()
    if (!description.trim()) return
    setSaving(true); setError(null)
    try {
      const topic = await api.relatorio.createTopic({
        store_name:      storeName,
        description:     description.trim(),
        severity:        isCritical ? 'critica' : severity,
        machine_mention: machineMention.trim() || null,
        created_by:      'TI',
      })
      onCreated(topic)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000a', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onCancel()}>
      <form onSubmit={handleSubmit} style={{ background: '#1a202c', border: '1px solid #2d3748', borderRadius: 10, padding: 24, width: 460, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 style={{ margin: 0, color: '#e2e8f0', fontSize: '0.95rem' }}>Novo Tópico — {storeName}</h3>

        <div>
          <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Descrição do problema *</label>
          <textarea
            value={description} onChange={e => setDescription(e.target.value)}
            required rows={3}
            style={{ width: '100%', background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '8px', fontSize: '0.85rem', resize: 'vertical', boxSizing: 'border-box', marginTop: 4 }}
            placeholder="Descreva o problema em detalhes..."
          />
        </div>

        <div>
          <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Máquina envolvida (opcional)</label>
          <input
            value={machineMention} onChange={e => setMachineMention(e.target.value)}
            style={{ width: '100%', background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '8px', fontSize: '0.85rem', boxSizing: 'border-box', marginTop: 4 }}
            placeholder="Ex: METROBOH, TERMBSHOP6..."
          />
          {isCritical && (
            <div style={{ marginTop: 4, fontSize: '0.72rem', color: '#fc8181', fontWeight: 700 }}>
              🔴 Máquina crítica detectada (BOH/TERM) — severidade será CRÍTICA automaticamente
            </div>
          )}
        </div>

        {!isCritical && (
          <div>
            <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Severidade</label>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {SEVERITIES.map(s => (
                <button key={s} type="button" onClick={() => setSeverity(s)}
                  style={{ flex: 1, padding: '5px 0', borderRadius: 6, border: `1px solid ${severity === s ? SEV_COLOR[s] : '#4a5568'}`,
                    background: severity === s ? `${SEV_COLOR[s]}22` : 'transparent',
                    color: severity === s ? SEV_COLOR[s] : '#718096', fontSize: '0.75rem', cursor: 'pointer', textTransform: 'capitalize' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && <div style={{ color: '#fc8181', fontSize: '0.78rem' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={onCancel}
            style={{ background: 'none', border: '1px solid #4a5568', borderRadius: 6, color: '#a0aec0', padding: '7px 14px', cursor: 'pointer', fontSize: '0.8rem' }}>
            Cancelar
          </button>
          <button type="submit" disabled={saving || !description.trim()}
            style={{ background: '#667eea', border: 'none', borderRadius: 6, color: 'white', padding: '7px 16px', cursor: saving ? 'wait' : 'pointer', fontSize: '0.8rem', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Salvando...' : 'Registrar Tópico'}
          </button>
        </div>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/report/TopicForm.jsx
git commit -m "feat(relatorio): add TopicForm modal component"
```

---

## Task 10: TopicList

**Files:**
- Create: `dashboard/src/components/report/TopicList.jsx`

- [ ] **Step 1: Criar TopicList.jsx**

```jsx
// dashboard/src/components/report/TopicList.jsx

const SEV_STYLE = {
  critica: { bg: '#2d1f1f', border: '#742a2a', badgeBg: '#742a2a', badgeColor: '#fc8181' },
  alta:    { bg: '#2d2416', border: '#744210', badgeBg: '#744210', badgeColor: '#fbd38d' },
  media:   { bg: '#1a202c', border: '#2d3748', badgeBg: '#1a365d', badgeColor: '#90cdf4' },
  baixa:   { bg: '#1a202c', border: '#2d3748', badgeBg: '#1a4731', badgeColor: '#9ae6b4' },
}

export function TopicList({ topics, onResolve }) {
  if (!topics.length) {
    return <p style={{ color: '#4a5568', fontSize: '0.8rem' }}>Nenhum tópico aberto nesta loja.</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {topics.map(t => {
        const s = SEV_STYLE[t.severity] || SEV_STYLE.baixa
        return (
          <div key={t.id} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6, padding: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 700, color: s.badgeColor, background: s.badgeBg, padding: '2px 5px', borderRadius: 3, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {t.severity.toUpperCase()}
            </span>
            <div style={{ flex: 1, fontSize: '0.75rem', color: '#e2e8f0' }}>{t.description}</div>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
              {t.is_critical_machine ? <span style={{ fontSize: '0.65rem', color: '#e53e3e', fontWeight: 700 }}>🔴 BOH/TERM</span> : null}
              {t.machine_mention && !t.is_critical_machine ? <span style={{ fontSize: '0.65rem', color: '#718096' }}>{t.machine_mention}</span> : null}
              <span style={{ fontSize: '0.65rem', color: '#4a5568' }}>{t.created_at?.slice(0, 10)}</span>
              <button onClick={() => onResolve(t.id)}
                style={{ background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}
                title="Marcar como resolvido">🗑</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/report/TopicList.jsx
git commit -m "feat(relatorio): add TopicList component"
```

---

## Task 11: StoreList (Sidebar)

**Files:**
- Create: `dashboard/src/components/report/StoreList.jsx`

- [ ] **Step 1: Criar StoreList.jsx**

```jsx
// dashboard/src/components/report/StoreList.jsx

function dotColor(score) {
  if (score === null) return '#4a5568'
  if (score >= 60)   return '#e53e3e'
  if (score >= 30)   return '#ed8936'
  return '#48bb78'
}

export function StoreList({ stores, selectedStore, onSelect }) {
  return (
    <div style={{ width: 220, borderRight: '1px solid #2d3748', padding: 12, flexShrink: 0, background: '#131720', overflowY: 'auto' }}>
      <div style={{ fontSize: '0.7rem', color: '#4a5568', fontWeight: 700, letterSpacing: '.08em', marginBottom: 8 }}>LOJAS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {stores.map(s => (
          <div key={s.name} onClick={() => onSelect(s.name)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 6,
              background: selectedStore === s.name ? '#1e2a3a' : 'transparent', cursor: 'pointer' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: dotColor(s.score), flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.78rem', fontWeight: selectedStore === s.name ? 600 : 400, color: selectedStore === s.name ? '#e2e8f0' : '#a0aec0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.name}
              </div>
              <div style={{ fontSize: '0.65rem', color: '#4a5568' }}>
                {s.score !== null ? `Score ${s.score}` : 'Sem dados'}{s.openTopics > 0 ? ` · ${s.openTopics} tópico${s.openTopics > 1 ? 's' : ''}` : ''}
              </div>
            </div>
          </div>
        ))}
        {!stores.length && <p style={{ fontSize: '0.75rem', color: '#4a5568' }}>Nenhuma loja com dados.</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/report/StoreList.jsx
git commit -m "feat(relatorio): add StoreList sidebar component"
```

---

## Task 12: GenerateModal

**Files:**
- Create: `dashboard/src/components/report/GenerateModal.jsx`

- [ ] **Step 1: Criar GenerateModal.jsx**

```jsx
// dashboard/src/components/report/GenerateModal.jsx
import { useState } from 'react'
import { api } from '../../api'

export function GenerateModal({ storeName, onClose, onGenerated }) {
  const now     = new Date()
  const defMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const [month,     setMonth]     = useState(defMonth)
  const [generating, setGenerating] = useState(false)
  const [result,    setResult]    = useState(null)
  const [feedback,  setFeedback]  = useState('')
  const [fbSaved,   setFbSaved]   = useState(false)
  const [error,     setError]     = useState(null)

  async function handleGenerate() {
    setGenerating(true); setError(null); setResult(null)
    try {
      const r = await api.relatorio.generate(storeName, month)
      setResult(r)
      onGenerated?.(r)
      // Disparar downloads automaticamente
      if (r.docxUrl) {
        const a = document.createElement('a')
        a.href = `${api.getServerUrl?.() || ''}${r.docxUrl}`
        a.download = `relatorio_${storeName}_${month}.docx`
        a.click()
      }
      if (r.pdfUrl) {
        setTimeout(() => {
          const a = document.createElement('a')
          a.href = `${api.getServerUrl?.() || ''}${r.pdfUrl}`
          a.download = `relatorio_${storeName}_${month}.pdf`
          a.click()
        }, 500)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  async function handleFeedback() {
    if (!feedback.trim() || !result) return
    await api.relatorio.saveFeedback(storeName, month, feedback, result.runId).catch(() => {})
    setFbSaved(true)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000a', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#1a202c', border: '1px solid #2d3748', borderRadius: 10, padding: 24, width: 480, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h3 style={{ margin: 0, color: '#e2e8f0' }}>📄 Gerar Relatório — {storeName}</h3>

        {!result && (
          <>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Mês de referência</label>
              <input type="month" value={month} onChange={e => setMonth(e.target.value)}
                style={{ display: 'block', marginTop: 4, background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '8px', fontSize: '0.85rem' }}
              />
            </div>
            {error && <div style={{ color: '#fc8181', fontSize: '0.78rem' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={{ background: 'none', border: '1px solid #4a5568', borderRadius: 6, color: '#a0aec0', padding: '7px 14px', cursor: 'pointer', fontSize: '0.8rem' }}>Cancelar</button>
              <button onClick={handleGenerate} disabled={generating}
                style={{ background: '#667eea', border: 'none', borderRadius: 6, color: 'white', padding: '7px 16px', cursor: generating ? 'wait' : 'pointer', fontSize: '0.8rem', opacity: generating ? 0.7 : 1 }}>
                {generating ? '⏳ Gerando... (pode levar 15s)' : '📄 Gerar e Baixar'}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            <div style={{ background: '#1a3a2a', border: '1px solid #48bb78', borderRadius: 8, padding: 12 }}>
              <div style={{ color: '#9ae6b4', fontWeight: 700, fontSize: '0.85rem' }}>✅ Relatório gerado!</div>
              <div style={{ color: '#e2e8f0', fontSize: '0.8rem', marginTop: 4 }}>Score: {result.score}/100 — Downloads iniciados automaticamente.</div>
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Sua opinião sobre este relatório (opcional — melhora os próximos)</label>
              <textarea value={feedback} onChange={e => setFeedback(e.target.value)} rows={3}
                disabled={fbSaved}
                style={{ width: '100%', marginTop: 4, background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '8px', fontSize: '0.82rem', resize: 'vertical', boxSizing: 'border-box' }}
                placeholder="Ex: Score muito alto, o problema da impressora não é crítico..."
              />
              {fbSaved
                ? <div style={{ color: '#9ae6b4', fontSize: '0.75rem', marginTop: 4 }}>✅ Feedback salvo — será usado nos próximos relatórios.</div>
                : <button onClick={handleFeedback} disabled={!feedback.trim()}
                    style={{ marginTop: 6, background: 'none', border: '1px solid #4a5568', borderRadius: 6, color: '#a0aec0', padding: '5px 12px', cursor: 'pointer', fontSize: '0.78rem' }}>
                    Salvar Feedback
                  </button>
              }
            </div>
            <button onClick={onClose} style={{ background: '#2d3748', border: 'none', borderRadius: 6, color: '#e2e8f0', padding: '8px', cursor: 'pointer', fontSize: '0.82rem' }}>Fechar</button>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/report/GenerateModal.jsx
git commit -m "feat(relatorio): add GenerateModal with feedback loop"
```

---

## Task 13: StoreDashboard

**Files:**
- Create: `dashboard/src/components/report/StoreDashboard.jsx`

- [ ] **Step 1: Criar StoreDashboard.jsx**

```jsx
// dashboard/src/components/report/StoreDashboard.jsx
import { useState, useEffect } from 'react'
import { api } from '../../api'
import { ScoreWidget }   from './ScoreWidget'
import { TopicList }     from './TopicList'
import { TopicForm }     from './TopicForm'
import { GenerateModal } from './GenerateModal'

export function StoreDashboard({ storeName }) {
  const [topics,       setTopics]       = useState([])
  const [latestRun,    setLatestRun]    = useState(null)
  const [fdCount,      setFdCount]      = useState({ active: 0, critical: 0, win10: 0 })
  const [loading,      setLoading]      = useState(true)
  const [showForm,     setShowForm]     = useState(false)
  const [showGenerate, setShowGenerate] = useState(false)
  const [syncMsg,      setSyncMsg]      = useState('')

  async function load() {
    setLoading(true)
    try {
      const [t, h] = await Promise.all([
        api.relatorio.getTopics(storeName),
        api.relatorio.getHistory(storeName),
      ])
      setTopics(t)
      setLatestRun(h[0] || null)
    } catch {}
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [storeName])

  async function handleResolve(id) {
    if (!confirm('Marcar este tópico como resolvido? Ele irá para o histórico.')) return
    await api.relatorio.resolveTopic(id).catch(() => {})
    load()
  }

  const scores = latestRun ? {
    score_total:        latestRun.score_total,
    score_hardware:     latestRun.score_hardware,
    score_software:     latestRun.score_software,
    score_connectivity: latestRun.score_connectivity,
    score_security:     latestRun.score_security,
    score_incidents:    latestRun.score_incidents,
  } : null

  const lastSync = latestRun ? `Último relatório: ${latestRun.generated_at?.slice(0,10)}` : 'Sem relatório gerado ainda'

  return (
    <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#e2e8f0' }}>{storeName}</div>
          <div style={{ fontSize: '0.75rem', color: '#718096' }}>{lastSync}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setShowForm(true)}
            style={{ background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', cursor: 'pointer', fontSize: '0.75rem' }}>
            + Novo Tópico
          </button>
          <button onClick={() => setShowGenerate(true)}
            style={{ background: '#667eea', border: 'none', borderRadius: 6, color: 'white', padding: '6px 10px', cursor: 'pointer', fontSize: '0.75rem' }}>
            📄 Gerar Relatório
          </button>
        </div>
      </div>

      {/* Score */}
      {scores && <ScoreWidget scores={scores} />}
      {!scores && !loading && (
        <div style={{ background: '#1a202c', borderRadius: 8, padding: 12, color: '#4a5568', fontSize: '0.8rem' }}>
          Nenhum relatório gerado ainda — clique em "Gerar Relatório" para calcular o score.
        </div>
      )}

      {/* Tópicos */}
      <div>
        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#a0aec0', letterSpacing: '.06em', marginBottom: 6 }}>
          TÓPICOS ABERTOS ({topics.length})
        </div>
        {loading
          ? <p style={{ color: '#4a5568', fontSize: '0.78rem' }}>Carregando...</p>
          : <TopicList topics={topics} onResolve={handleResolve} />
        }
      </div>

      {/* Modais */}
      {showForm && (
        <TopicForm storeName={storeName}
          onCreated={t => { setTopics(prev => [t, ...prev]); setShowForm(false) }}
          onCancel={() => setShowForm(false)}
        />
      )}
      {showGenerate && (
        <GenerateModal storeName={storeName}
          onClose={() => setShowGenerate(false)}
          onGenerated={() => load()}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/report/StoreDashboard.jsx
git commit -m "feat(relatorio): add StoreDashboard main panel component"
```

---

## Task 14: ReportModule (overlay principal)

**Files:**
- Create: `dashboard/src/components/ReportModule.jsx`

- [ ] **Step 1: Criar ReportModule.jsx**

```jsx
// dashboard/src/components/ReportModule.jsx
import { useState, useEffect } from 'react'
import { api }             from '../api'
import { StoreList }       from './report/StoreList'
import { StoreDashboard }  from './report/StoreDashboard'

export function ReportModule({ onClose }) {
  const [stores,        setStores]        = useState([])
  const [selectedStore, setSelectedStore] = useState(null)
  const [loading,       setLoading]       = useState(true)

  async function loadStores() {
    setLoading(true)
    try {
      const s = await api.relatorio.getStores()
      setStores(s)
      if (s.length && !selectedStore) setSelectedStore(s[0].name)
    } catch (e) {
      console.error('[ReportModule]', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadStores() }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f0f19f0', zIndex: 9999, display: 'flex', flexDirection: 'column', fontFamily: 'monospace' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #1e1e30' }}>
        <div>
          <h2 style={{ margin: 0, color: '#667eea', fontSize: '1.1em' }}>📊 Relatório Mensal de TI</h2>
          <p style={{ margin: '2px 0 0', fontSize: '0.78em', color: '#555' }}>Tópicos · Freshdesk · Score de Risco · Geração .docx + .pdf</p>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.3em', cursor: 'pointer' }}>✕</button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {loading
          ? <p style={{ color: '#888', padding: 24 }}>Carregando lojas...</p>
          : (
            <>
              <StoreList
                stores={stores}
                selectedStore={selectedStore}
                onSelect={setSelectedStore}
              />
              {selectedStore
                ? <StoreDashboard key={selectedStore} storeName={selectedStore} />
                : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4a5568' }}>Selecione uma loja</div>
              }
            </>
          )
        }
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/ReportModule.jsx
git commit -m "feat(relatorio): add ReportModule full-screen overlay"
```

---

## Task 15: Wiring no App.jsx

**Files:**
- Modify: `dashboard/src/App.jsx`

- [ ] **Step 1: Adicionar import do ReportModule**

No topo de `dashboard/src/App.jsx`, junto aos outros imports de módulos:

```javascript
import { ReportModule } from './components/ReportModule'
```

- [ ] **Step 2: Adicionar estado showRelatorio**

Na função App, junto aos outros estados `showDR`, `showAloha`:

```javascript
const [showRelatorio, setShowRelatorio] = useState(false)
```

- [ ] **Step 3: Adicionar pill no topbar**

Localizar o bloco do pill `🍕 Aloha` e adicionar após:

```jsx
<button
  className="pill-solo"
  onClick={() => setShowRelatorio(true)}
  title="Módulo Relatório — Score de risco por loja"
  style={{ background: '#667eea22', border: '1px solid #667eea55', color: '#818cf8' }}
>
  📊 Relatório
</button>
```

- [ ] **Step 4: Renderizar overlay**

Junto aos outros overlays (`showAloha`, `showDR`), adicionar:

```jsx
{showRelatorio && <ReportModule onClose={() => setShowRelatorio(false)} />}
```

- [ ] **Step 5: Verificar sintaxe**

```bash
cd dashboard && npx tsc --noEmit 2>&1 | head -20 || echo "sem erros TS"
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/App.jsx
git commit -m "feat(relatorio): wire ReportModule pill into topbar"
```

---

## Task 16: Build e Deploy na Azure VM

**Files:**
- Nenhum arquivo novo — build + deploy

- [ ] **Step 1: Build do dashboard**

```bash
cd dashboard && npm run build
```

Expected: `dist/` gerado sem erros.

- [ ] **Step 2: Copiar logo para a VM**

```bash
# Executar no PowerShell local
$logoSrc = "I:\CENTRAL\MARKETING\LOGO\Nova\Logo Delirio Tropical PNG.png"
$logoB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($logoSrc))
# Salvar b64 para usar no run-command
$logoB64 | Out-File -Encoding ascii "F:\Temp\logo_b64.txt"
```

Então no Azure VM run-command:

```bash
mkdir -p /opt/dt-manager/server/templates
echo '<LOGO_B64_AQUI>' | base64 -d > /opt/dt-manager/server/templates/logo-delirio.png
echo "logo OK: $(du -h /opt/dt-manager/server/templates/logo-delirio.png)"
```

- [ ] **Step 3: Deploy server files para VM**

Fazer deploy dos arquivos novos/modificados:
- `server/db.js`
- `server/server.js`  
- `server/config.json` (após adicionar chaves API reais)
- `server/routes/relatorio.js`
- `server/services/freshdesk.js`
- `server/services/reportEngine.js`

```bash
# Via az vm run-command (padrão do projeto)
'C:/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd' vm run-command invoke \
  --resource-group rg-dt-manager \
  --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'cd /opt/dt-manager/server && npm install docx@9 && echo NPM_OK'
```

- [ ] **Step 4: Verificar LibreOffice na VM**

```bash
'C:/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd' vm run-command invoke \
  --resource-group rg-dt-manager \
  --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'which soffice || apt-get install -y libreoffice-writer 2>&1 | tail -3'
```

Se não instalado: `sudo apt-get install -y libreoffice-writer` (pode demorar ~2min).

- [ ] **Step 5: Configurar chaves API no config.json da VM**

Adicionar no `config.json` da VM:
- `freshdesk.api_key`: obtido em `deliriotropical.freshdesk.com` → Perfil → API Settings
- `relatorio.claude_api_key`: mesma chave já usada em `insights.claude_api_key`

- [ ] **Step 6: Reiniciar servidor e verificar**

```bash
'C:/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd' vm run-command invoke \
  --resource-group rg-dt-manager \
  --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'pm2 restart dt-manager && sleep 3 && curl -s http://localhost:3847/api/relatorio/stores | head -c 100'
```

Expected: resposta JSON começando com `[`.

- [ ] **Step 7: Build e deploy da nova versão do Electron**

```bash
cd dashboard && npm run dist
```

Copiar o instalador gerado para os PCs da equipe de TI.

- [ ] **Step 8: Commit final**

```bash
git add -A
git commit -m "feat: Módulo Relatório completo — tópicos, Freshdesk, score AI, .docx + .pdf"
```

---

## Self-Review

**Cobertura do spec:**
- ✅ 5 tabelas SQLite (Task 2)
- ✅ Freshdesk sync + filtro TI + cache 4h (Task 3)
- ✅ Paridade ticket fechado = tópico resolvido (Tasks 3 + 4 — getFreshdeskActive/Closed)
- ✅ isCriticalMachine() detecta TERM*/BOH* (Task 2 db.js)
- ✅ buildStoreContext com histórico, recorrências, métricas DM, Win10 (Task 4)
- ✅ callClaude com prompt completo incluindo feedback histórico (Task 4)
- ✅ parseClaudeScore clampado 0-100 (Task 4)
- ✅ generateDocx com logo DT, 9 seções (Task 5)
- ✅ generatePdf via LibreOffice headless (Task 5)
- ✅ 7 endpoints REST (Task 6)
- ✅ api.relatorio namespace (Task 7)
- ✅ ScoreWidget + 5 dimensões (Task 8)
- ✅ TopicForm com auto-detect crítico (Task 9)
- ✅ TopicList com badges de severidade (Task 10)
- ✅ StoreList sidebar com semáforo (Task 11)
- ✅ GenerateModal + feedback loop (Task 12)
- ✅ StoreDashboard área principal (Task 13)
- ✅ ReportModule overlay full-screen (Task 14)
- ✅ Pill 📊 Relatório no topbar (Task 15)
- ✅ Deploy + LibreOffice + config API keys (Task 16)
- ✅ Zamak como placeholder na seção 8 do .docx (Task 5)
- ✅ Feedback injetado no prompt Claude (Task 4)
- ✅ Detecção de recorrência via histórico (Task 4)

**Pendências externas (bloqueadores):**
- API key Freshdesk (Task 16 Step 5)
- Claude API key na VM já existe (insights.claude_api_key) — reutilizar

**Tipo de consistência:**
- `db.getTopics()` → `api.relatorio.getTopics()` → `StoreDashboard` → `TopicList` ✅
- `db.resolveTopic()` → `api.relatorio.resolveTopic()` → `StoreDashboard.handleResolve()` ✅
- `parseClaudeScore` retorna `score_total` → `ScoreWidget` espera `scores.score_total` ✅
