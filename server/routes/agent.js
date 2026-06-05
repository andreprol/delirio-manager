'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { agentAuth, agentAuthNoLimit } = require('../middleware/auth');
const { broadcast } = require('../services/websocket');
const { readVersionInfo } = require('./update');

// POST /api/register
// Registra nova maquina ou atualiza existente. Retorna token.
router.post('/register', (req, res) => {
  const { machineId, hostname, version } = req.body;

  if (!machineId || !hostname) {
    return res.status(400).json({ error: 'machineId e hostname sao obrigatorios' });
  }

  try {
    const token = db.registerMachine({
      machineId,
      hostname,
      agentVersion: version || '',
    });

    console.log(`[Register] ${machineId} (${hostname}) registrado`);

    broadcast('machine:update', {
      machineId,
      hostname,
      status: 'online',
      agentVersion: version,
    });

    return res.status(201).json({ token, machineId });
  } catch (err) {
    console.error('[Register] Erro:', err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/heartbeat
// Recebe metricas do agente. Requer token valido.
router.post('/heartbeat', agentAuth, (req, res) => {
  const machine = req.machine;
  const { metrics, hostname, agentVersion } = req.body;

  try {
    // Atualiza status e last_seen
    db.setMachineStatus(machine.id, 'online');

    // Salva metricas
    if (metrics) {
      db.saveMetrics(machine.id, metrics);
    }

    // Atualiza ip_interno, mac e agent_version
    const upd = {}
    if (agentVersion && agentVersion !== machine.agent_version) upd.agent_version = agentVersion
    if (metrics) {
      if (metrics.ips && metrics.ips.length > 0) {
        const ipv4s = metrics.ips.filter(ip => !ip.includes(':'))
        const isPrivate = ip => /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(ip)
        const newIp = ipv4s.find(isPrivate) || ipv4s[0]
        const curIp = machine.ip_interno
        if (newIp && (!curIp || curIp.includes(':') || !isPrivate(curIp))) upd.ip_interno = newIp
      }
      if (metrics.mac && !machine.mac) upd.mac = metrics.mac
    }
    if (Object.keys(upd).length) db.updateMachine(machine.id, upd)

    // Atualiza WoL driver status e motherboard
    const { wolEnabled, motherboard } = req.body;

    if (typeof motherboard === 'string' && motherboard && !machine.motherboard) {
      db.updateMachine(machine.id, { motherboard });
    }

    let currentWolStatus = machine.wol_status;
    if (wolEnabled !== undefined) {
      const protectedStates = ['wol_confirmed', 'testing', 'bios_needed'];
      if (!protectedStates.includes(machine.wol_status)) {
        const newStatus = wolEnabled ? 'driver_enabled' : 'driver_disabled';
        if (newStatus !== machine.wol_status) {
          db.setWolStatus(machine.id, newStatus);
          currentWolStatus = newStatus;
        }
      }
    }

    // Push em tempo real para o dashboard
    broadcast('machine:update', {
      machineId:   machine.id,
      displayName: machine.display_name || machine.hostname,
      status:      'online',
      lastSeen:    new Date().toISOString(),
      metrics,
      wolStatus:   currentWolStatus,
      motherboard: machine.motherboard,
    });

    // Inclui versao mais recente do agente na resposta
    const versionInfo = readVersionInfo();
    return res.json({
      ok: true,
      latestVersion: versionInfo.version,
      updateInfo: { sha256: versionInfo.sha256 },
    });
  } catch (err) {
    console.error(`[Heartbeat] Erro para ${machine.id}:`, err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/commands/:machineId
// Retorna comandos pendentes para o agente. Requer token.
router.get('/commands/:machineId', agentAuthNoLimit, (req, res) => {
  const machine = req.machine;

  if (machine.id !== req.params.machineId) {
    return res.status(403).json({ error: 'Token nao corresponde ao machineId' });
  }

  try {
    const commands = db.getPendingCommands(machine.id);
    return res.json({ commands });
  } catch (err) {
    console.error(`[Commands] Erro para ${machine.id}:`, err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/commands/ack
// Agente confirma execucao de um comando.
router.post('/commands/ack', agentAuthNoLimit, (req, res) => {
  const { commandId, success, message } = req.body;

  if (!commandId) {
    return res.status(400).json({ error: 'commandId obrigatorio' });
  }

  try {
    db.ackCommand(commandId, req.machine.id, success !== false, message || '');

    broadcast('command:acked', {
      commandId,
      machineId: req.machine.id,
      success:   success !== false,
      message:   message || '',
    });

    if (success !== false) {
      db.addEvent(req.machine.id, 'command_ok',
        `Comando ${commandId} executado: ${message || 'OK'}`);
    } else {
      db.addEvent(req.machine.id, 'command_fail',
        `Comando ${commandId} falhou: ${message || ''}`);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[Ack] Erro:', err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
