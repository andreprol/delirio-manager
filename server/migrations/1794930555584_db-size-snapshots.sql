-- Up Migration
--
-- db_size_snapshots: historico diario do tamanho de cada tabela de usuario,
-- pra detectar crescimento anormal cedo (achado real que motivou isto:
-- ncr_monitor_emails.xml_b64 era write-only e crescia pra sempre sem
-- nenhum alerta, so descoberto manualmente apos a migracao SQLite->Postgres).
CREATE TABLE db_size_snapshots (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name   TEXT NOT NULL,
  bytes_total  BIGINT NOT NULL,
  row_count    BIGINT NOT NULL,
  snapshot_at  TEXT NOT NULL
);

CREATE INDEX idx_db_size_snapshots_table_time ON db_size_snapshots(table_name, snapshot_at);

-- Down Migration

DROP TABLE IF EXISTS db_size_snapshots;
