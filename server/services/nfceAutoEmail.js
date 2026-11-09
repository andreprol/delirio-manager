'use strict';

// Envia a DANFE automaticamente para o e-mail do cliente quando a NFC-e traz
// um e-mail no dest (encomendas do site = sempre vêm com e-mail, obrigatório
// na compra online; balcão = raro, mas se vier, também envia). CC fixo já
// embutido em sendDanfeEmail (bruno@delirio.com.br, suporteti@delirio.com.br).
//
// Decisão do André (09/11/2026): só notas NOVAS a partir de agora — nunca
// reenviar o histórico já indexado. O corte (cutoffAt) é gravado no
// config.json na primeira vez que este código roda em produção e nunca muda
// depois — mesmo que uma indexação futura (ex: "Indexar histórico completo")
// toque dias antigos, notas emitidas antes do corte nunca disparam envio.
//
// Trava anti-duplicata: claimAutoEmail faz um INSERT OR IGNORE pela chave da
// nota (única nacionalmente) ANTES de tentar enviar — se duas indexações
// processarem a mesma nota, só uma ganha a reivindicação.

const fs   = require('fs');
const path = require('path');
const db   = require('../db');
const { generateDanfePdf } = require('./danfe');
const { sendDanfeEmail }   = require('./nfce-mailer');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const EMAIL_RE     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

let _cutoffCache = null;

// Momento a partir do qual notas são elegíveis pro auto-envio. Persistido no
// config.json na primeira chamada; depois disso sempre o mesmo valor, mesmo
// reiniciando o servidor.
function getCutoffAt() {
  if (_cutoffCache) return _cutoffCache;
  const cfg = loadConfig();
  if (cfg.nfceAutoEmail?.cutoffAt) {
    _cutoffCache = cfg.nfceAutoEmail.cutoffAt;
    return _cutoffCache;
  }
  const now = new Date().toISOString();
  cfg.nfceAutoEmail = { ...(cfg.nfceAutoEmail || {}), cutoffAt: now };
  saveConfig(cfg);
  _cutoffCache = now;
  return now;
}

// Checa se o registro é candidato ao auto-envio: e-mail válido, chave e data
// de emissão presentes, e emitido depois do corte. Retorna o e-mail já
// normalizado (trim) ou null se não for elegível por qualquer motivo.
function eligibleEmail(record, cutoff) {
  const danfe = record.danfe || {};
  const email = danfe.dest && danfe.dest.email;
  if (!isValidEmail(email)) return null;
  if (!danfe.dhEmi || !record.chave) return null;

  const emittedAt = new Date(danfe.dhEmi).getTime();
  const cutoffAt  = new Date(cutoff).getTime();
  if (emittedAt < cutoffAt) return null; // nota antiga, nunca envia

  return email.trim();
}

// Envia (ou não) a DANFE automaticamente para um registro recém-indexado.
// Nunca lança — chamador roda isso em "fire and forget", sem travar o resto
// da indexação por causa de uma falha de rede no envio de e-mail.
async function maybeAutoSendDanfe(machineId, record) {
  const email = eligibleEmail(record, getCutoffAt());
  if (!email) return;

  const chave = record.chave;
  if (!db.claimAutoEmail(chave, machineId, email)) return; // já reivindicada

  try {
    const pdf = await generateDanfePdf(record.danfe);
    await sendDanfeEmail({ danfe: record.danfe, pdfBuffer: pdf, toEmail: email });
    db.markAutoEmailSent(chave);
    console.log(`[NFCe AutoEmail] Enviada automaticamente: chave=${chave}`);
  } catch (e) {
    db.markAutoEmailFailed(chave, e.message);
    console.error('[NFCe AutoEmail] Falha ao enviar:', e.message);
  }
}

module.exports = { maybeAutoSendDanfe, isValidEmail, getCutoffAt };
