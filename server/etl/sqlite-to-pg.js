'use strict';

// ETL único (Fase 3 da migração pós-incidente 15/11/2026 -- ver memória do
// projeto project_delirio_manager_incidente_sqlite_15_11.md). Lê uma CÓPIA
// do SQLite de produção (nunca o arquivo ao vivo -- sempre um backup tirado
// via `sqlite3 <origem> ".backup <copia>"`, Online Backup API) e carrega o
// mesmo dado em server/db-pg.js's schema (server/migrations/*). NUNCA
// importado por app.js/server.js/rotas -- roda só manual via CLI. Zero
// escrita no SQLite (aberto readonly); escreve só no Postgres de DATABASE_URL.
//
// Ordem de tabelas respeita o grafo de FK (ver
// server/migrations/1794796556368_add-on-update-cascade-machine-fks.sql +
// as FKs já inline no schema inicial): nível 0 sem FK de saída, nível 1 com
// FK pra machines/remote_employees, nível 2 (watchlist_matches) com FK pra
// activity_log. remote_time_entries tem FK pra si mesma (corrects_id) --
// carregada em ordem ascendente de id resolve isso sem lock especial, já
// que corrects_id sempre aponta pra um id anterior (append-only).
//
// Uso:
//   node server/etl/sqlite-to-pg.js --dry-run --sqlite-path=<copia.db>
//   node server/etl/sqlite-to-pg.js --load --truncate-first --sqlite-path=<copia.db>
// DATABASE_URL precisa estar no ambiente (ver server/.env.postgres.example).
//
// Recuperação após queda no meio da carga: cada tabela é carregada em
// batches autocommit independentes (sem transação cobrindo a tabela
// inteira), então uma queda no meio deixa ESSA tabela parcialmente
// carregada. Toda tabela tem PK (ver server/migrations/1794791426884_*),
// então um rerun SEM --truncate-first falha alto com violação de PK em vez
// de duplicar silenciosamente -- mas a recuperação correta é sempre rodar
// de novo com --truncate-first (reseta as 38 tabelas e recarrega do zero),
// nunca tentar "completar" uma tabela parcial manualmente.

const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const BATCH_SIZE = 500;

// Postgres rejeita \u0000 em qualquer coluna de texto (SQLite aceita --
// achado real na Fase 3 com dado de produção: 25/50049 linhas de `commands`
// tinham NUL byte dentro de `result` (saída crua capturada de agente
// Windows, ex: hourlySnapshot/wevtutil com mojibake de encoding). O byte
// nunca é visível/significativo pro usuário -- strip é seguro, mas conta
// quantas vezes aconteceu por tabela pra não esconder o problema de
// origem silenciosamente.
function stripNulBytes(value) {
  return typeof value === 'string' && value.includes('\u0000') ? value.split('\u0000').join('') : value;
}

const TABLE_ORDER = [
  // nível 0 -- sem FK de saída
  'machines', 'metrics', 'commands', 'events', 'alerts', 'groups',
  'clock_offboard_log', 'clock_operation_log', 'nfce_auto_email_log',
  'watchlist_keywords', 'ref1_registry', 'report_topics', 'report_topics_history',
  'freshdesk_cache', 'report_runs', 'report_feedback', 'deleted_machines',
  'zamak_device_cache', 'zamak_threats', 'zamak_discrepancies', 'zamak_performance',
  'zamak_outages', 'ncr_monitor_emails', 'service_status', 'remote_employees',
  // nível 1 -- FK pra machines ou remote_employees
  'win_events', 'insights', 'nfce_index', 'nfce_indexed_days', 'dr_backups',
  'activity_log', 'live_sessions', 'machine_metrics_hourly', 'machine_offline_events',
  'reading_miss_events', 'remote_sessions', 'remote_time_entries',
  // nível 2 -- FK pra activity_log
  'watchlist_matches',
];

function validateArgs(args) {
  if (!args.mode) throw new Error('passe --dry-run ou --load');
  if (!args.sqlitePath) throw new Error('passe --sqlite-path=<caminho da cópia do .db>');
  if (args.onlyTable && !TABLE_ORDER.includes(args.onlyTable)) {
    throw new Error(`--table="${args.onlyTable}" não é uma tabela conhecida (ver TABLE_ORDER)`);
  }
  if (args.onlyTable && args.truncateFirst) {
    throw new Error('--truncate-first + --table= não é seguro: truncate sempre afeta as 38 tabelas, ' +
      'apagaria as outras 37 sem recarregá-las. Rode --truncate-first sem --table= (carga completa), ' +
      'ou --table= sozinho pra recarregar uma tabela específica sem truncar nada.');
  }
}

function parseArgs(argv) {
  const args = { mode: null, truncateFirst: false, sqlitePath: null, onlyTable: null };
  for (const raw of argv.slice(2)) {
    if (raw === '--dry-run') args.mode = 'dry-run';
    else if (raw === '--load') args.mode = 'load';
    else if (raw === '--truncate-first') args.truncateFirst = true;
    else if (raw.startsWith('--sqlite-path=')) args.sqlitePath = raw.slice('--sqlite-path='.length);
    else if (raw.startsWith('--table=')) args.onlyTable = raw.slice('--table='.length);
    else throw new Error(`argumento desconhecido: ${raw}`);
  }
  validateArgs(args);
  return args;
}

function sqlitePkColumns(sqlite, table) {
  const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all();
  return cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
}

