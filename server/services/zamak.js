// server/services/zamak.js
'use strict';

const https = require('https');
const db    = require('../db');

function loadConfig() {
  try { return require('../config.json').zamak || {}; }
  catch { return {}; }
}

// ─── XML parser ───────────────────────────────────────────────────────────────
// N-sight returns flat XML; itemTag é o nome do elemento repetido dentro de <items>.
function parseFlatXmlList(xml, itemTag) {
  const items = [];
  const itemRe = new RegExp(`<${itemTag}[\\s>][\\s\\S]*?<\\/${itemTag}>`, 'gi');
  for (const match of xml.matchAll(itemRe)) {
    const item = {};
    const fieldRe = /<([a-zA-Z_][a-zA-Z0-9_]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
    for (const field of match[0].matchAll(fieldRe)) {
      item[field[1]] = field[2].trim();
    }
    if (Object.keys(item).length > 0) items.push(item);
  }
  return items;
}

// Tenta extrair lista de resposta JSON do N-sight (quando format=json é suportado)
function parseJsonList(json, ...keys) {
  try {
    const root = typeof json === 'string' ? JSON.parse(json) : json;
    // Tenta cada chave em ordem (ex: 'client', 'workstation', 'server')
    const items = root?.items;
    if (!items) return null;
    for (const k of keys) {
      const val = items[k];
      if (Array.isArray(val)) return val;
      if (val && typeof val === 'object') return [val]; // objeto único
    }
    // Se items é array diretamente
    if (Array.isArray(items)) return items;
  } catch (_) {}
  return null;
}

// ─── HTTP client ───────────────────────────────────────────────────────────────
function fetchNsight(server, apiKey, service, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://${server}/api/`);
    url.searchParams.set('apikey', apiKey);
    url.searchParams.set('service', service);
    // N-sight suporta format=json em alguns endpoints; tentamos XML para garantir compatibilidade
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

    const req = https.request(url.toString(), { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`N-sight ${service}: HTTP ${res.statusCode} — ${data.slice(0, 200)}`));
        }
        // Erro explícito na resposta
        if (data.includes('<status>FAIL</status>') || data.includes('"status":"FAIL"')) {
          const errMatch = data.match(/<message>([^<]*)<\/message>/i) ||
                           data.match(/"message"\s*:\s*"([^"]*)"/);
          return reject(new Error(`N-sight ${service}: ${errMatch?.[1] || 'erro desconhecido'}`));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`N-sight ${service}: timeout`)); });
    req.end();
  });
}

// ─── Rate limiter (max 55 chamadas/min com margem de segurança) ───────────────
let _callCount = 0;
let _windowStart = Date.now();

async function throttle() {
  const now = Date.now();
  if (now - _windowStart > 60000) {
    _callCount = 0;
    _windowStart = now;
  }
  _callCount++;
  if (_callCount > 55) {
    const wait = 60000 - (Date.now() - _windowStart) + 200;
    await new Promise(r => setTimeout(r, wait));
    _callCount = 0;
    _windowStart = Date.now();
  } else {
    // Espaçamento mínimo de 1s entre chamadas
    await new Promise(r => setTimeout(r, 1100));
  }
}

// ─── Mapeamento de lojas ──────────────────────────────────────────────────────
// Mapeia nomes de sites do N-able para nomes de localização do Delirio Manager.
// Matching por substring (lowercase) para lidar com variações.
const DEFAULT_STORE_MAP = {
  'barra shopping':     'Barra Shopping',
  'barra':              'Barra Shopping',
  'metropolitano':      'Metropolitano',
  'metro':              'Metropolitano',
  'città':              'Città',
  'citta':              'Città',
  'gávea':              'Gávea',
  'gavea':              'Gávea',
  'ipanema':            'Ipanema',
  'rio sul':            'Rio Sul',
  'niterói plaza':      'Niterói Plaza',
  'niterói':            'Niterói Plaza',
  'niteroi':            'Niterói Plaza',
  'assembleia':         'Assembleia',
  'assembléia':         'Assembleia',
  'tijuca':             'Tijuca',
  'escritório central': 'Escritório Central',
  'escritorio central': 'Escritório Central',
  'central':            'Escritório Central',
};

function resolveStoreName(nsightSiteName, customMap = {}) {
  if (!nsightSiteName) return null;
  const key = nsightSiteName.toLowerCase().trim();

  // Config customizado tem prioridade (chaves também são comparadas por substring lowercase)
  for (const [k, v] of Object.entries(customMap)) {
    if (key.includes(k.toLowerCase())) return v;
  }
  // Mapa padrão
  for (const [k, v] of Object.entries(DEFAULT_STORE_MAP)) {
    if (key.includes(k)) return v;
  }
  return null;
}

