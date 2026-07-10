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

// Valida o payload do heartbeat. Retorna array de erros (vazio = válido).
function validateHeartbeat(body) {
  const errors = [];
  const { metrics, agentVersion, motherboard, osVersion, drStatus } = body;

  if (agentVersion !== undefined && (typeof agentVersion !== 'string' || agentVersion.length > 50)) {
    errors.push('agentVersion deve ser string com máximo 50 chars');
  }
  if (motherboard !== undefined && (typeof motherboard !== 'string' || motherboard.length > 200)) {
    errors.push('motherboard deve ser string com máximo 200 chars');
  }
  if (osVersion !== undefined && (typeof osVersion !== 'string' || osVersion.length > 100)) {
    errors.push('osVersion deve ser string com máximo 100 chars');
  }

  if (metrics !== undefined) {
    if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) {
      errors.push('metrics deve ser um objeto');
    } else {
      const numericRanges = [
        { field: 'cpu_pct',  min: 0, max: 100 },
        { field: 'ram_pct',  min: 0, max: 100 },
        { field: 'disk_pct', min: 0, max: 100 },
        { field: 'temp_c',   min: 0, max: 150 },
      ];
      for (const { field, min, max } of numericRanges) {
        const val = metrics[field];
        if (val !== undefined && val !== null) {
          if (typeof val !== 'number' || isNaN(val) || val < min || val > max) {
            errors.push(`metrics.${field} deve ser número entre ${min} e ${max}`);
          }
        }
      }

      if (metrics.mac !== undefined && metrics.mac !== null) {
        const macRegex = /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/;
        if (typeof metrics.mac !== 'string' || !macRegex.test(metrics.mac)) {
          errors.push('metrics.mac deve ser endereço MAC válido (ex: AA:BB:CC:DD:EE:FF)');
        }
      }

      if (metrics.ips !== undefined) {
        if (!Array.isArray(metrics.ips)) {
          errors.push('metrics.ips deve ser um array');
        } else if (metrics.ips.length > 20) {
          errors.push('metrics.ips deve ter no máximo 20 itens');
        } else if (metrics.ips.some(ip => typeof ip !== 'string' || ip.length > 45)) {
          errors.push('cada item de metrics.ips deve ser string com máximo 45 chars');
        }
      }
    }
  }

  if (drStatus !== undefined) {
    if (typeof drStatus !== 'object' || drStatus === null || Array.isArray(drStatus)) {
      errors.push('drStatus deve ser um objeto');
    } else {
      if (drStatus.storage_gb !== undefined && drStatus.storage_gb !== null &&
          (typeof drStatus.storage_gb !== 'number' || isNaN(drStatus.storage_gb) || drStatus.storage_gb < 0)) {
        errors.push('drStatus.storage_gb deve ser número não-negativo');
      }
      if (drStatus.setup !== undefined && (typeof drStatus.setup !== 'string' || drStatus.setup.length > 50)) {
        errors.push('drStatus.setup deve ser string com máximo 50 chars');
      }
      if (drStatus.veeam_version !== undefined &&
          (typeof drStatus.veeam_version !== 'string' || drStatus.veeam_version.length > 50)) {
        errors.push('drStatus.veeam_version deve ser string com máximo 50 chars');
      }
    }
  }

  return errors;
}

