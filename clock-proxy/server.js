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
const LGPD_DIR           = process.env.LGPD_DIR           || 'G:\\CENTRAL\\LGPD\\06_Evidências_e_Registros\\Exclusoes_Biometria';
const LGPD_EXPLORER_PATH = process.env.LGPD_EXPLORER_PATH || '\\\\fileservergeral.file.core.windows.net\\escritoriocentral\\CENTRAL\\LGPD\\06_Evidências_e_Registros\\Exclusoes_Biometria';

const IP_TO_STORE = {
  '192.168.15.151': 'Gávea',
  '192.168.14.151': 'Metro',
  '192.168.12.151': 'Bshop',
  '192.168.0.151':  'Assembleia',
  '192.168.13.151': 'Città',
  '192.168.18.151': 'Ipanema',
  '192.168.16.151': 'Rio Sul',
  '192.168.20.151': 'Tijuca',
  '192.168.10.150': 'Niterói',
};

// ─── PER-IP OPERATION QUEUE ───────────────────────────────────────────────────
// Serializes Playwright browser sessions per clock IP.
// Prevents concurrent sessions from hitting the same clock simultaneously,
// which caused race conditions and crashes under multi-user load.
class ClockQueue {
  constructor() {
    this._tails   = {}; // ip → promise (tail of the chain — always resolves)
    this._pending = {}; // ip → count of queued+running operations
  }

  run(ip, fn) {
    const count = (this._pending[ip] = (this._pending[ip] || 0) + 1);
    if (count > 1) {
      console.log(`[ClockQueue] ${IP_TO_STORE[ip] || ip}: enfileirando (${count - 1} aguardando)`);
    }
    const prev = this._tails[ip] || Promise.resolve();
    // Run fn() regardless of whether prev succeeded or failed
    const tail = prev.then(() => fn(), () => fn());
    // The stored tail always resolves so the next item always runs
    this._tails[ip] = tail.then(() => {}, () => {});
    tail.finally(() => { this._pending[ip]--; });
    return tail;
  }

  pending(ip) {
    return this._pending[ip] || 0;
  }
}

const clockQueue = new ClockQueue();

// ─── GLOBAL PLAYWRIGHT SEMAPHORE ─────────────────────────────────────────────
// Limits the TOTAL number of concurrent Chrome/Playwright instances across ALL
// operations (scan + enroll + offboard + card update) to MAX_PW_SLOTS.
// The ClockQueue above serializes per-IP; this semaphore caps the global total.
// With MAX_PW_SLOTS=2: at most 2 Chrome processes = ~300MB RAM, safe on Servidor Skill.
const MAX_PW_SLOTS = 2;
let _pwSlots = MAX_PW_SLOTS;
const _pwQueue = [];

async function withPlaywrightSlot(fn) {
  if (_pwSlots <= 0) {
    await new Promise(resolve => _pwQueue.push(resolve));
  }
  _pwSlots--;
  try {
    return await fn();
  } finally {
    _pwSlots++;
    if (_pwQueue.length > 0) _pwQueue.shift()();
  }
}

