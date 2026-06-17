# Clock CRUD + Módulo RH — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Testar acesso a todos os relógios, comparar/sincronizar cadastros entre lojas e adicionar CRUD completo de funcionários no Delirio Manager com alertas LGPD.

**Architecture:** O clock-proxy ganha endpoints bulk (status, employees, enroll, update) que rodam em paralelo em todos os CLOCK_IPS. O backend Azure proxeia esses endpoints e loga todas as operações. O frontend Electron ganha um módulo RH com painel de status dos relógios, tabela de comparação de funcionários e botões de CRUD.

**Tech Stack:** Node.js + Express + Playwright (clock-proxy), better-sqlite3 (backend), React + Vite (Electron dashboard)

---

## Mapa de Arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `clock-proxy/henry-hexa.js` | Modificar | + `checkReachable()`, melhorar `listEmployees()` para retornar ref1/ref2 separados |
| `clock-proxy/server.js` | Modificar | + `GET /rh/clocks/status`, `GET /rh/employees`, `POST /rh/enroll`, `PUT /rh/employee` |
| `server/db.js` | Modificar | + tabela `clock_operation_log`, função `logClockOperation()` |
| `server/routes/rh.js` | Modificar | + proxy para os novos endpoints do clock-proxy + log de todas as operações |
| `dashboard/src/api.js` | Modificar | + métodos RH: `getClockStatus`, `getEmployees`, `enrollEmployee`, `updateEmployee`, `offboardEmployee` |
| `dashboard/src/components/ClockStatusGrid.jsx` | Criar | Grid 3×3 com status de cada relógio (✅/❌/loading) |
| `dashboard/src/components/EmployeeTable.jsx` | Criar | Tabela de comparação de funcionários por relógio + botões de ação |
| `dashboard/src/components/RhModule.jsx` | Criar | Painel principal RH com 3 abas: Status, Funcionários, Auditoria |
| `dashboard/src/App.jsx` | Modificar | Botão "RH" na topbar abre RhModule |

---

## Task 1: checkReachable() no henry-hexa.js

**Files:**
- Modify: `clock-proxy/henry-hexa.js`

**Por que:** Testar 9 relógios com Playwright (login completo) levaria ~5 min e sobrecarregaria os relógios. Um GET HTTP simples resolve em <5s e indica se o relógio está acessível na rede.

- [ ] **Step 1: Adicionar método `checkReachable()` em `henry-hexa.js` antes do método `login`**

```javascript
// Verifica se o relógio está acessível na rede sem iniciar browser
// Faz GET HTTP simples com timeout de 5 segundos
async checkReachable() {
  const http = require('http');
  const start = Date.now();
  return new Promise((resolve) => {
    const req = http.get(this.baseUrl, { timeout: 5000 }, (res) => {
      res.resume(); // descarta o body
      resolve({ reachable: true, responseTimeMs: Date.now() - start, statusCode: res.statusCode });
    });
    req.on('error', (err) => {
      resolve({ reachable: false, responseTimeMs: Date.now() - start, error: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, responseTimeMs: 5000, error: 'timeout' });
    });
  });
}
```

- [ ] **Step 2: Melhorar `listEmployees()` para retornar ref1 e ref2 separados**

Substituir o trecho de extração das células (linhas 244-251 do henry-hexa.js) por:

```javascript
const cells = await row.locator('td').all();
if (cells.length >= 3) {
  const name = (await cells[0].textContent() || '').trim();
  const cpf  = (await cells[1].textContent() || '').trim();
  const refs = (await cells[2].textContent() || '').trim();
  // Refs column usually shows "ref1 / ref2" or just one value
  const refParts = refs.split('/').map(s => s.trim());
  const ref1 = refParts[0] || '';
  const ref2 = refParts[1] || '';
  if (name && cpf) {
    employees.push({ name, cpf, ref1, ref2, refs });
  }
}
```

- [ ] **Step 3: Testar manualmente no Servidor Skill**

```powershell
# No Servidor Skill — testar checkReachable diretamente
cd C:\DtClockProxy
node -e "
const { HenryHexa } = require('./henry-hexa');
const h = new HenryHexa('192.168.15.151', process.env.CLOCK_USER, process.env.CLOCK_PASS);
require('dotenv').config();
h.checkReachable().then(r => console.log(JSON.stringify(r, null, 2)));
"
```

Esperado:
```json
{
  "reachable": true,
  "responseTimeMs": 45,
  "statusCode": 200
}
```

- [ ] **Step 4: Commit**

```bash
git add clock-proxy/henry-hexa.js
git commit -m "feat(clock-proxy): add checkReachable() and parse ref1/ref2 in listEmployees"
```

---

## Task 2: Endpoints bulk no clock-proxy/server.js

**Files:**
- Modify: `clock-proxy/server.js`

**Por que:** O Delirio Manager precisa de um único endpoint para checar todos os relógios e buscar todos os funcionários, sem precisar conhecer a lista de IPs.

- [ ] **Step 1: Adicionar `GET /rh/clocks/status` em server.js**

Adicionar após o endpoint `GET /clock/:ip/employees` existente:

