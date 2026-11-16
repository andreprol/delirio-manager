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

module.exports = {
  getPool, closePool, withTransaction,
  getMachineByToken, getMachineById, getMachineByHostname, getAllMachines,
  deleteMachine, isDeletedMachine, updateMachine, setMachineStatus,
  getMachinesStale, setWolStatus, getMachinesWolTesting, getMachinesBiosNeeded,
  getMachinesOfflineForWake, getMachinesAutoWolTesting, updateMachineInsightCursor,
  saveMetrics, getMetrics,
};
