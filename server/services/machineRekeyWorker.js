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
// 🔴 Fix-wave pós-revisão (27/11/2026, ver seção "Revisão pós-implementação"
// do plano): a 1ª versão deste arquivo trocava a PK da linha existente
// (`UPDATE machines SET id=$new WHERE id=$old`) dentro de uma transação que
// segurava o advisory lock durante TODO o cascade residual de
// `activity_log`/`nfce_index` -- um revisor independente (Opus) achou que
// isso bloqueava qualquer `UPDATE machines SET ... WHERE id=$old`
// concorrente do MESMO agente (heartbeat -- `setMachineStatus`/
// `updateMachine`, routes/agent.js), reproduzindo o incidente original de
// dentro do worker. Causa raiz: só é possível pré-processar em lote
// tabelas SEM FK ativa pra `machines(id)` -- as 10 com FK exigem que o
// `new_id` já exista em `machines` ANTES de qualquer UPDATE filho (senão
// viola a própria FK).
//
// Novo desenho (clone-and-swap): clona a linha de `old_id` pra `new_id`
// (token placeholder, `db.cloneMachineRow`) ANTES de tocar qualquer tabela
// filha -- com `new_id` já existindo em `machines`, as 15 tabelas filhas
// (10 com FK + 5 sem FK) podem ser pré-processadas em lote, fora de
// transação, sem nenhum cascade disparar (cascade só dispara quando a PK
// PAI muda, e ela não muda mais -- `new_id` nasce direto como uma linha
// nova). Só depois, numa transação curta sob o advisory lock, sincroniza os
// campos mutáveis mais recentes (captura heartbeats que escreveram na linha
// antiga depois do clone), migra o resíduo recente (escrito entre o lote e
// agora) e APAGA a linha antiga (cujo cascade, nesse ponto, já está vazio
// ou quase vazio -- rápido mesmo com `activity_log` em 23GB).
//
// Processa 1 job por ciclo (nunca em paralelo -- jobs do MESMO hostname nunca
// coexistem, por causa da UNIQUE parcial em machine_rekey_queue, mas jobs de
// hostnames diferentes podem; sequencial é suficiente e mais simples, sem
// risco de saturar o pool com vários pré-processamentos em lote ao mesmo
// tempo). Mesmo padrão de scheduler self-reagendável + leader gate de
// rhHealthMonitor.js/dbSizeMonitor.js.
'use strict';

const crypto = require('crypto');
const db = require('../db-pg');
const logger = require('./logger');
const leaderElection = require('./leaderElection');
const { sendAlert } = require('./resendAlert');

const POLL_INTERVAL_MS = 10 * 1000; // 10s -- correção em 2º plano, não SLA de latência curta
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5min -- job 'processing' mais velho que isso foi abandonado (crash/SIGTERM/troca de líder no meio)
const MAX_ATTEMPTS = 5; // depois disso, _reclaimStuckJobs() marca 'failed' em vez de devolver pra 'pending' -- para de martelar, fica pra investigação manual

// Mesma janela de cooldown usada pelos outros monitores desta branch
// (rhHealthMonitor.js/longTransactionMonitor.js) -- evita espamar um e-mail
// a cada ciclo (10s) enquanto o mesmo job continuar 'failed'.
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

// As 15 tabelas filhas de `machines` -- as 10 com FK ON UPDATE/DELETE CASCADE
// (ver migração add-on-update-cascade-machine-fks.sql) MAIS as 5 sem FK
// (db.MACHINE_CHILD_TABLES_NO_FK). Nenhuma fica de fora: com `new_id` já
// clonado em `machines` (ver cloneMachineRow acima), migrar qualquer uma em
// lote não dispara cascade nenhum -- só respeita a FK normalmente.
// `events`/`commands` grandes primeiro de propósito (eram as únicas 2 que o
// desenho antigo conseguia pré-processar; mantidas na frente por serem as
// que mais importam pra latência).
const ALL_CHILD_TABLES = [
  'activity_log', 'nfce_index', 'events', 'commands',
  'dr_backups', 'insights', 'live_sessions', 'machine_metrics_hourly',
  'machine_offline_events', 'nfce_indexed_days', 'reading_miss_events', 'win_events',
  'metrics', 'nfce_auto_email_log', 'service_status',
];