```javascript
// ─── STATUS DE TODOS OS RELÓGIOS ─────────────────────────────────────────────
// Verifica acessibilidade de cada relógio configurado em CLOCK_IPS em paralelo.
// Retorna em ~5s independente do número de relógios.
app.get('/rh/clocks/status', async (req, res) => {
  if (CLOCK_IPS.length === 0) {
    return res.status(500).json({ error: 'CLOCK_IPS nao configurado no .env' });
  }

  const results = await Promise.all(
    CLOCK_IPS.map(async (ip) => {
      const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
      const check = await henry.checkReachable();
      return { ip, ...check };
    })
  );

  res.json({
    total:     results.length,
    reachable: results.filter(r => r.reachable).length,
    unreachable: results.filter(r => !r.reachable).length,
    clocks:    results,
    timestamp: new Date().toISOString(),
  });
});
```

- [ ] **Step 2: Adicionar `GET /rh/employees` em server.js**

Adicionar após o endpoint de status:

```javascript
// ─── FUNCIONÁRIOS DE TODOS OS RELÓGIOS ───────────────────────────────────────
// Busca lista de funcionários de cada relógio acessível e retorna comparação.
// AVISO: cada relógio leva ~30-60s com Playwright — este endpoint pode demorar vários minutos.
// Recomendado: chamar apenas para sincronização, não em tempo real.
app.get('/rh/employees', async (req, res) => {
  if (CLOCK_IPS.length === 0) {
    return res.status(500).json({ error: 'CLOCK_IPS nao configurado no .env' });
  }

  // Busca sequencial para não sobrecarregar os relógios (cada um tem servidor embarcado limitado)
  const clockResults = [];
  for (const ip of CLOCK_IPS) {
    console.log(`[${new Date().toISOString()}] Buscando funcionários de ${ip}...`);
    const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
    const result = await henry.listEmployees();
    clockResults.push({ ip, ...result });
    // Aguardar 10s entre relógios para não sobrecarregar
    if (ip !== CLOCK_IPS[CLOCK_IPS.length - 1]) {
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  // Construir mapa mestre: CPF -> { name, ref1, ref2, presentIn: [ips...], absentIn: [ips...] }
  const masterMap = new Map();
  for (const clock of clockResults) {
    if (!clock.success) continue;
    for (const emp of clock.employees) {
      if (!masterMap.has(emp.cpf)) {
        masterMap.set(emp.cpf, {
          name: emp.name,
          cpf:  emp.cpf,
          ref1: emp.ref1,
          ref2: emp.ref2,
          presentIn:  [],
          absentIn:   [],
        });
      }
      masterMap.get(emp.cpf).presentIn.push(clock.ip);
    }
  }

  // Calcular absentIn para cada funcionário
  const reachableIps = clockResults.filter(r => r.success).map(r => r.ip);
  for (const emp of masterMap.values()) {
    emp.absentIn = reachableIps.filter(ip => !emp.presentIn.includes(ip));
  }

  const employees = Array.from(masterMap.values());
  const divergent = employees.filter(e => e.absentIn.length > 0);

  res.json({
    total:        employees.length,
    divergent:    divergent.length,
    synchronized: employees.length - divergent.length,
    employees,
    clocks:       clockResults.map(r => ({ ip: r.ip, success: r.success, total: r.total || 0, error: r.message })),
    timestamp:    new Date().toISOString(),
  });
});
```

- [ ] **Step 3: Adicionar `POST /rh/enroll` (bulk) em server.js**

Adicionar após o endpoint de employees:

```javascript
// ─── CADASTRO EM TODOS OS RELÓGIOS ───────────────────────────────────────────
// Body: { cpf, name, ref1, ref2, password, clockIps? }
// clockIps (opcional): array de IPs alvo. Se omitido, usa todos os CLOCK_IPS.
app.post('/rh/enroll', async (req, res) => {
  const { cpf, name, ref1, ref2, password, clockIps } = req.body;

  if (!cpf || !name || !ref1) {
    return res.status(400).json({ error: 'cpf, name e ref1 (matricula) sao obrigatorios' });
  }

  const targets = clockIps || CLOCK_IPS;
  if (targets.length === 0) {
    return res.status(500).json({ error: 'CLOCK_IPS nao configurado e clockIps nao informado' });
  }

  const timestamp = new Date().toISOString();
  const results = [];
  for (const ip of targets) {
    const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
    const result = await henry.enrollEmployee({ cpf, name, ref1, ref2, password });
    results.push({ clockIp: ip, ...result });
  }

  res.json({
    success:  results.every(r => r.success),
    cpf, name, ref1,
    timestamp,
    clocks:   results,
    total:    results.length,
    enrolled: results.filter(r => r.success).length,
    failed:   results.filter(r => !r.success).length,
  });
});
```

- [ ] **Step 4: Adicionar `PUT /rh/employee` (bulk update) em server.js**

Adicionar após o enroll:

```javascript
// ─── ATUALIZAR FUNCIONÁRIO EM TODOS OS RELÓGIOS ───────────────────────────────
// Atualiza ref2 (cartão NFC) de um funcionário em todos os relógios.
// Body: { cpf, ref2, clockIps? }
app.put('/rh/employee', async (req, res) => {
  const { cpf, ref2, clockIps } = req.body;

  if (!cpf || !ref2) {
    return res.status(400).json({ error: 'cpf e ref2 sao obrigatorios' });
  }

  const targets = clockIps || CLOCK_IPS;
  if (targets.length === 0) {
    return res.status(500).json({ error: 'CLOCK_IPS nao configurado' });
  }

  const timestamp = new Date().toISOString();
  const results = [];
  for (const ip of targets) {
    const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
    const result = await henry.updateCardRef2(cpf, ref2);
    results.push({ clockIp: ip, ...result });
  }

  res.json({
    success: results.every(r => r.success),
    cpf, ref2,
    timestamp,
    clocks:  results,
    total:   results.length,
    updated: results.filter(r => r.success).length,
    failed:  results.filter(r => !r.success).length,
  });
});
```

