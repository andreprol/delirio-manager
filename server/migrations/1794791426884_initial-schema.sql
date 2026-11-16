-- Up Migration
--
-- Traduz o schema atual de server/db.js (SQLite, better-sqlite3) pro estado
-- final equivalente em Postgres -- ou seja, já incorpora os 16 `ALTER TABLE
-- ADD COLUMN` que o migrate() do SQLite roda incrementalmente a cada boot
-- (migrations array), não um replay histórico deles.
--
-- Decisões de tradução deliberadas (faithful-first, sem mudar semântica
-- além do necessário -- fica para a fase de port de db.js revisar caso a
-- caso se vale a pena uma modelagem mais "nativa" de Postgres):
--   - REAL (SQLite, 8 bytes)        -> DOUBLE PRECISION (não REAL do Postgres,
--     que é 4 bytes -- REAL do Postgres teria menos precisão que o original).
--   - INTEGER PRIMARY KEY AUTOINCREMENT -> INTEGER GENERATED ALWAYS AS IDENTITY.
--   - Timestamps continuam TEXT (ISO 8601, igual ao `new Date().toISOString()`
--     que o código já grava) em vez de TIMESTAMPTZ -- evita mudar comparação
--     de string por `<`/`>` usada em todo o código atual (ex: purgeOldTerminalCommands).
--   - Booleans 0/1 continuam INTEGER, não BOOLEAN -- evita reescrever toda
--     comparação `= 1`/`= 0` no código JS nesta fase.
--   - Campos que guardam JSON como string (params, detail, products_json...)
--     continuam TEXT, não JSONB -- otimização de leitura/índice fica para depois.
--   - `DEFAULT (datetime('now'))` do SQLite (formato "YYYY-MM-DD HH:MM:SS")
--     traduzido para `DEFAULT (now() AT TIME ZONE 'utc')::text` -- formato de
--     string ligeiramente diferente (inclui microssegundos). Na prática o
--     código sempre passa o timestamp explícito nesses inserts; revisar se
--     algum caminho depender do default exato ao portar as funções de db.js.

CREATE TABLE machines (
  id                     TEXT PRIMARY KEY,
  hostname               TEXT NOT NULL,
  display_name           TEXT,
  location               TEXT DEFAULT '',
  subnet                 TEXT DEFAULT '',
  ip_interno             TEXT DEFAULT '',
  mac                    TEXT DEFAULT '',
  critica                INTEGER DEFAULT 0,
  token                  TEXT UNIQUE NOT NULL,
  agent_version          TEXT DEFAULT '',
  status                 TEXT DEFAULT 'unknown',
  last_seen              TEXT,
  registered_at          TEXT NOT NULL,
  online_since           TEXT,
  wol_status             TEXT DEFAULT 'unknown',
  wol_tested_at          TEXT,
  motherboard            TEXT DEFAULT '',
  dr_setup               TEXT DEFAULT 'not_installed',
  dr_last_ok             TEXT,
  dr_storage_gb          DOUBLE PRECISION,
  dr_version             TEXT,
  os_version             TEXT DEFAULT '',
  last_hourly_at         TEXT,
  wol_ever_confirmed     INTEGER DEFAULT 0,
  last_win_event_id      INTEGER DEFAULT 0,
  last_offline_event_id  INTEGER DEFAULT 0
);

CREATE TABLE metrics (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id    TEXT NOT NULL,
  ts            TEXT NOT NULL,
  cpu_pct       DOUBLE PRECISION DEFAULT 0,
  ram_free_mb   INTEGER DEFAULT 0,
  ram_total_mb  INTEGER DEFAULT 0,
  disk_free_gb  DOUBLE PRECISION DEFAULT 0,
  disk_total_gb DOUBLE PRECISION DEFAULT 0,
  uptime_h      DOUBLE PRECISION DEFAULT 0,
  cpu_temp_c    DOUBLE PRECISION DEFAULT -1,
  ips           TEXT DEFAULT '[]',
  room_temp_c   DOUBLE PRECISION DEFAULT -1
);

CREATE INDEX idx_metrics_machine_ts ON metrics(machine_id, ts);

