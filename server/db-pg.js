'use strict';

// Port assíncrono (pg) de server/db.js (SQLite/better-sqlite3), Fase 2 da
// migração pós-incidente 15/11/2026 (ver memória do projeto
// project_delirio_manager_incidente_sqlite_15_11.md). Arquivo em construção,
// função por função, por grupo de tabela -- NENHUM caller em produção usa
// este arquivo ainda (require('./db') continua apontando pro SQLite até a
// Fase 4, cutover). Zero risco de produção enquanto isso for verdade.
//
// Grupo 1 (machines + metrics) -- 17 das 18 funções do domínio. `registerMachine`
// fica de fora de propósito: faz re-key de UUID + merge de duplicatas usando
// `pragma foreign_keys=OFF` do SQLite, que não tem equivalente direto em
// Postgres (precisa de ON UPDATE CASCADE nas FKs ou constraints deferráveis
// -- decisão de schema própria, não cabe junto com o resto deste grupo).
//
// Grupo 2 (commands + events) -- todas as funções do domínio, incluindo
// purgeOrphanCommands/purgeOldTerminalCommands (já existiam no db.js original
// como fix do incidente 15/11 -- aqui só troca `rowid` por `id`, a PK real).
// Achado real no 2º review deste grupo: SELECT+UPDATE separados (atômicos
// de graça no SQLite síncrono) viram race de verdade com pool concorrente
// -- ver feedback_sqlite_para_postgres_select_update_race na memória antes
// de portar qualquer função nova que tenha esse padrão.
//
// Grupo 3 (alerts + groups) -- todas as funções do domínio.
//
// Grupo 4 (win_events + insights) -- todas as funções do domínio. COUNT(*)
// do Postgres devolve bigint, que o driver `pg` traz como STRING -- todo
// "countUnread*" precisa de Number() explícito (mesma lição de
// purgeOrphanCommands no Grupo 2).
//
// Grupo 5 (clock_offboard_log + clock_operation_log, LGPD Art. 15/16) --
// todas as funções do domínio, tradução 1:1 sem nenhum padrão novo.
//
// Grupo 6 (NF-Ce: nfce_index, nfce_indexed_days, nfce_auto_email_log) --
// 2 achados novos: (a) `LIKE` do SQLite é case-insensitive pra ASCII por
// padrão, `LIKE` do Postgres é case-sensitive -- usar `ILIKE` pra manter o
// comportamento de busca; (b) getNFCeIndexStatus tem VÁRIOS COUNT/SUM que
// precisam de Number() -- inclusive um caso em que o `|| 0` de uma função
// auxiliar (_parseSessionRow) não pegaria uma string bigint não-vazia
// ("0" || 0 === "0").
//
// Regras de tradução (mesmas de todo o arquivo, ver migrations/ pro schema):
//   - `?` -> `$1,$2...`
//   - `.prepare(sql).get/all/run()` -> `await pool.query(sql, params)`, lendo
//     `.rows[0]` / `.rows` / `.rowCount`
//   - `last_metrics` (getAllMachines): SQLite `json_object(...)` devolve TEXT;
//     Postgres `json_build_object(...)` devolve tipo `json` (o driver pg
//     devolveria já parseado como objeto JS) -- por isso `::text` explícito,
//     pra manter o mesmo contrato que routes/machines.js e
//     services/alertEngine.js já esperam (`JSON.parse(machine.last_metrics)`).

const { Pool } = require('pg');
const crypto = require('crypto');
const logger = require('./services/logger');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    // Sem isso, um erro num client idle do pool (queda de rede, idle timeout
    // do Azure Postgres) emite 'error' não tratado no Pool (EventEmitter) e
    // derruba o processo Node inteiro -- exatamente o tipo de falha que
    // motivou esta migração (incidente 15/11/2026).
    pool.on('error', (err) => logger.error('[db-pg] pool error', { error: err.message }));
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

// Roda uma query de COUNT(*) (ou qualquer SELECT de 1 linha com coluna "c")
// e devolve Number() já convertido -- COUNT(*)/SUM(...) do Postgres vêm
// como bigint, que o driver `pg` traz como STRING, não number. Centralizado
// aqui pra nunca mais esquecer o Number() num grupo futuro (a repetição já
// apareceu nos Grupos 2, 4 e 6).
async function countQuery(sql, params = []) {
  const { rows } = await getPool().query(sql, params);
  return Number(rows[0]?.c || 0);
}

// withTransaction: helper compartilhado pra todo o arquivo (substitui
// better-sqlite3 `.transaction()`, que é síncrono). BEGIN/COMMIT/ROLLBACK
// num client dedicado do pool -- fn recebe esse client, não o pool, pra
// garantir que todas as queries da transação rodem na mesma conexão.
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Machines ──────────────────────────────────────────────────────────────────

