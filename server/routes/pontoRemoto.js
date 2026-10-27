'use strict';

// routes/pontoRemoto.js — ponto remoto (REP-P/REP-A) pra funcionários
// elegíveis, via celular/web, fora do fluxo dos relógios Henry Hexa físicos.
// Timestamp de marcação é SEMPRE o do servidor — nunca o enviado pelo client.
// remote_time_entries é append-only: não existe rota de editar/apagar um
// registro, só "corrigir" (cria uma linha nova referenciando a original).

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const db = require('../db');
const { hashPassword, verifyPassword } = require('../services/password');
const { adminAuth } = require('../middleware/adminAuth');
const {
  employeeAuth, hashToken, issueSessionCookie, clearSessionCookie, SESSION_TTL_MS,
} = require('../middleware/employeeAuth');
const { STORE_GEOFENCE } = require('../config/storeGeofence');
const { isWithinGeofence } = require('../services/geofence');
const { normalizeCpf, isValidCpfFormat } = require('../services/cpf');

// ─── Rate limit de login por CPF+IP — mesmo espírito do limite em /api/register ─
const LOGIN_WINDOW_MS    = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const _loginAttempts = new Map(); // "cpf:ip" -> { count, windowStart }

function isLoginRateLimited(key) {
  const entry = _loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    _loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginAttempt(key) {
  const entry = _loginAttempts.get(key);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    _loginAttempts.set(key, { count: 1, windowStart: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearLoginAttempts(key) {
  _loginAttempts.delete(key);
}

// ─── Login ────────────────────────────────────────────────────────────────────
// POST /api/ponto-remoto/login  { cpf, senha }
router.post('/login', (req, res) => {
  const { senha } = req.body || {};
  const cpf = normalizeCpf(req.body?.cpf);
  if (!cpf || !senha) return res.status(400).json({ error: 'cpf e senha são obrigatórios' });

  const rateKey = `${cpf}:${req.ip}`;
  if (isLoginRateLimited(rateKey)) {
    return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  }

  const employee = db.getRemoteEmployeeByCpf(cpf);
  const valid = !!employee && !!employee.active && verifyPassword(senha, employee.password_hash);
  if (!valid) {
    recordLoginAttempt(rateKey);
    return res.status(401).json({ error: 'CPF ou senha inválidos' });
  }
  clearLoginAttempts(rateKey);

  const token = crypto.randomBytes(32).toString('hex');
  const now   = new Date();
  db.createRemoteSession({
    tokenHash:  hashToken(token),
    employeeId: employee.id,
    createdAt:  now.toISOString(),
    expiresAt:  new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  });

  issueSessionCookie(res, token);
  res.json({ ok: true, name: employee.name, store: employee.store });
});

// POST /api/ponto-remoto/logout
router.post('/logout', employeeAuth, (req, res) => {
  db.deleteRemoteSession(req.sessionTokenHash);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ─── Bater ponto ────────────────────────────────────────────────────────────────
// POST /api/ponto-remoto/clock  { tipo: 'in'|'out', lat?, lng?, accuracy? }
router.post('/clock', employeeAuth, (req, res) => {
  const { tipo, lat, lng, accuracy } = req.body || {};
  if (tipo !== 'in' && tipo !== 'out') {
    return res.status(400).json({ error: "tipo deve ser 'in' ou 'out'" });
  }

  const withinGeofence = isWithinGeofence(STORE_GEOFENCE[req.employee.store], lat, lng);

  const entry = db.insertRemoteTimeEntry({
    employeeId: req.employee.id,
    type: tipo,
    serverTs: new Date().toISOString(),
    lat: lat ?? null,
    lng: lng ?? null,
    accuracy: accuracy ?? null,
    withinGeofence,
    correctsId: null,
    correctionReason: null,
    createdBy: 'employee',
  });

  res.status(201).json({ ok: true, entry });
});

// GET /api/ponto-remoto/my-entries
router.get('/my-entries', employeeAuth, (req, res) => {
  res.json({ entries: db.listRemoteTimeEntriesForEmployee(req.employee.id) });
});

// ─── Admin ──────────────────────────────────────────────────────────────────────
// POST /api/ponto-remoto/admin/employees  { cpf, name, store, senha }
router.post('/admin/employees', adminAuth, (req, res) => {
  const { name, store, senha } = req.body || {};
  if (!req.body?.cpf || !name || !store || !senha) {
    return res.status(400).json({ error: 'cpf, name, store e senha são obrigatórios' });
  }
  if (!isValidCpfFormat(req.body.cpf)) {
    return res.status(400).json({ error: 'cpf inválido — precisa ter 11 dígitos' });
  }

  const cpf = normalizeCpf(req.body.cpf);
  if (db.getRemoteEmployeeByCpf(cpf)) {
    return res.status(409).json({ error: 'CPF já cadastrado' });
  }

  const employee = db.createRemoteEmployee({ cpf, name, store, passwordHash: hashPassword(senha) });
  res.status(201).json({
    ok: true,
    employee: { id: employee.id, cpf: employee.cpf, name: employee.name, store: employee.store, active: true },
  });
});

// GET /api/ponto-remoto/admin/employees
router.get('/admin/employees', adminAuth, (req, res) => {
  res.json({ employees: db.listRemoteEmployees() });
});

// PATCH /api/ponto-remoto/admin/employees/:id  { active }
router.patch('/admin/employees/:id', adminAuth, (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) é obrigatório' });

  const employee = db.getRemoteEmployeeById(req.params.id);
  if (!employee) return res.status(404).json({ error: 'Funcionário não encontrado' });

  db.setRemoteEmployeeActive(req.params.id, active);
  res.json({ ok: true });
});

// GET /api/ponto-remoto/admin/entries?employeeId=
router.get('/admin/entries', adminAuth, (req, res) => {
  const { employeeId } = req.query;
  res.json({ entries: db.listAllRemoteTimeEntries({ employeeId: employeeId || null }) });
});

// POST /api/ponto-remoto/admin/entries/:id/correct  { tipo, timestamp, motivo }
// Nunca edita o registro original — insere uma correção nova com corrects_id.
router.post('/admin/entries/:id/correct', adminAuth, (req, res) => {
  const original = db.getRemoteTimeEntryById(req.params.id);
  if (!original) return res.status(404).json({ error: 'Registro não encontrado' });

  const { tipo, timestamp, motivo } = req.body || {};
  if (!tipo || !timestamp || !motivo) {
    return res.status(400).json({ error: 'tipo, timestamp e motivo são obrigatórios' });
  }
  if (tipo !== 'in' && tipo !== 'out') {
    return res.status(400).json({ error: "tipo deve ser 'in' ou 'out'" });
  }

  const entry = db.insertRemoteTimeEntry({
    employeeId: original.employee_id,
    type: tipo,
    serverTs: timestamp,
    lat: null,
    lng: null,
    accuracy: null,
    withinGeofence: null,
    correctsId: original.id,
    correctionReason: motivo,
    createdBy: 'admin',
  });

  res.status(201).json({ ok: true, entry });
});

module.exports = router;