CREATE TABLE commands (
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

CREATE INDEX idx_commands_machine_status ON commands(machine_id, status);
CREATE INDEX idx_commands_status_created ON commands(status, created_at);

CREATE TABLE events (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  type       TEXT NOT NULL,
  details    TEXT DEFAULT ''
);

CREATE INDEX idx_events_machine_ts ON events(machine_id, ts);

CREATE TABLE alerts (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id    TEXT,
  type          TEXT NOT NULL,
  threshold     DOUBLE PRECISION DEFAULT 0,
  duration_mins INTEGER DEFAULT 3,
  channels      TEXT DEFAULT '["push"]',
  enabled       INTEGER DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE groups (
  name       TEXT PRIMARY KEY,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE win_events (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  event_time   TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text,
  event_id     INTEGER NOT NULL,
  source       TEXT NOT NULL,
  level        TEXT NOT NULL,
  translation  TEXT NOT NULL,
  raw_message  TEXT,
  is_read      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_win_events_machine ON win_events(machine_id, event_time);

-- pattern_hash é SHA256(machine_id + pattern[:80]), garantindo dedup por máquina
CREATE TABLE insights (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id    TEXT REFERENCES machines(id) ON DELETE CASCADE,
  generated_at  TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text,
  severity      TEXT NOT NULL,
  pattern       TEXT NOT NULL,
  solution      TEXT,
  pattern_hash  TEXT NOT NULL,
  is_read       INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_insights_hash ON insights(pattern_hash);

-- Log de auditoria LGPD Art. 15/16 — evidência de exclusão de dados biométricos
CREATE TABLE clock_offboard_log (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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

CREATE INDEX idx_clock_offboard_cpf ON clock_offboard_log(cpf, timestamp);

CREATE TABLE clock_operation_log (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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

CREATE INDEX idx_clock_op_log_cpf ON clock_operation_log(cpf, timestamp);
CREATE INDEX idx_clock_op_log_operation ON clock_operation_log(operation, timestamp);

CREATE TABLE nfce_index (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id    TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  chave         TEXT NOT NULL,
  n_nf          INTEGER,
  dh_emi        TEXT NOT NULL,
  v_nf          DOUBLE PRECISION NOT NULL,
  day_folder    TEXT NOT NULL,
  month_year    TEXT NOT NULL,
  products_text TEXT NOT NULL DEFAULT '',
  danfe_json    TEXT NOT NULL DEFAULT '{}',
  indexed_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_nfce_machine_chave ON nfce_index(machine_id, chave);
CREATE INDEX idx_nfce_dh_emi ON nfce_index(machine_id, dh_emi);

CREATE TABLE nfce_indexed_days (
  machine_id    TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  day_key       TEXT NOT NULL,
  record_count  INTEGER NOT NULL DEFAULT 0,
  indexed_at    TEXT NOT NULL,
  PRIMARY KEY (machine_id, day_key)
);

CREATE TABLE nfce_auto_email_log (
  chave         TEXT PRIMARY KEY,
  machine_id    TEXT NOT NULL,
  email_to      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  created_at    TEXT NOT NULL,
  sent_at       TEXT
);

CREATE TABLE dr_backups (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  backed_at    TEXT NOT NULL,
  status       TEXT NOT NULL,
  storage_gb   DOUBLE PRECISION,
  duration_min INTEGER,
  error_msg    TEXT
);

CREATE INDEX idx_dr_backups_machine ON dr_backups(machine_id, backed_at DESC);

CREATE TABLE watchlist_keywords (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  keyword    TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE activity_log (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id    TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  window_title  TEXT NOT NULL DEFAULT '',
  process_name  TEXT NOT NULL DEFAULT '',
  captured_at   TEXT NOT NULL
);

CREATE INDEX idx_activity_log_machine_ts ON activity_log(machine_id, captured_at);
CREATE INDEX idx_activity_log_captured_at ON activity_log(captured_at);

CREATE TABLE watchlist_matches (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activity_log_id      INTEGER NOT NULL REFERENCES activity_log(id) ON DELETE CASCADE,
  keyword              TEXT NOT NULL,
  screenshot_blob_path TEXT,
  matched_at           TEXT NOT NULL
);

CREATE INDEX idx_watchlist_matches_log ON watchlist_matches(activity_log_id);

CREATE TABLE live_sessions (
  id         TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  mode       TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  recorded   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_live_sessions_machine ON live_sessions(machine_id, started_at);

-- Registro permanente de Ref1 já utilizados — garante que nenhum número seja reutilizado após remoção
CREATE TABLE ref1_registry (
  ref1        INTEGER PRIMARY KEY,
  cpf         TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  assigned_at TEXT NOT NULL
);

-- ── Módulo Relatório ──────────────────────────────────────────────────────
CREATE TABLE report_topics (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_name          TEXT NOT NULL,
  description         TEXT NOT NULL,
  severity            TEXT NOT NULL CHECK (severity IN ('baixa','media','alta','critica')),
  machine_mention     TEXT,
  is_critical_machine INTEGER DEFAULT 0,
  photo_path          TEXT,
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL DEFAULT 'TI'
);

CREATE TABLE report_topics_history (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  original_topic_id   INTEGER,
  store_name          TEXT NOT NULL,
  description         TEXT NOT NULL,
  severity            TEXT NOT NULL,
  machine_mention     TEXT,
  is_critical_machine INTEGER DEFAULT 0,
  photo_path          TEXT,
  created_at          TEXT NOT NULL,
  resolved_at         TEXT NOT NULL
);

CREATE TABLE freshdesk_cache (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   INTEGER UNIQUE NOT NULL,
  store_name  TEXT,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  priority    TEXT,
  created_at  TEXT,
  resolved_at TEXT,
  cached_at   TEXT NOT NULL
);

CREATE TABLE report_runs (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  pdf_path            TEXT,
  score_operational   INTEGER
);

CREATE TABLE report_feedback (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_run_id INTEGER,
  store_name    TEXT NOT NULL,
  month         TEXT NOT NULL,
  feedback_text TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Blocklist de máquinas excluídas — impede re-registro automático pelo agente
CREATE TABLE deleted_machines (
  id         TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);

-- ── Métricas horárias (24 leituras/dia por máquina) ───────────────────────
CREATE TABLE machine_metrics_hourly (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  snapshot_ts INTEGER NOT NULL,
  hour_of_day INTEGER NOT NULL,
  hour_weight INTEGER NOT NULL,
  cpu_pct     DOUBLE PRECISION DEFAULT 0,
  ram_pct     DOUBLE PRECISION DEFAULT 0,
  disk_pct    DOUBLE PRECISION DEFAULT 0,
  cpu_temp_c  DOUBLE PRECISION DEFAULT -1,
  created_at  TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE INDEX idx_metrics_hourly_machine_ts ON machine_metrics_hourly(machine_id, snapshot_ts);

-- ── Eventos de queda offline ───────────────────────────────────────────────
CREATE TABLE machine_offline_events (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  offline_at   TEXT NOT NULL,
  online_at    TEXT NOT NULL,
  duration_min DOUBLE PRECISION NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE INDEX idx_offline_events_machine ON machine_offline_events(machine_id, offline_at);

-- ── Leituras horárias perdidas ────────────────────────────────────────────
CREATE TABLE reading_miss_events (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id     TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  expected_hour  INTEGER NOT NULL,
  machine_status TEXT NOT NULL,
  agent_version  TEXT,
  last_heartbeat INTEGER,
  diagnosis      TEXT,
  created_at     TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE INDEX idx_reading_miss_machine ON reading_miss_events(machine_id, expected_hour);
CREATE INDEX idx_reading_miss_hour ON reading_miss_events(expected_hour);

-- ── Cache Zamak / N-able N-sight ──────────────────────────────────────────
CREATE TABLE zamak_device_cache (
  device_id          TEXT PRIMARY KEY,
  site_id            TEXT NOT NULL,
  site_name          TEXT,
  store_name         TEXT,
  device_name        TEXT NOT NULL,
  device_type        TEXT,
  status             TEXT,
  os_type            TEXT,
  ip_address         TEXT,
  has_web_protection INTEGER DEFAULT 0,
  patch_critical     INTEGER DEFAULT 0,
  patch_high         INTEGER DEFAULT 0,
  patch_medium       INTEGER DEFAULT 0,
  patch_total        INTEGER DEFAULT 0,
  threats_active     INTEGER DEFAULT 0,
  failing_checks     INTEGER DEFAULT 0,
  dm_machine_id      TEXT,
  dm_hostname        TEXT,
  cached_at          TEXT NOT NULL
);

CREATE TABLE zamak_threats (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id   TEXT NOT NULL,
  device_name TEXT NOT NULL,
  store_name  TEXT,
  threat_name TEXT,
  category    TEXT,
  last_status TEXT,
  cached_at   TEXT NOT NULL
);

CREATE TABLE zamak_discrepancies (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type            TEXT NOT NULL,
  device_name     TEXT NOT NULL,
  store_name      TEXT,
  zamak_device_id TEXT,
  dm_machine_id   TEXT,
  detail          TEXT,
  detected_at     TEXT NOT NULL
);

CREATE TABLE zamak_performance (
  device_id     TEXT PRIMARY KEY,
  device_name   TEXT NOT NULL,
  store_name    TEXT,
  cpu_avg       DOUBLE PRECISION,
  cpu_peak      DOUBLE PRECISION,
  ram_total_mb  DOUBLE PRECISION,
  ram_avail_avg DOUBLE PRECISION,
  disk_time_avg DOUBLE PRECISION,
  cached_at     TEXT NOT NULL
);

CREATE TABLE zamak_outages (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outage_id         TEXT UNIQUE,
  device_id         TEXT NOT NULL,
  device_name       TEXT NOT NULL,
  store_name        TEXT,
  reason            TEXT,
  state             TEXT,
  utc_start         TEXT,
  utc_end           TEXT,
  duration_min      DOUBLE PRECISION,
  check_description TEXT,
  cached_at         TEXT NOT NULL
);

CREATE TABLE ncr_monitor_emails (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id         TEXT UNIQUE NOT NULL,
  received_at        TEXT NOT NULL,
  order_ref          TEXT,
  enterprise_unit_id TEXT,
  store_name         TEXT,
  boh_hostname       TEXT,
  machine_id         TEXT,
  total_value        DOUBLE PRECISION,
  date_brt           TEXT,
  products_json      TEXT,
  command_id         TEXT,
  retry_count        INTEGER DEFAULT 0,
  next_retry_at      TEXT,
  danfe_found        INTEGER,
  danfe_chave        TEXT,
  xml_b64            TEXT,
  notified_at        TEXT,
  created_at         TEXT DEFAULT (now() AT TIME ZONE 'utc')::text,
  lead_minutes       INTEGER DEFAULT 0
);

-- ── Monitoramento de serviços NCR Voyix (BOH) ─────────────────────────────
CREATE TABLE service_status (
  machine_id      TEXT NOT NULL,
  service_name    TEXT NOT NULL,
  status          TEXT NOT NULL,
  last_restart_at TEXT,
  last_restart_ok INTEGER,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (machine_id, service_name)
);

-- ── Ponto Remoto (REP-P/REP-A) ────────────────────────────────────────────
CREATE TABLE remote_employees (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cpf           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  store         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE remote_sessions (
  token_hash  TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES remote_employees(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX idx_remote_sessions_employee ON remote_sessions(employee_id);

-- remote_time_entries é append-only por design — ver comentário na seção de
-- funções de db.js. corrects_id referencia o registro original quando a
-- linha é uma correção administrativa, nunca uma edição em lugar.
CREATE TABLE remote_time_entries (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id       INTEGER NOT NULL REFERENCES remote_employees(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('in','out')),
  server_ts         TEXT NOT NULL,
  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION,
  accuracy          DOUBLE PRECISION,
  within_geofence   INTEGER,
  corrects_id       INTEGER REFERENCES remote_time_entries(id),
  correction_reason TEXT,
  created_by        TEXT NOT NULL DEFAULT 'employee',
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_remote_time_entries_employee ON remote_time_entries(employee_id, server_ts);

-- Down Migration

DROP TABLE IF EXISTS remote_time_entries;
DROP TABLE IF EXISTS remote_sessions;
DROP TABLE IF EXISTS remote_employees;
DROP TABLE IF EXISTS service_status;
DROP TABLE IF EXISTS ncr_monitor_emails;
DROP TABLE IF EXISTS zamak_outages;
DROP TABLE IF EXISTS zamak_performance;
DROP TABLE IF EXISTS zamak_discrepancies;
DROP TABLE IF EXISTS zamak_threats;
DROP TABLE IF EXISTS zamak_device_cache;
DROP TABLE IF EXISTS reading_miss_events;
DROP TABLE IF EXISTS machine_offline_events;
DROP TABLE IF EXISTS machine_metrics_hourly;
DROP TABLE IF EXISTS deleted_machines;
DROP TABLE IF EXISTS report_feedback;
DROP TABLE IF EXISTS report_runs;
DROP TABLE IF EXISTS freshdesk_cache;
DROP TABLE IF EXISTS report_topics_history;
DROP TABLE IF EXISTS report_topics;
DROP TABLE IF EXISTS ref1_registry;
DROP TABLE IF EXISTS live_sessions;
DROP TABLE IF EXISTS watchlist_matches;
DROP TABLE IF EXISTS activity_log;
DROP TABLE IF EXISTS watchlist_keywords;
DROP TABLE IF EXISTS dr_backups;
DROP TABLE IF EXISTS nfce_auto_email_log;
DROP TABLE IF EXISTS nfce_indexed_days;
DROP TABLE IF EXISTS nfce_index;
DROP TABLE IF EXISTS clock_operation_log;
DROP TABLE IF EXISTS clock_offboard_log;
DROP TABLE IF EXISTS insights;
DROP TABLE IF EXISTS win_events;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS commands;
DROP TABLE IF EXISTS metrics;
DROP TABLE IF EXISTS machines;
