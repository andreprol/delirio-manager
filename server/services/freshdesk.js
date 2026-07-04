// server/services/freshdesk.js
'use strict';

const https = require('https');
const db    = require('../db');

function loadConfig() {
  try { return require('../config.json').freshdesk || {}; }
  catch { return {}; }
}

// Mapeia status numérico do Freshdesk para string legível
function mapStatus(num) {
  const MAP = { 2: 'open', 3: 'pending', 4: 'resolved', 5: 'closed' };
  return MAP[num] || 'open';
}

// Inclui ticket se tem loja associada (cf_nome_de_loja) ou se está classificado como TI
function isTiTicket(ticket) {
  const cf = ticket.custom_fields || {};
  if (cf.cf_nome_de_loja) return true;
  const setor = (cf.cf_setor || '').toLowerCase();
  const grupo  = (cf.cf_grupo  || '').toLowerCase();
  return setor === 'ti' || grupo === 'ti';
}

function getStoreName(ticket) {
  const cf = ticket.custom_fields || {};
  return cf.cf_nome_de_loja || null;
}

function mapTicket(ticket) {
  return {
    ticket_id:  ticket.id,
    store_name: getStoreName(ticket),
    title:      ticket.subject || '',
    status:     mapStatus(ticket.status),
    priority:   ticket.priority ? String(ticket.priority) : null,
    created_at: ticket.created_at || null,
    resolved_at: ticket.resolved_at || null,
  };
}

function fetchPage(domain, apiKey, page) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${apiKey}:X`).toString('base64');
    const path = `/api/v2/tickets?per_page=100&page=${page}&updated_since=2024-01-01T00:00:00Z`;
    const req = https.request({
      hostname: `${domain}.freshdesk.com`,
      path,
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Freshdesk HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function syncAll() {
  const cfg = loadConfig();
  if (!cfg.api_key || !cfg.domain) throw new Error('Freshdesk não configurado (config.json: freshdesk.domain + freshdesk.api_key)');

  const allTickets = [];
  let page = 1;
  while (true) {
    const tickets = await fetchPage(cfg.domain, cfg.api_key, page);
    if (!Array.isArray(tickets) || tickets.length === 0) break;
    allTickets.push(...tickets);
    if (tickets.length < 100) break;
    page++;
    await new Promise(r => setTimeout(r, 300)); // respeitar rate limit
  }

  const tiTickets = allTickets.filter(isTiTicket).map(mapTicket);
  db.upsertFreshdeskTickets(tiTickets);
  return tiTickets.length;
}

// Sincroniza apenas se cache estiver vencido (default: 4h)
async function syncIfStale(storeName) {
  const cfg = loadConfig();
  const cacheHours = cfg.cache_hours || 4;
  const ageHours = db.getFreshdeskCacheAge(storeName);
  if (ageHours < cacheHours) return { synced: false, cached: true };
  const count = await syncAll();
  return { synced: true, count };
}

module.exports = { syncIfStale, syncAll, isTiTicket, mapStatus, mapTicket };