// ─── Helpers para extrair campos independente de variação de tag ───────────────
function deviceId(d) {
  return d.workstationid || d.serverid || d.deviceid || d.id || '';
}
function deviceName(d) {
  return d.name || d.workstationname || d.servername || d.devicename || '';
}
function deviceStatus(d) {
  return d.status || d.online_status || d.device_status || 'unknown';
}

// ─── Sync principal ───────────────────────────────────────────────────────────
async function syncAll() {
  const cfg = loadConfig();
  if (!cfg.server || !cfg.apiKey) {
    throw new Error('zamak.server e zamak.apiKey não configurados em config.json');
  }

  const { server, apiKey } = cfg;
  const customStoreMap = cfg.store_map || {};
  const log = [];
  const unmappedSites = [];
  const now = new Date().toISOString();

  // 1. Listar clientes — encontrar Delírio Tropical
  log.push('Buscando clientes N-able...');
  await throttle();
  const clientsXml = await fetchNsight(server, apiKey, 'list_clients');
  let clients = parseJsonList(clientsXml, 'client', 'clients');
  if (!clients) clients = parseFlatXmlList(clientsXml, 'client');

  const delirio = clients.find(c => {
    const name = (c.name || c.clientname || '').toLowerCase();
    return name.includes('delirio') || name.includes('delírio');
  });
  if (!delirio) {
    const names = clients.map(c => c.name || c.clientname || '?').join(', ');
    throw new Error(`Cliente Delírio não encontrado na Zamak. Clientes disponíveis: ${names}`);
  }

  const clientId = delirio.clientid;
  log.push(`Cliente: ${delirio.name || delirio.clientname} (clientid=${clientId})`);

  // 2. Listar sites
  await throttle();
  const sitesXml = await fetchNsight(server, apiKey, 'list_sites', { clientid: clientId });
  let sites = parseJsonList(sitesXml, 'site', 'sites');
  if (!sites) sites = parseFlatXmlList(sitesXml, 'site');
  log.push(`Sites: ${sites.length}`);

  const siteToStore = {};
  for (const site of sites) {
    const siteId   = site.siteid || site.id;
    const siteName = site.name || site.sitename || '';
    const mapped   = resolveStoreName(siteName, customStoreMap);
    siteToStore[siteId] = { siteName, storeName: mapped };
    if (!mapped) {
      unmappedSites.push({ siteId, siteName });
      log.push(`⚠️ Site sem mapeamento: "${siteName}" (siteId=${siteId})`);
    }
  }

  // 3. Listar todos os dispositivos do cliente (1 chamada por tipo)
  await throttle();
  const wsXml = await fetchNsight(server, apiKey, 'list_devices_at_client', {
    clientid: clientId, devicetype: 'workstation',
  });
  let workstations = parseJsonList(wsXml, 'workstation', 'device', 'devices');
  if (!workstations) workstations = parseFlatXmlList(wsXml, 'workstation');

  await throttle();
  const srvXml = await fetchNsight(server, apiKey, 'list_devices_at_client', {
    clientid: clientId, devicetype: 'server',
  });
  let servers = parseJsonList(srvXml, 'server', 'device', 'devices');
  if (!servers) servers = parseFlatXmlList(srvXml, 'server');

  const allDevices = [
    ...workstations.map(d => ({ ...d, _type: 'workstation' })),
    ...servers.map(d => ({ ...d, _type: 'server' })),
  ];
  log.push(`Dispositivos: ${allDevices.length} (${workstations.length} workstations + ${servers.length} servidores)`);

  // 4. Failing checks globais (1 chamada)
  await throttle();
  const fcXml = await fetchNsight(server, apiKey, 'list_failing_checks', { clientid: clientId });
  let failingChecks = parseJsonList(fcXml, 'check', 'checks');
  if (!failingChecks) failingChecks = parseFlatXmlList(fcXml, 'check');
  log.push(`Failing checks: ${failingChecks.length}`);

  const failingByDevice = {};
  for (const fc of failingChecks) {
    const did = fc.deviceid;
    if (did) failingByDevice[did] = (failingByDevice[did] || 0) + 1;
  }

  // 5. Por dispositivo: patches + ameaças MAV
  const allDmMachines = db.getAllMachines();
  const rows = [];

  for (const device of allDevices) {
    const did  = deviceId(device);
    const name = deviceName(device);
    const siteId = device.siteid;
    const { siteName = '?', storeName = null } = siteToStore[siteId] || {};

    // Match com máquina do DM por hostname (case-insensitive)
    const dmMatch = allDmMachines.find(m =>
      m.hostname && m.hostname.toLowerCase() === name.toLowerCase()
    );

    // Patches
    let patchCritical = 0, patchHigh = 0, patchMedium = 0, patchTotal = 0;
    if (did) {
      try {
        await throttle();
        const pXml = await fetchNsight(server, apiKey, 'patch_list_all', { deviceid: did });
        let patches = parseJsonList(pXml, 'patch', 'patches');
        if (!patches) patches = parseFlatXmlList(pXml, 'patch');
        patchTotal = patches.length;
        for (const p of patches) {
          const sev = (p.severity || '').toLowerCase();
          if (sev === 'critical')     patchCritical++;
          else if (sev === 'high')    patchHigh++;
          else if (sev === 'medium')  patchMedium++;
        }
      } catch (e) {
        log.push(`Patches ${name}: ${e.message}`);
      }
    }

    // MAV threats
    let threatsActive = 0;
    if (did) {
      try {
        await throttle();
        const mXml = await fetchNsight(server, apiKey, 'list_mav_threats', { deviceid: did });
        let threats = parseJsonList(mXml, 'threat', 'threats');
        if (!threats) threats = parseFlatXmlList(mXml, 'threat');
        threatsActive = threats.filter(t =>
          (t.last_status || t.status || '').toLowerCase() !== 'cleaned'
        ).length;
      } catch (e) {
        log.push(`MAV ${name}: ${e.message}`);
      }
    }

    rows.push({
      device_id:          did,
      site_id:            siteId || '',
      site_name:          siteName,
      store_name:         storeName,
      device_name:        name,
      device_type:        device._type,
      status:             deviceStatus(device),
      os_type:            device.os_type || device.os || '',
      ip_address:         device.ip_address || device.ipaddress || '',
      has_web_protection: 0, // WebControl não está disponível na API pública do N-sight
      patch_critical:     patchCritical,
      patch_high:         patchHigh,
      patch_medium:       patchMedium,
      patch_total:        patchTotal,
      threats_active:     threatsActive,
      failing_checks:     failingByDevice[did] || 0,
      dm_machine_id:      dmMatch?.id || null,
      dm_hostname:        dmMatch?.hostname || null,
      cached_at:          now,
    });
  }

  // 6. Salvar no banco
  db.upsertZamakDevices(rows);

  // 7. Discrepâncias
  const discrepancies = [];

  // zamak_only: existe na Zamak mas sem agente DM
  for (const row of rows) {
    if (!row.dm_machine_id) {
      discrepancies.push({
        type:            'zamak_only',
        device_name:     row.device_name,
        store_name:      row.store_name,
        zamak_device_id: row.device_id,
        dm_machine_id:   null,
        detail:          `Existe na Zamak (${row.store_name || row.site_name}) mas sem agente Delirio Manager`,
        detected_at:     now,
      });
    }
  }

  // dm_only: tem agente DM mas não aparece na Zamak
  const zamakNames = new Set(rows.map(r => r.device_name.toLowerCase()).filter(Boolean));
  for (const m of allDmMachines) {
    if (!m.hostname) continue;
    if (!zamakNames.has(m.hostname.toLowerCase())) {
      discrepancies.push({
        type:            'dm_only',
        device_name:     m.hostname,
        store_name:      m.location,
        zamak_device_id: null,
        dm_machine_id:   m.id,
        detail:          `Tem agente DM mas não aparece na Zamak (possível reinstalação ou máquina nova)`,
        detected_at:     now,
      });
    }
  }

  db.replaceZamakDiscrepancies(discrepancies);

  const summary = {
    devices:       rows.length,
    discrepancies: discrepancies.length,
    unmappedSites,
    log,
  };

  log.push(`✅ Sync concluído: ${rows.length} dispositivos, ${discrepancies.length} discrepâncias`);
  if (unmappedSites.length > 0) {
    log.push(
      `⚠️ Sites sem mapeamento (configurar em config.json > zamak.store_map): ` +
      unmappedSites.map(s => `"${s.siteName}"`).join(', ')
    );
  }

  return summary;
}

async function syncIfStale(hours = 6) {
  const age = db.getZamakCacheAge();
  if (age >= hours) return syncAll();
  return null;
}

module.exports = { syncAll, syncIfStale };