- [ ] **Step 5: Testar os novos endpoints no Servidor Skill**

```powershell
$token = "Bearer <CLOCK_PROXY_TOKEN>"
$h = @{Authorization=$token}

# Testar status de todos os relógios (rápido ~5s)
Invoke-RestMethod http://localhost:4321/rh/clocks/status -Headers $h | ConvertTo-Json -Depth 3

# Esperado: { total:9, reachable:X, unreachable:Y, clocks:[...] }
# Metropolitano (192.168.14.151) provavelmente vai aparecer como unreachable
```

- [ ] **Step 6: Deploy e commit**

```powershell
# No Servidor Skill
cd C:\DtClockProxy && .\deploy.ps1
```

```bash
git add clock-proxy/server.js
git commit -m "feat(clock-proxy): add bulk endpoints /rh/clocks/status, /rh/employees, /rh/enroll, /rh/employee"
```

---

## Task 3: clock_operation_log no db.js

**Files:**
- Modify: `server/db.js`

**Por que:** Toda operação de CRUD nos relógios (enroll, update, offboard) precisa ser auditada com resultado por relógio. O `clock_offboard_log` já existe para offboard; criamos um log geral para as demais operações.

- [ ] **Step 1: Adicionar tabela `clock_operation_log` na função `migrate()` do db.js**

Adicionar dentro do `db.exec(...)` da função migrate, após a tabela `clock_offboard_log`:

```sql
CREATE TABLE IF NOT EXISTS clock_operation_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operation     TEXT NOT NULL,
  cpf           TEXT NOT NULL,
  employee_name TEXT DEFAULT '',
  triggered_by  TEXT DEFAULT '',
  timestamp     TEXT NOT NULL,
  success       INTEGER NOT NULL DEFAULT 0,
  total         INTEGER DEFAULT 0,
  ok_count      INTEGER DEFAULT 0,
  failed_count  INTEGER DEFAULT 0,
  detail        TEXT DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_clock_op_log_cpf
  ON clock_operation_log(cpf, timestamp);

CREATE INDEX IF NOT EXISTS idx_clock_op_log_operation
  ON clock_operation_log(operation, timestamp);
```

- [ ] **Step 2: Adicionar funções `logClockOperation()` e `getClockOperationLog()` no db.js**

Adicionar junto com as funções `logClockOffboard` e `getClockOffboardLog` existentes:

```javascript
function logClockOperation({ operation, cpf, employeeName, triggeredBy, timestamp, success, total, okCount, failedCount, detail }) {
  getDb().prepare(`
    INSERT INTO clock_operation_log
      (operation, cpf, employee_name, triggered_by, timestamp, success, total, ok_count, failed_count, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation, cpf, employeeName || '', triggeredBy || '',
    timestamp, success ? 1 : 0,
    total || 0, okCount || 0, failedCount || 0,
    typeof detail === 'string' ? detail : JSON.stringify(detail || [])
  );
}

