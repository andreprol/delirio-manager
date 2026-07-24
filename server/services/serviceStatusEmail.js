// server/services/serviceStatusEmail.js
// Email 2x/dia (06:00 e 18:00 BRT) com status dos serviços NCR Voyix em cada BOH.
'use strict';

const path = require('path');
const fs   = require('fs');

const SERVICE_NAMES = [
  'NCR Voyix Takeout and Delivery',
  'NCR Voyix Takeout Service Monitor',
];

const RECIPIENTS = [
  'andre@delirio.com.br',
  'thais@delirio.com.br',
  'rodrigorosa@delirio.com.br',
  'italo@delirio.com.br',
];

// 06:00 BRT = 09:00 UTC | 18:00 BRT = 21:00 UTC
const SEND_UTC_HOURS = [9, 21];

function loadGraphConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).msGraph || {};
  } catch {
    return {};
  }
}

async function getAccessToken(cfg) {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    scope:         'offline_access https://graph.microsoft.com/Mail.Send',
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
  );
  if (!res.ok) throw new Error(`token Graph: ${res.status}`);
  const { access_token, refresh_token: newRt } = await res.json();

  if (newRt && newRt !== cfg.refreshToken) {
    try {
      const confPath = path.join(__dirname, '..', 'config.json');
      const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
      conf.msGraph.refreshToken = newRt;
      fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));
    } catch (e) {
      const logger = require('./logger');
      logger.warn('[ServiceStatusEmail] falha ao persistir refresh_token', { error: e.message });
    }
  }
  return access_token;
}

// Agrupa rows de service_status com a lista de máquinas BOH
function buildMachineMap(statusRows, allBOH) {
  const map = {};
  for (const m of allBOH) {
    map[m.id] = {
      hostname:      m.hostname,
      displayName:   m.display_name || m.hostname,
      location:      m.location || 'Sem localidade',
      machineStatus: m.status,
      services:      {},
    };
  }
  for (const r of statusRows) {
    if (!map[r.machine_id]) continue;
    map[r.machine_id].services[r.service_name] = {
      status:        r.service_status,
      lastRestartAt: r.last_restart_at,
      lastRestartOk: r.last_restart_ok,
      updatedAt:     r.updated_at,
    };
  }
  return Object.values(map).sort((a, b) => a.hostname.localeCompare(b.hostname));
}

function buildEmailHtml(machines, dtBRT) {
  const anyProblem = machines.some(m =>
    SERVICE_NAMES.some(svc => {
      const s = m.services[svc];
      return !s || s.status !== 'running';
    })
  );

  const headerColor = anyProblem ? '#c0392b' : '#276749';
  const headerIcon  = anyProblem ? '⚠️' : '✅';

  const tableRows = machines.map(m => {
    const offline  = m.machineStatus !== 'online';
    const rowHasProblem = SERVICE_NAMES.some(svc => {
      const s = m.services[svc];
      return !s || s.status !== 'running';
    });
    const rowBg = rowHasProblem ? '#fff5f5' : '';

    const svcCells = SERVICE_NAMES.map(svc => {
      const s = m.services[svc];
      if (!s) {
        return `<td style="padding:6px 10px;text-align:center;font-size:12px;color:#718096">—<br><small>sem dados</small></td>`;
      }
      const running = s.status === 'running';
      const color   = running ? '#276749' : '#c0392b';
      let extra = '';
      if (s.lastRestartAt) {
        const ts = new Date(s.lastRestartAt).toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
        });
        const ok = s.lastRestartOk === 1 ? '✓ ok' : (s.lastRestartOk === 0 ? '✗ falhou' : '');
        extra = `<br><small style="color:#718096">reiniciado ${ts}${ok ? ' — ' + ok : ''}</small>`;
      }
      return `<td style="padding:6px 10px;text-align:center">
        <span style="color:${color};font-weight:bold">${running ? '✅ Rodando' : '❌ Parado'}</span>${extra}
      </td>`;
    }).join('');

    return `<tr style="border-bottom:1px solid #eee${rowBg ? ';background:' + rowBg : ''}">
      <td style="padding:6px 10px;font-family:monospace;font-size:13px">${m.displayName}</td>
      <td style="padding:6px 10px;font-size:12px;color:#555">${m.location}</td>
      <td style="padding:6px 10px;text-align:center;font-size:12px;color:${offline ? '#c0392b' : '#276749'}">
        ${offline ? '🔴 Offline' : '🟢 Online'}
      </td>
      ${svcCells}
    </tr>`;
  }).join('');

  const svcHeaders = SERVICE_NAMES.map(s =>
    `<th style="padding:6px 10px;text-align:center;min-width:155px;font-size:11px">${s}</th>`
  ).join('');

  const banner = anyProblem
    ? `<p style="background:#fff5f5;border-left:4px solid #c0392b;padding:10px 14px;margin:0 0 16px;font-size:13px">
        ⚠️ <b>Atenção:</b> Um ou mais serviços NCR estão com problema. O agente tentará reiniciá-los automaticamente.
        Intervenção manual necessária apenas se o status continuar como Parado na próxima leitura.
      </p>`
    : `<p style="background:#f0fff4;border-left:4px solid #276749;padding:10px 14px;margin:0 0 16px;font-size:13px">
        ✅ Todos os serviços NCR Voyix estão operando normalmente em todas as máquinas BOH.
      </p>`;

  return `<!DOCTYPE html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;max-width:820px;margin:0 auto;color:#222">
<div style="background:${headerColor};color:#fff;padding:14px 20px;border-radius:6px 6px 0 0">
  <h2 style="margin:0;font-size:16px">${headerIcon} Delirio Manager — Status Serviços NCR Voyix (BOH)</h2>
  <p style="margin:4px 0 0;font-size:13px;opacity:0.8">${dtBRT}</p>
</div>
<div style="border:1px solid #ddd;border-top:none;padding:16px 20px;border-radius:0 0 6px 6px">
  ${banner}
  <table style="width:100%;border-collapse:collapse;border:1px solid #ddd;border-radius:4px;font-size:13px">
    <thead>
      <tr style="background:#f7f7f7;font-size:12px;color:#555">
        <th style="padding:6px 10px;text-align:left">Máquina</th>
        <th style="padding:6px 10px;text-align:left">Loja</th>
        <th style="padding:6px 10px;text-align:center">Agente</th>
        ${svcHeaders}
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  <p style="margin-top:16px;font-size:11px;color:#a0aec0">
    Serviços monitorados e reiniciados automaticamente pelo agente v1.5.27+.<br>
    Relatório enviado às 06:00 e 18:00 BRT. Máquinas sem dados aguardam atualização do agente.
  </p>
</div>
</body></html>`;
}