async function getMachineByToken(token) {
  const { rows } = await getPool().query('SELECT * FROM machines WHERE token = $1', [token]);
  return rows[0];
}

async function getMachineById(id) {
  const { rows } = await getPool().query('SELECT * FROM machines WHERE id = $1', [id]);
  return rows[0];
}

async function getMachineByHostname(hostname) {
  const { rows } = await getPool().query(
    'SELECT * FROM machines WHERE UPPER(hostname) = UPPER($1)', [hostname]
  );
  return rows[0];
}

async function getAllMachines() {
  const { rows } = await getPool().query(`
    SELECT m.*,
      (SELECT json_build_object(
        'cpuPct', cpu_pct, 'ramFreeMB', ram_free_mb, 'ramTotalMB', ram_total_mb,
        'diskFreeGB', disk_free_gb, 'diskTotalGB', disk_total_gb,
        'uptimeH', uptime_h, 'cpuTempC', cpu_temp_c, 'roomTempC', room_temp_c, 'ips', ips
      )::text FROM metrics WHERE machine_id = m.id ORDER BY ts DESC LIMIT 1) AS last_metrics
    FROM machines m
    ORDER BY m.location, m.display_name
  `);
  return rows;
}

// win_events/insights/nfce_index/nfce_indexed_days/dr_backups/activity_log/
// live_sessions/machine_metrics_hourly/machine_offline_events/reading_miss_events
// têm ON DELETE CASCADE na FK -- apagam sozinhas. metrics/commands/events não
// têm FK pra machines (igual no SQLite original), por isso o delete manual.
// Envolvido numa transação (melhoria deliberada sobre o original, que rodava
// cada DELETE solto sem atomicidade): com um pool de conexões concorrentes
// faz sentido garantir que a limpeza não pare pela metade.
async function deleteMachine(id) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM metrics  WHERE machine_id=$1', [id]);
    await client.query('DELETE FROM commands WHERE machine_id=$1', [id]);
    await client.query('DELETE FROM events   WHERE machine_id=$1', [id]);
    await client.query('DELETE FROM machines WHERE id=$1', [id]);
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO deleted_machines (id, deleted_at) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
      [id, now]
    );
  });
}

async function isDeletedMachine(id) {
  const { rows } = await getPool().query(
    'SELECT deleted_at FROM deleted_machines WHERE id = $1', [id]
  );
  const row = rows[0];
  if (!row) return false;
  // Bloqueia re-registro por 10 minutos; após isso, reinstalação manual funciona normalmente
  return (Date.now() - new Date(row.deleted_at).getTime()) < 10 * 60 * 1000;
}

