// server/services/resendAlert.js
// Helper compartilhado de alerta por e-mail via Resend, com cooldown por chave.
// Extraído de ncrMonitor.js (sendHealthAlert) para reuso por outros monitores (ex: rhHealthMonitor).
'use strict';

const path   = require('path');
const fs     = require('fs');
const logger = require('./logger');

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

const lastAlertAt = {};

function canAlert(cooldownKey, cooldownMs) {
  const last = lastAlertAt[cooldownKey] || 0;
  return Date.now() - last >= cooldownMs;
}

function markAlerted(cooldownKey) {
  lastAlertAt[cooldownKey] = Date.now();
}

function loadResendKey() {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return conf.resendApiKey || process.env.RESEND_API_KEY || null;
  } catch {
    return process.env.RESEND_API_KEY || null;
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHtml(source, stage, detail) {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return `<!DOCTYPE html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
<div style="background:#c0392b;color:#fff;padding:14px 20px;border-radius:6px 6px 0 0">
  <h2 style="margin:0;font-size:16px">🚨 ${escapeHtml(source)} — Falha Detectada</h2>
  <p style="margin:4px 0 0;font-size:13px;opacity:0.85">Delirio Manager — Health Alert</p>
</div>
<div style="border:1px solid #ddd;border-top:none;padding:16px 20px;border-radius:0 0 6px 6px">
  <p style="margin:0 0 8px"><b>Etapa com falha:</b> ${escapeHtml(stage)}</p>
  <p style="background:#fff5f5;border-left:4px solid #c0392b;padding:10px 14px;font-size:13px;margin:0 0 12px">${escapeHtml(detail)}</p>
  <p style="color:#718096;font-size:11px;margin:0">Delirio Manager — ${escapeHtml(source)} — ${nowStr} UTC</p>
</div>
</body></html>`;
}

// sendAlert({ source, stage, detail, cooldownKey, cooldownMs })
// source: nome do monitor que está alertando (ex: "NCR Monitor", "Módulo RH")
// stage: etapa/tipo da falha (aparece no assunto e no corpo)
// detail: descrição legível da falha
// cooldownKey: chave única para o cooldown (default: `${source}:${stage}`)
// cooldownMs: janela de cooldown (default: 30 min)
async function sendAlert({ source, stage, detail, cooldownKey, cooldownMs = DEFAULT_COOLDOWN_MS }) {
  const key = cooldownKey || `${source}:${stage}`;
  if (!canAlert(key, cooldownMs)) return { sent: false, reason: 'cooldown' };

  const apiKey = loadResendKey();
  if (!apiKey) {
    logger.error(`[${source}] sem resendApiKey — alerta ${stage}: ${detail}`);
    return { sent: false, reason: 'no-api-key' };
  }

  markAlerted(key);

  const html = buildHtml(source, stage, detail);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    `${source} <onboarding@resend.dev>`,
        to:      ['andreprol1980@gmail.com'],
        subject: `🚨 ${source} — Falha: ${stage}`,
        html,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      logger.error(`[${source}] Resend ${res.status}: ${txt.slice(0, 200)}`);
      return { sent: false, reason: `resend-${res.status}` };
    }
    logger.info(`[${source}] Alerta enviado — stage=${stage}`);
    return { sent: true };
  } catch (e) {
    logger.error(`[${source}] Erro ao enviar alerta: ${e.message}`);
    return { sent: false, reason: 'exception', error: e.message };
  }
}

module.exports = { sendAlert };
