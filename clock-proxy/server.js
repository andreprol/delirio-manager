require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const { HenryHexa } = require('./henry-hexa');

const app = express();
const PORT       = process.env.PORT       || 4321;
const API_TOKEN  = process.env.API_TOKEN;
const CLOCK_USER = process.env.CLOCK_USER;
const CLOCK_PASS = process.env.CLOCK_PASS;
const CLOCK_IPS  = (process.env.CLOCK_IPS || '')
  .split(',').map(ip => ip.trim()).filter(Boolean);

if (!API_TOKEN || !CLOCK_USER || !CLOCK_PASS) {
  console.error('ERRO: API_TOKEN, CLOCK_USER e CLOCK_PASS sao obrigatorios no .env');
  process.exit(1);
}

app.use(express.json());

// Health check sem autenticação (usado pelo Delirio Manager para checar se o proxy está vivo)
app.get('/health', (req, res) => res.json({ ok: true, service: 'dt-clock-proxy' }));

// Middleware de autenticação Bearer
app.use((req, res, next) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${API_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── OFFBOARDING (LGPD Art. 15/16) ──────────────────────────────────────────
// Remove funcionário de um relógio específico
// Body: { cpf, employeeName, triggeredBy }
app.post('/clock/:ip/offboard', async (req, res) => {
  const { ip } = req.params;
  const { cpf, employeeName, triggeredBy } = req.body;

  if (!cpf) return res.status(400).json({ error: 'cpf obrigatório' });

  console.log(`[${new Date().toISOString()}] OFFBOARD ${cpf} (${employeeName}) em ${ip} — por ${triggeredBy}`);

  const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await henry.deleteEmployee(cpf);

  console.log(`[${new Date().toISOString()}] OFFBOARD resultado: ${JSON.stringify(result)}`);
  res.json(result);
});

// ─── ONBOARDING ──────────────────────────────────────────────────────────────
// Cadastra funcionário em um relógio específico
// Body: { cpf, name, ref1, ref2, password }
// ref1 (matrícula) é obrigatório pelo relógio — sem ele o save retorna "Parâmetros inválidos"
app.post('/clock/:ip/enroll', async (req, res) => {
  const { ip } = req.params;
  const { cpf, name, ref1, ref2, password } = req.body;

  if (!cpf || !name || !ref1) return res.status(400).json({ error: 'cpf, name e ref1 (matrícula) são obrigatórios' });

  console.log(`[${new Date().toISOString()}] ENROLL ${cpf} (${name}) ref1=${ref1} em ${ip}`);

  const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await henry.enrollEmployee({ cpf, name, ref1, ref2, password });

  console.log(`[${new Date().toISOString()}] ENROLL resultado: ${JSON.stringify(result)}`);
  res.json(result);
});

// ─── ATUALIZAR CARTÃO ────────────────────────────────────────────────────────
// Atualiza Referência 2 (UID do cartão NFC) de um funcionário
// Body: { cpf, ref2 }
app.put('/clock/:ip/card', async (req, res) => {
  const { ip } = req.params;
  const { cpf, ref2 } = req.body;

  if (!cpf || !ref2) return res.status(400).json({ error: 'cpf e ref2 obrigatórios' });

  const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await henry.updateCardRef2(cpf, ref2);

  res.json(result);
});

// ─── LISTAR FUNCIONÁRIOS ─────────────────────────────────────────────────────
// Lista todos os funcionários cadastrados em um relógio
app.get('/clock/:ip/employees', async (req, res) => {
  const { ip } = req.params;

  const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await henry.listEmployees();

  res.json(result);
});

// ─── DEBUG — ESTRUTURA REAL DA TABELA ────────────────────────────────────────
// Retorna dados brutos das primeiras 5 linhas para diagnóstico de colunas.
// Usar para confirmar quantas colunas existem e o que cada uma contém.
app.get('/clock/:ip/employees/debug', async (req, res) => {
  const { ip } = req.params;
  if (!CLOCK_IPS.includes(ip)) return res.status(400).json({ error: 'IP nao configurado' });
  const henry  = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await henry.debugListEmployees();
  res.json(result);
});

// ─── OFFBOARD LGPD — TODOS OS RELÓGIOS ───────────────────────────────────────
// Chamado pelo Delirio Manager (Azure) no desligamento de funcionário.
// Remove o funcionário de todos os relógios configurados em CLOCK_IPS.
// Body: { cpf, employeeName, triggeredBy }
app.post('/rh/offboard', async (req, res) => {
  const { cpf, employeeName, triggeredBy } = req.body;

  if (!cpf) return res.status(400).json({ error: 'cpf obrigatorio' });

  if (CLOCK_IPS.length === 0) {
    return res.status(500).json({ error: 'CLOCK_IPS nao configurado no .env do servidor' });
  }

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] RH OFFBOARD ${cpf} (${employeeName}) em ${CLOCK_IPS.length} relogios — por ${triggeredBy}`);

  const results = [];
  for (const ip of CLOCK_IPS) {
    const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
    const result = await henry.deleteEmployee(cpf);
    results.push({ clockIp: ip, ...result });
    console.log(`[${new Date().toISOString()}] ${ip}: ${result.success ? 'OK' : result.alreadyAbsent ? 'JA_AUSENTE' : 'FALHOU'}`);
  }

  const summary = {
    success:       results.every(r => r.success || r.alreadyAbsent),
    cpf,
    employeeName,
    triggeredBy,
    timestamp,
    clocks:        results,
    total:         results.length,
    removed:       results.filter(r => r.success && !r.alreadyAbsent).length,
    alreadyAbsent: results.filter(r => r.alreadyAbsent).length,
    failed:        results.filter(r => !r.success && !r.alreadyAbsent).length,
  };

  res.json(summary);
});

// ─── STATUS DE TODOS OS RELÓGIOS ─────────────────────────────────────────────
// Verifica acessibilidade de cada relógio em paralelo (checkReachable, ~5s)
app.get('/rh/clocks/status', async (req, res) => {
  try {
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
      total:       results.length,
      reachable:   results.filter(r => r.reachable).length,
      unreachable: results.filter(r => !r.reachable).length,
      clocks:      results,
      timestamp:   new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/rh/clocks/status]', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ─── FUNCIONÁRIOS DE TODOS OS RELÓGIOS ───────────────────────────────────────
// Assíncrono: inicia job em background, retorna 202 imediatamente.
// Polling: chamar GET /rh/employees até receber 200 com dados.
// Partial refresh: POST /rh/employees/refresh com { clockIps: [...] } atualiza IPs específicos.
let _empJobState  = 'idle'; // 'idle' | 'running'
let _empCache     = null;   // resultado completo ou { error: msg }
let _empCacheAt   = 0;
let _clockResults = [];     // dados brutos por relógio — persistidos para partial refresh
const EMP_CACHE_TTL = 10 * 60 * 1000;

function buildMasterCache(clockResults) {
  const clockRef2Map = {};
  for (const clock of clockResults) {
    if (!clock.success) continue;
    clockRef2Map[clock.ip] = {};
    for (const emp of clock.employees) {
      clockRef2Map[clock.ip][emp.cpf] = emp.ref2 || '';
    }
  }

  const masterMap = new Map();
  for (const clock of clockResults) {
    if (!clock.success) continue;
    for (const emp of clock.employees) {
      if (!masterMap.has(emp.cpf)) {
        masterMap.set(emp.cpf, {
          name: emp.name, cpf: emp.cpf, ref1: emp.ref1, ref2: emp.ref2,
          presentIn: [], absentIn: [],
        });
      } else {
        const existing = masterMap.get(emp.cpf);
        if (!existing.ref2 && emp.ref2) existing.ref2 = emp.ref2;
        if (!existing.ref1 && emp.ref1) existing.ref1 = emp.ref1;
      }
      masterMap.get(emp.cpf).presentIn.push(clock.ip);
    }
  }

  const reachableIps = clockResults.filter(r => r.success).map(r => r.ip);
  for (const emp of masterMap.values()) {
    emp.absentIn     = reachableIps.filter(ip => !emp.presentIn.includes(ip));
    emp.incompleteIn = emp.ref2
      ? reachableIps.filter(ip => emp.presentIn.includes(ip) && !clockRef2Map[ip]?.[emp.cpf])
      : [];
  }

  const employees  = Array.from(masterMap.values());
  const divergent  = employees.filter(e => e.absentIn.length > 0);
  const incomplete = employees.filter(e => e.incompleteIn.length > 0);
  return {
    total:        employees.length,
    divergent:    divergent.length,
    incomplete:   incomplete.length,
    synchronized: employees.length - divergent.length,
    employees,
    clocks: clockResults.map(r => ({
      ip: r.ip, success: r.success, total: r.total || 0, error: r.message,
    })),
    allClockIps: CLOCK_IPS,
    timestamp:   new Date().toISOString(),
  };
}

// targetIps: undefined = full refresh (todos CLOCK_IPS); array = partial refresh (só esses IPs)
async function runEmployeesInBackground(targetIps) {
  _empJobState = 'running';
  const ips          = targetIps || CLOCK_IPS;
  const isFullRefresh = !targetIps;
  if (isFullRefresh) _clockResults = [];

  try {
    if (CLOCK_IPS.length === 0) throw new Error('CLOCK_IPS nao configurado no .env');

    let playwrightRan = false; // controla o intervalo de 10s entre sessões Playwright
    for (let i = 0; i < ips.length; i++) {
      const ip    = ips[i];
      const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);

      // Pré-verifica acessibilidade antes de abrir Playwright (5s timeout via HTTP simples)
      // Relógios offline são marcados como falha e pulados — evita aguardar timeout por Playwright
      const reach = await henry.checkReachable();
      if (!reach.reachable) {
        console.warn(`[/rh/employees] ${ip}: offline (${reach.error}) — pulando Playwright`);
        const clockResult = { ip, success: false, employees: [], total: 0, message: 'Relógio offline' };
        const idx = _clockResults.findIndex(r => r.ip === ip);
        if (idx >= 0) _clockResults[idx] = clockResult;
        else          _clockResults.push(clockResult);
        continue;
      }

      // Aguarda 10s entre sessões Playwright para não sobrecarregar o servidor embutido do relógio
      if (playwrightRan) await new Promise(r => setTimeout(r, 10000));

      console.log(`[${new Date().toISOString()}] Buscando funcionarios de ${ip}...`);
      const result = await henry.listEmployees();
      playwrightRan = true;
      if (!result.success) console.warn(`[/rh/employees] ${ip}: falhou — ${result.message}`);

      const clockResult = { ip, ...result };
      const idx = _clockResults.findIndex(r => r.ip === ip);
      if (idx >= 0) _clockResults[idx] = clockResult;
      else          _clockResults.push(clockResult);
    }

    _empCache   = buildMasterCache(_clockResults);
    _empCacheAt = Date.now();
    console.log(`[/rh/employees] Job concluído — ${_empCache.total} funcionários, ${_empCache.divergent} divergentes, ${_empCache.incomplete} incompletos`);
  } catch (err) {
    console.error('[/rh/employees bg]', err.message);
    _empCache   = { error: err.message };
    _empCacheAt = Date.now();
  } finally {
    _empJobState = 'idle';
  }
}

// Job state é verificado ANTES do cache para que partial refresh cause polling correto
app.get('/rh/employees', (req, res) => {
  if (_empJobState === 'running') {
    return res.status(202).json({ status: 'running' });
  }
  if (_empCache && !_empCache.error && (Date.now() - _empCacheAt) < EMP_CACHE_TTL) {
    return res.json({ ..._empCache, cached: true });
  }
  runEmployeesInBackground();
  return res.status(202).json({ status: 'started' });
});

// POST /rh/employees/refresh — atualiza leitura de relógios específicos sem descartar os demais
// Body: { clockIps: ["192.168.x.x", ...] }
app.post('/rh/employees/refresh', (req, res) => {
  const { clockIps } = req.body || {};
  if (!clockIps || !Array.isArray(clockIps) || clockIps.length === 0) {
    return res.status(400).json({ error: 'clockIps array obrigatorio' });
  }
  const invalid = clockIps.filter(ip => !CLOCK_IPS.includes(ip));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `IPs nao permitidos: ${invalid.join(', ')}` });
  }
  if (_empJobState === 'running') {
    return res.status(202).json({ status: 'running' });
  }
  runEmployeesInBackground(clockIps);
  return res.status(202).json({ status: 'started', clockIps });
});

// ─── CADASTRO EM TODOS OS RELÓGIOS ───────────────────────────────────────────
// Body: { cpf, name, ref1, ref2, password, clockIps? }
// clockIps (optional array): subset of IPs to enroll. Defaults to CLOCK_IPS.
app.post('/rh/enroll', async (req, res) => {
  try {
    const { cpf, name, ref1, ref2, password, clockIps } = req.body;

    if (!cpf || !name || !ref1) {
      return res.status(400).json({ error: 'cpf, name e ref1 (matricula) sao obrigatorios' });
    }

    const targets = clockIps || CLOCK_IPS;
    if (clockIps) {
      const invalid = clockIps.filter(ip => !CLOCK_IPS.includes(ip));
      if (invalid.length > 0) {
        return res.status(400).json({ error: `IPs nao permitidos: ${invalid.join(', ')}` });
      }
    }
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
  } catch (err) {
    console.error('[/rh/enroll]', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ─── ATUALIZAR CARTÃO EM TODOS OS RELÓGIOS ───────────────────────────────────
// Body: { cpf, ref2, clockIps? }
app.put('/rh/employee', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('[/rh/employee]', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ─── DEPLOY REMOTO ───────────────────────────────────────────────────────────
// Recebe arquivos como base64, salva em disco e reinicia o processo.
// Body: { files: { "server.js": "<base64>", "henry-hexa.js": "<base64>" } }
app.post('/deploy', (req, res) => {
  const { files } = req.body;
  if (!files || typeof files !== 'object') {
    return res.status(400).json({ error: 'files obrigatorio' });
  }

  const ALLOWED = new Set(['server.js', 'henry-hexa.js']);
  const TARGET  = process.cwd();
  const results = {};

  for (const [name, b64] of Object.entries(files)) {
    if (!ALLOWED.has(name)) {
      results[name] = { ok: false, error: 'arquivo nao permitido' };
      continue;
    }
    try {
      fs.writeFileSync(path.join(TARGET, name), Buffer.from(b64, 'base64'));
      results[name] = { ok: true };
    } catch (e) {
      results[name] = { ok: false, error: e.message };
    }
  }

  const written = Object.values(results).filter(r => r.ok).length;
  if (written === 0) {
    return res.status(400).json({ success: false, error: 'Nenhum arquivo permitido foi escrito', files: results });
  }
  const failed = Object.values(results).some(r => !r.ok);
  if (failed) {
    return res.status(500).json({ success: false, files: results });
  }

  res.json({ success: true, files: results, message: 'Reiniciando em 2s...' });

  // PM2 reinicia automaticamente quando o processo sai — mais confiável que spawn PowerShell
  setTimeout(() => process.exit(0), 2000);
});

// Escuta em todas as interfaces para ser acessível via LAN/VPN pelo backend Azure
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dt-clock-proxy] Rodando em 0.0.0.0:${PORT}`);
  console.log(`[dt-clock-proxy] Relogios configurados: ${CLOCK_IPS.length > 0 ? CLOCK_IPS.join(', ') : 'NENHUM — configure CLOCK_IPS no .env'}`);
});
