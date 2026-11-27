// server/services/machineRekeyWorker.js
// Fase B do re-key assíncrono de registerMachine (Task 4 do plano
// 2026-11-27-registermachine-rekey-fix). Ver comentário de
// `_rekeyAndMergeMachine` (Fase A) em db-pg.js pro contexto completo do
// incidente real (27/11/2026): o `UPDATE machines SET id=...` dispara
// ON UPDATE CASCADE atomicamente nas 10 tabelas com FK -- incluindo
// activity_log (59M linhas/23GB) e nfce_index (3,97M linhas/7,5GB) -- e
// travava a transação/advisory lock de registerMachine por 1 a 71+ minutos
// em produção. Este worker, em 2º plano, roda fora do request HTTP do
// agente e fora do advisory lock compartilhado entre hostnames.
//
// 🔴 Achado rodando contra Postgres de dev de verdade (não dava pra saber só
// lendo o código): NÃO é possível pré-processar `activity_log`/`nfce_index`
// em lotes ANTES do `UPDATE machines SET id=...` -- as duas têm FK ATIVA pra
// `machines(id)` (`ON UPDATE CASCADE ON DELETE CASCADE`), e o Postgres
// recusa `UPDATE activity_log SET machine_id=$new WHERE ...` enquanto `$new`
// ainda não existe como PK em `machines` (viola a própria FK que a tabela
// tem). Só `events`/`commands` (tabelas manuais, SEM FK -- ver
// `MACHINE_CHILD_TABLES_NO_FK`) podem ser pré-processadas assim. Pra
// `activity_log`/`nfce_index`, o cascade do `UPDATE machines` continua
// processando o histórico INTEIRO da máquina nessas 2 tabelas (não dá pra
// evitar sem reescrever a FK pra DEFERRABLE ou usar uma linha placeholder --
// fora de escopo aqui). Ainda é uma melhoria real: essa transação roda
// isolada, em 2º plano, protegida por `statement_timeout=180000`, sem
// segurar o advisory lock compartilhado nem bloquear o request HTTP do
// agente nem o heartbeat de outras máquinas -- só não é mais "rápida
// independente do volume" pra essas 2 tabelas especificamente.
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

// Pré-processamento em lotes (fora de transação, cada lote é seu próprio
// commit implícito) -- só `events`/`commands`: são as únicas 2 tabelas
// grandes SEM FK ativa pra `machines(id)` (ver comentário do topo do
// arquivo pra `activity_log`/`nfce_index`, que não podem passar por aqui).
// Entram na Fase B (não na Fase A) por serem grandes o bastante (2,3GB/
// 3,1GB) pra não fazer um UPDATE de tabela inteira de uma vez.
const PHASE_B_BATCH_TABLES = ['events', 'commands'];

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

// Transação final: troca machines.id (cascade cuida de `events`/`commands`
// só pelo resíduo recente, já pré-processados em lotes acima -- mas de
// `activity_log`/`nfce_index` pelo histórico INTEIRO da máquina, ver
// comentário do topo do arquivo) + dedup de duplicatas + marca o job
// 'done'. Sob o MESMO advisory lock por hostname que a Fase A usa --
// serializa contra qualquer registerMachine concorrente desse hostname que
// ainda não tenha visto o novo machines.id. Pode levar mais que
// milissegundos agora (ainda protegido por statement_timeout=180000), mas
// roda isolada, sem bloquear outros hostnames nem o request HTTP do agente.
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
