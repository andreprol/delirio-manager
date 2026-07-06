'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dt-manager.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id           TEXT PRIMARY KEY,
      hostname     TEXT NOT NULL,
      display_name TEXT,
      location     TEXT DEFAULT '',
      subnet       TEXT DEFAULT '',
      ip_interno   TEXT DEFAULT '',
      mac          TEXT DEFAULT '',
      critica      INTEGER DEFAULT 0,
      token        TEXT UNIQUE NOT NULL,
      agent_version TEXT DEFAULT '',
      status       TEXT DEFAULT 'unknown',
      last_seen    TEXT,
      registered_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id   TEXT NOT NULL,
      ts           TEXT NOT NULL,
      cpu_pct      REAL DEFAULT 0,
      ram_free_mb  INTEGER DEFAULT 0,
      ram_total_mb INTEGER DEFAULT 0,
      disk_free_gb REAL DEFAULT 0,
      disk_total_gb REAL DEFAULT 0,
      uptime_h     REAL DEFAULT 0,
      cpu_temp_c   REAL DEFAULT -1,
      ips          TEXT DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_machine_ts
      ON metrics(machine_id, ts);

    CREATE TABLE IF NOT EXISTS commands (
      id         TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      type       TEXT NOT NULL,
      params     TEXT DEFAULT '{}',
      status     TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL,
      sent_at    TEXT,
      acked_at   TEXT,
      result     TEXT,
      created_by TEXT DEFAULT 'dashboard'
    );

    CREATE INDEX IF NOT EXISTS idx_commands_machine_status
      ON commands(machine_id, status);

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      ts         TEXT NOT NULL,
      type       TEXT NOT NULL,
      details    TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_events_machine_ts
      ON events(machine_id, ts);

    CREATE TABLE IF NOT EXISTS alerts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id   TEXT,
      type         TEXT NOT NULL,
      threshold    REAL DEFAULT 0,
      duration_mins INTEGER DEFAULT 3,
      channels     TEXT DEFAULT '["push"]',
      enabled      INTEGER DEFAULT 1,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      name       TEXT PRIMARY KEY,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS win_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      event_time   TEXT NOT NULL,
      received_at  TEXT NOT NULL DEFAULT (datetime('now')),
      event_id     INTEGER NOT NULL,
      source       TEXT NOT NULL,
      level        TEXT NOT NULL,
      translation  TEXT NOT NULL,
      raw_message  TEXT,
      is_read      INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_win_events_machine
      ON win_events(machine_id, event_time);

    -- pattern_hash é SHA256(machine_id + pattern[:80]), garantindo dedup por máquina
    CREATE TABLE IF NOT EXISTS insights (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id    TEXT REFERENCES machines(id) ON DELETE CASCADE,
      generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      severity      TEXT NOT NULL,
      pattern       TEXT NOT NULL,
      solution      TEXT,
      pattern_hash  TEXT NOT NULL,
      is_read       INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_hash
      ON insights(pattern_hash);

    -- Log de auditoria LGPD Art. 15/16 — evidência de exclusão de dados biométricos
    CREATE TABLE IF NOT EXISTS clock_offboard_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      cpf            TEXT NOT NULL,
      employee_name  TEXT DEFAULT '',
      triggered_by   TEXT DEFAULT '',
      timestamp      TEXT NOT NULL,
      success        INTEGER NOT NULL DEFAULT 0,
      removed        INTEGER DEFAULT 0,
      already_absent INTEGER DEFAULT 0,
      failed         INTEGER DEFAULT 0,
      detail         TEXT DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_clock_offboard_cpf
      ON clock_offboard_log(cpf, timestamp);

    CREATE TABLE IF NOT EXISTS clock_operation_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      operation     TEXT NOT NULL,
      cpf           TEXT NOT NULL,
      employee_name TEXT DEFAULT '',
      triggered_by  TEXT DEFAULT '',
      timestamp     TEXT NOT NULL,
      success       INTEGER NOT NULL DEFAULT 0,
      total         INTEGER DEFAULT 0,
      ok_count      INTEGER DEFAULT 0,
      failed_count  INTEGER DEFAULT 0,
      detail        TEXT DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_clock_op_log_cpf
      ON clock_operation_log(cpf, timestamp);

    CREATE INDEX IF NOT EXISTS idx_clock_op_log_operation
      ON clock_operation_log(operation, timestamp);

    CREATE TABLE IF NOT EXISTS nfce_index (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id    TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      chave         TEXT NOT NULL,
      n_nf          INTEGER,
      dh_emi        TEXT NOT NULL,
      v_nf          REAL NOT NULL,
      day_folder    TEXT NOT NULL,
      month_year    TEXT NOT NULL,
      products_text TEXT NOT NULL DEFAULT '',
      danfe_json    TEXT NOT NULL DEFAULT '{}',
      indexed_at    TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_nfce_machine_chave
      ON nfce_index(machine_id, chave);

    CREATE INDEX IF NOT EXISTS idx_nfce_dh_emi
      ON nfce_index(machine_id, dh_emi);

    CREATE TABLE IF NOT EXISTS dr_backups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      backed_at    TEXT NOT NULL,
      status       TEXT NOT NULL,
      storage_gb   REAL,
      duration_min INTEGER,
      error_msg    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dr_backups_machine
      ON dr_backups(machine_id, backed_at DESC);
  `);

  // Migrações incrementais — seguras para rodar múltiplas vezes
  const migrations = [
    `ALTER TABLE machines ADD COLUMN online_since TEXT`,
    `ALTER TABLE metrics  ADD COLUMN room_temp_c  REAL DEFAULT -1`,
    `ALTER TABLE machines ADD COLUMN wol_status TEXT DEFAULT 'unknown'`,
    `ALTER TABLE machines ADD COLUMN wol_tested_at TEXT`,
    `ALTER TABLE machines ADD COLUMN motherboard TEXT DEFAULT ''`,
    // Registro permanente de Ref1 já utilizados — garante que nenhum número seja reutilizado após remoção
    `CREATE TABLE IF NOT EXISTS ref1_registry (
      ref1       INTEGER PRIMARY KEY,
      cpf        TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT '',
      assigned_at TEXT NOT NULL
    )`,
    `ALTER TABLE machines ADD COLUMN dr_setup TEXT DEFAULT 'not_installed'`,
    `ALTER TABLE machines ADD COLUMN dr_last_ok TEXT`,
    `ALTER TABLE machines ADD COLUMN dr_storage_gb REAL`,
    `ALTER TABLE machines ADD COLUMN dr_version TEXT`,
    // ── Módulo Relatório ──────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS report_topics (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      store_name         TEXT NOT NULL,
      description        TEXT NOT NULL,
      severity           TEXT NOT NULL CHECK(severity IN ('baixa','media','alta','critica')),
      machine_mention    TEXT,
      is_critical_machine INTEGER DEFAULT 0,
      photo_path         TEXT,
      created_at         TEXT NOT NULL,
      created_by         TEXT NOT NULL DEFAULT 'TI'
    )`,
    `CREATE TABLE IF NOT EXISTS report_topics_history (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      original_topic_id  INTEGER,
      store_name         TEXT NOT NULL,
      description        TEXT NOT NULL,
      severity           TEXT NOT NULL,
      machine_mention    TEXT,
      is_critical_machine INTEGER DEFAULT 0,
      photo_path         TEXT,
      created_at         TEXT NOT NULL,
      resolved_at        TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS freshdesk_cache (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id   INTEGER UNIQUE NOT NULL,
      store_name  TEXT,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL,
      priority    TEXT,
      created_at  TEXT,
      resolved_at TEXT,
      cached_at   TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS report_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      store_name          TEXT NOT NULL,
      month               TEXT NOT NULL,
      generated_at        TEXT NOT NULL,
      score_total         INTEGER,
      score_hardware      INTEGER,
      score_software      INTEGER,
      score_connectivity  INTEGER,
      score_security      INTEGER,
      score_incidents     INTEGER,
      ai_narrative        TEXT,
      ai_recommendations  TEXT,
      docx_path           TEXT,
      pdf_path            TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS report_feedback (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      report_run_id  INTEGER,
      store_name     TEXT NOT NULL,
      month          TEXT NOT NULL,
      feedback_text  TEXT NOT NULL,
      created_at     TEXT NOT NULL
    )`,
    // Blocklist de máquinas excluídas — impede re-registro automático pelo agente
    `CREATE TABLE IF NOT EXISTS deleted_machines (
      id         TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    )`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* coluna já existe */ }
  }
}