// POST /api/heartbeat
// Recebe metricas do agente. Requer token valido.
router.post('/heartbeat', agentAuth, (req, res) => {
  const machine = req.machine;
  const { metrics, hostname, agentVersion } = req.body;

  const validationErrors = validateHeartbeat(req.body);
  if (validationErrors.length > 0) {
    return res.status(400).json({ error: 'Payload inválido', details: validationErrors });
  }

  try {
    // Se a máquina estava offline, reseta cooldown para que a próxima queda alerte imediatamente
    if (machine.status === 'offline') {
      clearOfflineCooldown(machine.id);
    }

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

    // Atualiza WoL driver status, motherboard e OS version
    const { wolEnabled, motherboard, osVersion } = req.body;

    if (typeof motherboard === 'string' && motherboard && !machine.motherboard) {
      db.updateMachine(machine.id, { motherboard });
    }
    if (typeof osVersion === 'string' && osVersion && osVersion !== machine.os_version) {
      db.updateMachine(machine.id, { os_version: osVersion });
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
      osVersion:   osVersion || machine.os_version || '',
    });

    // DR status — update machines table and insert backup record if new
    const drStatus = req.body.dr_status;
    if (drStatus) {
      try {
        const setup = drStatus.setup || 'not_installed';
        const drUpdate = { setup };
        if (drStatus.veeam_version) drUpdate.version = drStatus.veeam_version;
        if (drStatus.storage_gb != null) drUpdate.storageGb = drStatus.storage_gb;

        if (drStatus.last_backup_at && drStatus.last_backup_at !== machine.dr_last_ok) {
          if (drStatus.last_backup_ok) {
            drUpdate.lastOk = drStatus.last_backup_at;
            db.insertDRBackup(machine.id, {
              backedAt:    drStatus.last_backup_at,
              status:      'ok',
              storageGb:   drStatus.storage_gb,
              durationMin: drStatus.duration_min,
            });
          } else {
            db.insertDRBackup(machine.id, {
              backedAt: drStatus.last_backup_at,
              status:   'failed',
              errorMsg: drStatus.error_msg,
            });
          }
        }

        db.updateMachineDRStatus(machine.id, drUpdate);
        broadcast('dr_update', { machineId: machine.id, drStatus });
      } catch (err) {
        console.error('[heartbeat] DR status update error:', err.message);
      }
    }

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

// POST /api/metrics/hourly
// Agente envia snapshot horário de métricas (24x/dia).
router.post('/metrics/hourly', agentAuth, (req, res) => {
  const machine = req.machine;
  const { snapshotTs, cpuPct, ramPct, diskPct, cpuTempC } = req.body;

  if (!snapshotTs) return res.status(400).json({ error: 'snapshotTs obrigatorio' });

  try {
    insertMetricsHourly(machine.id, { snapshotTs, cpuPct, ramPct, diskPct, cpuTempC });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[metrics/hourly]', err.message);
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

// POST /api/commands/ack
// Agente confirma execucao de um comando.
router.post('/commands/ack', agentAuthNoLimit, (req, res) => {
  const { commandId, success, message } = req.body;

  if (!commandId) {
    return res.status(400).json({ error: 'commandId obrigatorio' });
  }

  try {
    // Look up command type before ACKing (type doesn't change, but need it for post-processing)
    const cmd = db.getCommandById(commandId);
    db.ackCommand(commandId, req.machine.id, success !== false, message || '');

    // Post-process: upsert NF-Ce records when indexing succeeds
    if (cmd && cmd.type === 'aloha-index-nfce-day' && success !== false && message) {
      try {
        const result = JSON.parse(message);
        if (Array.isArray(result.records) && result.records.length > 0) {
          db.upsertNFCeRecords(req.machine.id, result.records);
          console.log(`[NFCe] ${req.machine.id} day=${result.day}: ${result.records.length} registros indexados`);
        }
      } catch (e) {
        console.error('[NFCe] Falha ao indexar registros:', e.message);
      }
    }

    // Post-process: verificar NFC-e para pedidos NCR
    if (cmd && cmd.type === 'aloha-find-nfce') {
      try {
        const emailRow = db.ncrGetByCommandId(commandId);
        if (emailRow && !emailRow.notified_at) {
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
        }
      } catch (e) {
        console.error('[NCR] Falha ao processar ACK aloha-find-nfce:', e.message);
      }
    }

    // Post-process: queue day-index commands for every discovered month/day
    if (cmd && cmd.type === 'aloha-list-nfce-months' && success !== false && message) {
      try {
        const { months } = JSON.parse(message);
        if (Array.isArray(months)) {
          if (months.length === 0) {
            console.warn(`[NFCe] ${req.machine.id}: aloha-list-nfce-months retornou 0 meses — pasta XML vazia ou caminho ausente em C:\\Bootdrv\\AlohaFiscal\\ServerData\\XML`);
          }
          let total = 0;
          for (const { month: mm, year: yy, days } of months) {
            const yearStr = yy || String(new Date().getFullYear());
            const monthKey = `${yearStr}-${mm}`; // e.g. "2026-06"
            for (const day of (days || [])) {
              db.createCommand(req.machine.id, 'aloha-index-nfce-day', { month: monthKey, day });
              total++;
            }
          }
          console.log(`[NFCe] ${req.machine.id} histórico: ${months.length} meses, ${total} comandos enfileirados`);
        }
      } catch (e) {
        console.error('[NFCe] Falha ao processar lista de meses:', e.message);
      }
    }

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
module.exports.validateHeartbeat = validateHeartbeat;
