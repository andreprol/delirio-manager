// server/services/ncrMonitor.js
// Monitora andre@delirio.com.br por emails TEST NCR e verifica NFC-e nos BOHs.
'use strict';

const path = require('path');
const fs   = require('fs');
const db   = require('../db');

const POLL_INTERVAL_MS     = 2 * 60 * 1000;  // 2 minutos
const ALERT_THRESHOLD      = 3;              // falhas consecutivas antes de alertar
const ALERT_COOLDOWN_MS    = 30 * 60 * 1000; // 30 min entre alertas da mesma etapa
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;  // watchdog verifica a cada 5 min
const WATCHDOG_MAX_SILENT  = 10 * 60 * 1000; // alerta se tick parou por > 10 min
const ACK_TIMEOUT_MINUTES  = 30;             // alerta se BOH não ACKou em 30 min

// ── Mapeamento enterpriseUnitId → hostname BOH ────────────────────────────────

const UNIT_TO_BOH = {
  '5106287247014b1d82f07eacb9ce6b94': 'TIJUCABOH',
  '961508b0b4434c8fbc69800fea190502': 'BSHOPBOH',
  '01202dac19534f59addff2945c49450e': 'RSULBOH',
  '9debb4dc0abb4b61b2e33b1c74f48460': 'IPANEMABOH',
  '3f72f66c92ef4029b575b01c5fdab9a0': 'ASSBOH',
  '0eef4431966744f9911b75d5ce1cb39c': 'METROBOH',
  'aa75a7efad3e467ba666d5a48c9f8ccb': 'GAVEABOH',
};

const STORE_NAME_TO_BOH = {
  'niteroi plaza': 'PLAZABOH',
  'niterói plaza': 'PLAZABOH',
  'plaza': 'PLAZABOH',
  'citta': 'CITTABOH',
  'città': 'CITTABOH',
};

function resolveBoh(enterpriseUnitId, storeName) {
  if (enterpriseUnitId && UNIT_TO_BOH[enterpriseUnitId]) {
    return UNIT_TO_BOH[enterpriseUnitId];
  }
  const normalized = (storeName || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  for (const [key, val] of Object.entries(STORE_NAME_TO_BOH)) {
    const keyNorm = key.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (normalized.includes(keyNorm)) return val;
  }
  return null;
}

// ── Health state ─────────────────────────────────────────────────────────────

const health = {
  tokenFailures:  0,
  fetchFailures:  0,
  lastTickAt:     Date.now(),
  lastAlert:      {},
};

function canAlert(stage) {
  const now  = Date.now();
  const last = health.lastAlert[stage] || 0;
  return now - last >= ALERT_COOLDOWN_MS;
}

function markAlerted(stage) {
  health.lastAlert[stage] = Date.now();
}

function loadResendKey() {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return conf.resendApiKey || process.env.RESEND_API_KEY || null;
  } catch {
    return process.env.RESEND_API_KEY || null;
  }
}

async function sendHealthAlert(stage, detail) {
  if (!canAlert(stage)) return;

  const apiKey = loadResendKey();
  if (!apiKey) {
    console.error(`[NCR-HEALTH] sem resendApiKey — alerta ${stage}: ${detail}`);
    return;
  }

  markAlerted(stage);

  const esc    = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const html = `<!DOCTYPE html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
<div style="background:#c0392b;color:#fff;padding:14px 20px;border-radius:6px 6px 0 0">
  <h2 style="margin:0;font-size:16px">🚨 NCR Monitor — Falha Detectada</h2>
  <p style="margin:4px 0 0;font-size:13px;opacity:0.85">Delirio Manager — Health Alert</p>
</div>
<div style="border:1px solid #ddd;border-top:none;padding:16px 20px;border-radius:0 0 6px 6px">
  <p style="margin:0 0 8px"><b>Etapa com falha:</b> ${esc(stage)}</p>
  <p style="background:#fff5f5;border-left:4px solid #c0392b;padding:10px 14px;font-size:13px;margin:0 0 12px">${esc(detail)}</p>
  <p style="color:#718096;font-size:11px;margin:0">Delirio Manager NCR Monitor — ${nowStr} UTC</p>
</div>
</body></html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'NCR Monitor <noreply@send.delirio.com.br>',
        to:      ['andre@delirio.com.br'],
        subject: `🚨 NCR Monitor — Falha: ${stage}`,
        html,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error(`[NCR-HEALTH] Resend ${res.status}: ${txt.slice(0, 200)}`);
    } else {
      console.log(`[NCR-HEALTH] Alerta enviado — stage=${stage}`);
    }
  } catch (e) {
    console.error('[NCR-HEALTH] Erro ao enviar alerta:', e.message);
  }
}

async function checkAckTimeouts() {
  const cutoff = new Date(Date.now() - ACK_TIMEOUT_MINUTES * 60000).toISOString();
  const timedOut = db.ncrGetAckTimedOut(cutoff);
  if (timedOut.length === 0) return;
  const sample = timedOut[0];
  const detail = timedOut.length === 1
    ? `Pedido #${sample.order_ref} (${sample.boh_hostname || 'BOH desconhecido'}) ` +
      `sem resposta do agente por mais de ${ACK_TIMEOUT_MINUTES} minutos. command_id=${sample.command_id}`
    : `${timedOut.length} pedido(s) sem resposta do agente por mais de ${ACK_TIMEOUT_MINUTES} minutos. ` +
      `Exemplo: #${sample.order_ref} (${sample.boh_hostname || 'BOH desconhecido'})`;
  await sendHealthAlert('BOH ACK Timeout', detail);
}