function getClockOperationLog(limit = 100, operation = null) {
  const q = operation
    ? `SELECT * FROM clock_operation_log WHERE operation = ? ORDER BY timestamp DESC LIMIT ?`
    : `SELECT * FROM clock_operation_log ORDER BY timestamp DESC LIMIT ?`;
  const args = operation ? [operation, limit] : [limit];
  return getDb().prepare(q).all(...args);
}
```

- [ ] **Step 3: Exportar as novas funções no module.exports de db.js**

Adicionar `logClockOperation` e `getClockOperationLog` no objeto `module.exports` existente:

```javascript
module.exports = {
  // ... funções já existentes ...
  logClockOperation,
  getClockOperationLog,
};
```

- [ ] **Step 4: Commit**

```bash
git add server/db.js
git commit -m "feat(db): add clock_operation_log table for CRUD audit"
```

---

## Task 4: Novos endpoints no server/routes/rh.js

**Files:**
- Modify: `server/routes/rh.js`

**Por que:** O Delirio Manager (Azure) precisa de endpoints que proxeiam os novos endpoints do clock-proxy, logam a operação e retornam o resultado com status por relógio. Alertas de falha são embutidos na resposta (campo `failed > 0`).

- [ ] **Step 1: Atualizar `callClockProxy()` para suportar GET e PUT**

Substituir a função `callClockProxy` existente por:

```javascript
function callClockProxy(path, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const url     = new URL(CLOCK_PROXY_URL + path);
    const isGet   = method === 'GET';
    const payload = isGet ? null : JSON.stringify(body || {});
    const lib     = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method,
      headers: {
        'Authorization': `Bearer ${CLOCK_PROXY_TOKEN}`,
        ...(isGet ? {} : {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        }),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({ error: data }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(600000, () => req.destroy(new Error('Timeout apos 10 minutos')));
    if (!isGet) req.write(payload);
    req.end();
  });
}
```

- [ ] **Step 2: Adicionar `GET /api/rh/clocks/status`**

Adicionar após o `router.get('/offboard-log', ...)` existente:

```javascript
// GET /api/rh/clocks/status
// Verifica acessibilidade de todos os relógios (~5s)
router.get('/clocks/status', async (req, res) => {
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }
  try {
    const result = await callClockProxy('/rh/clocks/status', null, 'GET');
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: 'Falha ao conectar com o clock-proxy',
      detail: err.message,
      hint: `Verifique se o Servidor Skill esta acessivel em ${CLOCK_PROXY_URL}`,
    });
  }
});
```

- [ ] **Step 3: Adicionar `GET /api/rh/employees`**

```javascript
// GET /api/rh/employees
// Busca funcionários de todos os relógios e retorna comparação
// AVISO: pode demorar vários minutos (Playwright em cada relógio)
router.get('/employees', async (req, res) => {
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }
  try {
    const result = await callClockProxy('/rh/employees', null, 'GET');
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao conectar com o clock-proxy', detail: err.message });
  }
});
```

- [ ] **Step 4: Adicionar `POST /api/rh/enroll`**

```javascript
// POST /api/rh/enroll
// Cadastra funcionário em todos os relógios (ou nos IPs informados em clockIps)
// Body: { cpf, name, ref1, ref2, password, clockIps?, triggeredBy? }
router.post('/enroll', async (req, res) => {
  const { cpf, name, ref1, ref2, password, clockIps, triggeredBy } = req.body;

  if (!cpf || !name || !ref1) {
    return res.status(400).json({ error: 'cpf, name e ref1 (matricula) sao obrigatorios' });
  }
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }

  const timestamp = new Date().toISOString();

  try {
    const result = await callClockProxy('/rh/enroll', { cpf, name, ref1, ref2, password, clockIps });

    db.logClockOperation({
      operation:    'enroll',
      cpf,
      employeeName: name,
      triggeredBy:  triggeredBy || 'delirio-manager-rh',
      timestamp,
      success:      result.success,
      total:        result.total || 0,
      okCount:      result.enrolled || 0,
      failedCount:  result.failed || 0,
      detail:       result.clocks || [],
    });

    res.json(result);
  } catch (err) {
    db.logClockOperation({
      operation: 'enroll', cpf, employeeName: name,
      triggeredBy: triggeredBy || 'delirio-manager-rh',
      timestamp, success: false, total: 0, okCount: 0, failedCount: -1,
      detail: [{ error: err.message }],
    });
    res.status(502).json({ error: 'Falha ao conectar com o clock-proxy', detail: err.message });
  }
});
```

- [ ] **Step 5: Adicionar `PUT /api/rh/employee`**

```javascript
// PUT /api/rh/employee
// Atualiza cartão NFC de funcionário em todos os relógios
// Body: { cpf, ref2, clockIps?, triggeredBy? }
router.put('/employee', async (req, res) => {
  const { cpf, ref2, clockIps, triggeredBy } = req.body;

  if (!cpf || !ref2) {
    return res.status(400).json({ error: 'cpf e ref2 sao obrigatorios' });
  }
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }

  const timestamp = new Date().toISOString();

  try {
    const result = await callClockProxy('/rh/employee', { cpf, ref2, clockIps }, 'PUT');

    db.logClockOperation({
      operation:    'update_card',
      cpf,
      employeeName: '',
      triggeredBy:  triggeredBy || 'delirio-manager-rh',
      timestamp,
      success:      result.success,
      total:        result.total || 0,
      okCount:      result.updated || 0,
      failedCount:  result.failed || 0,
      detail:       result.clocks || [],
    });

    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao conectar com o clock-proxy', detail: err.message });
  }
});
```

- [ ] **Step 6: Adicionar `GET /api/rh/operation-log`**

```javascript
// GET /api/rh/operation-log
// Retorna log de todas as operações (enroll, update_card, offboard)
router.get('/operation-log', (req, res) => {
  const limit     = parseInt(req.query.limit) || 100;
  const operation = req.query.operation || null;
  res.json(db.getClockOperationLog(limit, operation));
});
```

- [ ] **Step 7: Testar os endpoints do backend**

```powershell
$base = "https://dt-manager.brazilsouth.cloudapp.azure.com"

# Status dos relógios
Invoke-RestMethod "$base/api/rh/clocks/status" | ConvertTo-Json -Depth 3

# Enroll teste
Invoke-RestMethod -Method POST "$base/api/rh/enroll" `
  -ContentType "application/json" `
  -Body '{"cpf":"803.243.720-78","name":"TESTE RH","ref1":"9999","ref2":"00000000","triggeredBy":"plano-teste"}'
```

- [ ] **Step 8: Commit**

```bash
git add server/routes/rh.js
git commit -m "feat(rh): add clocks/status, employees, enroll, update-card endpoints with audit log"
```

---

## Task 5: Métodos RH no api.js

**Files:**
- Modify: `dashboard/src/api.js`

- [ ] **Step 1: Adicionar métodos RH no objeto `api` de api.js**

Adicionar após o bloco `// Settings`:

