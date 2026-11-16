-- Up Migration
--
-- Achado real na Fase 3 (ETL, ver memória do projeto
-- project_delirio_manager_incidente_sqlite_15_11.md): `ref1_registry.ref1`
-- foi traduzido como INTEGER (32 bits) na migration inicial, fiel ao
-- `INTEGER PRIMARY KEY` do SQLite -- mas SQLite não limita INTEGER a 32
-- bits (é alias de rowid, até 64 bits), e o dado real tem pelo menos um
-- ref1 = 2897983393 (passa do limite de INTEGER do Postgres, 2147483647).
-- Checado programaticamente: das 87 colunas INTEGER do schema, só esta
-- tem valor real fora do range -- nenhuma outra precisa do mesmo fix.

ALTER TABLE ref1_registry ALTER COLUMN ref1 TYPE BIGINT;

-- Down Migration

ALTER TABLE ref1_registry ALTER COLUMN ref1 TYPE INTEGER;
