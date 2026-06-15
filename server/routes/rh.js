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

function callClockProxy(path, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(CLOCK_PROXY_URL + path);
    const payload = JSON.stringify(body);
    const lib     = url.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization':  `Bearer ${CLOCK_PROXY_TOKEN}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({ error: data }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(300000, () => req.destroy(new Error('Timeout apos 5 minutos')));
    req.write(payload);
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

module.exports = router;
