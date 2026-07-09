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
    // Captura CDATA ou texto simples
    const fieldRe = /<([a-zA-Z_][a-zA-Z0-9_]*)(?:\s[^>]*)?>(<!\[CDATA\[[\s\S]*?\]\]>|[^<]*)<\/\1>/g;
    for (const field of match[0].matchAll(fieldRe)) {
      let val = field[2].trim();
      const cdata = val.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
      if (cdata) val = cdata[1].trim();
      item[field[1]] = val;
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
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        // N-sight retorna XML em ISO-8859-1; decodificar como latin1 para preservar acentos
        const data = Buffer.concat(chunks).toString('latin1');
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
  'citta':              'Città',
  'gavea':              'Gávea',
  'ipanema':            'Ipanema',
  'rio sul':            'Rio Sul',
  'niteroi plaza':      'Niterói Plaza',
  'niteroi':            'Niterói Plaza',
  'assembleia':         'Assembleia',
  'tijuca':             'Tijuca',
  'escritorio central': 'Escritório Central',
  'escritorio':         'Escritório Central',
  'central':            'Escritório Central',
};

// Normaliza acentos para comparação robusta (independente de encoding)
function stripAccents(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function resolveStoreName(nsightSiteName, customMap = {}) {
  if (!nsightSiteName) return null;
  const key = stripAccents(nsightSiteName);

  for (const [k, v] of Object.entries(customMap)) {
    if (key.includes(stripAccents(k))) return v;
  }
  for (const [k, v] of Object.entries(DEFAULT_STORE_MAP)) {
    if (key.includes(k)) return v;
  }
  return null;
}

// ─── Parser hierárquico para list_devices_at_client ──────────────────────────
// Resposta: <client> → <site id=X name=Y> → <workstation>/<server>
// O parser flat não captura o siteid do elemento pai.
function parseDevicesWithSite(xml, deviceTag) {
  const result = [];
  const siteRe = /<site[\s>][\s\S]*?<\/site>/gi;
  for (const sm of xml.matchAll(siteRe)) {
    const siteXml = sm[0];
    const siteId   = (siteXml.match(/<id>(\d+)<\/id>/) || [])[1] || null;
    const snCdata  = siteXml.match(/<name><!\[CDATA\[([\s\S]*?)\]\]><\/name>/);
    const snPlain  = siteXml.match(/<name>([^<]*)<\/name>/);
    const siteName = (snCdata ? snCdata[1] : snPlain ? snPlain[1] : '').trim();

    const devRe = new RegExp(`<${deviceTag}[\\s>][\\s\\S]*?<\\/${deviceTag}>`, 'gi');
    for (const dm of siteXml.matchAll(devRe)) {
      const item = {};
      const fieldRe = /<([a-zA-Z_][a-zA-Z0-9_]*)(?:\s[^>]*)?>(<!\[CDATA\[[\s\S]*?\]\]>|[^<]*)<\/\1>/g;
      for (const f of dm[0].matchAll(fieldRe)) {
        let val = f[2].trim();
        const cdata = val.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
        if (cdata) val = cdata[1].trim();
        item[f[1]] = val;
      }
      item._siteid   = siteId;
      item._sitename = siteName;
      if (Object.keys(item).length > 1) result.push(item);
    }
  }
  return result;
}

// ─── Helpers para extrair campos independente de variação de tag ───────────────
function deviceId(d) {
  return d.id || d.workstationid || d.serverid || d.deviceid || '';
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
    return stripAccents(c.name || c.clientname || '').includes('delirio');
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

  // 3. Listar todos os dispositivos — resposta hierárquica: <site> → <workstation>/<server>
  await throttle();
  const wsXml = await fetchNsight(server, apiKey, 'list_devices_at_client', {
    clientid: clientId, devicetype: 'workstation',
  });
  const workstations = parseDevicesWithSite(wsXml, 'workstation').map(d => ({ ...d, _type: 'workstation' }));

  await throttle();
  const srvXml = await fetchNsight(server, apiKey, 'list_devices_at_client', {
    clientid: clientId, devicetype: 'server',
  });
  const servers = parseDevicesWithSite(srvXml, 'server').map(d => ({ ...d, _type: 'server' }));

  const allDevices = [...workstations, ...servers];
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

  // 5. Por dispositivo: patches + ameaças MAV + performance + outages
  const allDmMachines = db.getAllMachines();
  const rows = [];
  const threatRows = [];
  const perfRows = [];
  const outageRows = [];

  for (const device of allDevices) {
    const did      = deviceId(device);
    const name     = deviceName(device);
    const siteId   = device._siteid;
    const siteName = device._sitename || '?';
    const storeName = resolveStoreName(siteName, customStoreMap);

    if (!storeName && siteName !== '?' && !unmappedSites.find(u => u.siteId === siteId)) {
      unmappedSites.push({ siteId, siteName });
      log.push(`⚠️ Site sem mapeamento: "${siteName}" (siteId=${siteId})`);
    }

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
    let activeThreats = [];
    if (did) {
      try {
        await throttle();
        const mXml = await fetchNsight(server, apiKey, 'list_mav_threats', { deviceid: did });
        let threats = parseJsonList(mXml, 'threat', 'threats');
        if (!threats) threats = parseFlatXmlList(mXml, 'threat');
        activeThreats = threats.filter(t =>
          (t.last_status || t.status || '').toLowerCase() !== 'cleaned'
        );
        threatsActive = activeThreats.length;
      } catch (e) {
        log.push(`MAV ${name}: ${e.message}`);
      }
    }

    for (const t of activeThreats) {
      threatRows.push({
        device_id:   did,
        device_name: name,
        store_name:  storeName,
        threat_name: t.name || t.threat_name || t.filename || 'Desconhecida',
        category:    t.category || t.infotype || '',
        last_status: t.last_status || t.status || '',
        cached_at:   now,
      });
    }

    // Performance history (interval=60 → até 8 dias)
    if (did) {
      try {
        await throttle();
        const phXml = await fetchNsight(server, apiKey, 'list_performance_history', {
          deviceid: did, interval: 60,
        });
        function firstFloat(tag) {
          const m = phXml.match(new RegExp(`<${tag}[^>]*>([\\d.]+)</${tag}>`));
          return m ? parseFloat(m[1]) : null;
        }
        const cpuAvg  = firstFloat('load_average');
        const cpuPeak = firstFloat('load_max');
        const ramTot  = firstFloat('total');
        const ramAvail= firstFloat('available_average');
        const diskTime= firstFloat('disk_time_average');
        perfRows.push({
          device_id:    did,
          device_name:  name,
          store_name:   storeName,
          cpu_avg:      cpuAvg,
          cpu_peak:     cpuPeak,
          ram_total_mb: ramTot,
          ram_avail_avg:ramAvail,
          disk_time_avg:diskTime,
          cached_at:    now,
        });
      } catch (e) {
        log.push(`Perf ${name}: ${e.message}`);
        perfRows.push({ device_id: did, device_name: name, store_name: storeName, cached_at: now });
      }
    }

    // Outages (últimos 61 dias)
    if (did) {
      try {
        await throttle();
        const oXml = await fetchNsight(server, apiKey, 'list_outages', { deviceid: did });
        const outages = parseFlatXmlList(oXml, 'outage');
        for (const o of outages) {
          let durationMin = null;
          if (o.utc_start && o.utc_end) {
            durationMin = Math.round((new Date(o.utc_end) - new Date(o.utc_start)) / 60000);
          }
          outageRows.push({
            outage_id:        o.outage_id || null,
            device_id:        did,
            device_name:      name,
            store_name:       storeName,
            reason:           o.reason || '',
            state:            o.state || '',
            utc_start:        o.utc_start || null,
            utc_end:          o.utc_end || null,
            duration_min:     durationMin,
            check_description:o.check_description || null,
            cached_at:        now,
          });
        }
      } catch (e) {
        log.push(`Outages ${name}: ${e.message}`);
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
  db.replaceZamakThreats(threatRows);
  db.replaceZamakPerformance(perfRows);
  db.replaceZamakOutages(outageRows);

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

// ─── Sync diário — performance + outages apenas ────────────────────────────────
// Usa device IDs já conhecidos no cache — sem re-discovery (poupa ~5 chamadas API)
async function syncPerfAndOutages() {
  const cfg = loadConfig();
  if (!cfg.server || !cfg.apiKey) throw new Error('zamak.server e zamak.apiKey não configurados');

  const { server, apiKey } = cfg;
  const now = new Date().toISOString();

  const cachedDevices = db.getZamakCachedDeviceIds();
  if (!cachedDevices.length) throw new Error('Nenhum device no cache. Execute sync completo primeiro (botão Atualizar).');

  const log = [];
  const perfRows = [];
  const outageRows = [];
  let errors = 0;

  log.push(`Sync performance+outages — ${cachedDevices.length} devices`);

  for (const { device_id: did, device_name: name, store_name: storeName } of cachedDevices) {
    if (!did) continue;

    // Performance history (interval=60 → 8 dias em intervalos horários)
    try {
      await throttle();
      const phXml = await fetchNsight(server, apiKey, 'list_performance_history', { deviceid: did, interval: 60 });
      function firstFloat(tag) {
        const m = phXml.match(new RegExp(`<${tag}[^>]*>([\\d.]+)</${tag}>`));
        return m ? parseFloat(m[1]) : null;
      }
      perfRows.push({
        device_id:     did,
        device_name:   name,
        store_name:    storeName,
        cpu_avg:       firstFloat('load_average'),
        cpu_peak:      firstFloat('load_max'),
        ram_total_mb:  firstFloat('total'),
        ram_avail_avg: firstFloat('available_average'),
        disk_time_avg: firstFloat('disk_time_average'),
        cached_at:     now,
      });
    } catch (e) {
      log.push(`Perf ${name}: ${e.message}`);
      perfRows.push({ device_id: did, device_name: name, store_name: storeName, cached_at: now });
      errors++;
    }

    // Outages (últimos 61 dias)
    try {
      await throttle();
      const oXml = await fetchNsight(server, apiKey, 'list_outages', { deviceid: did });
      const outages = parseFlatXmlList(oXml, 'outage');
      for (const o of outages) {
        let durationMin = null;
        if (o.utc_start && o.utc_end) {
          durationMin = Math.round((new Date(o.utc_end) - new Date(o.utc_start)) / 60000);
        }
        outageRows.push({
          outage_id:         o.outage_id || null,
          device_id:         did,
          device_name:       name,
          store_name:        storeName,
          reason:            o.reason || null,
          utc_start:         o.utc_start || null,
          utc_end:           o.utc_end || null,
          duration_min:      durationMin,
          check_description: o.check_description || null,
          cached_at:         now,
        });
      }
    } catch (e) {
      log.push(`Outages ${name}: ${e.message}`);
      errors++;
    }
  }

  db.replaceZamakPerformance(perfRows);
  db.replaceZamakOutages(outageRows);

  return {
    devices:   cachedDevices.length,
    perfRows:  perfRows.length,
    outageRows: outageRows.length,
    errors,
    log,
    syncedAt:  now,
  };
}

// ─── Email de resultado via MS Graph ──────────────────────────────────────────
async function sendSyncEmail(success, summary, error) {
  const path = require('path');
  const fs   = require('fs');
  const cfg  = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).msGraph || {}; }
    catch { return {}; }
  })();

  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    console.warn('[ZamakDaily] Email não enviado — msGraph não configurado');
    return;
  }

  // Obter access token
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    scope:         'offline_access https://graph.microsoft.com/Mail.Send',
  });
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
  );
  if (!tokenRes.ok) { console.error('[ZamakDaily] Falha ao obter token Graph'); return; }
  const { access_token, refresh_token: newRt } = await tokenRes.json();

  // Persistir novo refresh_token se veio rotacionado
  if (newRt && newRt !== cfg.refreshToken) {
    try {
      const confPath = path.join(__dirname, '..', 'config.json');
      const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
      conf.msGraph.refreshToken = newRt;
      fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));
    } catch {}
  }

  const dtBRT = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const subject = success
    ? `✅ Zamak sync concluido — ${dtBRT}`
    : `❌ Zamak sync FALHOU — ${dtBRT}`;

  const bodyHtml = success ? `
<!DOCTYPE html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#222">
<div style="background:#276749;color:#fff;padding:12px 20px;border-radius:6px 6px 0 0">
  <h2 style="margin:0;font-size:16px">✅ Zamak — Sync diário concluído</h2>
</div>
<div style="border:1px solid #ddd;border-top:none;padding:16px 20px;border-radius:0 0 6px 6px">
  <p><b>Data/hora:</b> ${dtBRT} (Brasília)</p>
  <table style="border-collapse:collapse;width:100%;margin:12px 0">
    <tr style="background:#f7f7f7"><td style="padding:6px 10px"><b>Devices sincronizados</b></td><td style="padding:6px 10px;text-align:right">${summary.devices}</td></tr>
    <tr><td style="padding:6px 10px"><b>Linhas de performance</b></td><td style="padding:6px 10px;text-align:right">${summary.perfRows}</td></tr>
    <tr style="background:#f7f7f7"><td style="padding:6px 10px"><b>Outages registrados</b></td><td style="padding:6px 10px;text-align:right">${summary.outageRows}</td></tr>
    <tr><td style="padding:6px 10px"><b>Erros</b></td><td style="padding:6px 10px;text-align:right;color:${summary.errors > 0 ? '#c0392b' : '#276749'}">${summary.errors}</td></tr>
  </table>
  ${summary.errors > 0 ? `<p style="color:#c0392b"><b>Erros encontrados:</b></p><pre style="background:#fff5f5;padding:10px;border-radius:4px;font-size:12px">${summary.log.filter(l => l.includes(': ')).join('\n')}</pre>` : ''}
  <p style="color:#718096;font-size:12px;margin-top:16px">Delirio Manager — sync automático diário 02:00 BRT</p>
</div></body></html>` : `
<!DOCTYPE html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#222">
<div style="background:#c0392b;color:#fff;padding:12px 20px;border-radius:6px 6px 0 0">
  <h2 style="margin:0;font-size:16px">❌ Zamak — Sync diário FALHOU</h2>
</div>
<div style="border:1px solid #ddd;border-top:none;padding:16px 20px;border-radius:0 0 6px 6px">
  <p><b>Data/hora:</b> ${dtBRT} (Brasília)</p>
  <p><b>Erro:</b></p>
  <pre style="background:#fff5f5;padding:10px;border-radius:4px;font-size:12px">${error?.message || String(error)}</pre>
  <p style="color:#718096;font-size:12px;margin-top:16px">Verifique os logs do servidor (pm2 logs dt-manager).</p>
</div></body></html>`;

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
    if (r.ok || r.status === 202) console.log('[ZamakDaily] Email enviado para andre@delirio.com.br');
    else r.text().then(t => console.error('[ZamakDaily] Erro ao enviar email:', t.slice(0, 200)));
  }).catch(e => console.error('[ZamakDaily] Falha no envio de email:', e.message));
}