// ── Machines ──────────────────────────────────────────────────────────────────

function registerMachine({ machineId, hostname, agentVersion }) {
  const d = getDb();
  const now = new Date().toISOString();

  // Verifica se ja existe pelo machineId
  const existing = d.prepare('SELECT * FROM machines WHERE id = ?').get(machineId);
  if (existing) {
    d.prepare(`UPDATE machines SET hostname=?, agent_version=?, last_seen=?, online_since=?, status='online'
               WHERE id=?`).run(hostname, agentVersion || '', now, now, machineId);
    return existing.token;
  }

  const token = crypto.randomUUID();
  // Detecta subnet pelo machineId ou hostname (pode ser refinado depois)
  d.prepare(`INSERT INTO machines
    (id, hostname, display_name, location, token, agent_version, status, last_seen, online_since, registered_at)
    VALUES (?, ?, ?, 'Temporário', ?, ?, 'online', ?, ?, ?)`
  ).run(machineId, hostname, hostname, token, agentVersion || '', now, now, now);

  addEvent(machineId, 'agent_installed', `Agente v${agentVersion || '?'} registrado`);
  return token;
}

function getMachineByToken(token) {
  return getDb().prepare('SELECT * FROM machines WHERE token = ?').get(token);
}

function getMachineById(id) {
  return getDb().prepare('SELECT * FROM machines WHERE id = ?').get(id);
}

