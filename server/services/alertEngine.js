'use strict';

const path       = require('path');
const fs         = require('fs');
const nodemailer = require('nodemailer');
const db         = require('../db');
const { broadcast } = require('./websocket');
const { getBiosGuide } = require('./wolBiosGuide');

const CHECK_INTERVAL_MS = 60 * 1000;
const OFFLINE_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min entre alertas offline por máquina
const cpuAlertStart = new Map();
const offlineAlertCooldown = new Map(); // machineId → timestamp do último alerta offline
let timer;

function loadConfig() {
  try {
    const cfgPath = path.join(__dirname, '..', 'config.json');
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return { alerts: { email: { enabled: false }, teams: { enabled: false } } };
  }
}

function start() {
  timer = setInterval(checkAll, CHECK_INTERVAL_MS);
  console.log('[AlertEngine] Iniciado (intervalo: 60s)');
}

function stop() {
  if (timer) clearInterval(timer);
}

function checkAll() {
  checkOffline();
  checkMetricThresholds();
  checkWolTests();
  checkWolAutoTests();
  checkAutoWake();
}

// Detecta maquinas que pararam de enviar heartbeat
function checkOffline() {
  const threshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const stale     = db.getMachinesStale(threshold);

  for (const machine of stale) {
    db.setMachineStatus(machine.id, 'offline');
    db.addEvent(machine.id, 'offline', 'Sem heartbeat por mais de 5 minutos');

    // Fetch last known health metrics
    let lastMetrics = null;
    try {
      const raw = db.getMetrics(machine.id, 1);
      if (raw.length > 0) lastMetrics = raw[raw.length - 1];
    } catch {}

    const displayName = machine.display_name || machine.hostname;
    const location    = machine.location || 'Sem localidade';

    // 1. In-app via WebSocket (sempre — UI precisa saber)
    broadcast('machine:offline', {
      machineId:   machine.id,
      displayName,
      location,
      lastSeen:    machine.last_seen,
      onlineSince: machine.online_since,
      lastMetrics,
    });

    // 2–3. Email + Teams: apenas se fora do cooldown de 30 min
    const now       = Date.now();
    const lastAlert = offlineAlertCooldown.get(machine.id) || 0;
    const inCooldown = (now - lastAlert) < OFFLINE_ALERT_COOLDOWN_MS;

    if (!inCooldown) {
      offlineAlertCooldown.set(machine.id, now);
      sendOfflineEmail(displayName, location, machine.last_seen, lastMetrics);
      sendOfflineTeams(displayName, location, machine.last_seen, lastMetrics);
    }

    // 4. fireAlert in-app (sempre)
    fireAlert(machine.id, 'offline',
      `${displayName} ficou offline`);

    console.log(`[AlertEngine] Offline: ${machine.id}${inCooldown ? ' (email/Teams suprimido — cooldown 30min)' : ''}`);
  }
}

// Chamado quando a máquina volta online — reseta cooldown para que
// uma nova queda gere alerta imediato, sem esperar os 30 min
function clearOfflineCooldown(machineId) {
  offlineAlertCooldown.delete(machineId);
}

// Verifica limiares de CPU, temperatura e disco
function checkMetricThresholds() {
  const machines = db.getAllMachines();

  for (const machine of machines) {
    if (machine.status !== 'online' || !machine.last_metrics) continue;

    let m;
    try { m = JSON.parse(machine.last_metrics); } catch { continue; }

    // CPU alta
    const cpuAlerts = db.getAlerts(machine.id).filter(
      a => a.enabled && a.type === 'cpu_high'
    );
    for (const rule of cpuAlerts) {
      const key = `${machine.id}:cpu`;
      if (m.cpuPct >= rule.threshold) {
        if (!cpuAlertStart.has(key)) cpuAlertStart.set(key, Date.now());
        const elapsed = (Date.now() - cpuAlertStart.get(key)) / 60000;
        if (elapsed >= rule.duration_mins) {
          fireAlert(machine.id, 'cpu_high',
            `${machine.display_name || machine.id}: CPU em ${m.cpuPct}% por ${Math.round(elapsed)}min`);
          cpuAlertStart.delete(key); // reseta para nao spam
        }
      } else {
        cpuAlertStart.delete(key);
      }
    }

    // Temperatura alta
    const tempAlerts = db.getAlerts(machine.id).filter(
      a => a.enabled && a.type === 'temp_high'
    );
    for (const rule of tempAlerts) {
      if (m.cpuTempC > 0 && m.cpuTempC >= rule.threshold) {
        fireAlert(machine.id, 'temp_high',
          `${machine.display_name || machine.id}: Temperatura CPU em ${m.cpuTempC}C`);
      }
    }

    // Disco baixo
    const diskAlerts = db.getAlerts(machine.id).filter(
      a => a.enabled && a.type === 'disk_low'
    );
    for (const rule of diskAlerts) {
      if (m.diskFreeGB > 0 && m.diskFreeGB <= rule.threshold) {
        fireAlert(machine.id, 'disk_low',
          `${machine.display_name || machine.id}: Disco livre: ${m.diskFreeGB}GB`);
      }
    }
  }
}

