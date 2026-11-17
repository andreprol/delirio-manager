'use strict';

// Port assíncrono (pg) do antigo server/db.js (SQLite/better-sqlite3, removido
// na Fase 5), Fase 2 da migração pós-incidente 15/11/2026 (ver memória do
// projeto project_delirio_manager_incidente_sqlite_15_11.md). Desde a Fase 4
// (cutover, 16/11/2026) os 31 arquivos chamadores (20 routes + 10 services +
// app.js + server.js) usam este módulo -- é o único backend de dados do
// servidor agora. Deploy real em produção (restart da VM apontando pra
// psql-dt-manager-prod) ainda pendente, bloqueado até a VM estabilizar.
//
// Tamanho do arquivo (142 funções, ~18 domínios de tabela sem relação):
// o `code-reviewer` do Grupo 14 apontou isso como 🟠 ALTO (SRP de módulo,
// deveria ser quebrado em arquivos por domínio). Decisão deliberada de NÃO
// fazer essa quebra agora: este arquivo espelha `server/db.js` 1:1 de
// propósito, o que facilitou toda comparação linha-a-linha dos 14 reviews
// desta fase -- separar agora, no meio da Fase 2/antes da Fase 3 (ETL),
// seria um refactor grande e arriscado (mover ~2300 linhas entre arquivos)
// sem nenhum ganho funcional, já que nada usa este módulo em produção
// ainda. Fica como recomendação pra Fase 4/5 (cutover/cleanup), quando o
// arquivo for de fato ativado -- nesse momento, quebrar por domínio
// (db/machines.js, db/zamak.js, db/pontoRemoto.js...) com um index.js
// agregando os exports é a hora certa.
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
// ("0" || 0 === "0"). Extraído helper countQuery() compartilhado.
//
// Grupo 7 (registerMachine, deferido do Grupo 1, + dr_backups) -- a função
// mais arriscada do arquivo: precisou de migração de schema própria
// (ON UPDATE CASCADE nas FKs que apontam pra machines, ver comentário em
// registerMachine) pra substituir o `pragma foreign_keys=OFF` do SQLite.
// Achado um bug latente real no original enquanto escrevia essa migração:
// `insights` tinha FK pra machines mas nunca esteve na lista manual de
// re-key do SQLite -- corrigido de graça no port.
//
// Grupo 8 (acesso remoto: watchlist_keywords, activity_log, live_sessions)
// -- generalizei `deleteCommandsInBatches` pra `deleteInBatches(table, ...)`
// e reusei em `purgeActivityLog` (mesmo risco de volume do incidente de
// commands -- activity_log também cresce rápido, 224 máquinas capturando
// janela/processo o tempo todo).
//
// Grupo 9 (Ref1 Registry + Módulo Relatório: report_topics*, freshdesk_cache,
// report_runs, report_feedback) -- maior grupo até agora (21 funções).
// Vários INSERT/UPDATE/DELETE seguidos de SELECT por id consolidados em
// RETURNING * numa query só (createTopic, updateTopic, moveTopic,
// resolveTopic, saveReportRun) -- menos round-trips, sem mudar
// comportamento observável. `substr()` existe idêntico em Postgres, sem
// tradução. `INSERT OR REPLACE` -> `ON CONFLICT DO UPDATE` (freshdesk_cache,
// troca o id no SQLite, preserva no Postgres -- sem efeito aqui).
//
// Grupo 11 (métricas horárias + eventos offline + reading-miss) -- 2
// traduções novas: `strftime('%s','now')` -> `EXTRACT(EPOCH FROM NOW())`;
// e `HAVING <alias do SELECT>` do SQLite NÃO funciona em Postgres
// (confirmado ao vivo: "column does not exist") -- precisa repetir a
// expressão agregada completa dentro do HAVING, só ORDER BY aceita alias.
//
// Grupo 12 (zamak_*, 5 tabelas) -- achado bug real no original:
// `getZamakDiscrepancies` consultava `zamak_device_cache` (sem a coluna
// `detected_at` que usava no ORDER BY) em vez de `zamak_discrepancies`;
// função exportada mas nunca chamada em nenhum route/service (confirmado
// via grep), por isso nunca deu erro em produção. Corrigido no port.
//
// Grupo 13 (NCR Monitor + service_status) -- `datetime(x) <= datetime('now')`
// do original só normaliza formato antes de comparar; como os timestamps
// aqui já são sempre `toISOString()` (confirmado nos call sites),
// comparação direta de string TEXT basta, sem função de data nenhuma.
//
// Grupo 14 (Ponto Remoto REP-P/REP-A) -- ÚLTIMO grupo do port (14/14).
// Tradução 1:1, sem padrão novo. Dado sensível (cpf, password_hash,
// lat/lng) -- LGPD, cuidado redobrado em qualquer teste/log futuro desta
// seção pra nunca imprimir valor real.
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

const PURGE_BATCH_SIZE = 1000;
const PURGE_BATCH_SLEEP_MS = 100;