async function updateMachine(id, fields) {
  const allowed = ['display_name', 'location', 'critica', 'subnet', 'ip_interno', 'mac', 'agent_version', 'motherboard', 'os_version'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const set = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
  const values = keys.map(k => fields[k]);
  await getPool().query(`UPDATE machines SET ${set} WHERE id=$${keys.length + 1}`, [...values, id]);
}

async function setMachineStatus(id, status) {
  const now = new Date().toISOString();
  if (status === 'online') {
    await getPool().query(
      'UPDATE machines SET status=$1, last_seen=$2, online_since=$3 WHERE id=$4',
      [status, now, now, id]
    );
  } else {
    await getPool().query(
      'UPDATE machines SET status=$1, last_seen=$2 WHERE id=$3',
      [status, now, id]
    );
  }
}

async function getMachinesStale(thresholdISO) {
  const { rows } = await getPool().query(
    `SELECT * FROM machines WHERE status = 'online' AND (last_seen IS NULL OR last_seen < $1)`,
    [thresholdISO]
  );
  return rows;
}

async function setWolStatus(machineId, status, testedAt = null) {
  const pool = getPool();
  const everConfirmed = status === 'wol_confirmed' ? 1 : undefined;
  if (testedAt && everConfirmed !== undefined) {
    await pool.query(
      'UPDATE machines SET wol_status=$1, wol_tested_at=$2, wol_ever_confirmed=1 WHERE id=$3',
      [status, testedAt, machineId]
    );
  } else if (testedAt) {
    await pool.query(
      'UPDATE machines SET wol_status=$1, wol_tested_at=$2 WHERE id=$3',
      [status, testedAt, machineId]
    );
  } else if (everConfirmed !== undefined) {
    await pool.query(
      'UPDATE machines SET wol_status=$1, wol_ever_confirmed=1 WHERE id=$2',
      [status, machineId]
    );
  } else {
    await pool.query('UPDATE machines SET wol_status=$1 WHERE id=$2', [status, machineId]);
  }
}

async function getMachinesWolTesting(olderThanISO) {
  const { rows } = await getPool().query(
    `SELECT * FROM machines WHERE wol_status = 'testing' AND wol_tested_at IS NOT NULL AND wol_tested_at < $1`,
    [olderThanISO]
  );
  return rows;
}

async function getMachinesBiosNeeded() {
  const { rows } = await getPool().query(
    `SELECT * FROM machines WHERE wol_status = 'bios_needed' ORDER BY location, display_name`
  );
  return rows;
}

async function getMachinesOfflineForWake(offlineSinceCutoff) {
  const { rows } = await getPool().query(
    `SELECT * FROM machines
     WHERE status = 'offline'
       AND wol_status = 'wol_confirmed'
       AND mac != ''
       AND last_seen IS NOT NULL
       AND last_seen < $1`,
    [offlineSinceCutoff]
  );
  return rows;
}

async function getMachinesAutoWolTesting(olderThanISO) {
  const { rows } = await getPool().query(
    `SELECT * FROM machines
     WHERE wol_status = 'wol_auto_testing'
       AND wol_tested_at IS NOT NULL
       AND wol_tested_at < $1`,
    [olderThanISO]
  );
  return rows;
}

// Avança o cursor incremental do InsightEngine após uma análise bem-sucedida —
// evita reenviar os mesmos eventos pro Claude no próximo ciclo.
async function updateMachineInsightCursor(machineId, { lastWinEventId, lastOfflineEventId }) {
  await getPool().query(
    'UPDATE machines SET last_win_event_id = $1, last_offline_event_id = $2 WHERE id = $3',
    [lastWinEventId, lastOfflineEventId, machineId]
  );
}

// ── Metrics ───────────────────────────────────────────────────────────────────

async function saveMetrics(machineId, m) {
  const pool = getPool();
  const now = new Date().toISOString();

  await pool.query(
    `INSERT INTO metrics
      (machine_id, ts, cpu_pct, ram_free_mb, ram_total_mb,
       disk_free_gb, disk_total_gb, uptime_h, cpu_temp_c, room_temp_c, ips)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      machineId, now,
      m.cpuPct || 0, m.ramFreeMB || 0, m.ramTotalMB || 0,
      m.diskFreeGB || 0, m.diskTotalGB || 0,
      m.uptimeH || 0,
      m.cpuTempC != null ? m.cpuTempC : -1,
      m.roomTempC != null ? m.roomTempC : -1,
      JSON.stringify(m.ips || []),
    ]
  );

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await pool.query('DELETE FROM metrics WHERE machine_id=$1 AND ts<$2', [machineId, cutoff]);
}

async function getMetrics(machineId, hours = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { rows } = await getPool().query(
    'SELECT * FROM metrics WHERE machine_id=$1 AND ts>=$2 ORDER BY ts ASC',
    [machineId, cutoff]
  );
  return rows;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function createCommand(machineId, type, params = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getPool().query(
    `INSERT INTO commands (id, machine_id, type, params, status, created_at)
     VALUES ($1,$2,$3,$4,'pending',$5)`,
    [id, machineId, type, JSON.stringify(params), now]
  );
  return id;
}

// SELECT + UPDATE separados (como no original db.js) deixariam de ser
// atômicos em Postgres: duas chamadas concorrentes pra mesma machineId
// (ex: retry de heartbeat) poderiam ler os mesmos comandos 'pending' antes
// de qualquer uma marcar 'sent', entregando o mesmo comando duas vezes. No
// SQLite original isso não existia porque better-sqlite3 é síncrono --
// aqui precisa de UPDATE...RETURNING numa query só. CTE pra preservar a
// ORDER BY created_at ASC do original (RETURNING puro não garante ordem).
async function getPendingCommands(machineId) {
  const now = new Date().toISOString();
  const { rows: cmds } = await getPool().query(
    `WITH updated AS (
       UPDATE commands SET status='sent', sent_at=$2
       WHERE machine_id=$1 AND status='pending'
       RETURNING id, type, params, created_at
     )
     SELECT id, type, params FROM updated ORDER BY created_at ASC`,
    [machineId, now]
  );

  return cmds.map(c => ({
    id: c.id,
    type: c.type,
    params: JSON.parse(c.params || '{}'),
  }));
}

async function ackCommand(commandId, machineId, success, message) {
  const now = new Date().toISOString();
  await getPool().query(
    `UPDATE commands SET status=$1, acked_at=$2, result=$3 WHERE id=$4 AND machine_id=$5`,
    [success ? 'acked' : 'failed', now, message || '', commandId, machineId]
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const COMMANDS_PURGE_BATCH_SIZE = 1000;
const COMMANDS_PURGE_BATCH_SLEEP_MS = 100;

// Apaga de `commands` em lotes (mesma razão do port original em db.js: um
// DELETE único sobre dezenas de milhares de linhas é lento demais e, sem
// ceder o loop entre lotes, atrasa outras queries na mesma pool). SQLite
// usa `rowid` pra isso (alias implícito, não existe em Postgres) -- aqui
// usamos `id` direto, que é a PK real da tabela.
async function deleteCommandsInBatches(whereSql, params) {
  const pool = getPool();
  const limitParamIndex = params.length + 1;
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM commands WHERE id IN (
        SELECT id FROM commands WHERE ${whereSql} LIMIT $${limitParamIndex}
      )`,
      [...params, COMMANDS_PURGE_BATCH_SIZE]
    );
    total += rowCount;
    if (rowCount < COMMANDS_PURGE_BATCH_SIZE) break;
    await sleep(COMMANDS_PURGE_BATCH_SLEEP_MS);
  }
  return total;
}

