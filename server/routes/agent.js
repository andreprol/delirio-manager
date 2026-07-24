'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { agentAuth, agentAuthNoLimit } = require('../middleware/auth');
const { insertMetricsHourly, insertOfflineEvent } = require('../db');
const { broadcast } = require('../services/websocket');
const { readVersionInfo } = require('./update');
const { clearOfflineCooldown } = require('../services/alertEngine');
const ncrMonitor = require('../services/ncrMonitor');

// Rate limit de registro: máximo 10 por IP a cada 30 min
// Mitiga token theft via POST /api/register (endpoint sem auth).
const _regAttempts = new Map();
function _checkRegRateLimit(ip) {
  const now = Date.now();
  const e = _regAttempts.get(ip) || { n: 0, since: now };
  if (now - e.since > 30 * 60 * 1000) { e.n = 0; e.since = now; }
  e.n++;
  _regAttempts.set(ip, e);
  return e.n <= 10;
}

// POST /api/register
// Registra nova maquina ou atualiza existente. Retorna token.
router.post('/register', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!_checkRegRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit: muitos registros deste IP. Aguarde 30 min.' });
  }

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

// ── Validadores auxiliares ────────────────────────────────────────────────────

function validateStringField(value, name, maxLen) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > maxLen) {
    return `${name} deve ser string com máximo ${maxLen} chars`;
  }
  return null;
}

function validateNumericNonNegative(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || isNaN(value) || value < 0) {
    return `${name} deve ser número não-negativo`;
  }
  return null;
}

const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

function validateMacField(mac) {
  if (mac === undefined || mac === null) return null;
  if (typeof mac !== 'string' || !MAC_REGEX.test(mac)) {
    return 'metrics.mac deve ser endereço MAC válido (ex: AA:BB:CC:DD:EE:FF)';
  }
  return null;
}

function validateIpsField(ips) {
  if (ips === undefined) return [];
  if (!Array.isArray(ips)) return ['metrics.ips deve ser um array'];
  if (ips.length > 20) return ['metrics.ips deve ter no máximo 20 itens'];
  if (ips.some(ip => typeof ip !== 'string' || ip.length > 45)) {
    return ['cada item de metrics.ips deve ser string com máximo 45 chars'];
  }
  return [];
}

const NUMERIC_RANGES = [
  { field: 'cpu_pct',  min: 0, max: 100 },
  { field: 'ram_pct',  min: 0, max: 100 },
  { field: 'disk_pct', min: 0, max: 100 },
  { field: 'temp_c',   min: 0, max: 150 },
];

function validateNumericMetrics(metrics) {
  const errors = [];
  for (const { field, min, max } of NUMERIC_RANGES) {
    const val = metrics[field];
    if (val !== undefined && val !== null && (typeof val !== 'number' || isNaN(val) || val < min || val > max)) {
      errors.push(`metrics.${field} deve ser número entre ${min} e ${max}`);
    }
  }
  return errors;
}

function validateMetricsObject(metrics) {
  if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) {
    return ['metrics deve ser um objeto'];
  }
  const errors = [];
  errors.push(...validateNumericMetrics(metrics));
  const macErr = validateMacField(metrics.mac);
  if (macErr) errors.push(macErr);
  errors.push(...validateIpsField(metrics.ips));
  return errors;
}

function validateDrStatusObject(drStatus) {
  if (typeof drStatus !== 'object' || drStatus === null || Array.isArray(drStatus)) {
    return ['drStatus deve ser um objeto'];
  }
  const errors = [];
  const storageErr = validateNumericNonNegative(drStatus.storage_gb, 'drStatus.storage_gb');
  if (storageErr) errors.push(storageErr);
  const setupErr = validateStringField(drStatus.setup, 'drStatus.setup', 50);
  if (setupErr) errors.push(setupErr);
  const veeamErr = validateStringField(drStatus.veeam_version, 'drStatus.veeam_version', 50);
  if (veeamErr) errors.push(veeamErr);
  return errors;
}

// Valida o payload do heartbeat. Retorna array de erros (vazio = válido).
function validateHeartbeat(body) {
  const errors = [];
  const { metrics, agentVersion, motherboard, osVersion, drStatus } = body;
  const avErr = validateStringField(agentVersion, 'agentVersion', 50);
  if (avErr) errors.push(avErr);
  const mbErr = validateStringField(motherboard, 'motherboard', 200);
  if (mbErr) errors.push(mbErr);
  const osErr = validateStringField(osVersion, 'osVersion', 100);
  if (osErr) errors.push(osErr);
  if (metrics !== undefined) errors.push(...validateMetricsObject(metrics));
  if (drStatus !== undefined) errors.push(...validateDrStatusObject(drStatus));
  return errors;
}