// Apaga de `table` em lotes (mesma razão do port original em db.js: um
// DELETE único sobre dezenas de milhares de linhas é lento demais e, sem
// ceder o loop entre lotes, atrasa outras queries na mesma pool). SQLite
// usa `rowid` pra isso (alias implícito, não existe em Postgres) -- aqui
// usamos `id` direto, que é a PK real de toda tabela com essa forma neste
// arquivo. `table` nunca vem de input externo -- sempre string literal fixa
// no próprio código-fonte (mesma garantia de `whereSql`), nunca concatenação
// de valor de usuário.
async function deleteInBatches(table, whereSql, params) {
  const pool = getPool();
  const limitParamIndex = params.length + 1;
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM ${table} WHERE id IN (
        SELECT id FROM ${table} WHERE ${whereSql} LIMIT $${limitParamIndex}
      )`,
      [...params, PURGE_BATCH_SIZE]
    );
    total += rowCount;
    if (rowCount < PURGE_BATCH_SIZE) break;
    await sleep(PURGE_BATCH_SLEEP_MS);
  }
  return total;
}

async function deleteCommandsInBatches(whereSql, params) {
  return deleteInBatches('commands', whereSql, params);
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

// ── Machines: registerMachine (Grupo 7) ────────────────────────────────────────
// Deferido do Grupo 1 de propósito -- é a função mais arriscada do arquivo
// (re-key de UUID + merge de duplicatas). Precisou de uma migração de
// schema própria antes de portar: migrations/..._add-on-update-cascade-
// machine-fks.sql adiciona ON UPDATE CASCADE nas 10 FKs que apontam pra
// machines(id) (activity_log, dr_backups, insights, live_sessions,
// machine_metrics_hourly, machine_offline_events, nfce_index,
// nfce_indexed_days, reading_miss_events, win_events).
//
// Achado ao escrever essa migração: `insights` SEMPRE teve essa FK mas
// NUNCA esteve na lista `_MACHINE_CHILD_TABLES` do db.js original -- bug
// latente: insights de uma máquina re-keyed ficavam órfãos no SQLite
// (machine_id apontando pro UUID antigo, que deixa de existir, sem o
// SQLite revalidar isso ao religar `foreign_keys = ON`). Corrigido de
// graça aqui: insights agora segue o re-key como as outras 9 tabelas com FK.

// Tabelas com machine_id SEM FK pra machines -- precisam de UPDATE/DELETE
// manual no re-key/dedup abaixo. As 10 com FK (ver migração acima) seguem
// o UPDATE/DELETE de `machines` automaticamente via ON UPDATE/DELETE CASCADE.
const MACHINE_CHILD_TABLES_NO_FK = ['metrics', 'commands', 'events', 'nfce_auto_email_log', 'service_status'];

// Re-key de UUID (config.json corrompido/reinstall) + merge de duplicatas
// por hostname. O original SQLite precisa de `pragma('foreign_keys = OFF')`
// porque mudar machines.id violaria toda FK que aponta pra ele -- sem
// equivalente em Postgres (não dá pra desligar a checagem globalmente, nem
// precisa, por isso): ON UPDATE CASCADE propaga a mudança de PK automaticamente
// pras 10 tabelas com FK; só as 5 sem FK (MACHINE_CHILD_TABLES_NO_FK) exigem
// UPDATE manual aqui, igual ao original fazia pra todas as 14.
//
// Simplificação real sobre o original: o SQLite tinha um passo extra
// (`DELETE FROM watchlist_matches WHERE activity_log_id IN (SELECT id FROM
// activity_log WHERE machine_id=?)`) só porque `foreign_keys=OFF` também
// desligava o CASCADE de watchlist_matches->activity_log durante o dedup.
// Em Postgres as FKs nunca são desligadas globalmente -- apagar activity_log
// já cascade-deleta watchlist_matches sozinho (watchlist_matches.activity_log_id
// REFERENCES activity_log(id) ON DELETE CASCADE), então esse passo não existe
// mais aqui.
//
// Decisão deliberada (não faithful 1:1): o original envolve cada
// UPDATE/DELETE da lista manual em `try{}catch(_){}` próprio, tolerando
// falha tabela-a-tabela sem abortar o re-key. Aqui, dentro de uma
// `withTransaction` real, deixo propagar -- qualquer falha aborta a
// transação inteira (rollback limpo) em vez de deixar o re-key
// parcialmente aplicado silenciosamente. Schema aqui é totalmente
// controlado (todas as tabelas sempre existem), então não há motivo pra
// tolerar falha de tabela individual como o SQLite original.
//
// 🔴 Achado real no review deste grupo (corrigido): o SQLite original é
// imune a race entre chamadas concorrentes pro MESMO hostname porque
// `d.transaction()()` roda 100% síncrono, sem nenhum ponto onde outra
// chamada pudesse se intercalar entre o SELECT do canonical e a mutação.
// Isso se perde ao virar async -- duas chamadas pro mesmo hostname (ex:
// agent com config.json persistentemente corrompido, reinstalando em
// loop) podiam ler o mesmo canonical ANTES de qualquer commit, e uma
// acabava apagando a máquina que a outra JUSTAGORA recriou como
// "duplicata". Fix: TUDO (os 3 casos) roda dentro de uma única transação
// que começa adquirindo `pg_advisory_xact_lock(hashtext(upper(hostname)))`
// -- serializa qualquer chamada concorrente pro mesmo hostname (chamadas
// pra hostnames diferentes não bloqueiam entre si). O lock libera
// automaticamente no fim da transação (commit ou rollback), sem unlock
// manual. `addEvent` continua fora da transação (mesmo lugar do original).
async function registerMachine({ machineId, hostname, agentVersion }) {
  const now = new Date().toISOString();

  const { token, event } = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext(upper($1)))', [hostname]);

    // 1. UUID já conhecido → atualiza normalmente. Reconferido AQUI DENTRO
    // (não só antes de entrar na transação) -- com o lock já adquirido,
    // nenhuma outra chamada pro mesmo hostname pode ter mudado o estado
    // entre uma checagem "de fora" e esta.
    const { rows: existingRows } = await client.query('SELECT * FROM machines WHERE id = $1', [machineId]);
    const existing = existingRows[0];
    if (existing) {
      await client.query(
        `UPDATE machines SET hostname=$1, agent_version=$2, last_seen=$3, online_since=$4, status='online'
         WHERE id=$5`,
        [hostname, agentVersion || '', now, now, machineId]
      );
      return { token: existing.token, event: null };
    }

    // 2. UUID desconhecido mas hostname conhecido → re-key atômico
    const { rows: canonicalRows } = await client.query(
      `SELECT * FROM machines WHERE UPPER(hostname) = UPPER($1)
       ORDER BY CASE WHEN location != 'Temporário' THEN 0 ELSE 1 END,
                last_seen DESC LIMIT 1`,
      [hostname]
    );
    const canonical = canonicalRows[0];
    if (canonical) {
      return _rekeyAndMergeMachine(client, { oldId: canonical.id, canonicalToken: canonical.token, machineId, hostname, agentVersion, now });
    }

    // 3. Máquina genuinamente nova
    const token2 = crypto.randomUUID();
    await client.query(
      `INSERT INTO machines
        (id, hostname, display_name, location, token, agent_version, status, last_seen, online_since, registered_at)
       VALUES ($1, $2, $3, 'Temporário', $4, $5, 'online', $6, $7, $8)`,
      [machineId, hostname, hostname, token2, agentVersion || '', now, now, now]
    );
    return { token: token2, event: { type: 'agent_installed', details: `Agente v${agentVersion || '?'} registrado` } };
  });

  if (event) await addEvent(machineId, event.type, event.details);
  return token;
}

// Extraído de registerMachine (caso 2) só pra manter a função principal
// legível -- segue rodando no `client` da mesma transação/lock, não é uma
// unidade de trabalho independente.
async function _rekeyAndMergeMachine(client, { oldId, canonicalToken, machineId, hostname, agentVersion, now }) {
  for (const t of MACHINE_CHILD_TABLES_NO_FK) {
    await client.query(`UPDATE ${t} SET machine_id=$1 WHERE machine_id=$2`, [machineId, oldId]);
  }
  // Re-key do registro principal -- ON UPDATE CASCADE propaga pras 10
  // tabelas com FK automaticamente.
  await client.query('UPDATE machines SET id=$1 WHERE id=$2', [machineId, oldId]);
  await client.query(
    `UPDATE machines SET hostname=$1, agent_version=$2, last_seen=$3, online_since=$4, status='online'
     WHERE id=$5`,
    [hostname, agentVersion || '', now, now, machineId]
  );

  // Remove todos os outros registros com mesmo hostname (duplicatas de registros anteriores)
  const { rows: dupes } = await client.query(
    `SELECT id FROM machines WHERE UPPER(hostname) = UPPER($1) AND id != $2`,
    [hostname, machineId]
  );
  for (const { id: dupId } of dupes) {
    for (const t of MACHINE_CHILD_TABLES_NO_FK) {
      await client.query(`DELETE FROM ${t} WHERE machine_id=$1`, [dupId]);
    }
    await client.query('DELETE FROM machines WHERE id=$1', [dupId]); // cascade cuida das 10 tabelas com FK
  }

  return {
    token: canonicalToken,
    event: { type: 'agent_reregistered', details: `UUID atualizado (config recuperado de ${oldId.slice(0, 8)}): agente v${agentVersion || '?'}` },
  };
}

// ── DR Backups (Grupo 7) ────────────────────────────────────────────────────────

async function updateMachineDRStatus(machineId, { setup, lastOk, storageGb, version } = {}) {
  const map = {
    dr_setup: setup,
    dr_last_ok: lastOk,
    dr_storage_gb: storageGb,
    dr_version: version,
  };
  const keys = Object.keys(map).filter(k => map[k] !== undefined);
  if (!keys.length) return;
  const set = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
  await getPool().query(
    `UPDATE machines SET ${set} WHERE id=$${keys.length + 1}`,
    [...keys.map(k => map[k]), machineId]
  );
}

