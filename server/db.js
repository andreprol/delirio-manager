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
  `);

  // Migrações incrementais — seguras para rodar múltiplas vezes
  const migrations = [
    `ALTER TABLE machines ADD COLUMN online_since TEXT`,
    `ALTER TABLE metrics  ADD COLUMN room_temp_c  REAL DEFAULT -1`,
    `ALTER TABLE machines ADD COLUMN wol_status TEXT DEFAULT 'unknown'`,
    `ALTER TABLE machines ADD COLUMN wol_tested_at TEXT`,
    `ALTER TABLE machines ADD COLUMN motherboard TEXT DEFAULT ''`,
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

module.exports = {
  getDb,
  // machines
  registerMachine, getMachineByToken, getMachineById,
  getAllMachines, updateMachine, setMachineStatus, getMachinesStale,
  setWolStatus, getMachinesWolTesting,
  getMachinesBiosNeeded, getMachinesOfflineForWake, getMachinesAutoWolTesting,
  // metrics
  saveMetrics, getMetrics,
  // commands
  createCommand, getPendingCommands, ackCommand, getCommandHistory,
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
};
