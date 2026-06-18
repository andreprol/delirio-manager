'use strict';

const path = require('path');
const fs   = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const FIXED_CC    = ['bruno@delirio.com.br', 'suporteti@delirio.com.br'];
const GRAPH_FROM  = 'andre@delirio.com.br';

const PAG_LABELS = {
  '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de Crédito',
  '04': 'Cartão de Débito', '17': 'Pix', '99': 'Outros',
};

// In-memory token cache to avoid hammering the token endpoint
let _tokenCache = null;

function loadGraphConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).msGraph || {};
  } catch { return {}; }
}

async function getAccessToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 300_000) {
    return _tokenCache.token;
  }

  const cfg = loadGraphConfig();
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    throw new Error('Configuração Microsoft Graph ausente. Adicione "msGraph" em config.json com tenantId, clientId, clientSecret e refreshToken.');
  }

  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    scope:         'offline_access https://graph.microsoft.com/Mail.Send',
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Erro ao obter token MS Graph: ${err.slice(0, 400)}`);
  }

  const data = await res.json();
  _tokenCache = {
    token:     data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  // Persist a newly-issued refresh_token so it doesn't expire
  if (data.refresh_token && data.refresh_token !== cfg.refreshToken) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config.msGraph.refreshToken = data.refresh_token;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch { /* non-fatal */ }
  }

  return data.access_token;
}

function fmtMoeda(v) {
  return `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    });
  } catch { return iso; }
}

function buildHtml(danfe) {
  const rows = (danfe.products || []).map(p => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee">${p.nItem}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee">${p.xProd || ''}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${p.qCom} ${p.uCom}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${fmtMoeda(p.vUnCom)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right"><b>${fmtMoeda(p.vProd)}</b></td>
    </tr>`).join('');

  const payRows = (danfe.payment || []).map(p =>
    `<tr><td>${PAG_LABELS[p.tPag] || `Cód ${p.tPag}`}</td><td style="text-align:right">${fmtMoeda(p.vPag)}</td></tr>`
  ).join('');

  const qrHtml = danfe.qrCode
    ? `<div style="text-align:center;margin:12px 0">
         <img src="${danfe.qrCode}" width="130" height="130" alt="QR Code NFC-e" />
         <p style="font-size:11px;color:#666">Aponte a câmera para consultar no SEFAZ</p>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><title>DANFE NFC-e ${danfe.nNF}</title></head>
<body style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#222">

<div style="background:#c0392b;color:#fff;padding:12px 20px;border-radius:6px 6px 0 0">
  <h2 style="margin:0;font-size:16px">🧾 DANFE NFC-e</h2>
</div>

<div style="border:1px solid #ddd;border-top:none;padding:16px 20px;border-radius:0 0 6px 6px">

  <h3 style="margin:0 0 4px">${danfe.emit?.xNome || ''}</h3>
  <p style="margin:0 0 12px;color:#555;font-size:13px">CNPJ: ${danfe.emit?.cnpj || ''}</p>

  <table style="width:100%;font-size:13px;margin-bottom:12px">
    <tr><td><b>Nº da Nota:</b></td><td>${danfe.nNF}</td>
        <td><b>Série:</b></td><td>${danfe.series || ''}</td></tr>
    <tr><td><b>Emissão:</b></td><td colspan="3">${fmtDate(danfe.dhEmi)}</td></tr>
  </table>

  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead>
      <tr style="background:#f5f5f5">
        <th style="padding:6px 8px;text-align:left">#</th>
        <th style="padding:6px 8px;text-align:left">Produto</th>
        <th style="padding:6px 8px;text-align:center">Qtd</th>
        <th style="padding:6px 8px;text-align:right">Unit.</th>
        <th style="padding:6px 8px;text-align:right">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div style="text-align:right;margin-top:10px;font-size:15px">
    <b>TOTAL: ${fmtMoeda((danfe.totals || {}).vNF || danfe.vNF)}</b>
  </div>

  <div style="margin-top:10px;font-size:13px">
    <b>Pagamento:</b>
    <table style="font-size:13px;margin-top:4px">${payRows}</table>
  </div>

  <hr style="margin:16px 0;border:none;border-top:1px solid #eee" />

  ${qrHtml}

  <p style="font-size:11px;color:#555;word-break:break-all">
    <b>Chave de Acesso:</b><br>${danfe.chave || ''}
  </p>
  <p style="font-size:11px">
    <b>Consultar:</b>
    <a href="${danfe.urlChave || ''}">${danfe.urlChave || ''}</a>
  </p>

  <p style="font-size:11px;color:#999;margin-top:20px">
    O PDF da DANFE está em anexo.<br>
    Este e-mail foi enviado automaticamente pelo Delirio Manager.
  </p>

</div>
</body>
</html>`;
}

/**
 * Sends a DANFE NFC-e via Microsoft Graph (delegated auth).
 * Requires config.json to contain:
 *   "msGraph": { "tenantId": "...", "clientId": "...", "clientSecret": "...", "refreshToken": "..." }
 */
async function sendDanfeEmail({ danfe, pdfBuffer, toEmail, extraCCs = [] }) {
  const token  = await getAccessToken();
  const store  = (danfe.emit?.xFant || danfe.emit?.xNome || '').slice(0, 30);
  const ccList = [...FIXED_CC, ...extraCCs.filter(e => e && e !== toEmail)];

  const message = {
    subject: `DANFE NFC-e Nº ${danfe.nNF} — ${store}`,
    body: {
      contentType: 'HTML',
      content:     buildHtml(danfe),
    },
    toRecipients: [{ emailAddress: { address: toEmail } }],
    ccRecipients: ccList.map(addr => ({ emailAddress: { address: addr } })),
    attachments: [{
      '@odata.type':  '#microsoft.graph.fileAttachment',
      name:           `DANFE-${danfe.nNF}.pdf`,
      contentType:    'application/pdf',
      contentBytes:   pdfBuffer.toString('base64'),
    }],
  };

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${GRAPH_FROM}/sendMail`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Erro ao enviar email via Graph: ${err.slice(0, 400)}`);
  }
}

module.exports = { sendDanfeEmail };
