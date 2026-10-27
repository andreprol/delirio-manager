'use strict';

// middleware/employeeAuth.js — sessão de FUNCIONÁRIO (ponto remoto), separada
// do X-Admin-Secret único usado pelas rotas administrativas (adminAuth.js).
// Token de sessão é opaco (32 bytes aleatórios) entregue via cookie HttpOnly;
// só o hash SHA-256 fica no banco — um leak do banco não dá o token em si.

const crypto = require('crypto');
const { getRemoteSession, getRemoteEmployeeById } = require('../db');

const SESSION_TTL_MS  = 12 * 60 * 60 * 1000; // 12h
const SESSION_COOKIE  = 'pr_session';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Secure é omitido só se explicitamente pedido (teste local via HTTP sem TLS) —
// produção sempre atrás de TLS, nunca deve rodar sem o Secure.
function cookieFlags() {
  return process.env.PONTO_REMOTO_INSECURE_COOKIE === 'true' ? '' : 'Secure; ';
}

function issueSessionCookie(res, token) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; ${cookieFlags()}SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; ${cookieFlags()}SameSite=Strict; Path=/; Max-Age=0`
  );
}

function employeeAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'Não autenticado' });

  const tokenHash = hashToken(token);
  const session = getRemoteSession(tokenHash);
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada' });
  }

  const employee = getRemoteEmployeeById(session.employee_id);
  if (!employee || !employee.active) {
    return res.status(401).json({ error: 'Funcionário inativo' });
  }

  req.employee        = employee;
  req.sessionTokenHash = tokenHash;
  next();
}

module.exports = {
  employeeAuth,
  parseCookies,
  hashToken,
  issueSessionCookie,
  clearSessionCookie,
  SESSION_TTL_MS,
  SESSION_COOKIE,
};
