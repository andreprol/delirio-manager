// server/services/machineRekeyWorker.js
// Fase B do re-key assíncrono de registerMachine (Task 4 do plano
// 2026-11-27-registermachine-rekey-fix). Ver comentário de
// `_rekeyAndMergeMachine` (Fase A) em db-pg.js pro contexto completo do
// incidente real (27/11/2026): o `UPDATE machines SET id=...` dispara
// ON UPDATE CASCADE atomicamente nas 10 tabelas com FK -- incluindo
// activity_log (59M linhas/23GB) e nfce_index (3,97M linhas/7,5GB) -- e
// travava a transação/advisory lock de registerMachine por 1 a 71+ minutos
// em produção. Este worker, em 2º plano, pré-processa as tabelas grandes em
// lotes ANTES de trocar machines.id, deixando pro cascade só o resíduo
// recente (rápido mesmo em tabelas de dezenas de GB).
//
// Processa 1 job por ciclo (nunca em paralelo -- jobs do MESMO hostname nunca
// coexistem, por causa da UNIQUE parcial em machine_rekey_queue, mas jobs de
// hostnames diferentes podem; sequencial é suficiente e mais simples, sem
// risco de saturar o pool com vários pré-processamentos em lote ao mesmo
// tempo). Mesmo padrão de scheduler self-reagendável + leader gate de
// rhHealthMonitor.js/dbSizeMonitor.js.
'use strict';

const db = require('../db-pg');
const logger = require('./logger');
const leaderElection = require('./leaderElection');

const POLL_INTERVAL_MS = 10 * 1000; // 10s -- correção em 2º plano, não SLA de latência curta

// Ordem de pré-processamento em lotes (fora de transação, cada lote é seu
// próprio commit implícito) -- maior primeiro é arbitrário, mantém a ordem
// da tabela de tamanhos do brief. `events`/`commands` entram aqui (Fase B),
// NÃO na Fase A.
const PHASE_B_BATCH_TABLES = ['activity_log', 'nfce_index', 'events', 'commands'];

const state = {
  timer: null,
  stopped: true,
};

// Pega o job pending mais antigo e marca como 'processing'. O
// `AND status='pending'` no UPDATE é defesa barata contra double-pick caso
// dois workers rodem ao mesmo tempo -- não deveria acontecer com isLeader(),
// mas custa nada garantir.
async function _claimNextJob() {
  const pool = db.getPool();
  const { rows } = await pool.query(
    `SELECT id, old_id, new_id, hostname FROM machine_rekey_queue
     WHERE status='pending' ORDER BY created_at ASC LIMIT 1`
  );
  const job = rows[0];
  if (!job) return null;

  const { rowCount } = await pool.query(
    `UPDATE machine_rekey_queue SET status='processing' WHERE id=$1 AND status='pending'`,
    [job.id]
  );
  if (rowCount === 0) return null; // outro worker pegou primeiro
  return job;
}

// Transação curta final: troca machines.id (cascade só do resíduo recente,
// já que os lotes acima pré-processaram o grosso) + dedup de duplicatas +
// marca o job 'done'. Sob o MESMO advisory lock por hostname que a Fase A
// usa -- serializa contra qualquer registerMachine concorrente desse
// hostname que ainda não tenha visto o novo machines.id.
async function _finalizeRekey({ id: jobId, old_id: oldId, new_id: newId, hostname }) {
  await db.withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext(upper($1)))', [hostname]);

    // Troca a PK -- UPDATE na MESMA linha física, não recria a linha: os
    // outros campos (hostname, agent_version, status='online', ...) já
    // setados pela Fase A continuam lá, não precisa repetir o UPDATE deles.
    await client.query('UPDATE machines SET id=$1 WHERE id=$2', [newId, oldId]);

    // Duplicatas: outros registros com o mesmo hostname, sobra de
    // reinstalações anteriores (mesma lógica do _rekeyAndMergeMachine
    // síncrono original, pré-Task 4).
    const { rows: dupes } = await client.query(
      `SELECT id FROM machines WHERE UPPER(hostname) = UPPER($1) AND id != $2`,
      [hostname, newId]
    );
    for (const { id: dupId } of dupes) {
      for (const t of db.MACHINE_CHILD_TABLES_NO_FK) {
        await client.query(`DELETE FROM ${t} WHERE machine_id=$1`, [dupId]);
      }
      await client.query('DELETE FROM machines WHERE id=$1', [dupId]); // cascade cuida das 10 tabelas com FK
    }

    await client.query(
      `UPDATE machine_rekey_queue SET status='done', completed_at=now() WHERE id=$1`,
      [jobId]
    );
  });
}

// Processa 1 ciclo: pega o job pending mais antigo (se houver), pré-processa
// em lotes (fora de transação) e finaliza (transação curta). Exportada pra
// chamada direta em teste (não só via scheduleNext/setTimeout).
async function runCycleOnce() {
  if (!leaderElection.isLeader()) return { processed: false, reason: 'not-leader' };

  const job = await _claimNextJob();
  if (!job) return { processed: false, reason: 'no-pending-job' };

  try {
    for (const table of PHASE_B_BATCH_TABLES) {
      await db.updateMachineIdInBatches(table, job.old_id, job.new_id);
    }
    await _finalizeRekey(job);
    logger.info('[MachineRekeyWorker] job concluido', {
      hostname: job.hostname, oldId: job.old_id, newId: job.new_id,
    });
    return { processed: true, job };
  } catch (err) {
    // Volta pra 'pending' -- deixa o próximo ciclo tentar de novo, em vez de
    // ficar presa em 'processing' pra sempre (o que bloquearia o hostname
    // via UNIQUE parcial, inclusive pra novas chamadas de registerMachine).
    logger.error('[MachineRekeyWorker] erro ao processar job, devolvendo pra pending', {
      error: err.message, hostname: job.hostname, jobId: job.id,
    });
    await db.getPool()
      .query(`UPDATE machine_rekey_queue SET status='pending' WHERE id=$1`, [job.id])
      .catch(e => logger.error('[MachineRekeyWorker] falha ao reverter job pra pending', { error: e.message }));
    throw err;
  }
}

function scheduleNext() {
  if (state.stopped) return; // stop() chamado enquanto o ciclo anterior estava em voo
  state.timer = setTimeout(() => {
    runCycleOnce()
      .catch(e => logger.error('[MachineRekeyWorker] ciclo erro', { error: e.message }))
      .finally(() => scheduleNext());
  }, POLL_INTERVAL_MS);
  state.timer.unref();
}

function start() {
  state.stopped = false;
  runCycleOnce()
    .catch(e => logger.error('[MachineRekeyWorker] ciclo inicial erro', { error: e.message }))
    .finally(() => scheduleNext());
}

function stop() {
  state.stopped = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

module.exports = { start, stop, runCycleOnce };