function writeLgpdKit(summary) {
  try {
    const safeName = (summary.employeeName || 'DESCONHECIDO')
      .replace(/[\\/:*?"<>|]/g, '_')
      .toUpperCase();
    const safeCpf    = summary.cpf.replace(/[\\/:*?"<>|]/g, '_');
    const tsFolder   = summary.timestamp.replace(/:/g, '-').replace('T', '_').replace(/\..+$/, '');
    const folderName = `${safeName}_${safeCpf}_${tsFolder}`;
    const folderPath = path.join(LGPD_DIR, folderName);

    fs.mkdirSync(folderPath, { recursive: true });

    // log-remocao.json — registro estruturado completo
    fs.writeFileSync(
      path.join(folderPath, 'log-remocao.json'),
      JSON.stringify(summary, null, 2),
      'utf8',
    );

    // comprovante.txt — leitura humana para arquivo LGPD
    const dtBR = new Date(summary.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const lines = [
      '=================================================',
      '  COMPROVANTE DE EXCLUSÃO DE DADOS BIOMÉTRICOS',
      '  Delírio Tropical — LGPD Art. 15 e 16',
      '=================================================',
      '',
      `Funcionário : ${summary.employeeName || '—'}`,
      `CPF         : ${summary.cpf}`,
      `Data/Hora   : ${dtBR}`,
      `Operador    : ${summary.triggeredBy || 'dashboard'}`,
      '',
      '-------------------------------------------------',
      'RELÓGIOS PROCESSADOS',
      '-------------------------------------------------',
    ];

    for (const c of summary.clocks) {
      const store  = IP_TO_STORE[c.clockIp] || c.clockIp;
      const icon   = c.success && !c.alreadyAbsent ? '✓' : c.alreadyAbsent ? '~' : '✗';
      const status = c.success && !c.alreadyAbsent ? 'Removido com sucesso'
                   : c.alreadyAbsent               ? 'Já ausente (não cadastrado)'
                   :                                  'Falhou';
      lines.push(`${icon} ${store.padEnd(14)} (${c.clockIp}) — ${status}`);
    }

    lines.push(
      '',
      '-------------------------------------------------',
      'RESUMO',
      '-------------------------------------------------',
      `Relógios processados  : ${summary.total}`,
      `Removidos com sucesso : ${summary.removed}`,
      `Já ausentes           : ${summary.alreadyAbsent}`,
      `Falhas                : ${summary.failed}`,
      '',
      '-------------------------------------------------',
      'DECLARAÇÃO',
      '-------------------------------------------------',
      'Os dados biométricos (impressões digitais e',
      'credenciais NFC) do titular identificado acima',
      'foram excluídos dos sistemas de controle de',
      'acesso/ponto da Delírio Tropical Ltda.,',
      'em conformidade com a Lei nº 13.709/2018',
      '(LGPD), Art. 15 e 16.',
      '',
      'Este documento é válido como comprovante de',
      'eliminação de dados pessoais sensíveis.',
      '=================================================',
    );

    fs.writeFileSync(
      path.join(folderPath, 'comprovante.txt'),
      lines.join('\r\n'),
      'utf8',
    );

    const explorerPath = path.join(LGPD_EXPLORER_PATH, folderName);
    console.log(`[LGPD] Kit salvo em: ${folderPath} | UNC: ${explorerPath}`);
    return { lgpdExplorerPath: explorerPath, lgpdExplorerBase: LGPD_EXPLORER_PATH };
  } catch (err) {
    console.error(`[LGPD] Erro ao salvar kit: ${err.message}`);
    return { lgpdError: err.message };
  }
}


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
  const result = await clockQueue.run(ip, () => withPlaywrightSlot(() => henry.deleteEmployee(cpf)));

  console.log(`[${new Date().toISOString()}] OFFBOARD resultado: ${JSON.stringify(result)}`);
  res.json(result);
});

// ─── ONBOARDING ──────────────────────────────────────────────────────────────
// Cadastra funcionário em um relógio específico
// Body: { cpf, name, ref1, ref2, password }
app.post('/clock/:ip/enroll', async (req, res) => {
  const { ip } = req.params;
  const { cpf, name, ref1, ref2, password } = req.body;

  if (!cpf || !name || !ref1) return res.status(400).json({ error: 'cpf, name e ref1 (matrícula) são obrigatórios' });

  console.log(`[${new Date().toISOString()}] ENROLL ${cpf} (${name}) ref1=${ref1} em ${ip}`);

  const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await clockQueue.run(ip, () => withPlaywrightSlot(() => henry.enrollEmployee({ cpf, name, ref1, ref2, password })));

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
  const result = await clockQueue.run(ip, () => withPlaywrightSlot(() => henry.updateCardRef2(cpf, ref2)));

  res.json(result);
});

// ─── LISTAR FUNCIONÁRIOS ─────────────────────────────────────────────────────
// Lista todos os funcionários cadastrados em um relógio
app.get('/clock/:ip/employees', async (req, res) => {
  const { ip } = req.params;

  const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await clockQueue.run(ip, () => withPlaywrightSlot(() => henry.listEmployees()));

  res.json(result);
});

// ─── DEBUG — ESTRUTURA REAL DA TABELA ────────────────────────────────────────
// Retorna dados brutos das primeiras 5 linhas para diagnóstico de colunas.
app.get('/clock/:ip/employees/debug', async (req, res) => {
  const { ip } = req.params;
  if (!CLOCK_IPS.includes(ip)) return res.status(400).json({ error: 'IP nao configurado' });
  const henry  = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await clockQueue.run(ip, () => withPlaywrightSlot(() => henry.debugListEmployees()));
  res.json(result);
});

// ─── OFFBOARD LGPD — TODOS OS RELÓGIOS ───────────────────────────────────────
// Chamado pelo Delirio Manager (Azure) no desligamento de funcionário.
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
    const result = await clockQueue.run(ip, () => withPlaywrightSlot(() => henry.deleteEmployee(cpf)));
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

  const lgpdResult = writeLgpdKit(summary);
  res.json({ ...summary, ...lgpdResult });
});

// ─── LGPD INFO ───────────────────────────────────────────────────────────────
// Retorna o caminho UNC da pasta de evidências LGPD (para o Electron abrir no Explorer)
app.get('/rh/lgpd-info', (req, res) => {
  res.json({ explorerPath: LGPD_EXPLORER_PATH });
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
let _empJobState       = 'idle'; // 'idle' | 'running'
let _empCache          = null;   // resultado completo ou { error: msg }
let _empCacheAt        = 0;
let _clockResults      = [];     // dados brutos por relógio — persistidos para partial refresh
let _pendingRefreshIps = null;   // IPs aguardando partial refresh enquanto job está rodando
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
// Todos os IPs são processados em PARALELO, cada um na sua própria fila.
// Isso reduz o tempo de scan de ~270s (sequencial) para ~30-60s (limitado pelo mais lento).
async function runEmployeesInBackground(targetIps) {
  _empJobState = 'running';

  // Partial refresh: garante que _clockResults terá dados de TODOS os CLOCK_IPS ao final.
  if (targetIps) {
    const cachedIps = new Set(_clockResults.map(r => r.ip));
    const uncached  = CLOCK_IPS.filter(ip => !cachedIps.has(ip) && !targetIps.includes(ip));
    if (uncached.length > 0) targetIps = [...targetIps, ...uncached];
  }

  const ips          = targetIps || CLOCK_IPS;
  const isFullRefresh = !targetIps;
  if (isFullRefresh) _clockResults = [];

  try {
    if (CLOCK_IPS.length === 0) throw new Error('CLOCK_IPS nao configurado no .env');

    // Scan em lotes de 3 IPs por vez: limita Chromium simultâneos para evitar OOM.
    // A ClockQueue garante que operações de usuário aguardam na fila por IP sem bloquear os demais.
    const SCAN_BATCH = 3;
    for (let i = 0; i < ips.length; i += SCAN_BATCH) {
      const batch = ips.slice(i, i + SCAN_BATCH);
      await Promise.allSettled(batch.map(async (ip) => {
        const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);

        // Pré-verifica acessibilidade antes de abrir Playwright (5s timeout via HTTP simples)
        const reach = await henry.checkReachable();
        if (!reach.reachable) {
          console.warn(`[/rh/employees] ${ip}: offline (${reach.error}) — pulando Playwright`);
          const clockResult = { ip, success: false, employees: [], total: 0, message: 'Relógio offline' };
          const idx = _clockResults.findIndex(r => r.ip === ip);
          if (idx >= 0) _clockResults[idx] = clockResult;
          else          _clockResults.push(clockResult);
          return;
        }

        console.log(`[${new Date().toISOString()}] Buscando funcionarios de ${ip}...`);
        const result = await clockQueue.run(ip, () => withPlaywrightSlot(() => henry.listEmployees()));
        if (!result.success) console.warn(`[/rh/employees] ${ip}: falhou — ${result.message}`);

        const clockResult = { ip, ...result };
        const idx = _clockResults.findIndex(r => r.ip === ip);
        if (idx >= 0) _clockResults[idx] = clockResult;
        else          _clockResults.push(clockResult);
      }));
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
    // Se houve partial refresh acumulado durante este job, executa agora
    const pending = _pendingRefreshIps;
    _pendingRefreshIps = null;
    if (pending && pending.length > 0) {
      console.log(`[/rh/employees] Iniciando partial refresh pendente: ${pending.join(', ')}`);
      setTimeout(() => runEmployeesInBackground(pending), 0);
    }
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
    // Acumula IPs — serão atualizados automaticamente quando o job atual terminar
    _pendingRefreshIps = _pendingRefreshIps
      ? [...new Set([..._pendingRefreshIps, ...clockIps])]
      : [...clockIps];
    return res.status(202).json({ status: 'running', queued: clockIps });
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
      const reach = await henry.checkReachable();
      if (!reach.reachable) {
        console.warn(`[/rh/enroll] ${ip}: offline — pulando`);
        results.push({ clockIp: ip, success: false, offline: true, message: `Relógio offline: ${reach.error || 'sem resposta'}` });
        continue;
      }
      const result = await clockQueue.run(ip, () => withPlaywrightSlot(() => henry.enrollEmployee({ cpf, name, ref1, ref2, password })));
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
      const result = await clockQueue.run(ip, () => withPlaywrightSlot(() => henry.updateCardRef2(cpf, ref2)));
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