function startWatchdog() {
  setInterval(async () => {
    const silentMs = Date.now() - health.lastTickAt;
    if (silentMs > WATCHDOG_MAX_SILENT) {
      await sendHealthAlert(
        'Loop Silencioso',
        `NCR Monitor não executou tick por ${Math.round(silentMs / 60000)} minutos. ` +
        `Verifique se o processo Node.js (PM2) ainda está rodando.`
      );
    }
  }, WATCHDOG_INTERVAL_MS);
}

// ── MS Graph config + token ───────────────────────────────────────────────────

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
    scope:         'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send',
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
  );
  if (!res.ok) throw new Error(`Falha ao obter token Graph NCR: ${res.status}`);
  const { access_token, refresh_token: newRt } = await res.json();

  if (newRt && newRt !== cfg.refreshToken) {
    try {
      const confPath = path.join(__dirname, '..', 'config.json');
      const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
      conf.msGraph.refreshToken = newRt;
      fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));
    } catch (_) {}
  }
  return access_token;
}

// ── Parse de email ────────────────────────────────────────────────────────────

function decodeHtmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractJsonBraces(text, startMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractPayloadJson(decoded) {
  const jsonStr = extractJsonBraces(decoded, '{"channel":')
    || extractJsonBraces(decoded, '{"orderId":')
    || extractJsonBraces(decoded, '{"referenceId":');
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr) || null;
  } catch {
    return null;
  }
}

function extractOrderRef(payload) {
  return payload.referenceId || payload.orderId || payload.id || '?';
}

function extractEnterpriseUnitId(payload) {
  return payload.enterpriseUnitId || payload.enterprise_unit_id || '';
}

function extractStoreName(payload) {
  return payload.enterpriseUnitName || payload.storeName || payload.store_name || '';
}

function parseTotalValue(payload) {
  const totalObj = (payload.totals || []).find(t => t.type === 'Net' || t.type === 'net');
  return totalObj ? Number(totalObj.value) : 0;
}

