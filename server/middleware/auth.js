'use strict';

const { getMachineByToken } = require('../db');

// Rate limit simples: 1 heartbeat a cada 5s por machineId
const lastSeen = new Map();

function agentAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ error: 'Token ausente' });
  }

  const machine = getMachineByToken(token);
  if (!machine) {
    return res.status(401).json({ error: 'Token invalido' });
  }

  // Rate limit: ignora heartbeats mais rapidos que 5s
  const key  = machine.id;
  const now  = Date.now();
  const last = lastSeen.get(key) || 0;
  if (now - last < 5000) {
    return res.status(429).json({ error: 'Rate limit: aguarde 5s entre heartbeats' });
  }
  lastSeen.set(key, now);

  req.machine = machine;
  next();
}

// Middleware para rotas do agente que nao precisam de rate limit (ex: commands poll)
function agentAuthNoLimit(req, res, next) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  if (!token) return res.status(401).json({ error: 'Token ausente' });

  const machine = getMachineByToken(token);
  if (!machine) return res.status(401).json({ error: 'Token invalido' });

  req.machine = machine;
  next();
}

module.exports = { agentAuth, agentAuthNoLimit };
