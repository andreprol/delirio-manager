'use strict';

// Rotas de RH — integração com o dt-clock-proxy para LGPD Art. 15/16
// O clock-proxy roda no Servidor Skill e controla os relógios Henry Hexa ADV.
// Conectividade: Azure VM → Servidor Skill via VPN ou IP acessível (CLOCK_PROXY_URL no .env).

const express = require('express');
const https   = require('https');
const http    = require('http');
const router  = express.Router();
const db      = require('../db-pg');
const { asyncHandler } = require('../middleware/asyncHandler');

const CLOCK_PROXY_URL   = process.env.CLOCK_PROXY_URL   || 'http://192.168.17.252:4321';
const CLOCK_PROXY_TOKEN = process.env.CLOCK_PROXY_TOKEN || '';

// Conexao (VPN/rede da loja fora do ar) tem que falhar rapido -- so a RESPOSTA
// (scan de funcionarios pode demorar minutos de verdade) justifica timeout longo.
// Sem isso, um tunel caido prende o socket ate 300s por chamada e derruba o
// servidor inteiro (ver project_delirio_manager_incidente_rh_healthmonitor_27_11.md).
const CONNECT_TIMEOUT_MS  = 5000;
const RESPONSE_TIMEOUT_MS = 300000;

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
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 202) return resolve({ ...parsed, _statusCode: 202 });
          if (res.statusCode >= 400) {
            const err = new Error(parsed.error || `clock-proxy HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.body = parsed;
            return reject(err);
          }
          resolve(parsed);
        }
        catch (_) { resolve({ error: data }); }
      });
    });

    req.on('error', reject);

    // Limpa no 'close' (nao so no 'connect') -- cobre tambem erro de rede
    // explicito (ECONNREFUSED/ENETUNREACH) antes do socket conectar, que senao
    // deixava o timer armado pra disparar depois num request ja morto.
    let connectTimer = null;
    const clearConnectTimer = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    };
    req.on('socket', (socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => {
        req.destroy(new Error(`Timeout ao conectar em ${url.hostname}:${options.port} apos ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', clearConnectTimer);
    });
    req.once('close', clearConnectTimer);

    req.setTimeout(RESPONSE_TIMEOUT_MS, () => req.destroy(new Error(`Timeout apos ${RESPONSE_TIMEOUT_MS / 1000}s`)));
    if (!isGet) req.write(payload);
    req.end();
  });
}

// ── Helpers for POST /offboard ────────────────────────────────────────────────

function buildOffboardPayload(cpf, employeeName, triggeredBy) {
  return {
    cpf,
    employeeName: employeeName || '',
    triggeredBy:  triggeredBy  || 'delirio-manager-rh',
  };
}

function buildOffboardSuccessLog(cpf, employeeName, triggeredBy, timestamp, result) {
  return {
    cpf,
    employeeName:  employeeName         || '',
    triggeredBy:   triggeredBy          || 'delirio-manager-rh',
    timestamp,
    success:       result.success ? 1 : 0,
    removed:       result.removed       || 0,
    alreadyAbsent: result.alreadyAbsent || 0,
    failed:        result.failed        || 0,
    detail:        JSON.stringify(result.clocks || []),
  };
}

function buildOffboardFailureLog(cpf, employeeName, triggeredBy, timestamp, err) {
  return {
    cpf,
    employeeName:  employeeName || '',
    triggeredBy:   triggeredBy  || 'delirio-manager-rh',
    timestamp,
    success:      0,
    removed:      0,
    alreadyAbsent:0,
    failed:       -1,
    detail:       JSON.stringify({ error: err.message }),
  };
}

// POST /api/rh/offboard
// Dispara o offboarding LGPD de um funcionário em todos os relógios.
// Body: { cpf, employeeName, triggeredBy }
router.post('/offboard', async (req, res) => {
  const { cpf, employeeName, triggeredBy } = req.body;

  if (!cpf)          return res.status(400).json({ error: 'cpf obrigatorio' });
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado no servidor' });
  }

  const timestamp = new Date().toISOString();

  try {
    const result = await callClockProxy('/rh/offboard', buildOffboardPayload(cpf, employeeName, triggeredBy));
    // Log de auditoria LGPD — evidência para ANPD
    await db.logClockOffboard(buildOffboardSuccessLog(cpf, employeeName, triggeredBy, timestamp, result));
    res.json(result);
  } catch (err) {
    // Log de falha também é importante para auditoria
    await db.logClockOffboard(buildOffboardFailureLog(cpf, employeeName, triggeredBy, timestamp, err));
    res.status(502).json({
      error:   'Falha ao conectar com o clock-proxy',
      detail:  err.message,
      hint:    `Verifique se o Servidor Skill esta acessivel em ${CLOCK_PROXY_URL}`,
    });
  }
});

// GET /api/rh/offboard-log
// Retorna o histórico de offboardings LGPD (auditoria)
router.get('/offboard-log', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(await db.getClockOffboardLog(limit));
}));

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
      error:  'Falha ao conectar com o clock-proxy',
      detail: err.message,
      hint:   `Verifique se o Servidor Skill esta acessivel em ${CLOCK_PROXY_URL}`,
    });
  }
});

// POST /api/rh/clock/:ip/mark-new
// Marca um relógio como "recém-substituído" — a próxima leitura de funcionários desse IP
// vai ignorar o guard de divergência (queda >50% no count) por uma leitura, uma única vez.
// Usar depois de trocar fisicamente o hardware de um relógio (mesmo IP, funcionários zerados).
router.post('/clock/:ip/mark-new', async (req, res) => {
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(req.params.ip)) {
    return res.status(400).json({ error: 'IP invalido' });
  }
  try {
    const result = await callClockProxy(`/clock/${req.params.ip}/mark-new`, {}, 'POST');
    res.json(result);
  } catch (err) {
    if (err.statusCode && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    res.status(502).json({
      error:  'Falha ao conectar com o clock-proxy',
      detail: err.message,
      hint:   `Verifique se o Servidor Skill esta acessivel em ${CLOCK_PROXY_URL}`,
    });
  }
});