// Apaga comandos de machine_id que não existe mais em `machines` (órfãos).
// Nunca apaga sem antes confirmar que `machines` tem pelo menos 1 linha --
// ver mesmo comentário em db.js. COUNT(*) do Postgres devolve bigint, que o
// driver `pg` traz como STRING (não number) -- por isso o Number() explícito,
// senão `=== 0` nunca bateria.
async function purgeOrphanCommands() {
  const machineCount = await countQuery('SELECT COUNT(*) as c FROM machines');
  if (machineCount === 0) return 0;
  return deleteCommandsInBatches('machine_id NOT IN (SELECT id FROM machines)', []);
}

// Apaga comandos terminais (acked/failed/cancelled) com created_at > days.
// Nunca apaga pending/sent — ainda podem ser entregues/consultados.
async function purgeOldTerminalCommands(days) {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return deleteCommandsInBatches(`status IN ('acked', 'failed', 'cancelled') AND created_at < $1`, [cutoff]);
}

async function getCommandHistory(machineId, limit = 50) {
  const { rows } = await getPool().query(
    `SELECT * FROM commands WHERE machine_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [machineId, limit]
  );
  return rows;
}

async function getLastAlohaScan(machineId) {
  const { rows } = await getPool().query(
    `SELECT id, result, acked_at FROM commands
     WHERE machine_id=$1 AND type='aloha-scan' AND status='acked' AND result IS NOT NULL
     ORDER BY acked_at DESC LIMIT 1`,
    [machineId]
  );
  return rows[0];
}

async function getCommandById(id) {
  const { rows } = await getPool().query(
    'SELECT id, machine_id, type, params, status FROM commands WHERE id = $1', [id]
  );
  return rows[0];
}

async function getCommandResult(id) {
  const { rows } = await getPool().query(
    'SELECT id, status, result, acked_at FROM commands WHERE id = $1', [id]
  );
  return rows[0];
}

// ── Events ────────────────────────────────────────────────────────────────────

async function addEvent(machineId, type, details = '') {
  const now = new Date().toISOString();
  await getPool().query(
    'INSERT INTO events (machine_id, ts, type, details) VALUES ($1,$2,$3,$4)',
    [machineId, now, type, details]
  );
}

async function getEvents(machineId, limit = 100) {
  const { rows } = await getPool().query(
    'SELECT * FROM events WHERE machine_id=$1 ORDER BY ts DESC LIMIT $2',
    [machineId, limit]
  );
  return rows;
}

// ── Alerts ────────────────────────────────────────────────────────────────────

async function getAlerts(machineId) {
  if (machineId) {
    const { rows } = await getPool().query(
      'SELECT * FROM alerts WHERE machine_id=$1 OR machine_id IS NULL', [machineId]
    );
    return rows;
  }
  const { rows } = await getPool().query('SELECT * FROM alerts ORDER BY id');
  return rows;
}

// better-sqlite3 devolve `lastInsertRowid` do .run(); Postgres precisa de
// RETURNING explícito.
async function createAlert(rule) {
  const now = new Date().toISOString();
  const { rows } = await getPool().query(
    `INSERT INTO alerts (machine_id, type, threshold, duration_mins, channels, enabled, created_at)
     VALUES ($1,$2,$3,$4,$5,1,$6) RETURNING id`,
    [
      rule.machineId || null,
      rule.type, rule.threshold || 0, rule.durationMins || 3,
      JSON.stringify(rule.channels || ['push']),
      now,
    ]
  );
  return rows[0].id;
}

async function deleteAlert(id) {
  await getPool().query('DELETE FROM alerts WHERE id=$1', [id]);
}

// ── Groups ────────────────────────────────────────────────────────────────────

async function getGroups() {
  const { rows } = await getPool().query('SELECT * FROM groups ORDER BY sort_order, name');
  return rows;
}

// Original fazia SELECT MAX(sort_order) e depois INSERT em 2 chamadas --
// mesma classe de race do SELECT+UPDATE (ver comentário no topo do
// arquivo): 2 createGroup concorrentes poderiam ler o mesmo MAX antes de
// qualquer INSERT, gerando sort_order duplicado. INSERT...SELECT numa
// query só resolve a race entre chamadas JS (SELECT agregado sobre tabela
// vazia ainda devolve 1 linha, COALESCE cobre o caso "nenhum grupo ainda").
// Limitação conhecida (aceita, não corrigida): sob READ COMMITTED, duas
// TRANSAÇÕES Postgres concorrentes ainda podem ler o mesmo MAX antes de
// qualquer COMMIT. Sem impacto real -- sort_order não é UNIQUE, só name
// (PK) é, e getGroups ordena por (sort_order, name), então um empate de
// sort_order só degrada pro desempate alfabético, nunca gera erro/duplicata
// de verdade. Criar grupo é ação admin rara via dashboard, não caminho
// crítico de agente. Se algum dia importar eliminar de vez, usar
// `SELECT ... FOR UPDATE` numa linha de lock ou advisory lock.
async function createGroup(name) {
  const now = new Date().toISOString();
  await getPool().query(
    `INSERT INTO groups (name, sort_order, created_at)
     SELECT $1, COALESCE(MAX(sort_order),0)+1, $2 FROM groups
     ON CONFLICT (name) DO NOTHING`,
    [name, now]
  );
}

// Envolvido em transação (melhoria deliberada sobre o original, mesmo
// motivo de deleteMachine no Grupo 1): evita deixar a máquina sem grupo
// (location='') mas o grupo ainda existindo, se a 2ª query falhar.
async function deleteGroup(name) {
  await withTransaction(async (client) => {
    await client.query(`UPDATE machines SET location='' WHERE location=$1`, [name]);
    await client.query('DELETE FROM groups WHERE name=$1', [name]);
  });
}

async function renameGroup(oldName, newName) {
  await withTransaction(async (client) => {
    await client.query('UPDATE machines SET location=$1 WHERE location=$2', [newName, oldName]);
    await client.query('UPDATE groups SET name=$1 WHERE name=$2', [newName, oldName]);
  });
}

async function reorderGroups(names) {
  await withTransaction(async (client) => {
    for (let i = 0; i < names.length; i++) {
      await client.query('UPDATE groups SET sort_order=$1 WHERE name=$2', [i, names[i]]);
    }
  });
}

// ── Win Events ────────────────────────────────────────────────────────────────

// IDs do Windows Event Log monitorados no modo "Focado"
// 41=reinício inesperado, 6008=desligamento inesperado, 1074=desligamento programado,
// 1001=BSOD, 19=update OK, 20=update falhou, 7034=serviço caiu, 6005=boot, 6006=shutdown limpo
const FOCUSED_EVENT_IDS = [41, 6008, 1074, 1001, 19, 20, 7034, 6005, 6006];

// Loop de INSERT envolvido em transação (equivalente ao `.transaction()`
// síncrono do better-sqlite3 original); purga de eventos >30 dias continua
// como statement separado FORA da transação, igual ao original.
async function saveWinEvents(machineId, events) {
  await withTransaction(async (client) => {
    for (const e of events) {
      await client.query(
        `INSERT INTO win_events (machine_id, event_time, event_id, source, level, translation, raw_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [machineId, e.eventTime, e.eventId, e.source, e.level, e.translation, e.rawMessage || null]
      );
    }
  });

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await getPool().query('DELETE FROM win_events WHERE machine_id=$1 AND event_time<$2', [machineId, cutoff]);
}