// ── Heartbeat helpers ─────────────────────────────────────────────────────────

const PRIVATE_IP_RE = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;
const isPrivateIp = ip => PRIVATE_IP_RE.test(ip);

function selectNewIp(ips, curIp) {
  if (!ips || ips.length === 0) return null;
  const ipv4s = ips.filter(ip => !ip.includes(':'));
  const candidate = ipv4s.find(isPrivateIp) || ipv4s[0];
  if (!candidate) return null;
  const curIsGood = curIp && !curIp.includes(':') && isPrivateIp(curIp);
  return curIsGood ? null : candidate;
}

function collectMachineUpdates(machine, { agentVersion, metrics }) {
  const upd = {};
  if (agentVersion && agentVersion !== machine.agent_version) upd.agent_version = agentVersion;
  if (metrics) {
    const newIp = selectNewIp(metrics.ips, machine.ip_interno);
    if (newIp) upd.ip_interno = newIp;
    if (metrics.mac && !machine.mac) upd.mac = metrics.mac;
  }
  return upd;
}

const WOL_PROTECTED = ['wol_confirmed', 'testing', 'bios_needed'];

function getUpdatedWolStatus(machine, wolEnabled) {
  if (wolEnabled === undefined) return machine.wol_status;
  if (WOL_PROTECTED.includes(machine.wol_status)) return machine.wol_status;
  const newStatus = wolEnabled ? 'driver_enabled' : 'driver_disabled';
  if (newStatus !== machine.wol_status) {
    db.setWolStatus(machine.id, newStatus);
    return newStatus;
  }
  return machine.wol_status;
}

function updateHardwareInfo(machineId, machine, { motherboard, osVersion, wolEnabled }) {
  if (typeof motherboard === 'string' && motherboard && !machine.motherboard) {
    db.updateMachine(machineId, { motherboard });
  }
  if (typeof osVersion === 'string' && osVersion && osVersion !== machine.os_version) {
    db.updateMachine(machineId, { os_version: osVersion });
  }
  return getUpdatedWolStatus(machine, wolEnabled);
}

function broadcastMachineUpdate(machine, metrics, osVersion, currentWolStatus) {
  broadcast('machine:update', {
    machineId:   machine.id,
    displayName: machine.display_name || machine.hostname,
    status:      'online',
    lastSeen:    new Date().toISOString(),
    metrics,
    wolStatus:   currentWolStatus,
    motherboard: machine.motherboard,
    osVersion:   osVersion || machine.os_version || '',
  });
}

function fmtMetric(v) { return v != null ? v.toFixed(1) : 'N/A'; }

function processHeartbeatDr(machineId, drStatus, drLastOk) {
  const drUpdate = { setup: drStatus.setup || 'not_installed' };
  if (drStatus.veeam_version) drUpdate.version = drStatus.veeam_version;
  if (drStatus.storage_gb != null) drUpdate.storageGb = drStatus.storage_gb;
  if (drStatus.last_backup_at && drStatus.last_backup_at !== drLastOk) {
    if (drStatus.last_backup_ok) {
      drUpdate.lastOk = drStatus.last_backup_at;
      db.insertDRBackup(machineId, { backedAt: drStatus.last_backup_at, status: 'ok', storageGb: drStatus.storage_gb, durationMin: drStatus.duration_min });
    } else {
      db.insertDRBackup(machineId, { backedAt: drStatus.last_backup_at, status: 'failed', errorMsg: drStatus.error_msg });
    }
  }
  db.updateMachineDRStatus(machineId, drUpdate);
  broadcast('dr_update', { machineId, drStatus });
}