// 3 das 15 não têm uma coluna `id` própria (PK composta ou PK em outra
// coluna -- ver comentário de `db.updateMachineIdDirect`) -- usam o UPDATE
// direto (sem lote) em vez de updateMachineIdInBatches. Sempre pequenas,
// nunca `activity_log`/`nfce_index`.
const DIRECT_UPDATE_TABLES = new Set(['nfce_indexed_days', 'nfce_auto_email_log', 'service_status']);

async function _migrateChildTablesInBatches(oldId, newId) {
  for (const table of ALL_CHILD_TABLES) {
    if (DIRECT_UPDATE_TABLES.has(table)) {
      await db.updateMachineIdDirect(table, oldId, newId);
    } else {
      await db.updateMachineIdInBatches(table, oldId, newId);
    }
  }
}

const state = {
  timer: null,
  stopped: true,
};

// Alerta quando um job de re-key esgota MAX_ATTEMPTS e vira 'failed' de
// verdade (revisão final de branch, 27/11/2026, ALTO 1a). Até esta
// fix-wave, isso acontecia em silêncio: `getMachineByToken` só resolvia
// `pending_rekey_new_id` pra status 'pending'/'processing' (ver ALTO 1b),
// então um job 'failed' fazia o agente (que já adotou o new_id desde o 201
// da Fase A) tomar 403 pra sempre em /commands e /service-status -- máquina
// "online" no dashboard, sem receber comando nenhum, sem ninguém saber.
// `.catch()` aqui de propósito: falha ao ENVIAR o alerta nunca pode
// interromper o worker nem mascarar o erro original que levou o job a
// 'failed'.
async function _alertJobFailed(jobId, hostname) {
  await sendAlert({
    source:      'MachineRekeyWorker',
    stage:       'Job de re-key falhou definitivamente',
    detail:      `Job de re-key pra hostname "${hostname}" (id ${jobId}) esgotou ${MAX_ATTEMPTS} tentativas e foi marcado 'failed'. A máquina continua "online" no dashboard mas NÃO recebe comandos (403 silencioso) até alguém investigar manualmente machine_rekey_queue e, se for o caso, resetar o job pra 'pending' (UPDATE machine_rekey_queue SET status='pending', attempts=0 WHERE id=${jobId}).`,
    cooldownKey: `rekey:failed:${hostname}`,
    cooldownMs:  ALERT_COOLDOWN_MS,
  }).catch(e => logger.error('[MachineRekeyWorker] falha ao enviar alerta de job failed', {
    error: e.message, jobId, hostname,
  }));
}

// Reset de jobs presos em 'processing' há mais de STUCK_THRESHOLD_MS --
// crash/SIGTERM/troca de líder no meio de um ciclo deixava, antes desta
// fix-wave, o hostname bloqueado pra sempre (a UNIQUE parcial por hostname
// não permite um 2º job ativo). Incrementa `attempts`; a partir de
// MAX_ATTEMPTS marca 'failed' em vez de 'pending' -- para de ser reclamado
// automaticamente, fica pra investigação manual (não tem CHECK que impeça
// 'failed' de novo virar 'pending' manualmente, se for o caso).
//
// 🔴 RETURNING status, hostname (revisão final de branch, 27/11/2026, ALTO
// 1a): este é um UPDATE em LOTE -- pode afetar várias linhas numa única
// chamada (vários jobs travados ao mesmo tempo). Sem o RETURNING não havia
// como saber quais linhas de fato viraram 'failed' (vs. voltaram
// 'pending') pra alertar sobre elas.
async function _reclaimStuckJobs() {
  const pool = db.getPool();
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();
  const { rows } = await pool.query(
    `UPDATE machine_rekey_queue
     SET status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
         attempts = attempts + 1
     WHERE status='processing' AND claimed_at < $1
     RETURNING id, status, hostname`,
    [cutoff, MAX_ATTEMPTS]
  );
  for (const row of rows) {
    if (row.status === 'failed') {
      await _alertJobFailed(row.id, row.hostname);
    }
  }
}