function parseDateBrt(payload, msg) {
  const dtUTC = new Date(payload.dateCreated || msg.receivedDateTime);
  const brtMs = dtUTC.getTime() - 3 * 3600 * 1000;
  const brtDate = new Date(brtMs);
  return [
    brtDate.getUTCFullYear(),
    String(brtDate.getUTCMonth() + 1).padStart(2, '0'),
    String(brtDate.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function resolveMachineForPayload(enterpriseUnitId, storeName) {
  const bohHostname = resolveBoh(enterpriseUnitId, storeName);
  const machine = bohHostname ? db.getMachineByHostname(bohHostname) : null;
  return { bohHostname: bohHostname || null, machineId: machine ? machine.id : null };
}

function parseNcrEmail(msg) {
  try {
    const html = msg.body?.content || '';
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    const decoded = decodeHtmlEntities(stripped);
    const payload = extractPayloadJson(decoded);
    if (!payload) return null;

    const orderRef         = extractOrderRef(payload);
    const enterpriseUnitId = extractEnterpriseUnitId(payload);
    const storeName        = extractStoreName(payload);
    const totalValue       = parseTotalValue(payload);
    const products         = (payload.orderLines || [])
      .map(l => l.description || l.name || '')
      .filter(Boolean);
    const dateBRT          = parseDateBrt(payload, msg);
    const { bohHostname, machineId } = resolveMachineForPayload(enterpriseUnitId, storeName);

    return {
      order_ref:          String(orderRef),
      enterprise_unit_id: enterpriseUnitId,
      store_name:         storeName,
      boh_hostname:       bohHostname,
      machine_id:         machineId,
      total_value:        totalValue,
      date_brt:           dateBRT,
      products_json:      JSON.stringify(products),
    };
  } catch (e) {
    console.error('[NCR] parseNcrEmail erro:', e.message);
    return null;
  }
}

// ── Dispatch de comando ao agente ─────────────────────────────────────────────

async function dispatchNcrCheck(emailRow) {
  const products = JSON.parse(emailRow.products_json || '[]');
  const commandId = db.createCommand(emailRow.machine_id, 'aloha-find-nfce', {
    date:     emailRow.date_brt,
    total:    emailRow.total_value,
    products,
  });
  db.ncrUpdate(emailRow.id, { command_id: commandId });
  console.log(`[NCR] Pedido #${emailRow.order_ref} → comando ${commandId} enviado para ${emailRow.boh_hostname}`);
}

// ── Email de resultado ────────────────────────────────────────────────────────

function fmtEmailStore(row) {
  return row.store_name || row.boh_hostname || 'N/D';
}

function fmtEmailDate(dateBrt) {
  const parts = (dateBrt || '').split('-');
  return parts.length === 3
    ? `${parts[2]}/${parts[1]}/${parts[0]}`
    : (dateBrt || '');
}

function fmtEmailValue(v) {
  return v != null ? `R$ ${Number(v).toFixed(2).replace('.', ',')}` : 'N/D';
}

function buildFoundEmail(emailRow, result) {
  const storeName   = fmtEmailStore(emailRow);
  const dtFormatted = fmtEmailDate(emailRow.date_brt);
  const value       = fmtEmailValue(emailRow.total_value);
  const chave = result.chave || '';
  const dhEmi = result.dh_emi ? result.dh_emi.replace('T', ' ').slice(0, 19) : '';

  return `<!DOCTYPE html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;color:#222">
<div style="background:#276749;color:#fff;padding:14px 20px;border-radius:6px 6px 0 0">
  <h2 style="margin:0;font-size:16px">✅ NFC-e Confirmada — Pedido #${emailRow.order_ref}</h2>
  <p style="margin:4px 0 0;font-size:13px;opacity:0.85">Delirio Manager — Check de Encomendas</p>
</div>
<div style="border:1px solid #ddd;border-top:none;padding:16px 20px;border-radius:0 0 6px 6px">
  <table style="border-collapse:collapse;width:100%">
    <tr style="background:#f7f7f7">
      <td style="padding:8px 12px;font-size:14px;width:40%"><b>Loja</b></td>
      <td style="padding:8px 12px;font-size:14px">${storeName}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-size:14px"><b>Pedido</b></td>
      <td style="padding:8px 12px;font-size:14px">#${emailRow.order_ref}</td>
    </tr>
    <tr style="background:#f7f7f7">
      <td style="padding:8px 12px;font-size:14px"><b>Valor</b></td>
      <td style="padding:8px 12px;font-size:14px">${value}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-size:14px"><b>Data (BRT)</b></td>
      <td style="padding:8px 12px;font-size:14px">${dtFormatted}</td>
    </tr>
    <tr style="background:#f7f7f7">
      <td style="padding:8px 12px;font-size:14px"><b>Emissão NFC-e</b></td>
      <td style="padding:8px 12px;font-size:14px">${dhEmi}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-size:13px;color:#555"><b>Chave de Acesso</b></td>
      <td style="padding:8px 12px;font-size:11px;font-family:monospace;word-break:break-all">${chave}</td>
    </tr>
  </table>
  <p style="background:#f0fff4;border-left:4px solid #276749;padding:10px 14px;margin-top:16px;font-size:13px">
    ✅ A NFC-e foi gerada com sucesso. O XML está anexo a este e-mail.
  </p>
  <p style="color:#718096;font-size:11px;margin-top:16px">Delirio Manager — Check de Encomendas (fase de teste)</p>
</div>
</body></html>`;
}

function buildNotFoundEmail(emailRow) {
  const storeName   = fmtEmailStore(emailRow);
  const dtFormatted = fmtEmailDate(emailRow.date_brt);
  const value       = fmtEmailValue(emailRow.total_value);
  const products    = JSON.parse(emailRow.products_json || '[]');
  const retryNum    = (emailRow.retry_count || 0) + 1;
  const bohLabel    = emailRow.boh_hostname || 'Não identificado';
  const bohWarn     = emailRow.boh_hostname || 'BOH';

  return `<!DOCTYPE html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;color:#222">
<div style="background:#c0392b;color:#fff;padding:14px 20px;border-radius:6px 6px 0 0">
  <h2 style="margin:0;font-size:16px">⚠️ NFC-e NÃO Gerada — Pedido #${emailRow.order_ref}</h2>
  <p style="margin:4px 0 0;font-size:13px;opacity:0.85">Delirio Manager — Check de Encomendas</p>
</div>
<div style="border:1px solid #ddd;border-top:none;padding:16px 20px;border-radius:0 0 6px 6px">
  <table style="border-collapse:collapse;width:100%">
    <tr style="background:#f7f7f7">
      <td style="padding:8px 12px;font-size:14px;width:40%"><b>Loja</b></td>
      <td style="padding:8px 12px;font-size:14px">${storeName}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-size:14px"><b>Pedido</b></td>
      <td style="padding:8px 12px;font-size:14px">#${emailRow.order_ref}</td>
    </tr>
    <tr style="background:#f7f7f7">
      <td style="padding:8px 12px;font-size:14px"><b>Valor</b></td>
      <td style="padding:8px 12px;font-size:14px">${value}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-size:14px"><b>Data (BRT)</b></td>
      <td style="padding:8px 12px;font-size:14px">${dtFormatted}</td>
    </tr>
    <tr style="background:#f7f7f7">
      <td style="padding:8px 12px;font-size:14px"><b>Servidor BOH</b></td>
      <td style="padding:8px 12px;font-size:14px">${bohLabel}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-size:14px"><b>Tentativas</b></td>
      <td style="padding:8px 12px;font-size:14px">${retryNum} de 3</td>
    </tr>
    ${products.length ? `<tr style="background:#f7f7f7">
      <td style="padding:8px 12px;font-size:14px;vertical-align:top"><b>Produtos</b></td>
      <td style="padding:8px 12px;font-size:13px">${products.join('<br>')}</td>
    </tr>` : ''}
  </table>
  <p style="background:#fff5f5;border-left:4px solid #c0392b;padding:10px 14px;margin-top:16px;font-size:13px">
    ⚠️ <b>Atenção:</b> A NFC-e não foi localizada no servidor ${bohWarn} após
    ${retryNum} tentativa(s). Verifique manualmente o servidor Aloha.
  </p>
  <p style="color:#718096;font-size:11px;margin-top:16px">Delirio Manager — Check de Encomendas (fase de teste)</p>
</div>
</body></html>`;
}

function buildNcrEmailPayload(emailRow, result) {
  const found     = !!result.found;
  const storeName = emailRow.store_name || emailRow.boh_hostname || 'loja';
  const orderRef  = emailRow.order_ref || '?';
  const subject   = found
    ? `✅ NFC-e confirmada — Pedido #${orderRef} | ${storeName}`
    : `⚠️ NFC-e NÃO gerada — Pedido #${orderRef} | ${storeName}`;
  const html      = found ? buildFoundEmail(emailRow, result) : buildNotFoundEmail(emailRow);
  return { found, orderRef, subject, html };
}

async function sendNcrResultEmail(emailRow, result) {
  const cfg = loadGraphConfig();
  if (!cfg.tenantId) throw new Error('msGraph não configurado');

  const token = await getAccessToken(cfg);
  const { found, orderRef, subject, html } = buildNcrEmailPayload(emailRow, result);

  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: [{ emailAddress: { address: 'andre@delirio.com.br' } }],
  };

  if (found && result.xml_b64) {
    message.attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name:          `${result.chave || 'nfce'}-nfce.xml`,
      contentType:   'application/xml',
      contentBytes:  result.xml_b64,
    }];
  }

  const r = await fetch('https://graph.microsoft.com/v1.0/users/andre@delirio.com.br/sendMail', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message }),
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`sendMail falhou: ${r.status} — ${txt.slice(0, 200)}`);
  }

  db.ncrUpdate(emailRow.id, { notified_at: new Date().toISOString() });
  console.log(`[NCR] Email enviado — Pedido #${orderRef} found=${found}`);
}