```javascript
// RH — Relógios e Funcionários
rh: {
  getClockStatus:   ()            => request('GET',  '/api/rh/clocks/status'),
  getEmployees:     ()            => request('GET',  '/api/rh/employees'),
  getOffboardLog:   (limit = 50)  => request('GET',  `/api/rh/offboard-log?limit=${limit}`),
  getOperationLog:  (limit = 100, op = '') =>
    request('GET', `/api/rh/operation-log?limit=${limit}${op ? `&operation=${op}` : ''}`),
  offboard: (cpf, employeeName, triggeredBy) =>
    request('POST', '/api/rh/offboard', { cpf, employeeName, triggeredBy }),
  enroll: (cpf, name, ref1, ref2, password, clockIps) =>
    request('POST', '/api/rh/enroll', { cpf, name, ref1, ref2, password, clockIps }),
  updateCard: (cpf, ref2, clockIps) =>
    request('PUT', '/api/rh/employee', { cpf, ref2, clockIps }),
},
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/api.js
git commit -m "feat(api): add RH methods (clocks status, employees, CRUD)"
```

---

## Task 6: ClockStatusGrid.jsx

**Files:**
- Create: `dashboard/src/components/ClockStatusGrid.jsx`

**Por que:** Mostra visualmente o estado de cada relógio. O usuário vê de um relance qual loja está com VPN fora.

- [ ] **Step 1: Criar ClockStatusGrid.jsx**

```jsx
import { useState, useEffect } from 'react'
import { api } from '../api'

// Mapa de IP para nome da loja
const CLOCK_LABELS = {
  '192.168.15.151': 'Gávea',
  '192.168.14.151': 'Metropolitano',
  '192.168.12.151': 'Bshop',
  '192.168.0.151':  'Assembleia',
  '192.168.13.151': 'Città',
  '192.168.18.151': 'Ipanema',
  '192.168.16.151': 'Rio Sul',
  '192.168.20.151': 'Tijuca',
  '192.168.20.150': 'Niterói',
}

export function ClockStatusGrid({ onRefresh }) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await api.rh.getClockStatus()
      setStatus(data)
      if (onRefresh) onRefresh(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div style={{ padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h3 style={{ margin: 0 }}>Status dos Relógios</h3>
        <button onClick={load} disabled={loading} style={{ padding: '4px 12px', cursor: 'pointer' }}>
          {loading ? 'Verificando...' : 'Verificar'}
        </button>
        {status && (
          <span style={{ fontSize: 13, color: '#888' }}>
            {status.reachable}/{status.total} acessíveis
          </span>
        )}
      </div>

      {error && (
        <div style={{ color: '#e55', background: '#2a1111', padding: 8, borderRadius: 6, marginBottom: 12 }}>
          Erro ao conectar com o Servidor Skill: {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {status?.clocks.map(clock => (
          <div
            key={clock.ip}
            style={{
              padding: '12px 14px',
              borderRadius: 8,
              border: `1px solid ${clock.reachable ? '#1a4a1a' : '#4a1a1a'}`,
              background: clock.reachable ? '#0d2b0d' : '#2b0d0d',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {clock.reachable ? '✅' : '❌'} {CLOCK_LABELS[clock.ip] || clock.ip}
            </div>
            <div style={{ fontSize: 12, color: '#aaa' }}>{clock.ip}</div>
            {clock.reachable
              ? <div style={{ fontSize: 12, color: '#5a5' }}>{clock.responseTimeMs}ms</div>
              : <div style={{ fontSize: 12, color: '#a55' }}>{clock.error || 'inacessível'}</div>
            }
          </div>
        ))}

        {loading && !status && Array.from({ length: 9 }).map((_, i) => (
          <div key={i} style={{ padding: '12px 14px', borderRadius: 8, border: '1px solid #333', background: '#1a1a1a' }}>
            <div style={{ color: '#555' }}>Verificando...</div>
          </div>
        ))}
      </div>

      {status && (
        <div style={{ fontSize: 12, color: '#555', marginTop: 10 }}>
          Última verificação: {new Date(status.timestamp).toLocaleString('pt-BR')}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/ClockStatusGrid.jsx
git commit -m "feat(dashboard): add ClockStatusGrid component"
```

---

## Task 7: EmployeeTable.jsx

**Files:**
- Create: `dashboard/src/components/EmployeeTable.jsx`

**Por que:** Exibe a comparação de funcionários entre relógios, identifica quem está faltando em qual loja, e permite acionar CRUD diretamente da tabela.

- [ ] **Step 1: Criar EmployeeTable.jsx**