function checkWolTests() {
  const timeout = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const machines = db.getMachinesWolTesting(timeout);

  for (const machine of machines) {
    const displayName = machine.display_name || machine.hostname;
    const location    = machine.location || 'Sem localidade';

    if (machine.status === 'online') {
      db.setWolStatus(machine.id, 'wol_confirmed');
      fireAlert(machine.id, 'wol_confirmed',
        `${displayName}: WoL confirmado! Máquina ligou via magic packet.`);
      console.log(`[WoL] Confirmado: ${machine.id}`);
    } else {
      db.setWolStatus(machine.id, 'bios_needed');
      const guide = getBiosGuide(machine.motherboard);
      sendWolBiosAlert(machine, displayName, location, guide);
      console.log(`[WoL] BIOS needed: ${machine.id} (${guide.manufacturer})`);
    }
  }
}

function checkAutoWake() {
  const cfg = loadConfig();
  if (!cfg.autoWake?.enabled) return;

  const cutoff      = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const allMachines = db.getAllMachines();
  const candidates  = db.getMachinesOfflineForWake(cutoff);

  for (const machine of candidates) {
    const relay = allMachines.find(m =>
      m.id       !== machine.id &&
      m.location === machine.location &&
      m.status   === 'online'
    );
    if (!relay) {
      console.log(`[AutoWake] Sem relay para ${machine.id} em ${machine.location}`);
      continue;
    }

    const now        = new Date().toISOString();
    const offlineMin = Math.round((Date.now() - new Date(machine.last_seen).getTime()) / 60000);
    const name       = machine.display_name || machine.hostname;
    const location   = machine.location || 'Sem localidade';

    db.createCommand(relay.id, 'wol', { mac: machine.mac, targetId: machine.id });
    db.setWolStatus(machine.id, 'wol_auto_testing', now);
    db.addEvent(machine.id, 'auto_wake_sent', `Auto-Wake: magic packet enviado via ${relay.display_name || relay.hostname}`);

    fireAlert(machine.id, 'auto_wake',
      `Auto-Wake: enviando magic packet para ${name} (offline há ${offlineMin} min)`);

    sendAutoWakeEmail(name, location, offlineMin);
    sendAutoWakeTeams(name, location, offlineMin);

    console.log(`[AutoWake] Magic packet enviado para ${machine.id} via relay ${relay.id}`);
  }
}

function checkWolAutoTests() {
  const timeout  = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const machines = db.getMachinesAutoWolTesting(timeout);

  for (const machine of machines) {
    const name     = machine.display_name || machine.hostname;
    const location = machine.location || 'Sem localidade';

    if (machine.status === 'online') {
      db.setWolStatus(machine.id, 'wol_confirmed');
      db.addEvent(machine.id, 'auto_wake_success', 'Máquina ligada automaticamente com sucesso');
      fireAlert(machine.id, 'auto_wake_success',
        `✅ ${name}: ligada automaticamente com sucesso!`);
      sendAutoWakeResultEmail(name, location, true);
      sendAutoWakeResultTeams(name, location, true);
      console.log(`[AutoWake] Sucesso: ${machine.id}`);
    } else {
      db.setWolStatus(machine.id, 'wol_confirmed');
      db.addEvent(machine.id, 'auto_wake_failed', 'Auto-Wake: sem resposta em 3 min');
      fireAlert(machine.id, 'auto_wake_failed',
        `⚠️ ${name}: Auto-Wake falhou — sem resposta em 3 min`);
      sendAutoWakeResultEmail(name, location, false);
      sendAutoWakeResultTeams(name, location, false);
      console.log(`[AutoWake] Falhou: ${machine.id}`);
    }
  }
}

async function sendWolBiosAlert(machine, displayName, location, guide) {
  const subject = `⚠️ WoL — Configurar BIOS: ${displayName}`;

  fireAlert(machine.id, 'wol_bios_needed',
    `${displayName}: WoL falhou — configurar BIOS (${guide.manufacturer} ${guide.model})`);

  await sendWolBiosEmail(subject, displayName, location, guide);
  await sendWolBiosTeams(displayName, location, guide);
}