async function insertDRBackup(machineId, { backedAt, status, storageGb, durationMin, errorMsg } = {}) {
  await getPool().query(
    `INSERT INTO dr_backups (machine_id, backed_at, status, storage_gb, duration_min, error_msg)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      machineId, backedAt, status,
      storageGb != null ? storageGb : null,
      durationMin != null ? durationMin : null,
      errorMsg || null,
    ]
  );
}

async function getDRHistory(machineId, days = 28) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await getPool().query(
    `SELECT * FROM dr_backups WHERE machine_id=$1 AND backed_at>=$2 ORDER BY backed_at DESC`,
    [machineId, cutoff]
  );
  return rows;
}

// SUM(dr_storage_gb) sobre coluna DOUBLE PRECISION volta como number de
// verdade via `pg` (confirmado ao vivo contra a instância dev -- só
// COUNT/SUM sobre inteiro/bigint vêm como string). Só total/okLast24h/
// failing (COUNT) precisam de countQuery. As 4 queries são independentes
// e só leitura -- paralelizadas com Promise.all (melhoria deliberada: o
// original roda sequencial só porque better-sqlite3 não tem concorrência;
// aqui reduz latência sem risco nenhum, o pool suporta queries paralelas).
async function getDROverview() {
  const pool = getPool();
  const threshold24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [total, okLast24h, totalGbResult, failing] = await Promise.all([
    countQuery(`SELECT COUNT(*) as c FROM machines WHERE dr_setup='configured'`),
    countQuery(`SELECT COUNT(*) as c FROM machines WHERE dr_setup='configured' AND dr_last_ok>=$1`, [threshold24h]),
    pool.query(`SELECT COALESCE(SUM(dr_storage_gb),0) as s FROM machines WHERE dr_setup='configured'`),
    countQuery(`SELECT COUNT(*) as c FROM machines WHERE dr_setup='error'`),
  ]);

  return { total, okLast24h, totalGb: totalGbResult.rows[0].s, failing };
}

async function getMachinesDRDue(olderThanISO) {
  const { rows } = await getPool().query(
    `SELECT * FROM machines WHERE dr_setup = 'configured' AND (dr_last_ok IS NULL OR dr_last_ok < $1)`,
    [olderThanISO]
  );
  return rows;
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

async function createWatchlistKeyword(keyword) {
  const now = new Date().toISOString();
  const { rows } = await getPool().query(
    'INSERT INTO watchlist_keywords (keyword, active, created_at) VALUES ($1, 1, $2) RETURNING id',
    [keyword, now]
  );
  return rows[0].id;
}

async function getWatchlistKeywords() {
  const { rows } = await getPool().query('SELECT * FROM watchlist_keywords ORDER BY id DESC');
  return rows;
}

async function getActiveWatchlistKeywords() {
  const { rows } = await getPool().query('SELECT * FROM watchlist_keywords WHERE active = 1');
  return rows;
}

async function setWatchlistKeywordActive(id, active) {
  await getPool().query('UPDATE watchlist_keywords SET active = $1 WHERE id = $2', [active ? 1 : 0, id]);
}

async function deleteWatchlistKeyword(id) {
  await getPool().query('DELETE FROM watchlist_keywords WHERE id = $1', [id]);
}

// ── Activity log (acesso remoto) ──────────────────────────────────────────────

async function insertActivityLog(machineId, windowTitle, processName) {
  const now = new Date().toISOString();
  const { rows } = await getPool().query(
    `INSERT INTO activity_log (machine_id, window_title, process_name, captured_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [machineId, windowTitle || '', processName || '', now]
  );
  return { id: rows[0].id, capturedAt: now };
}

async function getActivityLog(machineId, limit = 100) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 100;
  // id DESC como desempate: capturas no mesmo milissegundo (relógio grosseiro) mantêm a ordem de inserção
  const { rows } = await getPool().query(
    `SELECT * FROM activity_log WHERE machine_id = $1
     ORDER BY captured_at DESC, id DESC LIMIT $2`,
    [machineId, safeLimit]
  );
  return rows;
}

// Reaproveita deleteInBatches (mesmo motivo de purgeOldTerminalCommands no
// Grupo 2: activity_log é tabela de alto volume — captura de janela/processo
// a cada poucos segundos por máquina, 224 máquinas — um DELETE único
// cobrindo a janela de retenção inteira teria o mesmo risco de travar o
// writer que o incidente de 15/11 já expôs em `commands`.
async function purgeActivityLog(days) {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return deleteInBatches('activity_log', 'captured_at < $1', [cutoff]);
}

// ── Live sessions (acesso remoto) ─────────────────────────────────────────────

async function createLiveSession(machineId, mode) {
  if (mode !== 'normal' && mode !== 'shadow') {
    throw new Error(`mode inválido: ${mode}`);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getPool().query(
    `INSERT INTO live_sessions (id, machine_id, mode, started_at) VALUES ($1, $2, $3, $4)`,
    [id, machineId, mode, now]
  );
  return id;
}

async function getLiveSession(sessionId) {
  const { rows } = await getPool().query('SELECT * FROM live_sessions WHERE id = $1', [sessionId]);
  return rows[0];
}

async function endLiveSession(sessionId) {
  const now = new Date().toISOString();
  await getPool().query('UPDATE live_sessions SET ended_at = $1 WHERE id = $2', [now, sessionId]);
}

async function setLiveSessionRecorded(sessionId) {
  await getPool().query('UPDATE live_sessions SET recorded = 1 WHERE id = $1', [sessionId]);
}

// ── Ref1 Registry ────────────────────────────────────────────────────────────

async function registerRef1({ ref1, cpf, name }) {
  const n = parseInt(ref1, 10);
  if (!n || n <= 0) return;
  await getPool().query(
    `INSERT INTO ref1_registry (ref1, cpf, name, assigned_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (ref1) DO NOTHING`,
    [n, cpf || '', name || '', new Date().toISOString()]
  );
}

// ref1_registry.ref1 virou BIGINT na Fase 3 (ETL achou valor real > limite
// de INTEGER -- ver migrations/1794859503910_ref1-registry-ref1-bigint.sql),
// então MAX() agora devolve bigint-como-string via `pg` (mesma lição de
// sempre). Number() obrigatório -- antes da migration a coluna era INTEGER
// e MAX() devolvia number de verdade; não é mais o caso.
async function getMaxRef1() {
  const { rows } = await getPool().query('SELECT MAX(ref1) as max FROM ref1_registry');
  return Number(rows[0]?.max || 0);
}

// ── Módulo Relatório ──────────────────────────────────────────────────────────

const CRITICAL_RE = /^(TERM|BOH)/i;

function isCriticalMachine(mention) {
  return mention ? CRITICAL_RE.test(mention.trim()) : false;
}

async function getTopics(storeName) {
  const { rows } = await getPool().query(
    `SELECT * FROM report_topics WHERE store_name = $1 ORDER BY
     CASE severity WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, created_at DESC`,
    [storeName]
  );
  return rows;
}

async function getAllStoresTopicCount() {
  const { rows } = await getPool().query(
    `SELECT store_name, COUNT(*) as count FROM report_topics GROUP BY store_name`
  );
  return rows.map(r => ({ ...r, count: Number(r.count) }));
}

// INSERT...RETURNING * numa query só -- o original fazia INSERT seguido de
// SELECT por lastInsertRowid (2 round-trips); aqui 1 só, sem mudar
// comportamento (linha inserida é única, sem risco de concorrência entre
// as duas operações que existiria num SELECT+UPDATE).
async function createTopic({ store_name, description, severity, machine_mention, photo_path, created_by }) {
  const critical = isCriticalMachine(machine_mention);
  const now = new Date().toISOString();
  const { rows } = await getPool().query(
    `INSERT INTO report_topics (store_name, description, severity, machine_mention, is_critical_machine, photo_path, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [store_name, description, severity, machine_mention || null, critical ? 1 : 0, photo_path || null, now, created_by || 'TI']
  );
  return rows[0];
}

// UPDATE...RETURNING * numa query só -- mesma simplificação de createTopic.
// Devolve `undefined` se o id não existir (mesmo contrato de `.get()` no
// original, que não checava existência antes de atualizar).
async function updateTopic(id, { description, severity, machine_mention, photo_path }) {
  const critical = isCriticalMachine(machine_mention);
  const pool = getPool();
  // photo_path === undefined → não alterar (preservar o que está no DB)
  // photo_path === null      → limpar fotos explicitamente
  if (photo_path !== undefined) {
    const { rows } = await pool.query(
      `UPDATE report_topics SET description=$1, severity=$2, machine_mention=$3, is_critical_machine=$4, photo_path=$5
       WHERE id=$6 RETURNING *`,
      [description, severity, machine_mention || null, critical ? 1 : 0, photo_path, id]
    );
    return rows[0];
  }
  const { rows } = await pool.query(
    `UPDATE report_topics SET description=$1, severity=$2, machine_mention=$3, is_critical_machine=$4
     WHERE id=$5 RETURNING *`,
    [description, severity, machine_mention || null, critical ? 1 : 0, id]
  );
  return rows[0];
}

// DELETE...RETURNING * substitui o SELECT inicial do original (pega os
// dados do topic sendo apagado na mesma query) -- a ordem muda (apaga antes
// de inserir no histórico, original fazia o contrário), mas como tudo roda
// dentro de uma transação, observadores externos nunca veem o estado
// intermediário de nenhum dos dois jeitos (isolamento da transação).
async function resolveTopic(id) {
  const now = new Date().toISOString();
  return withTransaction(async (client) => {
    const { rows } = await client.query('DELETE FROM report_topics WHERE id = $1 RETURNING *', [id]);
    const topic = rows[0];
    if (!topic) return null;
    await client.query(
      `INSERT INTO report_topics_history
        (original_topic_id, store_name, description, severity, machine_mention, is_critical_machine, photo_path, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        topic.id, topic.store_name, topic.description, topic.severity, topic.machine_mention,
        topic.is_critical_machine, topic.photo_path, topic.created_at, now,
      ]
    );
    return { resolved: true };
  });
}

