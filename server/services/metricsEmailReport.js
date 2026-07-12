// server/services/metricsEmailReport.js
// Email diário às 00:00 BRT (03:00 UTC) com contagem de medições horárias por máquina
'use strict';

const path = require('path');
const fs   = require('fs');
const db   = require('../db');

// Carrega config msGraph do config.json
function loadGraphConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).msGraph || {};
  } catch {
    return {};
  }
}

// Obtém access_token via refresh_token e persiste novo RT se rotacionado
async function getAccessToken(cfg) {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    scope:         'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send',
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
  );
  if (!res.ok) throw new Error(`Falha ao obter token Graph: ${res.status}`);
  const { access_token, refresh_token: newRt } = await res.json();

  if (newRt && newRt !== cfg.refreshToken) {
    try {
      const confPath = path.join(__dirname, '..', 'config.json');
      const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
      conf.msGraph.refreshToken = newRt;
      fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));
    } catch {}
  }
  return access_token;
}

// Gera o HTML do email com tabela por loja
function buildEmailHtml(rows, dtBRT) {
  const totalMachines = rows.length;
  const withReadings  = rows.filter(r => r.readings_24h > 0).length;
  const noReadings    = totalMachines - withReadings;

  // Agrupar por loja
  const byStore = {};
  for (const r of rows) {
    if (!byStore[r.location]) byStore[r.location] = [];
    byStore[r.location].push(r);
  }

  const storeBlocks = Object.entries(byStore).map(([store, machines]) => {
    const storeNoReadings = machines.filter(m => m.readings_24h === 0).length;
    const storeHeaderColor = storeNoReadings > 0 ? '#c0392b' : '#276749';
    const storeHeaderIcon  = storeNoReadings > 0 ? '⚠️' : '✅';

    const machineRows = machines.map(m => {
      let icon, color;
      if (m.readings_24h === 0)       { icon = '❌'; color = '#c0392b'; }
      else if (m.readings_24h >= 20)  { icon = '✅'; color = '#276749'; }
      else if (m.readings_24h >= 12)  { icon = '⚠️'; color = '#b7791f'; }
      else                            { icon = '🟡'; color = '#b7791f'; }

      const pct = Math.round((m.readings_24h / 24) * 100);
      const ver = m.agent_version || '?';
      const verColor = (!m.agent_version || m.agent_version < '1.5.13') ? '#c0392b' : '#718096';
      const verNote  = (!m.agent_version || m.agent_version < '1.5.13') ? ' ⚠️ sem snapshot' : '';
      return `
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:5px 8px;font-family:monospace;font-size:13px">${m.hostname}</td>
          <td style="padding:5px 8px;text-align:center">${icon}</td>
          <td style="padding:5px 8px;text-align:right;color:${color};font-weight:bold">${m.readings_24h}/24</td>
          <td style="padding:5px 8px;text-align:right;color:#718096;font-size:12px">${pct}%</td>
          <td style="padding:5px 8px;color:#718096;font-size:12px">${m.status || ''}</td>
          <td style="padding:5px 8px;font-family:monospace;font-size:11px;color:${verColor}">${ver}${verNote}</td>
        </tr>`;
    }).join('');

    return `
    <div style="margin-bottom:20px">
      <div style="background:${storeHeaderColor};color:#fff;padding:8px 12px;border-radius:4px 4px 0 0;font-weight:bold;font-size:14px">
        ${storeHeaderIcon} ${store} — ${machines.length} máquinas (${storeNoReadings > 0 ? `<b>${storeNoReadings} sem medição</b>` : 'todas medindo'})
      </div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #ddd;border-top:none;border-radius:0 0 4px 4px">
        <thead>
          <tr style="background:#f7f7f7;font-size:12px;color:#555">
            <th style="padding:5px 8px;text-align:left">Máquina</th>
            <th style="padding:5px 8px">Status</th>
            <th style="padding:5px 8px;text-align:right">Leituras</th>
            <th style="padding:5px 8px;text-align:right">Cobertura</th>
            <th style="padding:5px 8px;text-align:left">Agente</th>
            <th style="padding:5px 8px;text-align:left">Versão</th>
          </tr>
        </thead>
        <tbody>${machineRows}</tbody>
      </table>
    </div>`;
  }).join('');

  const summaryColor = noReadings > 0 ? '#c0392b' : '#276749';

  return `<!DOCTYPE html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#222">
<div style="background:#2d3748;color:#fff;padding:14px 20px;border-radius:6px 6px 0 0">
  <h2 style="margin:0;font-size:16px">📊 Delirio Manager — Relatório de Medições Horárias</h2>
  <p style="margin:4px 0 0;font-size:13px;opacity:0.8">Período: últimas 24h | ${dtBRT}</p>
</div>
<div style="border:1px solid #ddd;border-top:none;padding:16px 20px;border-radius:0 0 6px 6px">

  <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
    <tr style="background:#f7f7f7">
      <td style="padding:8px 12px;font-size:14px"><b>Total de máquinas registradas</b></td>
      <td style="padding:8px 12px;text-align:right;font-size:14px"><b>${totalMachines}</b></td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-size:14px">✅ Máquinas com medições (últimas 24h)</td>
      <td style="padding:8px 12px;text-align:right;font-size:14px;color:#276749"><b>${withReadings}</b></td>
    </tr>
    <tr style="background:#fff5f5">
      <td style="padding:8px 12px;font-size:14px">❌ Máquinas SEM nenhuma medição</td>
      <td style="padding:8px 12px;text-align:right;font-size:14px;color:${summaryColor}"><b>${noReadings}</b></td>
    </tr>
  </table>

  ${noReadings > 0
    ? `<p style="background:#fff5f5;border-left:4px solid #c0392b;padding:10px 14px;margin-bottom:20px;font-size:13px">
        ⚠️ <b>Atenção:</b> ${noReadings} máquina(s) não enviaram nenhuma medição nas últimas 24 horas.
        Isso indica que estão offline ou ainda executam agente v1.5.12 ou anterior.
        Atualize o agente via Delirio Manager → Gestão → Atualizar Agente.
      </p>`
    : `<p style="background:#f0fff4;border-left:4px solid #276749;padding:10px 14px;margin-bottom:20px;font-size:13px">
        ✅ <b>Tudo certo!</b> Todas as máquinas enviaram medições nas últimas 24h.
      </p>`}

  <h3 style="font-size:14px;color:#4a5568;border-bottom:2px solid #e2e8f0;padding-bottom:6px;margin-bottom:12px">Detalhamento por Loja</h3>
  ${storeBlocks}

  <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">
  <p style="color:#718096;font-size:11px">
    Legenda: ✅ 20-24 leituras | ⚠️ 12-19 leituras | 🟡 1-11 leituras | ❌ 0 leituras<br>
    Delirio Manager — relatório automático diário 00:00 BRT
  </p>
</div>
</body></html>`;
}