async function sendWolBiosEmail(subject, displayName, location, guide) {
  const cfg = loadConfig().alerts?.email;
  if (!cfg?.enabled || !cfg.to?.length) return;

  const transporter = nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth:   { user: cfg.user, pass: cfg.pass },
  });

  try {
    await transporter.sendMail({
      from:    `"Delirio Manager" <${cfg.user}>`,
      to:      cfg.to.join(', '),
      subject,
      html: `
        <h2 style="color:#f59e0b">⚠️ Wake-on-LAN — Configuração de BIOS Necessária</h2>
        <p><strong>Máquina:</strong> ${displayName}</p>
        <p><strong>Localidade:</strong> ${location}</p>
        <p><strong>Placa-mãe:</strong> ${guide.manufacturer} — ${guide.model}</p>
        <hr>
        <p>O <strong>driver Windows</strong> está corretamente configurado, mas a máquina não respondeu ao magic packet.</p>
        <p>É necessário habilitar Wake-on-LAN na BIOS:</p>
        <div style="background:#1e1e1e;color:#fff;padding:12px;border-radius:6px;font-family:monospace">
          ${guide.path}
        </div>
        ${guide.note ? `<p style="color:#888"><em>Obs: ${guide.note}</em></p>` : ''}
        <hr>
        <p style="color:#888;font-size:12px">Delirio Manager — Sistema de Monitoramento</p>
      `,
    });
    console.log(`[AlertEngine] Email WoL BIOS enviado: ${displayName}`);
  } catch (err) {
    console.error('[AlertEngine] Falha email WoL BIOS:', err.message);
  }
}

async function sendWolBiosTeams(displayName, location, guide) {
  const cfg = loadConfig().alerts?.teams;
  if (!cfg?.enabled || !cfg.webhook_url) return;

  const facts = [
    { title: 'Máquina',      value: displayName },
    { title: 'Localidade',   value: location },
    { title: 'Placa-mãe',    value: `${guide.manufacturer} — ${guide.model}` },
    { title: 'Caminho BIOS', value: guide.path },
  ];
  if (guide.note) facts.push({ title: 'Obs', value: guide.note });

  const body = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: '⚠️ WoL — Configurar BIOS', weight: 'Bolder', size: 'Medium', color: 'Warning' },
          { type: 'FactSet', facts },
        ],
      },
    }],
  };

  try {
    await fetch(cfg.webhook_url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    console.log(`[AlertEngine] Teams WoL BIOS enviado: ${displayName}`);
  } catch (err) {
    console.error('[AlertEngine] Falha Teams WoL BIOS:', err.message);
  }
}

async function sendAutoWakeEmail(name, location, offlineMin) {
  const cfg = loadConfig().alerts?.email;
  if (!cfg?.enabled || !cfg.to?.length) return;

  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host, port: cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  try {
    await transporter.sendMail({
      from:    `"Delirio Manager" <${cfg.user}>`,
      to:      cfg.to.join(', '),
      subject: `🔄 Auto-Wake iniciado: ${name}`,
      html: `
        <h2 style="color:#3b82f6">🔄 Auto-Wake Iniciado</h2>
        <p><strong>Máquina:</strong> ${name}</p>
        <p><strong>Localidade:</strong> ${location}</p>
        <p><strong>Offline há:</strong> ${offlineMin} minutos</p>
        <p>Magic packet enviado automaticamente.</p>
        <hr><p style="color:#888;font-size:12px">Delirio Manager — Auto-Wake</p>
      `,
    });
  } catch (err) {
    console.error('[AutoWake] Falha email init:', err.message);
  }
}

async function sendAutoWakeResultEmail(name, location, success) {
  const cfg = loadConfig().alerts?.email;
  if (!cfg?.enabled || !cfg.to?.length) return;

  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host, port: cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  const icon   = success ? '✅' : '⚠️';
  const color  = success ? '#22c55e' : '#f59e0b';
  const status = success ? 'Ligada com sucesso' : 'Falhou — sem resposta em 3 min';

  try {
    await transporter.sendMail({
      from:    `"Delirio Manager" <${cfg.user}>`,
      to:      cfg.to.join(', '),
      subject: `${icon} Auto-Wake ${success ? 'OK' : 'Falhou'}: ${name}`,
      html: `
        <h2 style="color:${color}">${icon} Auto-Wake ${success ? 'Concluído' : 'Falhou'}</h2>
        <p><strong>Máquina:</strong> ${name}</p>
        <p><strong>Localidade:</strong> ${location}</p>
        <p><strong>Resultado:</strong> ${status}</p>
        <hr><p style="color:#888;font-size:12px">Delirio Manager — Auto-Wake</p>
      `,
    });
  } catch (err) {
    console.error('[AutoWake] Falha email result:', err.message);
  }
}

