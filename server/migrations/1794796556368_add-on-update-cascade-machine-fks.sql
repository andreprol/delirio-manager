-- Up Migration
--
-- Preparação pro port de `registerMachine` (Grupo 7 da Fase 2 -- ver
-- memória do projeto project_delirio_manager_incidente_sqlite_15_11.md).
--
-- `registerMachine` (server/db.js) re-keya o UUID de uma máquina quando o
-- agent reinstala com config.json corrompido/perdido: UPDATE machines SET
-- id=<novo> WHERE id=<antigo>. No SQLite original isso só funciona porque
-- o código envolve essa transação com `pragma('foreign_keys = OFF')` --
-- sem isso, mudar machines.id violaria toda FK que aponta pra ele.
--
-- Postgres não tem um jeito de desligar a checagem de FK globalmente numa
-- sessão (nem precisa): o equivalente correto é declarar a FK com
-- ON UPDATE CASCADE, que propaga a mudança de PK pros filhos automaticamente,
-- numa única operação atômica, sem o risco de "esquecer" uma tabela da lista
-- manual.
--
-- Achado ao escrever esta migração: `insights` TEM a mesma FK pra `machines`
-- (ON DELETE CASCADE) desde o schema original, mas NÃO estava na lista
-- `_MACHINE_CHILD_TABLES` de server/db.js que o re-key manual usa -- bug
-- latente no SQLite original: insights de uma máquina re-keyed ficam
-- órfãos (machine_id aponta pro UUID antigo, que deixou de existir, e o
-- SQLite não valida isso retroativamente ao religar `foreign_keys = ON`).
-- Corrigido aqui de graça: `insights` entra nesta lista igual às outras.

ALTER TABLE activity_log
  DROP CONSTRAINT activity_log_machine_id_fkey,
  ADD CONSTRAINT activity_log_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE dr_backups
  DROP CONSTRAINT dr_backups_machine_id_fkey,
  ADD CONSTRAINT dr_backups_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE insights
  DROP CONSTRAINT insights_machine_id_fkey,
  ADD CONSTRAINT insights_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE live_sessions
  DROP CONSTRAINT live_sessions_machine_id_fkey,
  ADD CONSTRAINT live_sessions_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE machine_metrics_hourly
  DROP CONSTRAINT machine_metrics_hourly_machine_id_fkey,
  ADD CONSTRAINT machine_metrics_hourly_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE machine_offline_events
  DROP CONSTRAINT machine_offline_events_machine_id_fkey,
  ADD CONSTRAINT machine_offline_events_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE nfce_index
  DROP CONSTRAINT nfce_index_machine_id_fkey,
  ADD CONSTRAINT nfce_index_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE nfce_indexed_days
  DROP CONSTRAINT nfce_indexed_days_machine_id_fkey,
  ADD CONSTRAINT nfce_indexed_days_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE reading_miss_events
  DROP CONSTRAINT reading_miss_events_machine_id_fkey,
  ADD CONSTRAINT reading_miss_events_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE win_events
  DROP CONSTRAINT win_events_machine_id_fkey,
  ADD CONSTRAINT win_events_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- Down Migration

ALTER TABLE activity_log
  DROP CONSTRAINT activity_log_machine_id_fkey,
  ADD CONSTRAINT activity_log_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE;

ALTER TABLE dr_backups
  DROP CONSTRAINT dr_backups_machine_id_fkey,
  ADD CONSTRAINT dr_backups_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE;

ALTER TABLE insights
  DROP CONSTRAINT insights_machine_id_fkey,
  ADD CONSTRAINT insights_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE;

ALTER TABLE live_sessions
  DROP CONSTRAINT live_sessions_machine_id_fkey,
  ADD CONSTRAINT live_sessions_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE;

ALTER TABLE machine_metrics_hourly
  DROP CONSTRAINT machine_metrics_hourly_machine_id_fkey,
  ADD CONSTRAINT machine_metrics_hourly_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE;

ALTER TABLE machine_offline_events
  DROP CONSTRAINT machine_offline_events_machine_id_fkey,
  ADD CONSTRAINT machine_offline_events_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE;

ALTER TABLE nfce_index
  DROP CONSTRAINT nfce_index_machine_id_fkey,
  ADD CONSTRAINT nfce_index_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE;

ALTER TABLE nfce_indexed_days
  DROP CONSTRAINT nfce_indexed_days_machine_id_fkey,
  ADD CONSTRAINT nfce_indexed_days_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE;

ALTER TABLE reading_miss_events
  DROP CONSTRAINT reading_miss_events_machine_id_fkey,
  ADD CONSTRAINT reading_miss_events_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE;

ALTER TABLE win_events
  DROP CONSTRAINT win_events_machine_id_fkey,
  ADD CONSTRAINT win_events_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE;
