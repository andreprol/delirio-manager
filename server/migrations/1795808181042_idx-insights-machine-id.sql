-- Up Migration
--
-- insights.machine_id era a UNICA coluna FK-para-machines entre as 10
-- tabelas FK deste schema sem indice (as outras 9 ja tem) -- achado na
-- investigacao ao vivo do incidente de re-key de 27/11/2026 (ver
-- docs/superpowers/plans/2026-11-27-registermachine-rekey-fix.md, Task 5).
--
-- Sem CONCURRENTLY de proposito: `insights` tem 13.579 linhas / ~10MB
-- (medido ao vivo na mesma investigacao) -- um CREATE INDEX plain leva
-- milissegundos aqui, e node-pg-migrate roda todas as migracoes pendentes
-- dentro de uma unica transacao por padrao (singleTransaction, sem config
-- `.pgmrc`/flag `--no-transaction` neste repo que mude isso -- confirmado
-- lendo server/package.json e as migracoes existentes antes desta).
-- CREATE INDEX CONCURRENTLY nao pode rodar dentro de uma transacao, ia
-- falhar a migracao inteira. Isso e diferente de `activity_log`/`nfce_index`
-- (23GB/7,5GB) -- qualquer indice futuro nessas duas PRECISA de
-- CONCURRENTLY + rodar fora do `migrate:up` padrao (ver Global Constraints
-- do mesmo plano).
CREATE INDEX idx_insights_machine_id ON insights (machine_id);

-- Down Migration

DROP INDEX IF EXISTS idx_insights_machine_id;