```jsx
import { useState } from 'react'
import { api } from '../api'

const CLOCK_LABELS = {
  '192.168.15.151': 'Gávea',
  '192.168.14.151': 'Metro',
  '192.168.12.151': 'Bshop',
  '192.168.0.151':  'Assembl.',
  '192.168.13.151': 'Città',
  '192.168.18.151': 'Ipanema',
  '192.168.16.151': 'Rio Sul',
  '192.168.20.151': 'Tijuca',
  '192.168.20.150': 'Niterói',
}

export function EmployeeTable() {
  const [data,       setData]       = useState(null)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)
  const [filter,     setFilter]     = useState('') // texto de busca
  const [showOnly,   setShowOnly]   = useState('all') // 'all' | 'divergent'
  const [enrollForm, setEnrollForm] = useState(null) // { cpf, name, ref1, ref2 }
  const [opStatus,   setOpStatus]   = useState(null)

  async function loadEmployees() {
    setLoading(true)
    setError(null)
    setOpStatus({ message: 'Buscando funcionários de todos os relógios... (pode demorar vários minutos)' })
    try {
      const result = await api.rh.getEmployees()
      setData(result)
      setOpStatus(null)
    } catch (err) {
      setError(err.message)
      setOpStatus(null)
    } finally {
      setLoading(false)
    }
  }

  async function handleOffboard(emp) {
    if (!window.confirm(`Remover ${emp.name} (CPF ${emp.cpf}) de TODOS os relógios?\n\nEsta ação é irreversível e gera log LGPD.`)) return
    setOpStatus({ message: `Removendo ${emp.name}...` })
    try {
      const result = await api.rh.offboard(emp.cpf, emp.name, 'dashboard-rh')
      setOpStatus({
        message: result.success
          ? `✅ ${emp.name} removido de ${result.removed} relógio(s).`
          : `⚠️ ${emp.name}: ${result.removed} removidos, ${result.failed} falharam.`,
        isError: !result.success,
        detail:  result.clocks,
      })
      await loadEmployees()
    } catch (err) {
      setOpStatus({ message: `Erro: ${err.message}`, isError: true })
    }
  }

  async function handleEnroll(emp, absentIps) {
    setEnrollForm({ cpf: emp.cpf, name: emp.name, ref1: emp.ref1, ref2: emp.ref2, clockIps: absentIps })
  }

  async function submitEnroll() {
    const { cpf, name, ref1, ref2, clockIps } = enrollForm
    if (!ref1) return alert('Matrícula (Ref1) é obrigatória para cadastro.')
    setOpStatus({ message: `Cadastrando ${name} em ${clockIps.length} relógio(s)...` })
    setEnrollForm(null)
    try {
      const result = await api.rh.enroll(cpf, name, ref1, ref2, '', clockIps)
      setOpStatus({
        message: result.success
          ? `✅ ${name} cadastrado em ${result.enrolled} relógio(s).`
          : `⚠️ ${name}: ${result.enrolled} OK, ${result.failed} falharam.`,
        isError: !result.success,
        detail:  result.clocks,
      })
      await loadEmployees()
    } catch (err) {
      setOpStatus({ message: `Erro: ${err.message}`, isError: true })
    }
  }

  const reachableIps = data?.clocks.filter(c => c.success).map(c => c.ip) || []
  const employees = (data?.employees || [])
    .filter(e => {
      if (showOnly === 'divergent' && e.absentIn.length === 0) return false
      const q = filter.toLowerCase()
      return !q || e.name.toLowerCase().includes(q) || e.cpf.includes(q)
    })

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={loadEmployees} disabled={loading} style={{ padding: '6px 14px', cursor: 'pointer', background: '#1a3a6a', color: '#fff', border: 'none', borderRadius: 6 }}>
          {loading ? 'Carregando...' : data ? 'Atualizar' : 'Carregar Funcionários'}
        </button>
        {data && (
          <>
            <span style={{ fontSize: 13, color: '#aaa' }}>{data.total} funcionários | {data.divergent} com divergência</span>
            <input
              placeholder="Buscar nome ou CPF..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              style={{ padding: '4px 10px', flex: 1, minWidth: 180, background: '#1a1a1a', border: '1px solid #333', color: '#fff', borderRadius: 6 }}
            />
            <select
              value={showOnly}
              onChange={e => setShowOnly(e.target.value)}
              style={{ padding: '4px 8px', background: '#1a1a1a', border: '1px solid #333', color: '#fff', borderRadius: 6 }}
            >
              <option value="all">Todos</option>
              <option value="divergent">Só divergentes</option>
            </select>
          </>
        )}
      </div>

      {opStatus && (
        <div style={{
          padding: '10px 14px', borderRadius: 6, marginBottom: 12,
          background: opStatus.isError ? '#2a1111' : '#0d2b0d',
          border: `1px solid ${opStatus.isError ? '#a33' : '#1a5a1a'}`,
          color: opStatus.isError ? '#e88' : '#8e8',
        }}>
          {opStatus.message}
          {opStatus.detail && (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              {opStatus.detail.map(c => (
                <span key={c.clockIp} style={{ marginRight: 10 }}>
                  {c.success || c.alreadyAbsent ? '✅' : '❌'} {CLOCK_LABELS[c.clockIp] || c.clockIp}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div style={{ color: '#e55', marginBottom: 12 }}>Erro: {error}</div>}

      {enrollForm && (
        <div style={{ background: '#1a2a3a', border: '1px solid #2a4a6a', borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <h4 style={{ margin: '0 0 10px' }}>Cadastrar {enrollForm.name} em {enrollForm.clockIps.length} relógio(s)</h4>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input placeholder="Matrícula (Ref1)*" value={enrollForm.ref1 || ''} onChange={e => setEnrollForm(f => ({...f, ref1: e.target.value}))}
              style={{ padding: '6px 10px', flex: 1, minWidth: 140, background: '#111', border: '1px solid #444', color: '#fff', borderRadius: 6 }} />
            <input placeholder="Nº Cartão NFC (Ref2)" value={enrollForm.ref2 || ''} onChange={e => setEnrollForm(f => ({...f, ref2: e.target.value}))}
              style={{ padding: '6px 10px', flex: 1, minWidth: 140, background: '#111', border: '1px solid #444', color: '#fff', borderRadius: 6 }} />
            <button onClick={submitEnroll} style={{ padding: '6px 14px', background: '#1a5a1a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Cadastrar</button>
            <button onClick={() => setEnrollForm(null)} style={{ padding: '6px 14px', background: '#333', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Cancelar</button>
          </div>
        </div>
      )}

      {data && employees.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#1a1a2a' }}>
                <th style={th}>Nome</th>
                <th style={th}>CPF</th>
                <th style={th}>Ref1</th>
                {reachableIps.map(ip => (
                  <th key={ip} style={{ ...th, minWidth: 70 }}>{CLOCK_LABELS[ip] || ip}</th>
                ))}
                <th style={th}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {employees.map(emp => (
                <tr key={emp.cpf} style={{ borderBottom: '1px solid #1a1a1a', background: emp.absentIn.length > 0 ? '#1a1505' : 'transparent' }}>
                  <td style={td}>{emp.name}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{emp.cpf}</td>
                  <td style={td}>{emp.ref1 || '-'}</td>
                  {reachableIps.map(ip => (
                    <td key={ip} style={{ ...td, textAlign: 'center' }}>
                      {emp.presentIn.includes(ip) ? '✅' : '❌'}
                    </td>
                  ))}
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {emp.absentIn.length > 0 && (
                        <button
                          onClick={() => handleEnroll(emp, emp.absentIn)}
                          title={`Cadastrar nas lojas: ${emp.absentIn.map(ip => CLOCK_LABELS[ip] || ip).join(', ')}`}
                          style={{ padding: '3px 8px', background: '#1a4a1a', color: '#8e8', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
                        >
                          Sincronizar
                        </button>
                      )}
                      <button
                        onClick={() => handleOffboard(emp)}
                        title="Remover de todos os relógios (LGPD)"
                        style={{ padding: '3px 8px', background: '#3a1111', color: '#e88', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
                      >
                        Remover
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && employees.length === 0 && !loading && (
        <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>
          {filter || showOnly === 'divergent' ? 'Nenhum funcionário encontrado com este filtro.' : 'Nenhum funcionário carregado.'}
        </div>
      )}
    </div>
  )
}

const th = { padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #2a2a2a', color: '#aaa', whiteSpace: 'nowrap' }
const td = { padding: '7px 10px', color: '#ddd', verticalAlign: 'middle' }
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/EmployeeTable.jsx
git commit -m "feat(dashboard): add EmployeeTable with comparison and CRUD actions"
```