function sqliteColumnNames(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
}

async function pgColumnInfo(pool, table) {
  const { rows } = await pool.query(
    `SELECT column_name, is_identity FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table]
  );
  if (rows.length === 0) throw new Error(`tabela "${table}" não existe no Postgres (schema não migrado?)`);
  return {
    columns: rows.map(r => r.column_name),
    identityColumn: rows.find(r => r.is_identity === 'YES')?.column_name || null,
  };
}

function assertSameColumnSet(table, sqliteCols, pgCols) {
  const a = [...sqliteCols].sort();
  const b = [...pgCols].sort();
  if (a.length !== b.length || a.some((c, i) => c !== b[i])) {
    throw new Error(
      `tabela "${table}": colunas divergem entre SQLite [${a.join(',')}] e Postgres [${b.join(',')}] -- ` +
      `schema desalinhado, abortando (ETL não deve "adivinhar" coluna faltante)`
    );
  }
}

async function countRows(db, table) {
  if (typeof db.prepare === 'function') {
    return db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
  }
  const { rows } = await db.query(`SELECT COUNT(*) AS c FROM "${table}"`);
  return Number(rows[0].c);
}

async function runDryRun(sqlite, pool, tables) {
  console.log('--- dry-run: contagem origem (SQLite) vs destino (Postgres) ---');
  let hasDiff = false;
  for (const table of tables) {
    const srcCount = await countRows(sqlite, table);
    let dstCount = 'n/a';
    try {
      dstCount = await countRows(pool, table);
    } catch (err) {
      dstCount = `erro: ${err.message}`;
    }
    const diff = srcCount !== dstCount ? '  <-- diferente' : '';
    if (diff) hasDiff = true;
    console.log(`${table.padEnd(28)} origem=${String(srcCount).padStart(10)}  destino=${String(dstCount).padStart(10)}${diff}`);
  }
  console.log(hasDiff ? '\nContagens batem apenas onde já carregado -- normal antes do --load.' : '\nTudo igual.');
}

async function truncateAll(pool, tables) {
  const list = tables.map(t => `"${t}"`).join(', ');
  console.log(`TRUNCATE ${tables.length} tabelas (RESTART IDENTITY)...`);
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

async function loadTable(sqlite, pool, table) {
  const { columns, identityColumn } = await pgColumnInfo(pool, table);
  const sqliteCols = sqliteColumnNames(sqlite, table);
  assertSameColumnSet(table, sqliteCols, columns);

  const pkCols = sqlitePkColumns(sqlite, table);
  const colList = columns.map(c => `"${c}"`).join(', ');
  const orderClause = pkCols.length ? ` ORDER BY ${pkCols.map(c => `"${c}"`).join(', ')}` : '';
  const selectSql = `SELECT ${colList} FROM "${table}"${orderClause}`;

  const overriding = identityColumn ? ' OVERRIDING SYSTEM VALUE' : '';
  const client = await pool.connect();
  let total = 0;
  let nulCount = 0;
  try {
    const iter = sqlite.prepare(selectSql).iterate();
    let batch = [];

    async function flush() {
      if (batch.length === 0) return;
      const params = [];
      const valueGroups = batch.map((row, i) => {
        const placeholders = columns.map((_, j) => `$${i * columns.length + j + 1}`);
        for (const col of columns) {
          const raw = row[col];
          const clean = stripNulBytes(raw);
          if (clean !== raw) nulCount++;
          params.push(clean);
        }
        return `(${placeholders.join(',')})`;
      });
      const sql = `INSERT INTO "${table}" (${colList})${overriding} VALUES ${valueGroups.join(',')}`;
      await client.query(sql, params);
      total += batch.length;
      batch = [];
    }

    for (const row of iter) {
      batch.push(row);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();

    if (identityColumn) {
      const { rows } = await client.query(`SELECT COALESCE(MAX("${identityColumn}"),0) AS max_id FROM "${table}"`);
      const nextVal = Number(rows[0].max_id) + 1;
      await client.query('SELECT setval(pg_get_serial_sequence($1,$2), $3, false)', [table, identityColumn, nextVal]);
    }
  } catch (err) {
    client.release(err); // descarta o client (não devolve pro pool) em erro de conexão, não só de dado
    throw err;
  }
  client.release();
  const nulSuffix = nulCount > 0 ? ` (${nulCount} valor(es) com NUL byte removido)` : '';
  console.log(`${table.padEnd(28)} ${total} linhas carregadas${nulSuffix}`);
  return total;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não setada (ver server/.env.postgres.example)');

  const sqlite = new Database(path.resolve(args.sqlitePath), { readonly: true, fileMustExist: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', err => console.error('[etl] pool error', err.message));

  const tables = args.onlyTable ? [args.onlyTable] : TABLE_ORDER;

  try {
    if (args.mode === 'dry-run') {
      await runDryRun(sqlite, pool, tables);
      return;
    }

    if (args.truncateFirst) await truncateAll(pool, TABLE_ORDER);

    let grandTotal = 0;
    for (const table of tables) {
      grandTotal += await loadTable(sqlite, pool, table);
    }
    console.log(`\nCarga concluída: ${grandTotal} linhas no total.`);
  } finally {
    sqlite.close();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[etl] falhou:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { TABLE_ORDER, parseArgs, validateArgs, assertSameColumnSet, sqlitePkColumns, sqliteColumnNames, countRows };