// Claim atômico via FOR UPDATE SKIP LOCKED -- um único UPDATE já é atômico,
// sem precisar de SELECT+UPDATE separados (o desenho antigo tinha uma
// janela de race aí: achado real do revisor -- uma 2ª chamada de
// registerMachine pro mesmo hostname podia atualizar `new_id` da fila entre
// o SELECT e o UPDATE 'processing', e o worker aplicava o `new_id`
// desatualizado; _finalizeRekey agora relê `new_id` da fila de novo, ver
// abaixo). SKIP LOCKED substitui a checagem de double-pick via rowCount que
// existia antes (não precisa mais -- se outro processo já travou essa
// linha, o subselect simplesmente não a retorna).
//
// `hostnameFilter` existe só pra teste -- em produção nunca é passado (ver
// comentário de runCycleOnce).
async function _claimNextJob(hostnameFilter) {
  const pool = db.getPool();
  const { rows } = await pool.query(
    hostnameFilter
      ? `UPDATE machine_rekey_queue SET status='processing', claimed_at=now()
         WHERE id = (SELECT id FROM machine_rekey_queue WHERE status='pending' AND hostname=$1
                     ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id, old_id, new_id, hostname`
      : `UPDATE machine_rekey_queue SET status='processing', claimed_at=now()
         WHERE id = (SELECT id FROM machine_rekey_queue WHERE status='pending'
                     ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id, old_id, new_id, hostname`,
    hostnameFilter ? [hostnameFilter] : []
  );
  return rows[0] || null;
}

// Copia os campos mutáveis mais recentes da linha antiga pra nova -- captura
// qualquer heartbeat que tenha atualizado a linha antiga depois do clone
// (db.cloneMachineRow, que roda fora desta transação, antes do
// pré-processamento em lote). Lista explícita (não todas as colunas --
// id/token tratados à parte: token real migra agora, placeholder do clone
// nunca é usado pra autenticar; registered_at nunca deveria mudar, por isso
// não está na lista). Extraída de _finalizeRekey só pra caber no limite de
// linhas por função do lint -- mesma transação/client do chamador.
async function _syncMutableFields(client, oldMachine, newId) {
  await client.query(
    `UPDATE machines SET
       token=$1, hostname=$2, display_name=$3, location=$4, subnet=$5,
       ip_interno=$6, mac=$7, critica=$8, agent_version=$9, status=$10,
       last_seen=$11, online_since=$12, wol_status=$13, wol_tested_at=$14,
       motherboard=$15, dr_setup=$16, dr_last_ok=$17, dr_storage_gb=$18,
       dr_version=$19, os_version=$20, last_hourly_at=$21,
       wol_ever_confirmed=$22, last_win_event_id=$23, last_offline_event_id=$24
     WHERE id=$25`,
    [
      oldMachine.token, oldMachine.hostname, oldMachine.display_name, oldMachine.location,
      oldMachine.subnet, oldMachine.ip_interno, oldMachine.mac, oldMachine.critica,
      oldMachine.agent_version, oldMachine.status, oldMachine.last_seen, oldMachine.online_since,
      oldMachine.wol_status, oldMachine.wol_tested_at, oldMachine.motherboard, oldMachine.dr_setup,
      oldMachine.dr_last_ok, oldMachine.dr_storage_gb, oldMachine.dr_version, oldMachine.os_version,
      oldMachine.last_hourly_at, oldMachine.wol_ever_confirmed, oldMachine.last_win_event_id,
      oldMachine.last_offline_event_id, newId,
    ]
  );
}

// Duplicatas: outros registros com o mesmo hostname, sobra de reinstalações
// anteriores (mesma lógica de antes). rowCount check nos DELETE de filhos é
// desnecessário (0 é um resultado normal -- a duplicata pode não ter filho
// algum numa tabela dada); o que importa é o DELETE da própria linha
// duplicada, coberto pelo DELETE de `machines` abaixo (cascade cuida das 10
// tabelas com FK).
//
// 🟡 Limitação conhecida (achado real do revisor, 2ª rodada, não corrigida):
// isso roda DENTRO da transação final de _finalizeRekey, sob o `FOR UPDATE`
// da linha antiga -- se uma duplicata tiver histórico grande em
// activity_log/nfce_index, o DELETE dela (linha 183) dispara o MESMO padrão
// de cascade longo que o CRÍTICO original apontava, ainda que só pra essa
// duplicata, não pra `oldId`/`newId` do re-key principal (que já migraram
// em lote, fora de transação, antes daqui). Duplicatas reais tendem a ser
// pequenas (resíduo de reinstalações falhas, não máquinas com histórico de
// produção completo), mas isso não é garantido pelo código. Fix futuro, se
// necessário: migrar/apagar os filhos de cada duplicata em lote (mesmo
// padrão de updateMachineIdInBatches/deleteInBatches) ANTES desta
// transação, não durante.
async function _removeDuplicateMachines(client, hostname, survivorId) {
  const { rows: dupes } = await client.query(
    `SELECT id FROM machines WHERE UPPER(hostname) = UPPER($1) AND id != $2`,
    [hostname, survivorId]
  );
  for (const { id: dupId } of dupes) {
    for (const t of db.MACHINE_CHILD_TABLES_NO_FK) {
      await client.query(`DELETE FROM ${t} WHERE machine_id=$1`, [dupId]);
    }
    await client.query('DELETE FROM machines WHERE id=$1', [dupId]);
  }
}