---

## Task 8: RhModule.jsx

**Files:**
- Create: `dashboard/src/components/RhModule.jsx`

- [ ] **Step 1: Criar RhModule.jsx**

```jsx
import { useState } from 'react'
import { ClockStatusGrid } from './ClockStatusGrid'
import { EmployeeTable }   from './EmployeeTable'
import { api }             from '../api'

const TABS = [
  { id: 'status',       label: 'Status dos Relógios' },
  { id: 'employees',    label: 'Funcionários' },
  { id: 'audit',        label: 'Auditoria LGPD' },
]

export function RhModule({ onClose }) {
  const [tab,      setTab]      = useState('status')
  const [auditLog, setAuditLog] = useState(null)
  const [auditLoading, setAuditLoading] = useState(false)

  async function loadAudit() {
    setAuditLoading(true)
    try {
      const [ops, off] = await Promise.all([
        api.rh.getOperationLog(100),
        api.rh.getOffboardLog(50),
      ])
      setAuditLog({ operations: ops, offboards: off })
    } catch (_) {}
    setAuditLoading(false)
  }

  function handleTabChange(id) {
    setTab(id)
    if (id === 'audit' && !auditLog) loadAudit()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#111', borderRadius: 12, border: '1px solid #2a2a2a',
        width: '92vw', maxWidth: 1100, maxHeight: '88vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid #1e1e1e' }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Módulo RH — Relógios Henry Hexa</span>
          <div style={{ display: 'flex', gap: 8, marginLeft: 24 }}>
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => handleTabChange(t.id)}
                style={{
                  padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
                  background: tab === t.id ? '#1a3a6a' : '#1a1a1a',
                  color:      tab === t.id ? '#8af' : '#888',
                  border: `1px solid ${tab === t.id ? '#2a5aaa' : '#2a2a2a'}`,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button onClick={onClose} style={{ marginLeft: 'auto', padding: '4px 12px', background: '#2a1a1a', color: '#e88', border: '1px solid #5a2a2a', borderRadius: 6, cursor: 'pointer' }}>
            Fechar
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {tab === 'status'    && <ClockStatusGrid />}
          {tab === 'employees' && <EmployeeTable />}
          {tab === 'audit'     && <AuditLog data={auditLog} loading={auditLoading} onRefresh={loadAudit} />}
        </div>
      </div>
    </div>
  )
}

function AuditLog({ data, loading, onRefresh }) {
  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: '#888' }}>Carregando...</div>

  const rows = [
    ...(data?.offboards || []).map(r => ({ ...r, operation: 'offboard' })),
    ...(data?.operations || []).filter(r => r.operation !== 'offboard'),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  const opLabel = { offboard: '🗑 Remoção LGPD', enroll: '✅ Cadastro', update_card: '💳 Cartão NFC' }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <button onClick={onRefresh} style={{ padding: '5px 12px', background: '#1a2a3a', color: '#8af', border: '1px solid #2a4a6a', borderRadius: 6, cursor: 'pointer' }}>
          Atualizar
        </button>
        <span style={{ fontSize: 13, color: '#666', alignSelf: 'center' }}>{rows.length} registros</span>
      </div>
      {rows.length === 0 && <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>Nenhuma operação registrada ainda.</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#1a1a2a' }}>
            {['Data/Hora', 'Operação', 'Funcionário', 'CPF', 'Acionado por', 'Resultado'].map(h => (
              <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#aaa', borderBottom: '1px solid #2a2a2a' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #141414' }}>
              <td style={{ padding: '7px 10px', color: '#888', whiteSpace: 'nowrap' }}>{new Date(r.timestamp).toLocaleString('pt-BR')}</td>
              <td style={{ padding: '7px 10px' }}>{opLabel[r.operation] || r.operation}</td>
              <td style={{ padding: '7px 10px' }}>{r.employee_name || r.employeeName || '-'}</td>
              <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: 12 }}>{r.cpf}</td>
              <td style={{ padding: '7px 10px', color: '#888' }}>{r.triggered_by || r.triggeredBy || '-'}</td>
              <td style={{ padding: '7px 10px' }}>
                {r.success
                  ? <span style={{ color: '#5a5' }}>✅ {r.removed ?? r.ok_count ?? 0} OK{r.failed ? `, ${r.failed ?? r.failed_count} falha(s)` : ''}</span>
                  : <span style={{ color: '#a55' }}>❌ Falha</span>
                }
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/RhModule.jsx
git commit -m "feat(dashboard): add RhModule with status/employees/audit tabs"
```