async function getWinEvents(machineId, scope = 'focused') {
  if (scope === 'focused') {
    const placeholders = FOCUSED_EVENT_IDS.map((_, i) => `$${i + 2}`).join(',');
    const { rows } = await getPool().query(
      `SELECT * FROM win_events
       WHERE machine_id = $1 AND event_id IN (${placeholders})
       ORDER BY event_time DESC LIMIT 200`,
      [machineId, ...FOCUSED_EVENT_IDS]
    );
    return rows;
  }
  const { rows } = await getPool().query(
    `SELECT * FROM win_events WHERE machine_id = $1 ORDER BY event_time DESC LIMIT 200`,
    [machineId]
  );
  return rows;
}

async function markWinEventsRead(machineId) {
  await getPool().query('UPDATE win_events SET is_read = 1 WHERE machine_id = $1', [machineId]);
}

async function countUnreadWinEvents(machineId) {
  return countQuery(
    'SELECT COUNT(*) as c FROM win_events WHERE machine_id = $1 AND is_read = 0', [machineId]
  );
}

// ── Insights ──────────────────────────────────────────────────────────────────

async function saveInsight({ machineId, severity, pattern, solution, patternHash }) {
  await getPool().query(
    `INSERT INTO insights (machine_id, severity, pattern, solution, pattern_hash)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (pattern_hash) DO NOTHING`,
    [machineId || null, severity, pattern, solution || null, patternHash]
  );
}