function getAllMachines() {
  return getDb().prepare(`
    SELECT m.*,
      (SELECT json_object(
        'cpuPct', cpu_pct, 'ramFreeMB', ram_free_mb, 'ramTotalMB', ram_total_mb,
        'diskFreeGB', disk_free_gb, 'diskTotalGB', disk_total_gb,
        'uptimeH', uptime_h, 'cpuTempC', cpu_temp_c, 'roomTempC', room_temp_c, 'ips', ips
      ) FROM metrics WHERE machine_id = m.id ORDER BY ts DESC LIMIT 1) AS last_metrics
    FROM machines m
    ORDER BY m.location, m.display_name
  `).all();
}

function deleteMachine(id) {
  const db = getDb();
  const now = new Date().toISOString();
  // win_events, insights, nfce_index, dr_backups têm ON DELETE CASCADE
  db.prepare('DELETE FROM metrics  WHERE machine_id=?').run(id);
  db.prepare('DELETE FROM commands WHERE machine_id=?').run(id);
  db.prepare('DELETE FROM events   WHERE machine_id=?').run(id);
  db.prepare('DELETE FROM machines WHERE id=?').run(id);
  // Bloqueia re-registro pelo agente
  db.prepare('INSERT OR REPLACE INTO deleted_machines (id, deleted_at) VALUES (?, ?)').run(id, now);
}

function isDeletedMachine(id) {
  return !!getDb().prepare('SELECT 1 FROM deleted_machines WHERE id = ?').get(id);
}

function updateMachine(id, fields) {
  const allowed = ['display_name', 'location', 'critica', 'subnet', 'ip_interno', 'mac', 'agent_version', 'motherboard'];
  const keys    = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const set = keys.map(k => `${k}=?`).join(', ');
  getDb().prepare(`UPDATE machines SET ${set} WHERE id=?`)
         .run(...keys.map(k => fields[k]), id);
}

function setMachineStatus(id, status) {
  const now = new Date().toISOString();
  if (status === 'online') {
    getDb().prepare(`
      UPDATE machines SET status=?, last_seen=?, online_since=? WHERE id=?
    `).run(status, now, now, id);
  } else {
    getDb().prepare(`
      UPDATE machines SET status=?, last_seen=? WHERE id=?
    `).run(status, now, id);
  }
}

function getMachinesStale(thresholdISO) {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE status = 'online' AND (last_seen IS NULL OR last_seen < ?)
  `).all(thresholdISO);
}

function setWolStatus(machineId, status, testedAt = null) {
  const d = getDb();
  if (testedAt) {
    d.prepare(`UPDATE machines SET wol_status=?, wol_tested_at=? WHERE id=?`)
     .run(status, testedAt, machineId);
  } else {
    d.prepare(`UPDATE machines SET wol_status=? WHERE id=?`)
     .run(status, machineId);
  }
}

function getMachinesWolTesting(olderThanISO) {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE wol_status = 'testing' AND wol_tested_at IS NOT NULL AND wol_tested_at < ?
  `).all(olderThanISO);
}

function getMachinesBiosNeeded() {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE wol_status = 'bios_needed'
    ORDER BY location, display_name
  `).all();
}

function getMachinesOfflineForWake(offlineSinceCutoff) {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE status = 'offline'
      AND wol_status = 'wol_confirmed'
      AND mac != ''
      AND last_seen IS NOT NULL
      AND last_seen < ?
  `).all(offlineSinceCutoff);
}

function getMachinesAutoWolTesting(olderThanISO) {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE wol_status = 'wol_auto_testing'
      AND wol_tested_at IS NOT NULL
      AND wol_tested_at < ?
  `).all(olderThanISO);
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function saveMetrics(machineId, m) {
  const d   = getDb();
  const now = new Date().toISOString();

  d.prepare(`INSERT INTO metrics
    (machine_id, ts, cpu_pct, ram_free_mb, ram_total_mb,
     disk_free_gb, disk_total_gb, uptime_h, cpu_temp_c, room_temp_c, ips)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    machineId, now,
    m.cpuPct || 0, m.ramFreeMB || 0, m.ramTotalMB || 0,
    m.diskFreeGB || 0, m.diskTotalGB || 0,
    m.uptimeH || 0,
    m.cpuTempC  != null ? m.cpuTempC  : -1,
    m.roomTempC != null ? m.roomTempC : -1,
    JSON.stringify(m.ips || [])
  );

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  d.prepare('DELETE FROM metrics WHERE machine_id=? AND ts<?').run(machineId, cutoff);
}

function getMetrics(machineId, hours = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return getDb().prepare(`
    SELECT * FROM metrics WHERE machine_id=? AND ts>=?
    ORDER BY ts ASC
  `).all(machineId, cutoff);
}

// ── Commands ──────────────────────────────────────────────────────────────────