// ─── Agendador diário — 02:00 BRT (05:00 UTC) ─────────────────────────────────
async function runDailySync() {
  console.log('[ZamakDaily] Iniciando sync performance+outages...');
  try {
    const summary = await syncPerfAndOutages();
    console.log(`[ZamakDaily] Concluido: ${summary.devices} devices, ${summary.perfRows} perf, ${summary.outageRows} outages, ${summary.errors} erros`);
    await sendSyncEmail(true, summary, null);
  } catch (err) {
    console.error('[ZamakDaily] FALHOU:', err.message);
    await sendSyncEmail(false, null, err);
  }
}

function scheduleDailySync() {
  // Se cache estiver stale no startup (restart pós-05:00 UTC), sync imediato
  syncIfStale(6)
    .then(result => { if (result) console.log('[ZamakDaily] Startup sync executado (cache estava stale)'); })
    .catch(e => console.error('[ZamakDaily] Startup sync error:', e.message));

  function scheduleNext() {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(5, 0, 0, 0); // 02:00 BRT = 05:00 UTC
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delayMs = next - now;
    const delayMin = Math.round(delayMs / 60000);
    console.log(`[ZamakDaily] Proximo sync em ${delayMin} min (${next.toISOString()})`);
    setTimeout(async () => {
      await runDailySync();
      scheduleNext();
    }, delayMs);
  }
  scheduleNext();
}

module.exports = { syncAll, syncIfStale, scheduleDailySync };