async function moveTopic(id, newStoreName) {
  const { rows } = await getPool().query(
    'UPDATE report_topics SET store_name = $1 WHERE id = $2 RETURNING *',
    [newStoreName, id]
  );
  return rows[0] || null; // original checava existência antes e retornava null explícito
}

async function replicateTopic(id, targetStores) {
  const { rows: topicRows } = await getPool().query('SELECT * FROM report_topics WHERE id = $1', [id]);
  const topic = topicRows[0];
  if (!topic) return null;
  const now = new Date().toISOString();
  const critical = isCriticalMachine(topic.machine_mention);

  return withTransaction(async (client) => {
    const created = [];
    for (const storeName of targetStores) {
      const { rows } = await client.query(
        `INSERT INTO report_topics (store_name, description, severity, machine_mention, is_critical_machine, photo_path, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [storeName, topic.description, topic.severity, topic.machine_mention, critical ? 1 : 0, topic.photo_path, now, topic.created_by || 'TI']
      );
      created.push({ id: rows[0].id, store_name: storeName });
    }
    return created;
  });
}

async function getTopicsHistory(storeName, months = 6) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const { rows } = await getPool().query(
    `SELECT * FROM report_topics_history WHERE store_name = $1 AND resolved_at >= $2 ORDER BY resolved_at DESC`,
    [storeName, since.toISOString()]
  );
  return rows;
}

// Freshdesk cache

async function getFreshdeskCacheAge(storeName) {
  const { rows } = await getPool().query(
    `SELECT cached_at FROM freshdesk_cache WHERE store_name = $1 ORDER BY cached_at DESC LIMIT 1`,
    [storeName]
  );
  const row = rows[0];
  if (!row) return Infinity;
  return (Date.now() - new Date(row.cached_at).getTime()) / 3600000; // hours
}

// `INSERT OR REPLACE` do SQLite apaga+reinsere em conflito, trocando o id
// AUTOINCREMENT; `ON CONFLICT DO UPDATE` do Postgres preserva o id
// existente -- diferença sem efeito aqui (nada referencia
// freshdesk_cache.id como FK, é só cache re-sincronizado periodicamente).
async function upsertFreshdeskTickets(tickets) {
  const now = new Date().toISOString();
  await withTransaction(async (client) => {
    for (const t of tickets) {
      await client.query(
        `INSERT INTO freshdesk_cache (ticket_id, store_name, title, status, priority, created_at, resolved_at, cached_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (ticket_id) DO UPDATE SET
           store_name  = EXCLUDED.store_name,
           title       = EXCLUDED.title,
           status      = EXCLUDED.status,
           priority    = EXCLUDED.priority,
           created_at  = EXCLUDED.created_at,
           resolved_at = EXCLUDED.resolved_at,
           cached_at   = EXCLUDED.cached_at`,
        [t.ticket_id, t.store_name, t.title, t.status, t.priority, t.created_at, t.resolved_at, now]
      );
    }
  });
}

// substr(string, start, length) existe idêntico em Postgres (confirmado ao
// vivo) -- nenhuma tradução necessária aqui, ao contrário de LIKE/rowid/etc.
async function getFreshdeskActive(storeName, month) {
  const { rows } = await getPool().query(
    `SELECT * FROM freshdesk_cache
     WHERE store_name = $1 AND status IN ('open','pending')
     AND substr(created_at, 1, 7) <= $2 ORDER BY created_at DESC`,
    [storeName, month]
  );
  return rows;
}

async function getFreshdeskClosed(storeName, month) {
  const { rows } = await getPool().query(
    `SELECT * FROM freshdesk_cache
     WHERE store_name = $1 AND status = 'closed'
     AND substr(resolved_at, 1, 7) = $2 ORDER BY resolved_at DESC`,
    [storeName, month]
  );
  return rows;
}

// Report runs

async function saveReportRun(data) {
  const { rows } = await getPool().query(
    `INSERT INTO report_runs (store_name, month, generated_at, score_total, score_hardware, score_software,
     score_connectivity, score_security, score_incidents, score_operational, ai_narrative, ai_recommendations, docx_path, pdf_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      data.store_name, data.month, new Date().toISOString(),
      data.score_total, data.score_hardware, data.score_software,
      data.score_connectivity, data.score_security, data.score_incidents, data.score_operational,
      data.ai_narrative, JSON.stringify(data.ai_recommendations || []),
      data.docx_path || null, data.pdf_path || null,
    ]
  );
  return rows[0].id;
}

async function getReportHistory(storeName) {
  const { rows } = await getPool().query(
    `SELECT * FROM report_runs WHERE store_name = $1 ORDER BY generated_at DESC LIMIT 12`,
    [storeName]
  );
  return rows;
}

// Dedup: evita gerar (e pagar) relatório de novo se já existe um recente
// pra mesma loja+mês dentro da janela.
async function getRecentReportRun(storeName, month, windowMinutes) {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const { rows } = await getPool().query(
    `SELECT * FROM report_runs WHERE store_name = $1 AND month = $2 AND generated_at >= $3
     ORDER BY generated_at DESC LIMIT 1`,
    [storeName, month, cutoff]
  );
  return rows[0];
}

// Feedback

async function saveFeedback({ store_name, month, feedback_text, report_run_id }) {
  await getPool().query(
    `INSERT INTO report_feedback (report_run_id, store_name, month, feedback_text, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [report_run_id || null, store_name, month, feedback_text, new Date().toISOString()]
  );
}

async function getRecentFeedback(storeName, limit = 5) {
  const { rows } = await getPool().query(
    `SELECT * FROM report_feedback WHERE store_name = $1 ORDER BY created_at DESC LIMIT $2`,
    [storeName, limit]
  );
  return rows;
}

// Stores list with score + open topics
async function getStoresOverview() {
  const topicCounts = await getAllStoresTopicCount();
  const { rows: runs } = await getPool().query(
    `SELECT store_name, score_total, generated_at FROM report_runs r1
     WHERE generated_at = (SELECT MAX(generated_at) FROM report_runs r2 WHERE r2.store_name = r1.store_name)`
  );
  const countMap = Object.fromEntries(topicCounts.map(r => [r.store_name, r.count]));
  const scoreMap = Object.fromEntries(runs.map(r => [r.store_name, { score: r.score_total, generatedAt: r.generated_at }]));
  return { countMap, scoreMap };
}

// ── Métricas horárias ─────────────────────────────────────────────────────────

// month = "YYYY-MM" -> [inicio, fim) do mês em epoch (segundos) ou ISO,
// conforme a coluna que a query compara. Usado por 5 funções deste grupo
// (mesma lógica de corte de mês repetida originalmente em cada uma).
function monthRangeEpoch(month) {
  const [year, mon] = month.split('-').map(Number);
  return {
    start: Math.floor(new Date(year, mon - 1, 1).getTime() / 1000),
    end: Math.floor(new Date(year, mon, 1).getTime() / 1000),
  };
}

function monthRangeIso(month) {
  const [year, mon] = month.split('-').map(Number);
  return {
    start: new Date(year, mon - 1, 1).toISOString(),
    end: new Date(year, mon, 1).toISOString(),
  };
}

async function insertMetricsHourly(machineId, { snapshotTs, cpuPct, ramPct, diskPct, cpuTempC }) {
  const hourOfDay = new Date(snapshotTs * 1000).getUTCHours();
  const localHour = new Date(snapshotTs * 1000).getHours();
  const hourWeight = (localHour >= 8 && localHour < 22) ? 2 : 1;
  const pool = getPool();
  await pool.query(
    `INSERT INTO machine_metrics_hourly
      (machine_id, snapshot_ts, hour_of_day, hour_weight, cpu_pct, ram_pct, disk_pct, cpu_temp_c)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [machineId, snapshotTs, hourOfDay, hourWeight, cpuPct ?? 0, ramPct ?? 0, diskPct ?? 0, cpuTempC ?? -1]
  );
  // datetime('now') do SQLite -> (now() AT TIME ZONE 'utc')::text, mesma
  // tradução já usada no schema (migrations/1794791426884) pros defaults.
  await pool.query(`UPDATE machines SET last_hourly_at = (now() AT TIME ZONE 'utc')::text WHERE id = $1`, [machineId]);
}

// Retorna média ponderada por hora de todas as máquinas da loja no mês informado.
// month = "2026-07"
async function getWeightedMetricsForStore(location, month) {
  const { start, end } = monthRangeEpoch(month);

  const { rows } = await getPool().query(
    `SELECT
      SUM(mmh.cpu_pct  * mmh.hour_weight) / NULLIF(SUM(mmh.hour_weight), 0) AS avg_cpu_pct,
      SUM(mmh.ram_pct  * mmh.hour_weight) / NULLIF(SUM(mmh.hour_weight), 0) AS avg_ram_pct,
      SUM(mmh.disk_pct * mmh.hour_weight) / NULLIF(SUM(mmh.hour_weight), 0) AS avg_disk_pct,
      SUM(CASE WHEN mmh.cpu_temp_c > 0 THEN mmh.cpu_temp_c * mmh.hour_weight ELSE 0 END)
        / NULLIF(SUM(CASE WHEN mmh.cpu_temp_c > 0 THEN mmh.hour_weight ELSE 0 END), 0) AS avg_cpu_temp,
      COUNT(*) AS total_readings
     FROM machine_metrics_hourly mmh
     JOIN machines m ON m.id = mmh.machine_id
     WHERE m.location = $1
       AND mmh.snapshot_ts >= $2 AND mmh.snapshot_ts < $3`,
    [location, start, end]
  );
  // Agregado sem GROUP BY sempre devolve exatamente 1 linha no Postgres
  // (mesmo sem nenhuma linha correspondente -- COUNT vira 0, SUM vira NULL),
  // então `rows[0]` nunca é undefined aqui; sem fallback "row ausente".
  const row = rows[0];
  return { ...row, total_readings: Number(row.total_readings) };
}

// ── Eventos offline ───────────────────────────────────────────────────────────

async function insertOfflineEvent(machineId, { offlineAt, onlineAt, durationMin }) {
  await getPool().query(
    `INSERT INTO machine_offline_events (machine_id, offline_at, online_at, duration_min)
     VALUES ($1, $2, $3, $4)`,
    [machineId, offlineAt, onlineAt, durationMin]
  );
}

// Retorna contagem total de eventos offline da loja no mês informado.
async function getOfflineEventsForStore(location, month) {
  const { start, end } = monthRangeIso(month);

  return countQuery(
    `SELECT COUNT(*) AS c
     FROM machine_offline_events moe
     JOIN machines m ON m.id = moe.machine_id
     WHERE m.location = $1
       AND moe.offline_at >= $2 AND moe.offline_at < $3`,
    [location, start, end]
  );
}

// ── Leituras horárias perdidas ────────────────────────────────────────────────

// `INSERT OR IGNORE` do original não evita conflito real HOJE --
// reading_miss_events só tem índices NÃO-únicos em (machine_id,
// expected_hour) e (expected_hour) (confirmado no schema, migrations/
// 1794791426884). `ON CONFLICT DO NOTHING` sem target preserva o mesmo
// comportamento atual (equivalente a um INSERT comum, já que não há
// nenhuma constraint única pra colidir) -- não é bug introduzido pelo
// port, já era assim no SQLite original. Decidir se deveria existir uma
// UNIQUE aqui está fora do escopo desta migração.
async function insertReadingMiss(machineId, { expectedHour, machineStatus, agentVersion, lastHeartbeat, diagnosis }) {
  await getPool().query(
    `INSERT INTO reading_miss_events
      (machine_id, expected_hour, machine_status, agent_version, last_heartbeat, diagnosis)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [machineId, expectedHour, machineStatus, agentVersion || null, lastHeartbeat || null, diagnosis || null]
  );
}

async function getReadingMissesForDate(dateStr) {
  const dayStart = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
  const dayEnd = dayStart + 86400;
  const { rows } = await getPool().query(
    `SELECT rme.machine_id, rme.expected_hour, rme.machine_status,
            rme.agent_version, rme.last_heartbeat, rme.diagnosis,
            m.hostname, m.location, m.display_name
     FROM reading_miss_events rme
     JOIN machines m ON m.id = rme.machine_id
     WHERE rme.expected_hour >= $1 AND rme.expected_hour < $2
     ORDER BY rme.machine_status DESC, m.location, m.hostname, rme.expected_hour`,
    [dayStart, dayEnd]
  );
  return rows;
}

async function getReadingMissesForMonth(storeName, month) {
  const { start, end } = monthRangeEpoch(month);
  const { rows } = await getPool().query(
    `SELECT m.hostname, m.display_name,
            COUNT(*) AS total_misses,
            SUM(CASE WHEN rme.machine_status = 'online'  THEN 1 ELSE 0 END) AS online_misses,
            SUM(CASE WHEN rme.machine_status = 'offline' THEN 1 ELSE 0 END) AS offline_misses
     FROM reading_miss_events rme
     JOIN machines m ON m.id = rme.machine_id
     WHERE m.location = $1
       AND rme.expected_hour >= $2 AND rme.expected_hour < $3
     GROUP BY m.id
     ORDER BY online_misses DESC, total_misses DESC`,
    [storeName, start, end]
  );
  return rows.map(r => ({
    ...r,
    total_misses: Number(r.total_misses),
    online_misses: Number(r.online_misses),
    offline_misses: Number(r.offline_misses),
  }));
}

// Máquinas online sem leitura há mais de N horas — usado pelo monitor.
// 2 traduções SQLite-específicas aqui: `strftime('%s','now')` ->
// `EXTRACT(EPOCH FROM NOW())`; e o `HAVING last_snapshot_ts ...` do
// original referenciava o ALIAS do SELECT -- SQLite permite isso, Postgres
// NÃO (confirmado ao vivo: "column does not exist") -- precisa repetir a
// expressão agregada completa (MAX(h.snapshot_ts)) dentro do HAVING.
async function getMachinesOnlineMissingReading(sinceTs) {
  const { rows } = await getPool().query(
    `SELECT m.id, m.hostname, m.display_name, m.location, m.status,
            m.agent_version, m.last_seen,
            MAX(h.snapshot_ts) AS last_snapshot_ts,
            COUNT(h.id)        AS readings_24h
     FROM machines m
     LEFT JOIN machine_metrics_hourly h
       ON h.machine_id = m.id AND h.snapshot_ts >= EXTRACT(EPOCH FROM NOW())::bigint - 86400
     WHERE m.status = 'online'
     GROUP BY m.id
     HAVING MAX(h.snapshot_ts) IS NULL OR MAX(h.snapshot_ts) < $1
     ORDER BY last_snapshot_ts ASC NULLS FIRST`,
    [sinceTs]
  );
  return rows.map(r => ({ ...r, readings_24h: Number(r.readings_24h) }));
}

// Média mensal de hardware por máquina (usa machine_metrics_hourly, não metrics 24h)
async function getMachineDataForMonth(storeName, month) {
  const { start, end } = monthRangeEpoch(month);

  const { rows } = await getPool().query(
    `SELECT m.id, m.hostname, m.status,
            AVG(h.cpu_pct)  AS avg_cpu,
            AVG(h.ram_pct)  AS avg_ram,
            AVG(CASE WHEN h.cpu_temp_c > 0 THEN h.cpu_temp_c ELSE NULL END) AS avg_temp,
            AVG(h.disk_pct) AS avg_disk_pct,
            COUNT(h.id)     AS reading_count
     FROM machines m
     LEFT JOIN machine_metrics_hourly h
       ON h.machine_id = m.id
       AND h.snapshot_ts >= $1 AND h.snapshot_ts < $2
     WHERE m.location = $3
     GROUP BY m.id
     ORDER BY m.hostname`,
    [start, end, storeName]
  );
  return rows.map(r => ({ ...r, reading_count: Number(r.reading_count) }));
}

// Máquinas sem medição horária no mês (offline total ou agente desatualizado)
async function getMachinesWithoutMetrics(storeName, month) {
  const { start, end } = monthRangeEpoch(month);

  const { rows } = await getPool().query(
    `SELECT m.id, m.hostname, m.status
     FROM machines m
     WHERE m.location = $1
       AND NOT EXISTS (
         SELECT 1 FROM machine_metrics_hourly h
         WHERE h.machine_id = m.id
           AND h.snapshot_ts >= $2 AND h.snapshot_ts < $3
       )
     ORDER BY m.hostname`,
    [storeName, start, end]
  );
  return rows;
}

// Resumo de medições das últimas 24h — para email diário de verificação do agente
async function getDailyMetricsSummary() {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const { rows } = await getPool().query(
    `SELECT m.id, m.hostname, m.location, m.status, m.agent_version, m.last_hourly_at,
            COUNT(h.id) as readings_24h
     FROM machines m
     LEFT JOIN machine_metrics_hourly h
       ON h.machine_id = m.id AND h.snapshot_ts >= $1
     GROUP BY m.id
     ORDER BY m.location, readings_24h ASC, m.hostname`,
    [since]
  );
  return rows.map(r => ({ ...r, readings_24h: Number(r.readings_24h) }));
}

// Diagnóstico de snapshots horários — última medição por máquina
async function getHourlyMetricsDiag() {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const { rows } = await getPool().query(
    `SELECT m.id, m.hostname, m.location, m.status, m.agent_version, m.last_hourly_at,
            COUNT(h.id) as readings_24h,
            MAX(h.snapshot_ts) as last_snapshot_ts
     FROM machines m
     LEFT JOIN machine_metrics_hourly h
       ON h.machine_id = m.id AND h.snapshot_ts >= $1
     GROUP BY m.id
     ORDER BY readings_24h ASC, m.location, m.hostname`,
    [since]
  );
  return rows.map(r => ({ ...r, readings_24h: Number(r.readings_24h) }));
}

// ── Zamak / N-able N-sight cache ────────────────────────────────────────────────

async function upsertZamakDevices(rows) {
  await withTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO zamak_device_cache
          (device_id, site_id, site_name, store_name, device_name, device_type, status,
           os_type, ip_address, has_web_protection,
           patch_critical, patch_high, patch_medium, patch_total,
           threats_active, failing_checks, dm_machine_id, dm_hostname, cached_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (device_id) DO UPDATE SET
           site_id = EXCLUDED.site_id, site_name = EXCLUDED.site_name,
           store_name = EXCLUDED.store_name, device_name = EXCLUDED.device_name,
           device_type = EXCLUDED.device_type, status = EXCLUDED.status,
           os_type = EXCLUDED.os_type, ip_address = EXCLUDED.ip_address,
           has_web_protection = EXCLUDED.has_web_protection,
           patch_critical = EXCLUDED.patch_critical, patch_high = EXCLUDED.patch_high,
           patch_medium = EXCLUDED.patch_medium, patch_total = EXCLUDED.patch_total,
           threats_active = EXCLUDED.threats_active, failing_checks = EXCLUDED.failing_checks,
           dm_machine_id = EXCLUDED.dm_machine_id, dm_hostname = EXCLUDED.dm_hostname,
           cached_at = EXCLUDED.cached_at`,
        [
          r.device_id, r.site_id, r.site_name, r.store_name, r.device_name,
          r.device_type, r.status, r.os_type, r.ip_address,
          r.has_web_protection ? 1 : 0,
          r.patch_critical, r.patch_high, r.patch_medium, r.patch_total,
          r.threats_active, r.failing_checks,
          r.dm_machine_id || null, r.dm_hostname || null, r.cached_at,
        ]
      );
    }
  });
}

// DELETE + INSERTs envolvidos na MESMA transação (melhoria deliberada: o
// original rodava o DELETE como statement solto FORA da `.transaction()`
// do insert -- se o loop de insert falhasse no meio, a tabela ficava
// vazia sem rollback possível, porque o DELETE já tinha "commitado" de
// graça). replaceZamakThreats/Performance/Outages abaixo seguem o mesmo padrão.
async function replaceZamakDiscrepancies(rows) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM zamak_discrepancies');
    for (const r of rows) {
      await client.query(
        `INSERT INTO zamak_discrepancies
          (type, device_name, store_name, zamak_device_id, dm_machine_id, detail, detected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.type, r.device_name, r.store_name || null, r.zamak_device_id || null, r.dm_machine_id || null, r.detail || null, r.detected_at]
      );
    }
  });
}

// Status consolidado de ambas as integrações (Zamak + Freshdesk)
async function getIntegrationsStatus() {
  const now = Date.now();
  const pool = getPool();
  let zamakLast = null, freshdeskLast = null;
  try {
    const { rows } = await pool.query(`SELECT MAX(cached_at) as t FROM zamak_device_cache`);
    zamakLast = rows[0]?.t || null;
  } catch (_) { /* mesma defesa do original -- tolera tabela ausente */ }
  try {
    const { rows } = await pool.query(`SELECT MAX(cached_at) as t FROM freshdesk_cache`);
    freshdeskLast = rows[0]?.t || null;
  } catch (_) { /* idem */ }

  const ageMin = (ts) => ts ? (now - new Date(ts).getTime()) / 60000 : null;
  const zamakAge = ageMin(zamakLast);
  const freshdeskAge = ageMin(freshdeskLast);

  return {
    zamak:     { lastSync: zamakLast,     ageMinutes: zamakAge,     ok: zamakAge     !== null && zamakAge     < 360 },
    freshdesk: { lastSync: freshdeskLast, ageMinutes: freshdeskAge, ok: freshdeskAge !== null && freshdeskAge < 240 },
  };
}

// Devices conhecidos no cache — evita re-discovery na API durante sync diário
async function getZamakCachedDeviceIds() {
  const { rows } = await getPool().query(
    `SELECT device_id, device_name, store_name FROM zamak_device_cache WHERE device_id IS NOT NULL`
  );
  return rows;
}

// Retorna quantas horas desde o último sync (Infinity se nunca sincronizou)
async function getZamakCacheAge() {
  const { rows } = await getPool().query(
    `SELECT cached_at FROM zamak_device_cache ORDER BY cached_at DESC LIMIT 1`
  );
  const row = rows[0];
  if (!row) return Infinity;
  return (Date.now() - new Date(row.cached_at).getTime()) / 3600000;
}

// Resumo por loja: agregados de patches, ameaças e failing checks. Todos os
// 7 campos são COUNT/SUM -- todos precisam de Number() (bigint-como-string
// do Postgres). Loja sem nenhum device: a query ainda devolve exatamente 1
// linha (agregado sem GROUP BY sempre devolve, mesmo com 0 matches --
// COUNT=0, SUM=NULL), então `row` nunca é undefined/ausente de verdade; é
// o `Number(null) === 0` de cada campo (não o `if (!row)` abaixo) que
// produz os zeros nesse caso. O `if (!row)` é só defensivo/morto -- mesma
// situação já confirmada em getWeightedMetricsForStore (Grupo 11).
async function getZamakSummaryForStore(storeName) {
  const { rows } = await getPool().query(
    `SELECT
      COUNT(*) AS total_devices,
      SUM(patch_critical) AS patch_critical,
      SUM(patch_high)     AS patch_high,
      SUM(patch_total)    AS patch_total,
      SUM(threats_active) AS threats_active,
      SUM(failing_checks) AS failing_checks,
      SUM(CASE WHEN status IN ('offline','overdue','Error') THEN 1 ELSE 0 END) AS devices_offline
     FROM zamak_device_cache
     WHERE store_name = $1`,
    [storeName]
  );
  const row = rows[0];
  if (!row) {
    return {
      total_devices: 0, patch_critical: 0, patch_high: 0, patch_total: 0,
      threats_active: 0, failing_checks: 0, devices_offline: 0,
    };
  }
  return {
    total_devices: Number(row.total_devices),
    patch_critical: Number(row.patch_critical),
    patch_high: Number(row.patch_high),
    patch_total: Number(row.patch_total),
    threats_active: Number(row.threats_active),
    failing_checks: Number(row.failing_checks),
    devices_offline: Number(row.devices_offline),
  };
}

// Bug real achado no original: a função consultava `zamak_device_cache`
// (que nem tem coluna `detected_at`) em vez de `zamak_discrepancies` --
// exportada mas NUNCA chamada em nenhum route/service (confirmado via
// grep), por isso o erro nunca apareceu em produção (SQLite também daria
// "no such column" se alguém chamasse). Corrigido no port pra consultar a
// tabela certa.
async function getZamakDiscrepancies() {
  const { rows } = await getPool().query(
    `SELECT * FROM zamak_discrepancies ORDER BY detected_at DESC`
  );
  return rows;
}

async function replaceZamakThreats(rows) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM zamak_threats');
    for (const r of rows) {
      await client.query(
        `INSERT INTO zamak_threats (device_id, device_name, store_name, threat_name, category, last_status, cached_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.device_id, r.device_name, r.store_name, r.threat_name, r.category, r.last_status, r.cached_at]
      );
    }
  });
}