---

## Task 9: Integração no App.jsx

**Files:**
- Modify: `dashboard/src/App.jsx`

- [ ] **Step 1: Importar RhModule no App.jsx**

Adicionar com os outros imports no topo do arquivo:

```jsx
import { RhModule } from './components/RhModule'
```

- [ ] **Step 2: Adicionar estado `showRh` junto com os outros estados do App.jsx**

Após `const [showAlertsPanel, setShowAlertsPanel] = useState(false)`:

```jsx
const [showRh, setShowRh] = useState(false)
```

- [ ] **Step 3: Adicionar botão "RH" na topbar do App.jsx**

Localizar onde ficam os botões de Alertas/Insights na topbar (próximo a `setShowAlertsPanel`) e adicionar:

```jsx
<button
  onClick={() => setShowRh(true)}
  title="Módulo RH — Relógios e Funcionários"
  style={{
    padding: '5px 12px',
    background: '#0d2b0d',
    color: '#5e5',
    border: '1px solid #1a5a1a',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  }}
>
  RH
</button>
```

- [ ] **Step 4: Renderizar RhModule no JSX do App.jsx**

Adicionar antes do último `</div>` de fechamento do componente App:

```jsx
{showRh && <RhModule onClose={() => setShowRh(false)} />}
```

- [ ] **Step 5: Fazer build e verificar**

```powershell
cd F:\RichClub
npm run build
```

Esperado: build completo sem erros.

- [ ] **Step 6: Commit e push**

```bash
git add dashboard/src/App.jsx dashboard/src/components/RhModule.jsx
git commit -m "feat(dashboard): add RH button and module integration in App"
git push origin master
```

---

## Roteiro de Testes Pós-Implementação

### Ponto 1 — Status dos relógios
```powershell
# No Servidor Skill
$h = @{Authorization="Bearer <CLOCK_PROXY_TOKEN>"}
Invoke-RestMethod http://localhost:4321/rh/clocks/status -Headers $h | ConvertTo-Json -Depth 3
```
Esperado: JSON com `reachable` e `unreachable` por IP. Metropolitano provavelmente `reachable: false`.

### Ponto 2 — Comparação de funcionários
No dashboard Electron: clicar "RH" → aba "Funcionários" → "Carregar Funcionários".
Aguardar (pode demorar 5-15min dependendo de quantos relógios estiverem acessíveis).
Verificar coluna de divergências.

### Ponto 3 — CRUD
- **Cadastrar:** filtrar um funcionário divergente → "Sincronizar" → preencher matrícula → confirmar
- **Remover (LGPD):** selecionar funcionário → "Remover" → confirmar modal
- **Auditoria:** aba "Auditoria LGPD" → verificar log com resultado por relógio

---

## Limitações Conhecidas

1. **Biometria (digital):** não é possível sincronizar via web UI. O cadastro textual é sincronizado, mas o funcionário precisa registrar a digital fisicamente em cada relógio novo.
2. **Velocidade:** buscar funcionários de 9 relógios leva ~5-15min (Playwright + servidor embarcado lento). Não usar em tempo real.
3. **Ref1/Ref2 na lista:** o parsing de ref1/ref2 da coluna de refs depende do formato que o Henry Hexa exibe na listagem. Se o formato não for `ref1 / ref2`, os campos aparecerão como string bruta no campo `refs` e vazios em `ref1`/`ref2`. Nesse caso, o usuário precisará informar a matrícula manualmente no form de sincronização.
