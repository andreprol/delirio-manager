'use strict';

// middleware/adminAuth.js — autenticação por X-Admin-Secret compartilhada por
// toda ação de alto risco (executar PowerShell remoto, abrir acesso remoto de
// tela). Existia duplicada em routes/machines.js e routes/live.js, cada cópia
// checando uma fonte diferente (só config.json vs. env var + config.json) e
// comparando de um jeito diferente (!== vs. timing-safe) — rotacionar
// ADMIN_SECRET via env var silenciosamente não valia pra metade das rotas.
// Única fonte de verdade agora.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

function loadAdminSecret() {
  if (process.env.ADMIN_SECRET) return process.env.ADMIN_SECRET;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return cfg.adminSecret || null;
  } catch {
    return null;
  }
}

// Comparação resistente a timing attack — X-Admin-Secret autoriza ações de
// alto risco, merece o mesmo cuidado que os tokens de sessão ao vivo.
function safeSecretEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function adminAuth(req, res, next) {
  const secret = loadAdminSecret();
  if (!secret || !safeSecretEqual(req.headers['x-admin-secret'], secret)) {
    return res.status(401).json({ error: 'X-Admin-Secret inválido ou não configurado' });
  }
  next();
}

module.exports = { adminAuth, loadAdminSecret, safeSecretEqual };
