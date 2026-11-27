-- Up Migration
--
-- Fix-wave pós-revisão (Opus) da Task 4 do plano
-- 2026-11-27-registermachine-rekey-fix: suporta o claim atômico (FOR UPDATE
-- SKIP LOCKED), a recuperação de jobs presos em 'processing' (crash/SIGTERM/
-- troca de líder no meio) e a UNIQUE case-insensitive por hostname --
-- ver server/services/machineRekeyWorker.js (_claimNextJob/_reclaimStuckJobs)
-- e server/db-pg.js (_rekeyAndMergeMachine) pro uso de cada coluna/índice.
--
-- claimed_at: setado por _claimNextJob() quando o job vira 'processing';
-- _reclaimStuckJobs() usa isso pra detectar jobs presos (> 5min) e devolver
-- pra 'pending' (ou 'failed' se attempts já esgotou).
-- attempts: incrementado tanto no catch de runCycleOnce() (erro imediato)
-- quanto em _reclaimStuckJobs() (job travado) -- MAX_ATTEMPTS=5 antes de
-- desistir ('failed').
ALTER TABLE machine_rekey_queue
  ADD COLUMN claimed_at TIMESTAMPTZ,
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- Nome confirmado por convenção padrão do Postgres pra CHECK de coluna sem
-- nome explícito (<tabela>_<coluna>_check) -- a migração original
-- (1795811915722_machine-rekey-queue.sql) declara `status ... CHECK (status
-- IN (...))` inline, sem CONSTRAINT nomeada. IF EXISTS por segurança: se o
-- nome real divergir (ex: Postgres de versão/config diferente), o DROP é
-- noop e o ADD CONSTRAINT abaixo falha alto (migração aborta, visível),
-- em vez de deixar duas CHECK conflitantes silenciosamente.
ALTER TABLE machine_rekey_queue
  DROP CONSTRAINT IF EXISTS machine_rekey_queue_status_check;
ALTER TABLE machine_rekey_queue
  ADD CONSTRAINT machine_rekey_queue_status_check
  CHECK (status IN ('pending', 'processing', 'done', 'failed'));

-- Troca pra UPPER(hostname): o resto do sistema trata hostname como
-- case-insensitive (getMachineByHostname, dedup de duplicatas em
-- _finalizeRekey) -- a UNIQUE antiga (case-sensitive) deixava passar 2 jobs
-- ativos pro mesmo hostname em case diferente ("Loja-1" vs "LOJA-1").
DROP INDEX IF EXISTS idx_rekey_queue_hostname_active;
CREATE UNIQUE INDEX idx_rekey_queue_hostname_active ON machine_rekey_queue (UPPER(hostname))
  WHERE status IN ('pending', 'processing');

-- Down Migration
DROP INDEX IF EXISTS idx_rekey_queue_hostname_active;
CREATE UNIQUE INDEX idx_rekey_queue_hostname_active ON machine_rekey_queue (hostname)
  WHERE status IN ('pending', 'processing');

ALTER TABLE machine_rekey_queue
  DROP CONSTRAINT IF EXISTS machine_rekey_queue_status_check;
ALTER TABLE machine_rekey_queue
  ADD CONSTRAINT machine_rekey_queue_status_check
  CHECK (status IN ('pending', 'processing', 'done'));

ALTER TABLE machine_rekey_queue
  DROP COLUMN claimed_at,
  DROP COLUMN attempts;