function createCommand(machineId, type, params = {}) {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO commands (id, machine_id, type, params, status, created_at)
                   VALUES (?,?,?,?,'pending',?)`
  ).run(id, machineId, type, JSON.stringify(params), now);
  return id;
}

function getPendingCommands(machineId) {
  const cmds = getDb().prepare(`
    SELECT * FROM commands
    WHERE machine_id=? AND status='pending'
    ORDER BY created_at ASC
  `).all(machineId);

  // Marca como 'sent'
  if (cmds.length) {
    const now = new Date().toISOString();
    const ids = cmds.map(() => '?').join(',');
    getDb().prepare(`UPDATE commands SET status='sent', sent_at=? WHERE id IN (${ids})`)
           .run(now, ...cmds.map(c => c.id));
  }

  return cmds.map(c => ({
    id:     c.id,
    type:   c.type,
    params: JSON.parse(c.params || '{}'),
  }));
}

function ackCommand(commandId, machineId, success, message) {
  const now = new Date().toISOString();
  getDb().prepare(`UPDATE commands
    SET status=?, acked_at=?, result=?
    WHERE id=? AND machine_id=?`
  ).run(success ? 'acked' : 'failed', now, message || '', commandId, machineId);
}

function getCommandHistory(machineId, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM commands WHERE machine_id=?
    ORDER BY created_at DESC LIMIT ?
  `).all(machineId, limit);
}

function getLastAlohaScan(machineId) {
  return getDb().prepare(`
    SELECT id, result, acked_at FROM commands
    WHERE machine_id=? AND type='aloha-scan' AND status='acked' AND result IS NOT NULL
    ORDER BY acked_at DESC LIMIT 1
  `).get(machineId);
}

// ── Events ────────────────────────────────────────────────────────────────────

function addEvent(machineId, type, details = '') {
  const now = new Date().toISOString();
  getDb().prepare('INSERT INTO events (machine_id, ts, type, details) VALUES (?,?,?,?)')
         .run(machineId, now, type, details);
}

function getEvents(machineId, limit = 100) {
  return getDb().prepare(`
    SELECT * FROM events WHERE machine_id=?
    ORDER BY ts DESC LIMIT ?
  `).all(machineId, limit);
}

// ── Alerts ────────────────────────────────────────────────────────────────────

function getAlerts(machineId) {
  if (machineId) {
    return getDb().prepare('SELECT * FROM alerts WHERE machine_id=? OR machine_id IS NULL')
                  .all(machineId);
  }
  return getDb().prepare('SELECT * FROM alerts ORDER BY id').all();
}

function createAlert(rule) {
  const now = new Date().toISOString();
  const r   = getDb().prepare(`
    INSERT INTO alerts (machine_id, type, threshold, duration_mins, channels, enabled, created_at)
    VALUES (?,?,?,?,?,1,?)
  `).run(
    rule.machineId || null,
    rule.type, rule.threshold || 0, rule.durationMins || 3,
    JSON.stringify(rule.channels || ['push']),
    now
  );
  return r.lastInsertRowid;
}

function deleteAlert(id) {
  getDb().prepare('DELETE FROM alerts WHERE id=?').run(id);
}

// ── Groups ────────────────────────────────────────────────────────────────────

function getGroups() {
  return getDb().prepare('SELECT * FROM groups ORDER BY sort_order, name').all();
}

function createGroup(name) {
  const now   = new Date().toISOString();
  const maxOrder = getDb().prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM groups').get().m;
  getDb().prepare('INSERT OR IGNORE INTO groups (name, sort_order, created_at) VALUES (?,?,?)')
         .run(name, maxOrder + 1, now);
}

function deleteGroup(name) {
  // Move maquinas do grupo para "Sem localidade"
  getDb().prepare("UPDATE machines SET location='' WHERE location=?").run(name);
  getDb().prepare('DELETE FROM groups WHERE name=?').run(name);
}

function renameGroup(oldName, newName) {
  getDb().prepare('UPDATE machines SET location=? WHERE location=?').run(newName, oldName);
  getDb().prepare('UPDATE groups SET name=? WHERE name=?').run(newName, oldName);
}

function reorderGroups(names) {
  const stmt = getDb().prepare('UPDATE groups SET sort_order=? WHERE name=?');
  names.forEach((name, i) => stmt.run(i, name));
}

// ── Win Events ────────────────────────────────────────────────────────────────

// IDs do Windows Event Log monitorados no modo "Focado"
// 41=reinício inesperado, 6008=desligamento inesperado, 1074=desligamento programado,
// 1001=BSOD, 19=update OK, 20=update falhou, 7034=serviço caiu, 6005=boot, 6006=shutdown limpo
const FOCUSED_EVENT_IDS = [41, 6008, 1074, 1001, 19, 20, 7034, 6005, 6006];