async function getInsights({ machineId, limit = 50 } = {}) {
  if (machineId) {
    const { rows } = await getPool().query(
      `SELECT * FROM insights WHERE machine_id = $1 ORDER BY generated_at DESC LIMIT $2`,
      [machineId, limit]
    );
    return rows;
  }
  const { rows } = await getPool().query(
    `SELECT i.*, m.display_name, m.hostname
     FROM insights i
     LEFT JOIN machines m ON i.machine_id = m.id
     ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
       generated_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function markInsightRead(id) {
  await getPool().query('UPDATE insights SET is_read = 1 WHERE id = $1', [id]);
}

async function countUnreadInsights(machineId) {
  if (machineId) {
    return countQuery(
      'SELECT COUNT(*) as c FROM insights WHERE machine_id = $1 AND is_read = 0', [machineId]
    );
  }
  return countQuery('SELECT COUNT(*) as c FROM insights WHERE is_read = 0');
}

// ── Clock Offboard Log (LGPD Art. 15/16) ─────────────────────────────────────

async function logClockOffboard({ cpf, employeeName, triggeredBy, timestamp, success, removed, alreadyAbsent, failed, detail }) {
  await getPool().query(
    `INSERT INTO clock_offboard_log
      (cpf, employee_name, triggered_by, timestamp, success, removed, already_absent, failed, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [cpf, employeeName, triggeredBy, timestamp, success, removed, alreadyAbsent, failed, detail]
  );
}

async function getClockOffboardLog(limit = 100) {
  const { rows } = await getPool().query(
    'SELECT * FROM clock_offboard_log ORDER BY timestamp DESC LIMIT $1', [limit]
  );
  return rows;
}

async function logClockOperation({ operation, cpf, employeeName, triggeredBy, timestamp, success, total, okCount, failedCount, detail }) {
  await getPool().query(
    `INSERT INTO clock_operation_log
      (operation, cpf, employee_name, triggered_by, timestamp, success, total, ok_count, failed_count, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      operation,
      cpf,
      employeeName || '',
      triggeredBy || '',
      timestamp,
      success ? 1 : 0,
      total || 0,
      okCount || 0,
      failedCount || 0,
      typeof detail === 'string' ? detail : JSON.stringify(detail || []),
    ]
  );
}

async function getClockOperationLog(limit = 100, operation = null) {
  if (operation) {
    const { rows } = await getPool().query(
      'SELECT * FROM clock_operation_log WHERE operation = $1 ORDER BY timestamp DESC LIMIT $2',
      [operation, limit]
    );
    return rows;
  }
  const { rows } = await getPool().query(
    'SELECT * FROM clock_operation_log ORDER BY timestamp DESC LIMIT $1', [limit]
  );
  return rows;
}

// ── NF-Ce Index ───────────────────────────────────────────────────────────────

// ON CONFLICT(...) DO UPDATE SET x=excluded.x é sintaxe que o Postgres
// originou e o SQLite copiou -- traduz quase sem mudança, só `excluded`
// (minúsculo no SQLite) -> `EXCLUDED` (convenção Postgres, case-insensitive
// de qualquer forma) e `?` -> `$N`. Loop de upserts envolvido em transação
// (equivalente ao `.transaction()` síncrono original).
async function upsertNFCeRecords(machineId, records) {
  const now = new Date().toISOString();
  await withTransaction(async (client) => {
    for (const r of records) {
      const monthYear = (r.dh_emi || '').slice(0, 7);
      const productsText = (r.danfe?.products || []).map(p => p.xProd || '').join(' | ');
      await client.query(
        `INSERT INTO nfce_index
          (machine_id, chave, n_nf, dh_emi, v_nf, day_folder, month_year, products_text, danfe_json, indexed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (machine_id, chave) DO UPDATE SET
           n_nf          = EXCLUDED.n_nf,
           dh_emi        = EXCLUDED.dh_emi,
           v_nf          = EXCLUDED.v_nf,
           products_text = EXCLUDED.products_text,
           danfe_json    = EXCLUDED.danfe_json,
           indexed_at    = EXCLUDED.indexed_at`,
        [
          machineId, r.chave, r.n_nf || 0, r.dh_emi || '',
          r.v_nf || 0, r.day_folder || '', monthYear,
          productsText, JSON.stringify(r.danfe || {}), now,
        ]
      );
    }
  });
}

// `LIKE` do SQLite é case-insensitive pra ASCII por padrão; `LIKE` do
// Postgres é case-sensitive -- precisa de `ILIKE` pra manter a mesma busca
// "contém, sem diferenciar maiúscula/minúscula" que o original tinha de
// graça.
async function searchNFCe({ machineId, dateFrom, dateTo, valueMin, valueMax, product, limit = 50, offset = 0 }) {
  const pool = getPool();
  const conditions = ['machine_id = $1'];
  const args = [machineId];

  if (dateFrom) { args.push(dateFrom); conditions.push(`dh_emi >= $${args.length}`); }
  if (dateTo) { args.push(dateTo + 'T23:59:59'); conditions.push(`dh_emi <= $${args.length}`); }
  if (valueMin != null) { args.push(valueMin); conditions.push(`v_nf >= $${args.length}`); }
  if (valueMax != null) { args.push(valueMax); conditions.push(`v_nf <= $${args.length}`); }
  if (product) { args.push(`%${product}%`); conditions.push(`products_text ILIKE $${args.length}`); }

  const where = conditions.join(' AND ');
  const { rows: totalRows } = await pool.query(`SELECT COUNT(*) as c FROM nfce_index WHERE ${where}`, args);
  const total = Number(totalRows[0].c);

  const { rows } = await pool.query(
    `SELECT id, chave, n_nf, dh_emi, v_nf, day_folder, month_year, products_text, indexed_at
     FROM nfce_index WHERE ${where}
     ORDER BY dh_emi DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    [...args, limit, offset]
  );

  return { total, results: rows };
}

async function getNFCeByChave(machineId, chave) {
  const { rows } = await getPool().query(
    'SELECT * FROM nfce_index WHERE machine_id = $1 AND chave = $2', [machineId, chave]
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, danfe: JSON.parse(row.danfe_json || '{}') };
}

// Função pura, sem query -- idêntica ao original.
function _parseSessionRow(sess) {
  return {
    totalDays:        sess?.total      || 0,
    pendingDays:      sess?.pending    || 0,
    sessionStartedAt: sess?.started_at || null,
  };
}

// COUNT(*)/SUM(...) do Postgres devolvem bigint como STRING via `pg` --
// convertidos pra Number ANTES de chegar em _parseSessionRow (o `|| 0` de
// _parseSessionRow não pega string não-vazia: "0" || 0 === "0", não 0).
async function getNFCeIndexStatus(machineId) {
  const pool = getPool();

  const { rows: monthRows } = await pool.query(
    `SELECT month_year, COUNT(*) as total, MAX(indexed_at) as last_indexed
     FROM nfce_index WHERE machine_id = $1
     GROUP BY month_year ORDER BY month_year DESC LIMIT 12`,
    [machineId]
  );
  const months = monthRows.map(r => ({ ...r, total: Number(r.total) }));

  const totalRecords = await countQuery(
    'SELECT COUNT(*) as c FROM nfce_index WHERE machine_id = $1', [machineId]
  );

  const { rows: listCmdRows } = await pool.query(
    `SELECT status, acked_at, created_at FROM commands
     WHERE machine_id = $1 AND type = 'aloha-list-nfce-months' ORDER BY created_at DESC LIMIT 1`,
    [machineId]
  );
  const listCmd = listCmdRows[0] || null;

  // Sessão atual: todos os aloha-index-nfce-day enfileirados desde o último
  // aloha-list-nfce-months. pendingDays sem valor inicial de propósito --
  // os dois branches abaixo sempre reatribuem antes de qualquer leitura.
  let totalDays = 0, pendingDays, processedDays = 0, sessionStartedAt = null;
  if (listCmd) {
    const { rows: sessRows } = await pool.query(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
         MIN(created_at) as started_at
       FROM commands
       WHERE machine_id = $1 AND type = 'aloha-index-nfce-day' AND created_at >= $2`,
      [machineId, listCmd.created_at]
    );
    const sessRaw = sessRows[0];
    const sess = sessRaw
      ? { total: Number(sessRaw.total), pending: Number(sessRaw.pending || 0), started_at: sessRaw.started_at }
      : null;
    ({ totalDays, pendingDays, sessionStartedAt } = _parseSessionRow(sess));
    processedDays = totalDays - pendingDays;
  } else {
    pendingDays = await countQuery(
      `SELECT COUNT(*) as c FROM commands WHERE machine_id = $1 AND type = 'aloha-index-nfce-day' AND status = 'pending'`,
      [machineId]
    );
  }

  return {
    months,
    totalRecords,
    pendingDays,
    totalDays,
    processedDays,
    sessionStartedAt,
    listMonths: listCmd,
  };
}

// ── NF-Ce indexação incremental ─────────────────────────────────────────────
// Rastreia quais dias já foram indexados por máquina, pra "Indexar mês atual" /
// "Indexar histórico completo" / scheduler noturno pularem dias já processados
// em vez de reenfileirar tudo a cada clique/execução.

async function markNFCeDayIndexed(machineId, dayKey, recordCount) {
  await getPool().query(
    `INSERT INTO nfce_indexed_days (machine_id, day_key, record_count, indexed_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (machine_id, day_key) DO UPDATE SET
       record_count = EXCLUDED.record_count,
       indexed_at   = EXCLUDED.indexed_at`,
    [machineId, dayKey, recordCount || 0, new Date().toISOString()]
  );
}

// Retorna o Set de day_keys ("YYYY-MM-DD") já indexados para a máquina.
async function getIndexedDayKeysSet(machineId) {
  const { rows } = await getPool().query(
    'SELECT day_key FROM nfce_indexed_days WHERE machine_id = $1', [machineId]
  );
  return new Set(rows.map(r => r.day_key));
}

// Chave "YYYY-MM-DD" de hoje (hora local do servidor) — o dia corrente nunca
// é pulado na indexação incremental porque a loja pode ainda estar vendendo.
// Função pura, sem query -- idêntica ao original.
function todayDayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// ── NF-Ce auto-envio por e-mail ─────────────────────────────────────────────
// Reivindicação atômica por chave (única nacionalmente) — evita enviar a
// mesma DANFE 2x mesmo se duas passadas de indexação processarem a mesma nota
// em paralelo ou em execuções diferentes.

// Retorna true se esta chamada "ganhou" a reivindicação (pode prosseguir pro
// envio); false se já foi reivindicada antes (enviada, falhou ou em curso).
// `rowCount` do pg já reflete se o INSERT foi afetado de verdade (0 se o
// ON CONFLICT DO NOTHING descartou) -- equivalente direto ao `.changes`
// do better-sqlite3, sem o problema de bigint-como-string (rowCount é
// metadado do driver, não coluna de resultado).
async function claimAutoEmail(chave, machineId, emailTo) {
  const result = await getPool().query(
    `INSERT INTO nfce_auto_email_log (chave, machine_id, email_to, status, created_at)
     VALUES ($1,$2,$3,'pending',$4)
     ON CONFLICT (chave) DO NOTHING`,
    [chave, machineId, emailTo, new Date().toISOString()]
  );
  return result.rowCount === 1;
}

async function markAutoEmailSent(chave) {
  await getPool().query(
    `UPDATE nfce_auto_email_log SET status='sent', sent_at=$1 WHERE chave=$2`,
    [new Date().toISOString(), chave]
  );
}

async function markAutoEmailFailed(chave, error) {
  await getPool().query(
    `UPDATE nfce_auto_email_log SET status='failed', error=$1 WHERE chave=$2`,
    [String(error || '').slice(0, 500), chave]
  );
}

module.exports = {
  getPool, closePool, withTransaction,
  getMachineByToken, getMachineById, getMachineByHostname, getAllMachines,
  deleteMachine, isDeletedMachine, updateMachine, setMachineStatus,
  getMachinesStale, setWolStatus, getMachinesWolTesting, getMachinesBiosNeeded,
  getMachinesOfflineForWake, getMachinesAutoWolTesting, updateMachineInsightCursor,
  saveMetrics, getMetrics,
  createCommand, getPendingCommands, ackCommand, purgeOrphanCommands, purgeOldTerminalCommands,
  getCommandHistory, getLastAlohaScan, getCommandById, getCommandResult,
  addEvent, getEvents,
  getAlerts, createAlert, deleteAlert,
  getGroups, createGroup, deleteGroup, renameGroup, reorderGroups,
  saveWinEvents, getWinEvents, markWinEventsRead, countUnreadWinEvents,
  saveInsight, getInsights, markInsightRead, countUnreadInsights,
  logClockOffboard, getClockOffboardLog, logClockOperation, getClockOperationLog,
  upsertNFCeRecords, searchNFCe, getNFCeByChave, getNFCeIndexStatus,
  markNFCeDayIndexed, getIndexedDayKeysSet, todayDayKey,
  claimAutoEmail, markAutoEmailSent, markAutoEmailFailed,
};
