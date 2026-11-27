-- Up Migration
--
-- machine_rekey_queue: fila do re-key assíncrono de registerMachine (Task 4
-- do plano 2026-11-27-registermachine-rekey-fix). Motivação: o re-key
-- síncrono antigo (UPDATE machines SET id=... dentro da mesma transação que
-- já segura pg_advisory_xact_lock(hashtext(upper(hostname)))) disparava
-- ON UPDATE CASCADE atomicamente nas 10 tabelas com FK -- incluindo
-- activity_log (59M linhas/23GB) e nfce_index (3,97M linhas/7,5GB) -- e
-- travava essa transação (e o lock) por 1 a 71+ minutos em produção
-- (27/11/2026), saturando o pool e derrubando /api/healthz.
--
-- Fase A (dentro de registerMachine, db-pg.js:_rekeyAndMergeMachine) só
-- enfileira aqui; Fase B (server/services/machineRekeyWorker.js, em 2º
-- plano) pré-processa as tabelas grandes em lotes e só então troca
-- machines.id (cascade residual, rápido).
CREATE TABLE machine_rekey_queue (
  id            SERIAL PRIMARY KEY,
  old_id        UUID NOT NULL,
  new_id        UUID NOT NULL,
  hostname      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

-- Garantia de idempotência: no máximo 1 job ATIVO (pending/processing) por
-- hostname -- uma 2ª chamada de registerMachine pro mesmo hostname antes do
-- worker processar o job antigo só atualiza o new_id dele (ver Fase A),
-- nunca cria um 2º job concorrente.
CREATE UNIQUE INDEX idx_rekey_queue_hostname_active ON machine_rekey_queue (hostname)
  WHERE status IN ('pending', 'processing');

-- getMachineByToken (db-pg.js) usa isto pra resolver, via LEFT JOIN, o
-- pending_rekey_new_id de uma máquina ainda não re-keyed -- índice evita
-- scan sequencial da fila em toda chamada autenticada do agente.
CREATE INDEX idx_rekey_queue_old_id_active ON machine_rekey_queue (old_id)
  WHERE status IN ('pending', 'processing');

-- Down Migration
DROP TABLE IF EXISTS machine_rekey_queue;