// ── Busca emails novos no Graph ───────────────────────────────────────────────

async function fetchNewNcrEmails(token) {
  const url = [
    'https://graph.microsoft.com/v1.0/users/andre@delirio.com.br/messages',
    '?$search="subject:NCR"',
    '&$top=50',
    '&$select=id,subject,from,receivedDateTime,body',
  ].join('');

  const res = await fetch(url, {
    headers: {
      Authorization:    `Bearer ${token}`,
      'Content-Type':   'application/json',
      ConsistencyLevel: 'eventual',
    },
  });
  if (!res.ok) throw new Error(`Graph search falhou: ${res.status}`);
  const { value } = await res.json();
  return (value || []).filter(msg =>
    msg.from?.emailAddress?.address?.toLowerCase() === 'delirio@i9vando.com.br'
  );
}

// ── Retry de pedidos sem NFC-e ────────────────────────────────────────────────

async function processRetries() {
  const rows = db.ncrGetPendingRetries();
  for (const row of rows) {
    try {
      await dispatchNcrCheck(row);
      console.log(`[NCR] Retry despachado — Pedido #${row.order_ref} tentativa ${row.retry_count + 1}`);
    } catch (e) {
      console.error(`[NCR] Erro no retry pedido #${row.order_ref}:`, e.message);
    }
  }
}