// GET /api/rh/employees
// Busca funcionários de todos os relógios e retorna comparação (pode demorar minutos)
router.get('/employees', async (req, res) => {
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }
  try {
    const result = await callClockProxy('/rh/employees', null, 'GET');
    if (result._statusCode === 202) {
      return res.status(202).json({ status: result.status });
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao conectar com o clock-proxy', detail: err.message });
  }
});

// POST /api/rh/enroll
// Cadastra funcionário — assíncrono: retorna 202 + jobId imediatamente.
// O clock-proxy processa em background; use GET /api/rh/enroll/:jobId para polling.
// Body: { cpf, name, ref1, ref2?, password?, clockIps?, triggeredBy? }
router.post('/enroll', async (req, res) => {
  const { cpf, name, ref1, ref2, password, clockIps, triggeredBy } = req.body;

  if (!cpf || !name || !ref1) {
    return res.status(400).json({ error: 'cpf, name e ref1 (matricula) sao obrigatorios' });
  }
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }

  try {
    const result = await callClockProxy('/rh/enroll', { cpf, name, ref1, ref2, password, clockIps });
    // clock-proxy retorna 202 + { jobId, status:'running' }
    return res.status(202).json({ jobId: result.jobId, status: 'running', cpf, name, triggeredBy });
  } catch (err) {
    await db.logClockOperation({
      operation: 'enroll', cpf, employeeName: name,
      triggeredBy: triggeredBy || 'delirio-manager-rh',
      timestamp: new Date().toISOString(), success: false, total: 0, okCount: 0, failedCount: -1,
      detail: [{ error: err.message }],
    });
    res.status(502).json({ error: 'Falha ao conectar com o clock-proxy', detail: err.message });
  }
});

// ── Helpers for GET /enroll/:jobId ───────────────────────────────────────────

const _loggedEnrollJobs = new Set();

function buildEnrollLogPayload(result, triggeredBy) {
  return {
    operation:    'enroll',
    cpf:          result.cpf       || '',
    employeeName: result.name      || '',
    triggeredBy:  triggeredBy      || 'delirio-manager-rh',
    timestamp:    result.timestamp || new Date().toISOString(),
    success:      result.success   || false,
    total:        result.total     || 0,
    okCount:      result.enrolled  || 0,
    failedCount:  result.failed    || 0,
    detail:       result.clocks    || [],
  };
}

async function processEnrollCompletion(result, jobId, triggeredBy) {
  _loggedEnrollJobs.add(jobId);
  await db.logClockOperation(buildEnrollLogPayload(result, triggeredBy));
  if (result.ref1) {
    await db.registerRef1({ ref1: result.ref1, cpf: result.cpf || '', name: result.name || '' });
  }
}

// GET /api/rh/enroll/:jobId — polling de resultado de enroll assíncrono
router.get('/enroll/:jobId', async (req, res) => {
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }
  try {
    const result = await callClockProxy(`/rh/enroll/${req.params.jobId}`, null, 'GET');
    if (result._statusCode === 202) {
      return res.status(202).json({ jobId: req.params.jobId, status: 'running' });
    }
    // Loga uma única vez quando o job completa
    if (result.status === 'done' && !_loggedEnrollJobs.has(req.params.jobId)) {
      await processEnrollCompletion(result, req.params.jobId, req.query.triggeredBy);
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao conectar com o clock-proxy', detail: err.message });
  }
});

// GET /api/rh/next-ref1
// Retorna o próximo Ref1 disponível, considerando todos que já foram utilizados (mesmo removidos).
router.get('/next-ref1', asyncHandler(async (req, res) => {
  try {
    const maxFromRegistry = await db.getMaxRef1();
    res.json({ nextRef1: String(maxFromRegistry + 1) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

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

    await db.logClockOperation({
      operation:    'update_card',
      cpf,
      employeeName: '',
      triggeredBy:  triggeredBy || 'delirio-manager-rh',
      timestamp,
      success:      result.success,
      total:        result.total   || 0,
      okCount:      result.updated || 0,
      failedCount:  result.failed  || 0,
      detail:       result.clocks  || [],
    });

    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao conectar com o clock-proxy', detail: err.message });
  }
});

// POST /api/rh/employees/refresh
// Dispara leitura parcial — apenas os relógios informados em clockIps.
// Body: { clockIps: ["192.168.x.x", ...] }
router.post('/employees/refresh', async (req, res) => {
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }
  try {
    const result = await callClockProxy('/rh/employees/refresh', req.body, 'POST');
    if (result._statusCode === 202) {
      return res.status(202).json({ status: result.status, clockIps: result.clockIps });
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao conectar com o clock-proxy', detail: err.message });
  }
});

// GET /api/rh/operation-log
// Retorna log de todas as operações (enroll, update_card, offboard)
router.get('/operation-log', asyncHandler(async (req, res) => {
  const limit     = parseInt(req.query.limit)     || 100;
  const operation = req.query.operation           || null;
  res.json(await db.getClockOperationLog(limit, operation));
}));

// GET /api/rh/lgpd-info
// Retorna o caminho UNC da pasta LGPD para o Electron abrir no Windows Explorer
router.get('/lgpd-info', async (req, res) => {
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }
  try {
    const result = await callClockProxy('/rh/lgpd-info', null, 'GET');
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao conectar com o clock-proxy', detail: err.message });
  }
});

module.exports = router;