async function sendServiceStatusEmail() {
  const logger = require('./logger');
  const { getAllMachines, getServiceStatusBOH } = require('../db');

  try {
    const cfg = loadGraphConfig();
    if (!cfg.clientId || !cfg.refreshToken) {
      logger.warn('[ServiceStatusEmail] msGraph não configurado — pulando envio');
      return;
    }

    const allBOH = getAllMachines().filter(m => m.hostname?.toUpperCase().endsWith('BOH'));
    if (!allBOH.length) {
      logger.info('[ServiceStatusEmail] Nenhuma máquina BOH registrada');
      return;
    }

    const statusRows = getServiceStatusBOH();
    const machines   = buildMachineMap(statusRows, allBOH);

    const now    = new Date();
    const dtBRT  = now.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short',
    });
    const hhmm   = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    });
    const subject = `Delirio Manager — Status NCR BOH — ${hhmm} BRT`;
    const html    = buildEmailHtml(machines, dtBRT);

    const token = await getAccessToken(cfg);

    const msgRes = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        message: {
          subject,
          body:         { contentType: 'HTML', content: html },
          toRecipients: RECIPIENTS.map(addr => ({ emailAddress: { address: addr } })),
        },
        saveToSentItems: false,
      }),
    });

    if (!msgRes.ok) {
      const txt = await msgRes.text();
      throw new Error(`Graph sendMail: ${msgRes.status} — ${txt}`);
    }

    logger.info('[ServiceStatusEmail] Email enviado', { recipients: RECIPIENTS.length, machines: machines.length, subject });
  } catch (err) {
    logger.error('[ServiceStatusEmail] Falha ao enviar', { error: err.message });
  }
}

let _lastSentHour = -1;

function scheduleServiceStatusEmails() {
  const logger = require('./logger');

  setInterval(() => {
    const now     = new Date();
    const utcHour = now.getUTCHours();
    const utcMin  = now.getUTCMinutes();

    if (utcMin <= 1 && SEND_UTC_HOURS.includes(utcHour) && utcHour !== _lastSentHour) {
      _lastSentHour = utcHour;
      sendServiceStatusEmail().catch(err =>
        logger.error('[ServiceStatusEmail] Scheduler erro', { error: err.message })
      );
    }
  }, 60 * 1000);

  logger.info('[ServiceStatusEmail] Scheduler iniciado', { horarios: '06:00 e 18:00 BRT' });
}

module.exports = { scheduleServiceStatusEmails, sendServiceStatusEmail };