async function sendAutoWakeTeams(name, location, offlineMin) {
  const cfg = loadConfig().alerts?.teams;
  if (!cfg?.enabled || !cfg.webhook_url) return;

  const body = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', text: '🔄 Auto-Wake Iniciado', weight: 'Bolder', size: 'Medium', color: 'Accent' },
          { type: 'FactSet', facts: [
            { title: 'Máquina',    value: name },
            { title: 'Localidade', value: location },
            { title: 'Offline há', value: `${offlineMin} minutos` },
          ]},
        ],
      },
    }],
  };

  try {
    await fetch(cfg.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[AutoWake] Falha Teams init:', err.message);
  }
}

async function sendAutoWakeResultTeams(name, location, success) {
  const cfg = loadConfig().alerts?.teams;
  if (!cfg?.enabled || !cfg.webhook_url) return;

  const body = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard', version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: success ? '✅ Auto-Wake Concluído' : '⚠️ Auto-Wake Falhou',
            weight: 'Bolder', size: 'Medium',
            color: success ? 'Good' : 'Warning',
          },
          { type: 'FactSet', facts: [
            { title: 'Máquina',    value: name },
            { title: 'Localidade', value: location },
            { title: 'Resultado',  value: success ? 'Ligada com sucesso' : 'Sem resposta em 3 min' },
          ]},
        ],
      },
    }],
  };

  try {
    await fetch(cfg.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[AutoWake] Falha Teams result:', err.message);
  }
}

function formatMetricsText(m) {
  if (!m) return 'Métricas não disponíveis';
  const ram = m.ram_total_mb > 0
    ? `${Math.round((1 - m.ram_free_mb / m.ram_total_mb) * 100)}%`
    : 'N/D';
  const cpu  = m.cpu_pct    != null ? `${m.cpu_pct}%`                  : 'N/D';
  const temp = m.cpu_temp_c  > 0    ? `${Math.round(m.cpu_temp_c)}°C`  : 'N/D';
  const sala = m.room_temp_c > 0    ? `${Math.round(m.room_temp_c)}°C` : 'N/D';
  return `CPU: ${cpu} | RAM: ${ram} | Temp CPU: ${temp} | Temp Sala: ${sala}`;
}

async function sendOfflineEmail(displayName, location, lastSeen, lastMetrics) {
  const cfg = loadConfig().alerts?.email;
  if (!cfg?.enabled || !cfg.to?.length) return;

  const transporter = nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth:   { user: cfg.user, pass: cfg.pass },
  });

  const when    = lastSeen ? new Date(lastSeen).toLocaleString('pt-BR') : 'desconhecido';
  const metrics = formatMetricsText(lastMetrics);

  try {
    await transporter.sendMail({
      from:    `"Delirio Manager" <${cfg.user}>`,
      to:      cfg.to.join(', '),
      subject: `🔴 Máquina Offline: ${displayName}`,
      html: `
        <h2 style="color:#ef4444">🔴 Máquina Offline</h2>
        <p><strong>Máquina:</strong> ${displayName}</p>
        <p><strong>Localidade:</strong> ${location}</p>
        <p><strong>Último contato:</strong> ${when}</p>
        <hr>
        <p><strong>Último estado de saúde:</strong><br>${metrics}</p>
        <hr>
        <p style="color:#888;font-size:12px">Delirio Manager — Sistema de Monitoramento</p>
      `,
    });
    console.log(`[AlertEngine] Email enviado para offline: ${displayName}`);
  } catch (err) {
    console.error('[AlertEngine] Falha ao enviar email:', err.message);
  }
}

async function sendOfflineTeams(displayName, location, lastSeen, lastMetrics) {
  const cfg = loadConfig().alerts?.teams;
  if (!cfg?.enabled || !cfg.webhook_url) return;

  const when    = lastSeen ? new Date(lastSeen).toLocaleString('pt-BR') : 'desconhecido';
  const metrics = formatMetricsText(lastMetrics);

  const body = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: '🔴 Máquina Offline', weight: 'Bolder', size: 'Medium', color: 'Attention' },
          { type: 'FactSet', facts: [
            { title: 'Máquina',        value: displayName },
            { title: 'Localidade',     value: location    },
            { title: 'Último contato', value: when        },
            { title: 'Saúde',          value: metrics     },
          ]},
        ],
      },
    }],
  };

  try {
    // Node.js 22+ has native fetch
    await fetch(cfg.webhook_url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    console.log(`[AlertEngine] Teams webhook enviado para offline: ${displayName}`);
  } catch (err) {
    console.error('[AlertEngine] Falha Teams webhook:', err.message);
  }
}

function fireAlert(machineId, type, message) {
  broadcast('alert', { machineId, type, message, ts: new Date().toISOString() });
  db.addEvent(machineId, `alert_${type}`, message);
  console.log(`[Alert] ${type} | ${machineId}: ${message}`);
}

module.exports = { start, stop, checkAll, clearOfflineCooldown };
