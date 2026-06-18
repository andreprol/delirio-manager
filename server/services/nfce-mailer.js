'use strict';

const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const FIXED_CC    = ['bruno@delirio.com.br', 'suporteti@delirio.com.br'];

const PAG_LABELS = {
  '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de Crédito',
  '04': 'Cartão de Débito', '17': 'Pix', '99': 'Outros',
};

function loadSmtpConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).smtp || {};
  } catch { return {}; }
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
 * Sends a DANFE NFC-e via email.
 * SMTP credentials must be configured in config.json under the key "smtp":
 *   { "host": "smtp.office365.com", "port": 587, "user": "...", "pass": "...", "from": "..." }
 */
async function sendDanfeEmail({ danfe, pdfBuffer, toEmail, extraCCs = [] }) {
  const smtp = loadSmtpConfig();
  if (!smtp.host || !smtp.user || !smtp.pass) {
    throw new Error('Configuração SMTP ausente. Adicione a chave "smtp" em config.json com host, user e pass.');
  }

  const transporter = nodemailer.createTransport({
    host:   smtp.host,
    port:   smtp.port || 587,
    secure: smtp.port === 465,
    auth:   { user: smtp.user, pass: smtp.pass },
    tls:    { rejectUnauthorized: false },
  });

  const store  = (danfe.emit?.xFant || danfe.emit?.xNome || '').slice(0, 30);
  const ccList = [...FIXED_CC, ...extraCCs.filter(e => e && e !== toEmail)];

  await transporter.sendMail({
    from:        `${store || 'Delirio Tropical'} <${smtp.from || smtp.user}>`,
    to:          toEmail,
    cc:          ccList.join(', '),
    subject:     `DANFE NFC-e Nº ${danfe.nNF} — ${store}`,
    html:        buildHtml(danfe),
    attachments: [{
      filename:    `DANFE-${danfe.nNF}.pdf`,
      content:     pdfBuffer,
      contentType: 'application/pdf',
    }],
  });
}

module.exports = { sendDanfeEmail };