// ── Tick principal ────────────────────────────────────────────────────────────

function loadNcrSince() {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return conf.ncrSince ? new Date(conf.ncrSince) : null;
  } catch {
    return null;
  }
}

async function processNcrEmail(msg, since) {
  if (since && new Date(msg.receivedDateTime) < since) return 0;
  if (db.ncrGetByMessageId(msg.id)) return 0;

  const parsed = parseNcrEmail(msg);
  if (!parsed) {
    console.warn('[NCR] Não foi possível parsear email id:', msg.id);
    return 0;
  }

  const changes = db.ncrInsertEmail({
    message_id:  msg.id,
    received_at: msg.receivedDateTime,
    ...parsed,
  });

  if (changes > 0) {
    const row = db.ncrGetByMessageId(msg.id);
    if (row && row.machine_id) {
      await dispatchNcrCheck(row);
      return 1;
    }
    console.warn(`[NCR] BOH não mapeado — Pedido #${parsed.order_ref} enterpriseUnitId=${parsed.enterprise_unit_id}`);
  }
  return 0;
}

async function getTokenTracked(cfg) {
  try {
    const token = await getAccessToken(cfg);
    health.tokenFailures = 0;
    return token;
  } catch (e) {
    health.tokenFailures++;
    console.error('[NCR] Falha ao obter token:', e.message);
    if (health.tokenFailures >= ALERT_THRESHOLD) {
      await sendHealthAlert(
        'Graph Auth',
        `Falha ao obter token MS Graph: ${e.message} (${health.tokenFailures}× consecutivas)`
      );
    }
    return null;
  }
}

async function fetchEmailsTracked(token) {
  try {
    const emails = await fetchNewNcrEmails(token);
    health.fetchFailures = 0;
    return emails;
  } catch (e) {
    health.fetchFailures++;
    console.error('[NCR] Falha ao buscar emails:', e.message);
    if (health.fetchFailures >= ALERT_THRESHOLD) {
      await sendHealthAlert(
        'Email Fetch',
        `Falha ao buscar emails no MS Graph: ${e.message} (${health.fetchFailures}× consecutivas)`
      );
    }
    return null;
  }
}

async function tick() {
  health.lastTickAt = Date.now();

  const cfg = loadGraphConfig();
  if (!cfg.refreshToken) {
    console.warn('[NCR] msGraph.refreshToken ausente — monitor inativo');
    return;
  }

  const token = await getTokenTracked(cfg);
  if (!token) return;

  const emails = await fetchEmailsTracked(token);
  if (!emails) return;

  const since = loadNcrSince();
  let newCount = 0;
  for (const msg of emails) {
    try {
      newCount += await processNcrEmail(msg, since);
    } catch (e) {
      console.error('[NCR] Erro ao processar email:', e.message);
    }
  }

  if (newCount > 0) {
    console.log(`[NCR] tick: ${newCount} novo(s) pedido(s) despachados`);
  }

  try {
    await processRetries();
  } catch (e) {
    console.error('[NCR] processRetries erro:', e.message);
  }

  try {
    await checkAckTimeouts();
  } catch (e) {
    console.error('[NCR-HEALTH] checkAckTimeouts erro:', e.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

function start() {
  tick().catch(e => console.error('[NCR] tick inicial erro:', e.message));
  setInterval(() => {
    tick().catch(e => console.error('[NCR] tick erro:', e.message));
  }, POLL_INTERVAL_MS);
  startWatchdog();
}

module.exports = { start, sendNcrResultEmail };