// Transação final curta (substitui integralmente a troca de PK do desenho
// antigo): sob o MESMO advisory lock por hostname que a Fase A usa --
// serializa contra qualquer registerMachine concorrente desse hostname.
// Só trava a linha ANTIGA (FOR UPDATE), e só por esta transação curta --
// nunca pelo cascade inteiro, que é o que o CRÍTICO do revisor apontou no
// desenho anterior.
async function _finalizeRekey({ id: jobId, old_id: oldId, new_id: newId, hostname }) {
  await db.withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext(upper($1)))', [hostname]);

    // Relê new_id da fila por defesa (não deveria mais divergir do `newId`
    // capturado no claim: _rekeyAndMergeMachine, db-pg.js, agora só
    // sobrescreve new_id com `AND status='pending'` no próprio UPDATE --
    // uma Fase A concorrente nunca muda new_id depois que o worker já
    // reclamou o job e clonou a linha pra esse id, fechando o achado real
    // do revisor na 2ª rodada: antes, a condição era um `if` em JS sobre um
    // status já lido, não uma guarda no SQL, e podia sobrescrever new_id
    // DEPOIS do clone -- o dedup abaixo apagaria, com cascade, o clone já
    // migrado). Mantido como cinto-e-suspensório, sem custo.
    const { rows: queueRows } = await client.query(
      'SELECT new_id FROM machine_rekey_queue WHERE id=$1', [jobId]
    );
    const effectiveNewId = queueRows[0]?.new_id || newId;

    const { rows: oldRows } = await client.query(
      'SELECT * FROM machines WHERE id=$1 FOR UPDATE', [oldId]
    );
    const oldMachine = oldRows[0];
    if (!oldMachine) {
      // Já foi apagada por outro caminho (dedup de uma chamada concorrente?)
      // -- nada a sincronizar, só limpa a fila.
      await client.query(`UPDATE machine_rekey_queue SET status='done', completed_at=now() WHERE id=$1`, [jobId]);
      return;
    }

    // Resíduo: linhas escritas entre o pré-processamento em lote (fora
    // desta transação) e agora ainda apontam pra oldId -- janela de
    // segundos, UPDATE direto nas 15, sem lote (deve ser pouquíssimas
    // linhas). PRECISA rodar antes do DELETE da linha antiga abaixo --
    // senão o cascade do DELETE apagaria esse resíduo em vez de preservá-lo.
    for (const table of ALL_CHILD_TABLES) {
      await client.query(`UPDATE ${table} SET machine_id=$1 WHERE machine_id=$2`, [effectiveNewId, oldId]);
    }

    // DELETE da linha antiga ANTES de sincronizar os campos mutáveis na
    // nova: `token` é UNIQUE NOT NULL, e `oldMachine.token` (capturado
    // acima) é o token REAL que `_syncMutableFields` vai copiar pra
    // `effectiveNewId` -- se a linha antiga ainda existir com esse mesmo
    // token no momento desse UPDATE, a constraint UNIQUE rejeita na hora
    // (não-deferrable, checada por statement, não no commit). 🔴 Achado ao
    // vivo validando a fix-wave contra Postgres de dev real: a ordem
    // original (sync primeiro, delete depois) sempre violava
    // `machines_token_key`. Resíduo já migrado acima, então o cascade deste
    // DELETE agora encontra 0 linhas filhas (ou quase) -- rápido mesmo com
    // `activity_log` em 23GB.
    const { rowCount: deletedOld } = await client.query('DELETE FROM machines WHERE id=$1', [oldId]);
    if (deletedOld === 0) {
      throw new Error(`esperava deletar machines.id=${oldId}, mas rowCount=0 (linha some entre o FOR UPDATE e agora?)`);
    }

    await _syncMutableFields(client, oldMachine, effectiveNewId);
    await _removeDuplicateMachines(client, hostname, effectiveNewId);

    await client.query(
      `UPDATE machine_rekey_queue SET status='done', completed_at=now() WHERE id=$1`,
      [jobId]
    );
  });
}