// POST /api/heartbeat
// Recebe metricas do agente. Requer token valido.
router.post('/heartbeat', agentAuth, (req, res) => {
  const machine = req.machine;
  const { metrics, osVersion } = req.body;

  const validationErrors = validateHeartbeat(req.body);
  if (validationErrors.length > 0) {
    return res.status(400).json({ error: 'Payload inválido', details: validationErrors });
  }

  try {
    if (machine.status === 'offline') clearOfflineCooldown(machine.id);
    db.setMachineStatus(machine.id, 'online');
    if (metrics) db.saveMetrics(machine.id, metrics);

    const upd = collectMachineUpdates(machine, req.body);
    if (Object.keys(upd).length) db.updateMachine(machine.id, upd);

    const currentWolStatus = updateHardwareInfo(machine.id, machine, req.body);

    broadcastMachineUpdate(machine, metrics, osVersion, currentWolStatus);

    const drStatus = req.body.dr_status;
    if (drStatus) {
      try { processHeartbeatDr(machine.id, drStatus, machine.dr_last_ok); }
      catch (err) { console.error('[heartbeat] DR status update error:', err.message); }
    }

    const versionInfo = readVersionInfo();
    return res.json({ ok: true, latestVersion: versionInfo.version, updateInfo: { sha256: versionInfo.sha256 } });
  } catch (err) {
    console.error(`[Heartbeat] Erro para ${machine.id}:`, err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/metrics/hourly
// Agente envia snapshot horário de métricas (24x/dia).
// Usa agentAuthNoLimit: chamado 1x/hora, rate limit de 5s causaria rejeição no startup
// quando heartbeat e snapshot disparam simultaneamente.
router.post('/metrics/hourly', agentAuthNoLimit, (req, res) => {
  const machine = req.machine;
  const { snapshotTs, cpuPct, ramPct, diskPct, cpuTempC } = req.body;

  if (!snapshotTs) return res.status(400).json({ error: 'snapshotTs obrigatorio' });

  const tsNum = Number(snapshotTs);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return res.status(400).json({ error: 'snapshotTs inválido' });
  }

  try {
    insertMetricsHourly(machine.id, { snapshotTs: tsNum, cpuPct, ramPct, diskPct, cpuTempC });
    const host = machine.hostname || machine.id;
    console.log(`[metrics/hourly] ${host}: ts=${tsNum} cpu=${fmtMetric(cpuPct)}% ram=${fmtMetric(ramPct)}% disk=${fmtMetric(diskPct)}% temp=${fmtMetric(cpuTempC)}°C`);
    return res.json({ ok: true });
  } catch (err) {
    const host = machine.hostname || machine.id;
    console.error(`[metrics/hourly] ${host}: ${err.message}`);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/offline-event
// Agente reporta evento de queda: quando reconecta após gap > 10 min.
router.post('/offline-event', agentAuth, (req, res) => {
  const machine = req.machine;
  const { offlineAt, onlineAt, durationMin } = req.body;

  if (!offlineAt || !onlineAt || durationMin == null) {
    return res.status(400).json({ error: 'offlineAt, onlineAt e durationMin sao obrigatorios' });
  }

  try {
    insertOfflineEvent(machine.id, { offlineAt, onlineAt, durationMin });
    console.log(`[offline-event] ${machine.id} offline ${Math.round(durationMin)} min (${offlineAt} → ${onlineAt})`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[offline-event]', err.message);
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

// ── Ack post-processors ───────────────────────────────────────────────────────

function postProcessNfceIndex(machineId, message) {
  try {
    const result = JSON.parse(message);
    if (Array.isArray(result.records) && result.records.length > 0) {
      db.upsertNFCeRecords(machineId, result.records);
      console.log(`[NFCe] ${machineId} day=${result.day}: ${result.records.length} registros indexados`);
    }
  } catch (e) {
    console.error('[NFCe] Falha ao indexar registros:', e.message);
  }
}

function handleNfceFindNotFound(emailRow) {
  const retryDelays = [5, 15];
  if (emailRow.retry_count < 2) {
    const nextAt = new Date(Date.now() + retryDelays[emailRow.retry_count] * 60000).toISOString();
    db.ncrUpdate(emailRow.id, { retry_count: emailRow.retry_count + 1, next_retry_at: nextAt });
    console.log(`[NCR] Pedido #${emailRow.order_ref} — retry ${emailRow.retry_count + 1} agendado em ${retryDelays[emailRow.retry_count]}min`);
  } else {
    db.ncrUpdate(emailRow.id, { danfe_found: 0 });
    ncrMonitor.sendNcrResultEmail(emailRow, { found: false }).catch(e =>
      console.error('[NCR] Falha ao enviar alerta:', e.message)
    );
  }
}

function postProcessNfceFind(commandId, machineId, success, message) {
  try {
    const emailRow = db.ncrGetByCommandId(commandId);
    if (!emailRow || emailRow.notified_at) return;
    let found = false;
    let result = { found: false };
    if (success !== false && message) {
      try { result = JSON.parse(message); found = !!result.found; } catch (_) {}
    }
    if (found) {
      db.ncrUpdate(emailRow.id, { danfe_found: 1, danfe_chave: result.chave, xml_b64: result.xml_b64 });
      ncrMonitor.sendNcrResultEmail(emailRow, result).catch(e =>
        console.error('[NCR] Falha ao enviar email confirmação:', e.message)
      );
    } else {
      handleNfceFindNotFound(emailRow);
    }
  } catch (e) {
    console.error('[NCR] Falha ao processar ACK aloha-find-nfce:', e.message);
  }
}

function postProcessNfceMonths(machineId, message) {
  try {
    const { months } = JSON.parse(message);
    if (!Array.isArray(months)) return;
    if (months.length === 0) {
      console.warn(`[NFCe] ${machineId}: aloha-list-nfce-months retornou 0 meses — pasta XML vazia ou caminho ausente em C:\\Bootdrv\\AlohaFiscal\\ServerData\\XML`);
    }
    let total = 0;
    for (const { month: mm, year: yy, days } of months) {
      const yearStr = yy || String(new Date().getFullYear());
      const monthKey = `${yearStr}-${mm}`;
      for (const day of (days || [])) {
        db.createCommand(machineId, 'aloha-index-nfce-day', { month: monthKey, day });
        total++;
      }
    }
    console.log(`[NFCe] ${machineId} histórico: ${months.length} meses, ${total} comandos enfileirados`);
  } catch (e) {
    console.error('[NFCe] Falha ao processar lista de meses:', e.message);
  }
}

const ACK_POST_PROCESSORS = {
  'aloha-index-nfce-day':   (commandId, machineId, success, message) => { if (success !== false && message) postProcessNfceIndex(machineId, message); },
  'aloha-find-nfce':        (commandId, machineId, success, message) => postProcessNfceFind(commandId, machineId, success, message),
  'aloha-list-nfce-months': (commandId, machineId, success, message) => { if (success !== false && message) postProcessNfceMonths(machineId, message); },
  'get_agent_log':          (commandId, machineId, success, message) => {
    if (success !== false && message)
      db.addEvent(machineId, 'agent_log_retrieved', `Diagnóstico reading_miss — log do agente (últimas linhas):\n${message.slice(0, 5000)}`);
  },
};

// POST /api/commands/ack
// Agente confirma execucao de um comando.
router.post('/commands/ack', agentAuthNoLimit, (req, res) => {
  const { commandId, success, message } = req.body;

  if (!commandId) {
    return res.status(400).json({ error: 'commandId obrigatorio' });
  }

  try {
    const cmd = db.getCommandById(commandId);
    db.ackCommand(commandId, req.machine.id, success !== false, message || '');

    if (cmd) {
      const processor = ACK_POST_PROCESSORS[cmd.type];
      if (processor) processor(commandId, req.machine.id, success, message);
    }

    broadcast('command:acked', { commandId, machineId: req.machine.id, success: success !== false, message: message || '' });

    if (success !== false) {
      db.addEvent(req.machine.id, 'command_ok', `Comando ${commandId} executado: ${message || 'OK'}`);
    } else {
      db.addEvent(req.machine.id, 'command_fail', `Comando ${commandId} falhou: ${message || ''}`);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[Ack] Erro:', err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

function _upsertServiceEntries(machineId, services) {
  let written = 0;
  for (const svc of services) {
    if (typeof svc.name !== 'string' || !svc.name) continue;
    if (svc.status !== 'running' && svc.status !== 'stopped') continue;
    const restartOk = svc.lastRestartOk != null ? (svc.lastRestartOk ? 1 : 0) : null;
    db.upsertServiceStatus(machineId, svc.name, svc.status, svc.lastRestartAt || null, restartOk);
    written++;
  }
  return written;
}

// POST /api/machines/:id/service-status
// Agente BOH reporta status dos serviços NCR Voyix a cada 60s.
// Usa agentAuthNoLimit para evitar conflito com o rate-limit de 5s do heartbeat.
router.post('/machines/:id/service-status', agentAuthNoLimit, (req, res) => {
  const { id } = req.params;
  if (req.machine.id !== id) return res.status(403).json({ error: 'Token não corresponde ao machineId' });

  const { services } = req.body;
  if (!Array.isArray(services) || services.length === 0) {
    return res.status(400).json({ error: 'services obrigatório' });
  }

  try {
    const written = _upsertServiceEntries(id, services);
    if (written === 0) return res.status(400).json({ error: 'Nenhuma entrada válida em services' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[ServiceStatus] Erro:', err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
module.exports.validateHeartbeat = validateHeartbeat;
