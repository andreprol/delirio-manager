'use strict';

const express        = require('express');
const router         = express.Router();
const db             = require('../db');
const { broadcast }  = require('../services/websocket');

// GET /api/machines
router.get('/', (req, res) => {
  try {
    const machines = db.getAllMachines().map(parseMachine);
    res.json(machines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/machines/:id
router.get('/:id', (req, res) => {
  const m = db.getMachineById(req.params.id);
  if (!m) return res.status(404).json({ error: 'Maquina nao encontrada' });
  res.json(parseMachine(m));
});

// GET /api/machines/:id/aloha — ultimo scan de C:\Bootdrv
router.get('/:id/aloha', (req, res) => {
  const scan = db.getLastAlohaScan(req.params.id);
  if (!scan) return res.json(null);
  try {
    const data = JSON.parse(scan.result);
    res.json({ ...data, command_id: scan.id, acked_at: scan.acked_at });
  } catch {
    res.json(null);
  }
});

// GET /api/machines/:id/metrics?hours=24
router.get('/:id/metrics', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const data  = db.getMetrics(req.params.id, Math.min(hours, 168)); // max 7 dias
  res.json(data.map(m => ({
    ts:         m.ts,
    cpuPct:     m.cpu_pct,
    ramFreeMB:  m.ram_free_mb,
    ramTotalMB: m.ram_total_mb,
    diskFreeGB: m.disk_free_gb,
    diskTotalGB:m.disk_total_gb,
    uptimeH:    m.uptime_h,
    cpuTempC:   m.cpu_temp_c,
    ips:        parseJSON(m.ips, []),
  })));
});

// GET /api/machines/:id/events
router.get('/:id/events', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(db.getEvents(req.params.id, limit));
});

// GET /api/machines/:id/commands
router.get('/:id/commands', (req, res) => {
  res.json(db.getCommandHistory(req.params.id));
});

// ── Helpers for POST /:id/commands ───────────────────────────────────────────

function getCriticalCheckError(machine, type, confirm) {
  if (machine.critica && ['reboot', 'shutdown'].includes(type)) {
    if (confirm !== machine.id) {
      return {
        error: 'Maquina critica. Envie confirm=<machineId> para confirmar.',
        machineId: machine.id,
        critica: true,
      };
    }
  }
  return null;
}

function handleWolSetup(machine, params) {
  const now         = new Date().toISOString();
  const wolTargetId = params?.targetId || machine.id;
  db.setWolStatus(wolTargetId, 'testing', now);
  db.addEvent(wolTargetId, 'wol_testing', `WoL iniciado via relay ${machine.id}`);
  const target = db.getMachineById(wolTargetId);
  if (target) {
    broadcast('machine:update', {
      machineId:   wolTargetId,
      displayName: target.display_name || target.hostname,
      status:      target.status || 'offline',
      lastSeen:    target.last_seen,
      wolStatus:   'testing',
      motherboard: target.motherboard,
    });
  }
  console.log(`[WoL] Teste iniciado para ${wolTargetId} via relay ${machine.id} às ${now}`);
}

// POST /api/machines/:id/commands
// Envia um comando para a maquina (reboot, shutdown, wol, cancel-shutdown)
router.post('/:id/commands', (req, res) => {
  const machine = db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Maquina nao encontrada' });

  const { type, params } = req.body;
  const allowed = ['reboot', 'shutdown', 'wol', 'cancel-shutdown', 'uninstall', 'aloha-scan', 'aloha-index-nfce-day', 'aloha-list-nfce-months'];

  if (!type || !allowed.includes(type)) {
    return res.status(400).json({ error: `Tipo invalido. Permitidos: ${allowed.join(', ')}` });
  }

  // Protecao para maquinas criticas: bloqueia reboot/shutdown sem confirmacao
  const critError = getCriticalCheckError(machine, type, req.body.confirm);
  if (critError) return res.status(409).json(critError);

  try {
    const commandId = db.createCommand(machine.id, type, params || {});

    if (type === 'wol') handleWolSetup(machine, params);

    db.addEvent(machine.id, `command_sent`, `Comando ${type} enviado (id: ${commandId})`);

    console.log(`[Command] ${type} enviado para ${machine.id} (cmd: ${commandId})`);
    res.status(201).json({ commandId, machineId: machine.id, type, status: 'pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/machines/:id
// Atualiza nome, localidade, critica
router.put('/:id', (req, res) => {
  const machine = db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Maquina nao encontrada' });

  const { displayName, location, critica, subnet, mac } = req.body;
  const fields = {};

  if (displayName !== undefined) fields.display_name = displayName;
  if (location    !== undefined) fields.location      = location || 'Temporário';
  if (critica     !== undefined) fields.critica        = critica ? 1 : 0;
  if (subnet      !== undefined) fields.subnet         = subnet;
  if (mac         !== undefined) fields.mac            = mac;

  db.updateMachine(req.params.id, fields);
  res.json({ ok: true });
});

// DELETE /api/machines/:id
router.delete('/:id', (req, res) => {
  const machine = db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Maquina nao encontrada' });
  db.deleteMachine(req.params.id);
  res.json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMachineIdentity(m) {
  return {
    displayName: m.display_name || m.hostname,
    location:    m.location     || '',
    subnet:      m.subnet       || '',
    ipInterno:   m.ip_interno   || '',
    mac:         m.mac          || '',
  };
}

function buildMachineStatus(m) {
  return {
    agentVersion: m.agent_version || '',
    status:       m.status        || 'unknown',
    lastSeen:     m.last_seen     || null,
    onlineSince:  m.online_since  || null,
    wolStatus:    m.wol_status    || 'unknown',
    motherboard:  m.motherboard   || '',
    osVersion:    m.os_version    || '',
  };
}

function parseMachine(m) {
  return {
    id:              m.id,
    hostname:        m.hostname,
    ...buildMachineIdentity(m),
    critica:         m.critica === 1,
    ...buildMachineStatus(m),
    registeredAt:    m.registered_at,
    lastMetrics:     m.last_metrics ? parseJSON(m.last_metrics, null) : null,
    wolEverConfirmed: m.wol_ever_confirmed === 1,
  };
}

// POST /api/machines/:id/run
// Executa script PowerShell na maquina e aguarda resultado sincrono (max 35s).
// Requer header X-Admin-Secret (mesmo segredo do endpoint /api/admin/*).

function loadAdminSecret() {
  const fs   = require('fs');
  const path = require('path');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return cfg.adminSecret || null;
  } catch { return null; }
}

function isValidScript(script) {
  return script && typeof script === 'string' && script.trim();
}

async function pollCommandResult(commandId, deadline) {
  const POLL_MS = 500;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const cmd = db.getCommandResult(commandId);
    if (cmd && cmd.status === 'acked') {
      return { failed: false, output: cmd.result || '' };
    }
    if (cmd && cmd.status === 'failed') {
      return { failed: true, output: cmd.result || '' };
    }
  }
  return null;
}

router.post('/:id/run', async (req, res) => {
  const adminSecret = loadAdminSecret();
  if (!adminSecret || req.headers['x-admin-secret'] !== adminSecret) {
    return res.status(401).json({ error: 'X-Admin-Secret invalido ou nao configurado' });
  }

  const machine = db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Maquina nao encontrada' });

  const { script } = req.body;
  if (!isValidScript(script)) {
    return res.status(400).json({ error: 'script obrigatorio' });
  }

  const commandId  = db.createCommand(machine.id, 'run_powershell', { script });
  const TIMEOUT_MS = 35_000;
  const deadline   = Date.now() + TIMEOUT_MS;

  const pollResult = await pollCommandResult(commandId, deadline);
  if (!pollResult) {
    return res.status(504).json({
      error: 'Timeout aguardando resposta da maquina (35s). Maquina pode estar offline.',
      commandId,
    });
  }
  if (pollResult.failed) {
    return res.status(500).json({ success: false, output: pollResult.output, commandId });
  }
  return res.json({ success: true, output: pollResult.output, commandId });
});

function parseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
