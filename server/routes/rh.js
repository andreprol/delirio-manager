'use strict';

// Rotas de RH — integração com o dt-clock-proxy para LGPD Art. 15/16
// O clock-proxy roda no Servidor Skill e controla os relógios Henry Hexa ADV.
// Conectividade: Azure VM → Servidor Skill via VPN ou IP acessível (CLOCK_PROXY_URL no .env).

const express = require('express');
const https   = require('https');
const http    = require('http');
const router  = express.Router();
const db      = require('../db');

const CLOCK_PROXY_URL   = process.env.CLOCK_PROXY_URL   || 'http://192.168.17.252:4321';
const CLOCK_PROXY_TOKEN = process.env.CLOCK_PROXY_TOKEN || '';

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
          resolve(res.statusCode === 202 ? { ...parsed, _statusCode: 202 } : parsed);
        }
        catch (_) { resolve({ error: data }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('Timeout apos 90s')));
    if (!isGet) req.write(payload);
    req.end();
  });
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
    const result = await callClockProxy('/rh/offboard', {
      cpf,
      employeeName: employeeName || '',
      triggeredBy:  triggeredBy  || 'delirio-manager-rh',
    });

    // Log de auditoria LGPD — evidência para ANPD
    db.logClockOffboard({
      cpf,
      employeeName: employeeName || '',
      triggeredBy:  triggeredBy  || 'delirio-manager-rh',
      timestamp,
      success:      result.success ? 1 : 0,
      removed:      result.removed      || 0,
      alreadyAbsent:result.alreadyAbsent || 0,
      failed:       result.failed       || 0,
      detail:       JSON.stringify(result.clocks || []),
    });

    res.json(result);

  } catch (err) {
    // Log de falha também é importante para auditoria
    db.logClockOffboard({
      cpf,
      employeeName: employeeName || '',
      triggeredBy:  triggeredBy  || 'delirio-manager-rh',
      timestamp,
      success:      0,
      removed:      0,
      alreadyAbsent:0,
      failed:       -1,
      detail:       JSON.stringify({ error: err.message }),
    });

    res.status(502).json({
      error:   'Falha ao conectar com o clock-proxy',
      detail:  err.message,
      hint:    `Verifique se o Servidor Skill esta acessivel em ${CLOCK_PROXY_URL}`,
    });
  }
});

// GET /api/rh/offboard-log
// Retorna o histórico de offboardings LGPD (auditoria)
router.get('/offboard-log', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(db.getClockOffboardLog(limit));
});

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
// Cadastra funcionário em todos os relógios (ou subset em clockIps)
// Body: { cpf, name, ref1, ref2?, password?, clockIps?, triggeredBy? }
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
      total:        result.total    || 0,
      okCount:      result.enrolled || 0,
      failedCount:  result.failed   || 0,
      detail:       result.clocks   || [],
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
router.get('/operation-log', (req, res) => {
  const limit     = parseInt(req.query.limit)     || 100;
  const operation = req.query.operation           || null;
  res.json(db.getClockOperationLog(limit, operation));
});

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