async function getZamakThreats(storeName) {
  if (storeName) {
    const { rows } = await getPool().query(
      `SELECT * FROM zamak_threats WHERE store_name = $1 ORDER BY device_name, threat_name`, [storeName]
    );
    return rows;
  }
  const { rows } = await getPool().query(`SELECT * FROM zamak_threats ORDER BY store_name, device_name, threat_name`);
  return rows;
}

async function replaceZamakPerformance(rows) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM zamak_performance');
    for (const r of rows) {
      await client.query(
        `INSERT INTO zamak_performance
          (device_id, device_name, store_name, cpu_avg, cpu_peak, ram_total_mb, ram_avail_avg, disk_time_avg, cached_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          r.device_id, r.device_name, r.store_name,
          r.cpu_avg ?? null, r.cpu_peak ?? null,
          r.ram_total_mb ?? null, r.ram_avail_avg ?? null,
          r.disk_time_avg ?? null, r.cached_at,
        ]
      );
    }
  });
}

async function getZamakPerformance(storeName) {
  if (storeName) {
    const { rows } = await getPool().query(
      `SELECT * FROM zamak_performance WHERE store_name = $1 ORDER BY device_name`, [storeName]
    );
    return rows;
  }
  const { rows } = await getPool().query(`SELECT * FROM zamak_performance ORDER BY store_name, device_name`);
  return rows;
}

// `outage_id TEXT UNIQUE` é nullable -- Postgres (igual SQLite) trata NULL
// como distinto em constraint UNIQUE, então linhas sem outage_id nunca
// "conflitam" e sempre inserem, igual o INSERT OR IGNORE original.
async function replaceZamakOutages(rows) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM zamak_outages');
    for (const r of rows) {
      await client.query(
        `INSERT INTO zamak_outages
          (outage_id, device_id, device_name, store_name, reason, state, utc_start, utc_end, duration_min, check_description, cached_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (outage_id) DO NOTHING`,
        [
          r.outage_id, r.device_id, r.device_name, r.store_name,
          r.reason, r.state, r.utc_start, r.utc_end ?? null,
          r.duration_min ?? null, r.check_description ?? null, r.cached_at,
        ]
      );
    }
  });
}

async function getZamakOutages(storeName) {
  if (storeName) {
    const { rows } = await getPool().query(
      `SELECT * FROM zamak_outages WHERE store_name = $1 ORDER BY utc_start DESC`, [storeName]
    );
    return rows;
  }
  const { rows } = await getPool().query(`SELECT * FROM zamak_outages ORDER BY utc_start DESC`);
  return rows;
}

// ── NCR Monitor — Check de Encomendas ────────────────────────────────────────

async function ncrInsertEmail(row) {
  const result = await getPool().query(
    `INSERT INTO ncr_monitor_emails
      (message_id, received_at, order_ref, enterprise_unit_id, store_name,
       boh_hostname, machine_id, total_value, date_brt, lead_minutes, products_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (message_id) DO NOTHING`,
    [
      row.message_id, row.received_at, row.order_ref || null,
      row.enterprise_unit_id || null, row.store_name || null,
      row.boh_hostname || null, row.machine_id || null,
      row.total_value != null ? row.total_value : null,
      row.date_brt || null,
      row.lead_minutes || 0,
      row.products_json || null,
    ]
  );
  return result.rowCount;
}

async function ncrGetByMessageId(messageId) {
  const { rows } = await getPool().query('SELECT * FROM ncr_monitor_emails WHERE message_id = $1', [messageId]);
  return rows[0];
}

async function ncrGetByCommandId(commandId) {
  const { rows } = await getPool().query('SELECT * FROM ncr_monitor_emails WHERE command_id = $1', [commandId]);
  return rows[0];
}

async function ncrUpdate(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
  await getPool().query(
    `UPDATE ncr_monitor_emails SET ${set} WHERE id=$${keys.length + 1}`,
    [...keys.map(k => fields[k]), id]
  );
}

// `datetime(x) <= datetime('now')` do original só normaliza formato de data
// antes de comparar -- next_retry_at já é sempre `toISOString()` (confirmado
// no único call site, routes/agent.js:373), então comparação direta de
// string funciona igual (mesma convenção de timestamp-como-TEXT usada em
// todo o resto do db-pg.js).
async function ncrGetPendingRetries() {
  const now = new Date().toISOString();
  const { rows } = await getPool().query(
    `SELECT * FROM ncr_monitor_emails
     WHERE danfe_found IS NULL
       AND retry_count > 0
       AND retry_count < 5
       AND machine_id IS NOT NULL
       AND (next_retry_at IS NULL OR next_retry_at <= $1)
       AND command_id IS NOT NULL`,
    [now]
  );
  return rows;
}

async function ncrGetAckTimedOut(cutoffIso) {
  const { rows } = await getPool().query(
    `SELECT e.id, e.order_ref, e.boh_hostname, e.command_id,
            c.created_at AS cmd_created_at
     FROM ncr_monitor_emails e
     JOIN commands c ON c.id = e.command_id
     WHERE e.danfe_found IS NULL
       AND e.machine_id IS NOT NULL
       AND e.command_id IS NOT NULL
       AND e.notified_at IS NULL
       AND c.acked_at IS NULL
       AND c.created_at < $1`,
    [cutoffIso]
  );
  return rows;
}

// ── Monitoramento de serviços NCR Voyix (BOH) ───────────────────────────────────

async function upsertServiceStatus(machineId, serviceName, status, lastRestartAt, lastRestartOk) {
  const now = new Date().toISOString();
  await getPool().query(
    `INSERT INTO service_status (machine_id, service_name, status, last_restart_at, last_restart_ok, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (machine_id, service_name) DO UPDATE SET
       status          = EXCLUDED.status,
       last_restart_at = EXCLUDED.last_restart_at,
       last_restart_ok = EXCLUDED.last_restart_ok,
       updated_at      = EXCLUDED.updated_at`,
    [machineId, serviceName, status, lastRestartAt ?? null, lastRestartOk ?? null, now]
  );
}

// `UPPER(m.hostname) LIKE '%BOH'` não precisa de ILIKE: o lado esquerdo já é
// forçado pra uppercase e o padrão já é literal uppercase, então a
// case-sensitividade do LIKE nunca entra em jogo aqui -- diferente de
// searchNFCe (Grupo 6), onde o termo de busca vinha direto do usuário.
async function getServiceStatusBOH() {
  const { rows } = await getPool().query(
    `SELECT s.machine_id, s.service_name, s.status AS service_status,
            s.last_restart_at, s.last_restart_ok, s.updated_at
     FROM service_status s
     JOIN machines m ON m.id = s.machine_id
     WHERE UPPER(m.hostname) LIKE '%BOH'
     ORDER BY m.hostname, s.service_name`
  );
  return rows;
}

// ── Ponto Remoto (REP-P/REP-A) ────────────────────────────────────────────────
// Funcionários elegíveis batem ponto via celular/web, fora do fluxo dos
// relógios Henry Hexa físicos (REP-C). remote_time_entries é append-only por
// design — nenhuma função aqui faz UPDATE/DELETE num registro já criado; uma
// correção administrativa sempre insere uma nova linha referenciando a
// original (corrects_id), preservando a trilha de auditoria exigida pela
// Portaria MTP 671/2021. Dado sensível (cpf, password_hash, lat/lng) --
// nenhum teste/comentário deste grupo deve imprimir valor real nenhum.
// Último grupo do port (14/14) -- tradução 1:1, sem padrão novo.

async function createRemoteEmployee({ cpf, name, store, passwordHash }) {
  const now = new Date().toISOString();
  const { rows } = await getPool().query(
    `INSERT INTO remote_employees (cpf, name, store, password_hash, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING *`,
    [cpf, name, store, passwordHash, now, now]
  );
  return rows[0];
}

// `SELECT *` devolve password_hash junto -- IGUAL ao original, de propósito,
// não um descuido do port: o único caller real (routes/pontoRemoto.js, rota
// de login) usa `employee.password_hash` direto pra `verifyPassword()` na
// MESMA chamada -- tirar a coluna daqui quebraria o login assim que a
// Fase 4 trocar pro require('./db-pg'). Confirmado que o hash nunca escapa
// num response HTTP: todo `res.json` que usa `req.employee` (vindo de
// getRemoteEmployeeById via middleware/employeeAuth.js) seleciona campos
// específicos (`{ name, store }`), nunca serializa o objeto inteiro.
async function getRemoteEmployeeByCpf(cpf) {
  const { rows } = await getPool().query('SELECT * FROM remote_employees WHERE cpf = $1', [cpf]);
  return rows[0];
}

async function getRemoteEmployeeById(id) {
  const { rows } = await getPool().query('SELECT * FROM remote_employees WHERE id = $1', [id]);
  return rows[0];
}

async function listRemoteEmployees() {
  const { rows } = await getPool().query(
    `SELECT id, cpf, name, store, active, created_at, updated_at FROM remote_employees ORDER BY name`
  );
  return rows;
}

async function setRemoteEmployeeActive(id, active) {
  await getPool().query(
    'UPDATE remote_employees SET active = $1, updated_at = $2 WHERE id = $3',
    [active ? 1 : 0, new Date().toISOString(), id]
  );
}

async function createRemoteSession({ tokenHash, employeeId, createdAt, expiresAt }) {
  await getPool().query(
    `INSERT INTO remote_sessions (token_hash, employee_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
    [tokenHash, employeeId, createdAt, expiresAt]
  );
}

async function getRemoteSession(tokenHash) {
  const { rows } = await getPool().query('SELECT * FROM remote_sessions WHERE token_hash = $1', [tokenHash]);
  return rows[0];
}

async function deleteRemoteSession(tokenHash) {
  await getPool().query('DELETE FROM remote_sessions WHERE token_hash = $1', [tokenHash]);
}

async function insertRemoteTimeEntry({ employeeId, type, serverTs, lat, lng, accuracy, withinGeofence, correctsId, correctionReason, createdBy }) {
  const now = new Date().toISOString();
  const { rows } = await getPool().query(
    `INSERT INTO remote_time_entries
      (employee_id, type, server_ts, lat, lng, accuracy, within_geofence, corrects_id, correction_reason, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      employeeId, type, serverTs,
      lat ?? null, lng ?? null, accuracy ?? null,
      withinGeofence === null || withinGeofence === undefined ? null : (withinGeofence ? 1 : 0),
      correctsId ?? null, correctionReason ?? null,
      createdBy || 'employee', now,
    ]
  );
  return rows[0];
}

async function getRemoteTimeEntryById(id) {
  const { rows } = await getPool().query('SELECT * FROM remote_time_entries WHERE id = $1', [id]);
  return rows[0];
}

async function listRemoteTimeEntriesForEmployee(employeeId, limit = 200) {
  const { rows } = await getPool().query(
    `SELECT * FROM remote_time_entries WHERE employee_id = $1 ORDER BY server_ts DESC LIMIT $2`,
    [employeeId, limit]
  );
  return rows;
}

async function listAllRemoteTimeEntries({ employeeId = null, limit = 500 } = {}) {
  if (employeeId) {
    const { rows } = await getPool().query(
      `SELECT * FROM remote_time_entries WHERE employee_id = $1 ORDER BY server_ts DESC LIMIT $2`,
      [employeeId, limit]
    );
    return rows;
  }
  const { rows } = await getPool().query(
    `SELECT * FROM remote_time_entries ORDER BY server_ts DESC LIMIT $1`,
    [limit]
  );
  return rows;
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
  registerMachine,
  updateMachineDRStatus, insertDRBackup, getDRHistory, getDROverview, getMachinesDRDue,
  createWatchlistKeyword, getWatchlistKeywords, getActiveWatchlistKeywords,
  setWatchlistKeywordActive, deleteWatchlistKeyword,
  insertActivityLog, getActivityLog, purgeActivityLog,
  createLiveSession, getLiveSession, endLiveSession, setLiveSessionRecorded,
  registerRef1, getMaxRef1,
  isCriticalMachine, getTopics, getAllStoresTopicCount, createTopic, updateTopic,
  resolveTopic, moveTopic, replicateTopic, getTopicsHistory,
  getFreshdeskCacheAge, upsertFreshdeskTickets, getFreshdeskActive, getFreshdeskClosed,
  saveReportRun, getReportHistory, getRecentReportRun,
  saveFeedback, getRecentFeedback, getStoresOverview,
  insertMetricsHourly, getWeightedMetricsForStore,
  insertOfflineEvent, getOfflineEventsForStore,
  insertReadingMiss, getReadingMissesForDate, getReadingMissesForMonth,
  getMachinesOnlineMissingReading, getMachineDataForMonth, getMachinesWithoutMetrics,
  getDailyMetricsSummary, getHourlyMetricsDiag,
  upsertZamakDevices, replaceZamakDiscrepancies, getIntegrationsStatus,
  getZamakCachedDeviceIds, getZamakCacheAge, getZamakSummaryForStore, getZamakDiscrepancies,
  replaceZamakThreats, getZamakThreats, replaceZamakPerformance, getZamakPerformance,
  replaceZamakOutages, getZamakOutages,
  ncrInsertEmail, ncrGetByMessageId, ncrGetByCommandId, ncrUpdate,
  ncrGetPendingRetries, ncrGetAckTimedOut,
  upsertServiceStatus, getServiceStatusBOH,
  createRemoteEmployee, getRemoteEmployeeByCpf, getRemoteEmployeeById,
  listRemoteEmployees, setRemoteEmployeeActive,
  createRemoteSession, getRemoteSession, deleteRemoteSession,
  insertRemoteTimeEntry, getRemoteTimeEntryById,
  listRemoteTimeEntriesForEmployee, listAllRemoteTimeEntries,
};