async function sendDailyMetricsEmail() {
  const cfg = loadGraphConfig();
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    console.warn('[MetricsEmail] Email não enviado — msGraph não configurado');
    return;
  }

  const rows = db.getDailyMetricsSummary();
  const dtBRT = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const noReadings = rows.filter(r => r.readings_24h === 0).length;
  const subject = noReadings > 0
    ? `⚠️ DM — Medições: ${noReadings} máquina(s) sem dados — ${dtBRT}`
    : `✅ DM — Medições OK (${rows.length} máquinas) — ${dtBRT}`;

  let access_token;
  try {
    access_token = await getAccessToken(cfg);
  } catch (err) {
    console.error('[MetricsEmail] Falha ao obter token:', err.message);
    return;
  }

  const bodyHtml = buildEmailHtml(rows, dtBRT);

  await fetch('https://graph.microsoft.com/v1.0/users/andre@delirio.com.br/sendMail', {
    method:  'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: bodyHtml },
        toRecipients: [{ emailAddress: { address: 'andre@delirio.com.br' } }],
      },
    }),
  }).then(r => {
    if (r.ok) console.log('[MetricsEmail] Email enviado com sucesso');
    else r.text().then(t => console.error('[MetricsEmail] Falha ao enviar email:', t));
  }).catch(e => console.error('[MetricsEmail] Erro HTTP:', e.message));
}

// Agendador diário — 00:00 BRT (03:00 UTC)
function scheduleDailyMetricsEmail() {
  function scheduleNext() {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(3, 0, 0, 0); // 00:00 BRT = 03:00 UTC
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delayMs  = next - now;
    const delayMin = Math.round(delayMs / 60000);
    console.log(`[MetricsEmail] Próximo relatório em ${delayMin} min (${next.toISOString()})`);
    setTimeout(async () => {
      console.log('[MetricsEmail] Gerando relatório de medições...');
      await sendDailyMetricsEmail();
      scheduleNext();
    }, delayMs);
  }
  scheduleNext();
}

module.exports = { sendDailyMetricsEmail, scheduleDailyMetricsEmail };
