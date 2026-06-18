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
  if (machine.critica && ['reboot', 'shutdown'].includes(type)) {
    const confirm = req.body.confirm;
    if (confirm !== machine.id) {
      return res.status(409).json({
        error: 'Maquina critica. Envie confirm=<machineId> para confirmar.',
        machineId: machine.id,
        critica: true,
      });
    }
  }

  try {
    const commandId = db.createCommand(machine.id, type, params || {});

    if (type === 'wol') {
      const now = new Date().toISOString();
      // targetId = máquina a acordar; machine.id = relay que envia o magic packet
      const wolTargetId = params?.targetId || machine.id;
      db.setWolStatus(wolTargetId, 'testing', now);
      db.addEvent(wolTargetId, 'wol_testing', `WoL iniciado via relay ${machine.id}`);

      // Broadcast imediato para o dashboard atualizar o badge sem esperar poll
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
  if (location    !== undefined) fields.location      = location;
  if (critica     !== undefined) fields.critica        = critica ? 1 : 0;
  if (subnet      !== undefined) fields.subnet         = subnet;
  if (mac         !== undefined) fields.mac            = mac;

  db.updateMachine(req.params.id, fields);
  res.json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseMachine(m) {
  return {
    id:           m.id,
    hostname:     m.hostname,
    displayName:  m.display_name || m.hostname,
    location:     m.location     || '',
    subnet:       m.subnet       || '',
    ipInterno:    m.ip_interno   || '',
    mac:          m.mac          || '',
    critica:      m.critica === 1,
    agentVersion: m.agent_version || '',
    status:       m.status       || 'unknown',
    lastSeen:     m.last_seen    || null,
    onlineSince:  m.online_since || null,
    registeredAt: m.registered_at,
    lastMetrics:  m.last_metrics ? parseJSON(m.last_metrics, null) : null,
    wolStatus:    m.wol_status   || 'unknown',
    motherboard:  m.motherboard  || '',
  };
}

function parseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