// Processa 1 ciclo: reclama jobs travados, pega o job pending mais antigo
// (se houver), clona a linha pro new_id, pré-processa as 15 tabelas filhas
// em lote (fora de transação) e finaliza (transação curta). Exportada pra
// chamada direta em teste (não só via scheduleNext/setTimeout).
//
// `hostnameFilter` (opcional, só teste): restringe a chamada ao job de um
// hostname específico -- evita que múltiplos arquivos de teste rodando em
// paralelo (mesmo banco de dev compartilhado) "roubem" o job de outro
// arquivo (_claimNextJob pegaria sempre o pending mais antigo GLOBALMENTE).
// Produção nunca passa este argumento.
async function runCycleOnce(hostnameFilter) {
  if (!leaderElection.isLeader()) return { processed: false, reason: 'not-leader' };
  await _reclaimStuckJobs();

  const job = await _claimNextJob(hostnameFilter);
  if (!job) return { processed: false, reason: 'no-pending-job' };

  try {
    const cloned = await db.cloneMachineRow(job.old_id, job.new_id, crypto.randomUUID());
    if (!cloned) {
      // old_id já não existe -- máquina apagada durante a janela pendente,
      // nada a clonar/migrar. Marca o job 'done' sem erro.
      await db.getPool().query(`UPDATE machine_rekey_queue SET status='done', completed_at=now() WHERE id=$1`, [job.id]);
      return { processed: true, job, skipped: 'old_id_gone' };
    }

    await _migrateChildTablesInBatches(job.old_id, job.new_id);
    await _finalizeRekey(job);
    logger.info('[MachineRekeyWorker] job concluido', {
      hostname: job.hostname, oldId: job.old_id, newId: job.new_id,
    });
    return { processed: true, job };
  } catch (err) {
    // Volta pra 'pending' (ou 'failed' depois de MAX_ATTEMPTS) e incrementa
    // attempts -- deixa o próximo ciclo tentar de novo, em vez de ficar
    // presa em 'processing' pra sempre (o que bloquearia o hostname via
    // UNIQUE parcial, inclusive pra novas chamadas de registerMachine). 🔴
    // Achado real do revisor (2ª rodada): antes deste fix, só
    // _reclaimStuckJobs aplicava MAX_ATTEMPTS -- um erro IMEDIATO (ex: o
    // antigo bug de machines_token_key, ou qualquer falha determinística
    // que aconteça rápido o bastante pra nunca ficar 'processing' por mais
    // de STUCK_THRESHOLD_MS) nunca batia esse teto e martelava o mesmo erro
    // a cada 10s pra sempre. Mesmo CASE WHEN de _reclaimStuckJobs.
    logger.error('[MachineRekeyWorker] erro ao processar job, devolvendo pra pending/failed', {
      error: err.message, hostname: job.hostname, jobId: job.id,
    });
    // 🔴 RETURNING status (revisão final de branch, 27/11/2026, ALTO 1a):
    // igual a _reclaimStuckJobs -- sem isso não dava pra saber se o
    // resultado REAL deste UPDATE foi 'failed' (MAX_ATTEMPTS esgotado
    // aqui, não só em _reclaimStuckJobs) pra alertar sobre isso.
    const revertResult = await db.getPool()
      .query(
        `UPDATE machine_rekey_queue
         SET status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
             attempts = attempts + 1
         WHERE id=$1
         RETURNING status`,
        [job.id, MAX_ATTEMPTS]
      )
      .catch(e => {
        logger.error('[MachineRekeyWorker] falha ao reverter job pra pending/failed', { error: e.message });
        return null;
      });
    if (revertResult?.rows[0]?.status === 'failed') {
      await _alertJobFailed(job.id, job.hostname);
    }
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