function saveWinEvents(machineId, events) {
  const d    = getDb();
  const stmt = d.prepare(`
    INSERT INTO win_events (machine_id, event_time, event_id, source, level, translation, raw_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  d.transaction((evts) => {
    for (const e of evts) {
      stmt.run(machineId, e.eventTime, e.eventId, e.source, e.level, e.translation, e.rawMessage || null);
    }
  })(events);

  // Purga eventos com mais de 30 dias
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  d.prepare('DELETE FROM win_events WHERE machine_id=? AND event_time<?').run(machineId, cutoff);
}

function getWinEvents(machineId, scope = 'focused') {
  if (scope === 'focused') {
    const placeholders = FOCUSED_EVENT_IDS.map(() => '?').join(',');
    return getDb().prepare(`
      SELECT * FROM win_events
      WHERE machine_id = ? AND event_id IN (${placeholders})
      ORDER BY event_time DESC LIMIT 200
    `).all(machineId, ...FOCUSED_EVENT_IDS);
  }
  return getDb().prepare(`
    SELECT * FROM win_events WHERE machine_id = ?
    ORDER BY event_time DESC LIMIT 200
  `).all(machineId);
}

function markWinEventsRead(machineId) {
  getDb().prepare(`UPDATE win_events SET is_read = 1 WHERE machine_id = ?`).run(machineId);
}

function countUnreadWinEvents(machineId) {
  return getDb().prepare(`
    SELECT COUNT(*) as c FROM win_events WHERE machine_id = ? AND is_read = 0
  `).get(machineId).c;
}

// ── Insights ──────────────────────────────────────────────────────────────────

function saveInsight({ machineId, severity, pattern, solution, patternHash }) {
  getDb().prepare(`
    INSERT OR IGNORE INTO insights (machine_id, severity, pattern, solution, pattern_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(machineId || null, severity, pattern, solution || null, patternHash);
}

function getInsights({ machineId, limit = 50 } = {}) {
  if (machineId) {
    return getDb().prepare(`
      SELECT * FROM insights WHERE machine_id = ?
      ORDER BY generated_at DESC LIMIT ?
    `).all(machineId, limit);
  }
  return getDb().prepare(`
    SELECT i.*, m.display_name, m.hostname
    FROM insights i
    LEFT JOIN machines m ON i.machine_id = m.id
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      generated_at DESC
    LIMIT ?
  `).all(limit);
}

function markInsightRead(id) {
  getDb().prepare(`UPDATE insights SET is_read = 1 WHERE id = ?`).run(id);
}

function countUnreadInsights(machineId) {
  if (machineId) {
    return getDb().prepare(`
      SELECT COUNT(*) as c FROM insights WHERE machine_id = ? AND is_read = 0
    `).get(machineId).c;
  }
  return getDb().prepare(`SELECT COUNT(*) as c FROM insights WHERE is_read = 0`).get().c;
}

// ── Clock Offboard Log (LGPD Art. 15/16) ─────────────────────────────────────

function logClockOffboard({ cpf, employeeName, triggeredBy, timestamp, success, removed, alreadyAbsent, failed, detail }) {
  getDb().prepare(`
    INSERT INTO clock_offboard_log
      (cpf, employee_name, triggered_by, timestamp, success, removed, already_absent, failed, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cpf, employeeName, triggeredBy, timestamp, success, removed, alreadyAbsent, failed, detail);
}

function getClockOffboardLog(limit = 100) {
  return getDb().prepare(`
    SELECT * FROM clock_offboard_log ORDER BY timestamp DESC LIMIT ?
  `).all(limit);
}

function logClockOperation({ operation, cpf, employeeName, triggeredBy, timestamp, success, total, okCount, failedCount, detail }) {
  getDb().prepare(`
    INSERT INTO clock_operation_log
      (operation, cpf, employee_name, triggered_by, timestamp, success, total, ok_count, failed_count, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation,
    cpf,
    employeeName || '',
    triggeredBy  || '',
    timestamp,
    success ? 1 : 0,
    total        || 0,
    okCount      || 0,
    failedCount  || 0,
    typeof detail === 'string' ? detail : JSON.stringify(detail || [])
  );
}

function getClockOperationLog(limit = 100, operation = null) {
  const q = operation
    ? 'SELECT * FROM clock_operation_log WHERE operation = ? ORDER BY timestamp DESC LIMIT ?'
    : 'SELECT * FROM clock_operation_log ORDER BY timestamp DESC LIMIT ?';
  const args = operation ? [operation, limit] : [limit];
  return getDb().prepare(q).all(...args);
}

// ── NF-Ce Index ───────────────────────────────────────────────────────────────

function getCommandById(id) {
  return getDb().prepare('SELECT id, machine_id, type, params, status FROM commands WHERE id = ?').get(id);
}

function upsertNFCeRecords(machineId, records) {
  const d   = getDb();
  const now = new Date().toISOString();
  const stmt = d.prepare(`
    INSERT INTO nfce_index
      (machine_id, chave, n_nf, dh_emi, v_nf, day_folder, month_year, products_text, danfe_json, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id, chave) DO UPDATE SET
      n_nf          = excluded.n_nf,
      dh_emi        = excluded.dh_emi,
      v_nf          = excluded.v_nf,
      products_text = excluded.products_text,
      danfe_json    = excluded.danfe_json,
      indexed_at    = excluded.indexed_at
  `);
  d.transaction((recs) => {
    for (const r of recs) {
      const monthYear    = (r.dh_emi || '').slice(0, 7);
      const productsText = (r.danfe?.products || []).map(p => p.xProd || '').join(' | ');
      stmt.run(
        machineId, r.chave, r.n_nf || 0, r.dh_emi || '',
        r.v_nf || 0, r.day_folder || '', monthYear,
        productsText, JSON.stringify(r.danfe || {}), now
      );
    }
  })(records);
}

function searchNFCe({ machineId, dateFrom, dateTo, valueMin, valueMax, product, limit = 50, offset = 0 }) {
  const d          = getDb();
  const conditions = ['machine_id = ?'];
  const args       = [machineId];

  if (dateFrom) { conditions.push("dh_emi >= ?");          args.push(dateFrom); }
  if (dateTo)   { conditions.push("dh_emi <= ?");          args.push(dateTo + 'T23:59:59'); }
  if (valueMin != null) { conditions.push('v_nf >= ?');    args.push(valueMin); }
  if (valueMax != null) { conditions.push('v_nf <= ?');    args.push(valueMax); }
  if (product)  { conditions.push('products_text LIKE ?'); args.push(`%${product}%`); }

  const where = conditions.join(' AND ');
  const total = d.prepare(`SELECT COUNT(*) as c FROM nfce_index WHERE ${where}`).get(...args).c;
  const rows  = d.prepare(`
    SELECT id, chave, n_nf, dh_emi, v_nf, day_folder, month_year, products_text, indexed_at
    FROM nfce_index WHERE ${where}
    ORDER BY dh_emi DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);

  return { total, results: rows };
}

function getNFCeByChave(machineId, chave) {
  const row = getDb().prepare(
    'SELECT * FROM nfce_index WHERE machine_id = ? AND chave = ?'
  ).get(machineId, chave);
  if (!row) return null;
  return { ...row, danfe: JSON.parse(row.danfe_json || '{}') };
}

function getNFCeIndexStatus(machineId) {
  const d = getDb();
  const months = d.prepare(`
    SELECT month_year, COUNT(*) as total, MAX(indexed_at) as last_indexed
    FROM nfce_index WHERE machine_id = ?
    GROUP BY month_year ORDER BY month_year DESC LIMIT 12
  `).all(machineId);
  const totalRow = d.prepare(`SELECT COUNT(*) as c FROM nfce_index WHERE machine_id = ?`).get(machineId);
  const listCmd  = d.prepare(
    `SELECT status, acked_at, created_at FROM commands WHERE machine_id = ? AND type = 'aloha-list-nfce-months' ORDER BY created_at DESC LIMIT 1`
  ).get(machineId);

  // Sessão atual: todos os aloha-index-nfce-day enfileirados desde o último aloha-list-nfce-months
  let totalDays = 0, pendingDays = 0, processedDays = 0, sessionStartedAt = null;
  if (listCmd) {
    const sess = d.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        MIN(created_at) as started_at
      FROM commands
      WHERE machine_id = ? AND type = 'aloha-index-nfce-day' AND created_at >= ?
    `).get(machineId, listCmd.created_at);
    totalDays       = sess?.total      || 0;
    pendingDays     = sess?.pending    || 0;
    processedDays   = totalDays - pendingDays;
    sessionStartedAt = sess?.started_at || null;
  } else {
    const pendingRow = d.prepare(
      `SELECT COUNT(*) as c FROM commands WHERE machine_id = ? AND type = 'aloha-index-nfce-day' AND status = 'pending'`
    ).get(machineId);
    pendingDays = pendingRow?.c || 0;
  }

  return {
    months,
    totalRecords:    totalRow?.c || 0,
    pendingDays,
    totalDays,
    processedDays,
    sessionStartedAt,
    listMonths: listCmd || null,
  };
}

// ── Ref1 Registry ─────────────────────────────────────────────────────────────

function registerRef1({ ref1, cpf, name }) {
  const n = parseInt(ref1, 10);
  if (!n || n <= 0) return;
  getDb().prepare(
    `INSERT OR IGNORE INTO ref1_registry (ref1, cpf, name, assigned_at) VALUES (?, ?, ?, ?)`
  ).run(n, cpf || '', name || '', new Date().toISOString());
}

function getMaxRef1() {
  const row = getDb().prepare(`SELECT MAX(ref1) as max FROM ref1_registry`).get();
  return row?.max || 0;
}

// ── DR Backups ────────────────────────────────────────────────────────────────

function updateMachineDRStatus(machineId, { setup, lastOk, storageGb, version } = {}) {
  const map = {
    dr_setup:      setup,
    dr_last_ok:    lastOk,
    dr_storage_gb: storageGb,
    dr_version:    version,
  };
  const keys = Object.keys(map).filter(k => map[k] !== undefined);
  if (!keys.length) return;
  const set = keys.map(k => `${k}=?`).join(', ');
  getDb()
    .prepare(`UPDATE machines SET ${set} WHERE id=?`)
    .run(...keys.map(k => map[k]), machineId);
}

function insertDRBackup(machineId, { backedAt, status, storageGb, durationMin, errorMsg } = {}) {
  getDb().prepare(`
    INSERT INTO dr_backups (machine_id, backed_at, status, storage_gb, duration_min, error_msg)
    VALUES (?,?,?,?,?,?)
  `).run(machineId, backedAt, status, storageGb != null ? storageGb : null, durationMin != null ? durationMin : null, errorMsg || null);
}

function getDRHistory(machineId, days = 28) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return getDb().prepare(`
    SELECT * FROM dr_backups WHERE machine_id=? AND backed_at>=?
    ORDER BY backed_at DESC
  `).all(machineId, cutoff);
}

function getDROverview() {
  const d = getDb();
  const threshold24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return {
    total:     d.prepare(`SELECT COUNT(*) as c FROM machines WHERE dr_setup='configured'`).get().c,
    okLast24h: d.prepare(`SELECT COUNT(*) as c FROM machines WHERE dr_setup='configured' AND dr_last_ok>=?`).get(threshold24h).c,
    totalGb:   d.prepare(`SELECT COALESCE(SUM(dr_storage_gb),0) as s FROM machines WHERE dr_setup='configured'`).get().s,
    failing:   d.prepare(`SELECT COUNT(*) as c FROM machines WHERE dr_setup='error'`).get().c,
  };
}

function getMachinesDRDue(olderThanISO) {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE dr_setup = 'configured'
      AND (dr_last_ok IS NULL OR dr_last_ok < ?)
  `).all(olderThanISO);
}

// ── Módulo Relatório ──────────────────────────────────────────────────────────

const CRITICAL_RE = /^(TERM|BOH)/i;

function isCriticalMachine(mention) {
  return mention ? CRITICAL_RE.test(mention.trim()) : false;
}

// Topics
function getTopics(storeName) {
  return getDb().prepare(
    `SELECT * FROM report_topics WHERE store_name = ? ORDER BY
     CASE severity WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, created_at DESC`
  ).all(storeName);
}

function getAllStoresTopicCount() {
  return getDb().prepare(
    `SELECT store_name, COUNT(*) as count FROM report_topics GROUP BY store_name`
  ).all();
}

function createTopic({ store_name, description, severity, machine_mention, photo_path, created_by }) {
  const critical = isCriticalMachine(machine_mention);
  const now = new Date().toISOString();
  const info = getDb().prepare(
    `INSERT INTO report_topics (store_name, description, severity, machine_mention, is_critical_machine, photo_path, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(store_name, description, severity, machine_mention || null, critical ? 1 : 0, photo_path || null, now, created_by || 'TI');
  return getDb().prepare('SELECT * FROM report_topics WHERE id = ?').get(info.lastInsertRowid);
}

function updateTopic(id, { description, severity, machine_mention, photo_path }) {
  const critical = isCriticalMachine(machine_mention);
  // photo_path === undefined → não alterar (preservar o que está no DB)
  // photo_path === null      → limpar fotos explicitamente
  if (photo_path !== undefined) {
    getDb().prepare(
      `UPDATE report_topics SET description=?, severity=?, machine_mention=?, is_critical_machine=?, photo_path=? WHERE id=?`
    ).run(description, severity, machine_mention || null, critical ? 1 : 0, photo_path, id);
  } else {
    getDb().prepare(
      `UPDATE report_topics SET description=?, severity=?, machine_mention=?, is_critical_machine=? WHERE id=?`
    ).run(description, severity, machine_mention || null, critical ? 1 : 0, id);
  }
  return getDb().prepare('SELECT * FROM report_topics WHERE id = ?').get(id);
}

function resolveTopic(id) {
  const topic = getDb().prepare('SELECT * FROM report_topics WHERE id = ?').get(id);
  if (!topic) return null;
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO report_topics_history (original_topic_id, store_name, description, severity, machine_mention, is_critical_machine, photo_path, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(topic.id, topic.store_name, topic.description, topic.severity, topic.machine_mention, topic.is_critical_machine, topic.photo_path, topic.created_at, now);
  getDb().prepare('DELETE FROM report_topics WHERE id = ?').run(id);
  return { resolved: true };
}

function getTopicsHistory(storeName, months = 6) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  return getDb().prepare(
    `SELECT * FROM report_topics_history WHERE store_name = ? AND resolved_at >= ? ORDER BY resolved_at DESC`
  ).all(storeName, since.toISOString());
}

// Freshdesk cache
function getFreshdeskCacheAge(storeName) {
  const row = getDb().prepare(
    `SELECT cached_at FROM freshdesk_cache WHERE store_name = ? ORDER BY cached_at DESC LIMIT 1`
  ).get(storeName);
  if (!row) return Infinity;
  return (Date.now() - new Date(row.cached_at).getTime()) / 3600000; // hours
}

function upsertFreshdeskTickets(tickets) {
  const stmt = getDb().prepare(
    `INSERT OR REPLACE INTO freshdesk_cache (ticket_id, store_name, title, status, priority, created_at, resolved_at, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  const insert = getDb().transaction((rows) => {
    for (const t of rows) stmt.run(t.ticket_id, t.store_name, t.title, t.status, t.priority, t.created_at, t.resolved_at, now);
  });
  insert(tickets);
}

function getFreshdeskActive(storeName, month) {
  // month = YYYY-MM
  return getDb().prepare(
    `SELECT * FROM freshdesk_cache
     WHERE store_name = ? AND status IN ('open','pending')
     AND substr(created_at, 1, 7) <= ? ORDER BY created_at DESC`
  ).all(storeName, month);
}

function getFreshdeskClosed(storeName, month) {
  return getDb().prepare(
    `SELECT * FROM freshdesk_cache
     WHERE store_name = ? AND status = 'closed'
     AND substr(resolved_at, 1, 7) = ? ORDER BY resolved_at DESC`
  ).all(storeName, month);
}

// Report runs
function saveReportRun(data) {
  const info = getDb().prepare(
    `INSERT INTO report_runs (store_name, month, generated_at, score_total, score_hardware, score_software,
     score_connectivity, score_security, score_incidents, ai_narrative, ai_recommendations, docx_path, pdf_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.store_name, data.month, new Date().toISOString(),
    data.score_total, data.score_hardware, data.score_software,
    data.score_connectivity, data.score_security, data.score_incidents,
    data.ai_narrative, JSON.stringify(data.ai_recommendations || []),
    data.docx_path || null, data.pdf_path || null
  );
  return info.lastInsertRowid;
}

function getReportHistory(storeName) {
  return getDb().prepare(
    `SELECT * FROM report_runs WHERE store_name = ? ORDER BY generated_at DESC LIMIT 12`
  ).all(storeName);
}

// Feedback
function saveFeedback({ store_name, month, feedback_text, report_run_id }) {
  getDb().prepare(
    `INSERT INTO report_feedback (report_run_id, store_name, month, feedback_text, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(report_run_id || null, store_name, month, feedback_text, new Date().toISOString());
}

function getRecentFeedback(storeName, limit = 5) {
  return getDb().prepare(
    `SELECT * FROM report_feedback WHERE store_name = ? ORDER BY created_at DESC LIMIT ?`
  ).all(storeName, limit);
}

// Stores list with score + open topics
function getStoresOverview() {
  const topicCounts = getAllStoresTopicCount();
  const runs = getDb().prepare(
    `SELECT store_name, score_total, generated_at FROM report_runs r1
     WHERE generated_at = (SELECT MAX(generated_at) FROM report_runs r2 WHERE r2.store_name = r1.store_name)`
  ).all();
  const countMap = Object.fromEntries(topicCounts.map(r => [r.store_name, r.count]));
  const scoreMap = Object.fromEntries(runs.map(r => [r.store_name, { score: r.score_total, generatedAt: r.generated_at }]));
  return { countMap, scoreMap };
}

// ──────────────────────────────────────────────────────────────────────────────

module.exports = {
  getDb,
  // machines
  registerMachine, getMachineByToken, getMachineById, isDeletedMachine,
  getAllMachines, updateMachine, deleteMachine, setMachineStatus, getMachinesStale,
  setWolStatus, getMachinesWolTesting,
  getMachinesBiosNeeded, getMachinesOfflineForWake, getMachinesAutoWolTesting,
  // metrics
  saveMetrics, getMetrics,
  // commands
  createCommand, getPendingCommands, ackCommand, getCommandHistory, getLastAlohaScan,
  // events
  addEvent, getEvents,
  // alerts
  getAlerts, createAlert, deleteAlert,
  // groups
  getGroups, createGroup, deleteGroup, renameGroup, reorderGroups,
  // win_events
  saveWinEvents, getWinEvents, markWinEventsRead, countUnreadWinEvents,
  // insights
  saveInsight, getInsights, markInsightRead, countUnreadInsights,
  // rh / clock offboard
  logClockOffboard, getClockOffboardLog,
  // rh / clock operation log
  logClockOperation, getClockOperationLog,
  // nfce index
  getCommandById, upsertNFCeRecords, searchNFCe, getNFCeByChave, getNFCeIndexStatus,
  // ref1 registry
  registerRef1, getMaxRef1,
  // dr backups
  updateMachineDRStatus, insertDRBackup, getDRHistory, getDROverview, getMachinesDRDue,
  // relatório — topics
  getTopics, getAllStoresTopicCount, createTopic, updateTopic, resolveTopic, getTopicsHistory,
  // relatório — freshdesk cache
  getFreshdeskCacheAge, upsertFreshdeskTickets, getFreshdeskActive, getFreshdeskClosed,
  // relatório — report runs
  saveReportRun, getReportHistory,
  // relatório — feedback
  saveFeedback, getRecentFeedback,
  // relatório — overview
  getStoresOverview,
};
