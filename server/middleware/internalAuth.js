'use strict';

// middleware/internalAuth.js — protege endpoints internos que disparam
// chamadas pagas à API da Anthropic (relatório/insights sob demanda) contra
// acesso público não autenticado. Mesmo padrão shared-secret de routes/admin.js
// (x-admin-secret), extraído aqui pra reuso em outras rotas internas.

const fs   = require('fs');
const path = require('path');

function loadInternalKey() {
  if (process.env.INTERNAL_API_KEY) return process.env.INTERNAL_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return cfg.internalApiKey || null;
  } catch {
    return null;
  }
}

function internalAuth(req, res, next) {
  const key = loadInternalKey();
  if (!key) {
    return res.status(503).json({ error: 'INTERNAL_API_KEY nao configurada' });
  }
  if (req.headers['x-internal-key'] !== key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { internalAuth, loadInternalKey };
