'use strict';

// Envia a DANFE por WhatsApp (WhatsApp Business Cloud API, Meta) — sempre sob
// pedido manual do cliente no balcão/atendimento, nunca automático (ao
// contrário do nfceAutoEmail). Usa o template aprovado "envio_danfe"
// (categoria Utility, header documento), já que fora da janela de 24h de
// conversa a API só aceita mensagens de template.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH       = path.join(__dirname, '..', 'config.json');
const GRAPH_API_VERSION = 'v21.0';

function loadWhatsappConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).whatsapp || {}; } catch { return {}; }
}

function validateWhatsappConfig(cfg) {
  return !!(cfg.accessToken && cfg.phoneNumberId && cfg.templateName);
}

// Reporta só se a configuração está completa — nunca o valor dos campos.
function isWhatsappConfigured() {
  return !!validateWhatsappConfig(loadWhatsappConfig());
}

// Número BR em qualquer formato (com DDD, com/sem 9, com/sem símbolos) vira
// E.164 sem símbolos (ex: 5521998765432), formato exigido pela API da Meta.
// Resultado final tem que ter 12 (fixo) ou 13 (celular) dígitos — qualquer
// outro tamanho (ex: "123") é rejeitado em vez de seguir adiante pro upload
// de mídia e envio pra um número que nunca existiu.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;

  const withCountry = digits.startsWith('55') ? digits : `55${digits}`;
  if (withCountry.length !== 12 && withCountry.length !== 13) return null;
  return withCountry;
}

async function uploadMedia(cfg, pdfBuffer, filename) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), filename);

  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.phoneNumberId}/media`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}` },
    body:    form,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Erro ao enviar PDF ao WhatsApp: ${err.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.id;
}

async function sendTemplateMessage(cfg, { phone, mediaId, filename, customerName }) {
  const payload = {
    messaging_product: 'whatsapp',
    to:                phone,
    type:              'template',
    template: {
      name:     cfg.templateName,
      language: { code: cfg.templateLang || 'pt_BR' },
      components: [
        { type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename } }] },
        { type: 'body',   parameters: [{ type: 'text', text: customerName || 'cliente' }] },
      ],
    },
  };

  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.phoneNumberId}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Erro ao enviar DANFE via WhatsApp: ${err.slice(0, 400)}`);
  }
}

/**
 * Envia a DANFE (PDF) por WhatsApp usando o template aprovado.
 * Requires config.json to contain:
 *   "whatsapp": { "accessToken": "...", "phoneNumberId": "...", "templateName": "envio_danfe", "templateLang": "pt_BR" }
 */
async function sendDanfeWhatsapp({ danfe, pdfBuffer, toPhone, customerName }) {
  const cfg = loadWhatsappConfig();
  if (!validateWhatsappConfig(cfg)) {
    throw new Error('Configuração WhatsApp ausente. Adicione "whatsapp" em config.json com accessToken, phoneNumberId e templateName.');
  }

  const phone = normalizePhone(toPhone);
  if (!phone) throw new Error('Número de telefone inválido');

  const filename = `DANFE-${danfe.nNF}.pdf`;
  const mediaId  = await uploadMedia(cfg, pdfBuffer, filename);
  await sendTemplateMessage(cfg, { phone, mediaId, filename, customerName });
}

module.exports = { sendDanfeWhatsapp, isWhatsappConfigured, normalizePhone };
