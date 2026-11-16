'use strict';

// Validação pós-carga do ETL (server/etl/sqlite-to-pg.js) -- roda depois de
// um --load real. 2 checagens: (1) contagem de linhas por tabela, origem vs
// destino, tem que ser EXATAMENTE igual (esperamos carga completa, não
// incremental); (2) checksum de amostra em remote_employees.cpf/password_hash
// -- os 2 campos sensíveis que todo o resto da Fase 2 teve cuidado especial
// de não expor fora de lugar (ver registerRemoteEmployeeByCpf/ById em
// db-pg.js), então valem conferência extra de que o dado chegou intacto.
//
// Uso: node server/etl/validate.js --sqlite-path=<copia.db>
// DATABASE_URL precisa estar no ambiente.

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const { TABLE_ORDER } = require('./sqlite-to-pg');

function parseArgs(argv) {
  const args = { sqlitePath: null };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith('--sqlite-path=')) args.sqlitePath = raw.slice('--sqlite-path='.length);
  }
  if (!args.sqlitePath) throw new Error('passe --sqlite-path=<caminho da cópia do .db>');
  return args;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

async function validateCounts(sqlite, pool) {
  console.log('--- contagem por tabela ---');
  const mismatches = [];
  for (const table of TABLE_ORDER) {
    const src = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
    const { rows } = await pool.query(`SELECT COUNT(*) AS c FROM "${table}"`);
    const dst = Number(rows[0].c);
    const ok = src === dst;
    if (!ok) mismatches.push({ table, src, dst });
    console.log(`${table.padEnd(28)} origem=${String(src).padStart(10)}  destino=${String(dst).padStart(10)}  ${ok ? 'OK' : '<< DIFERENTE'}`);
  }
  return mismatches;
}

async function validateRemoteEmployeesChecksum(sqlite, pool) {
  console.log('\n--- checksum remote_employees (cpf, password_hash) ---');
  const srcRows = sqlite.prepare('SELECT id, cpf, password_hash FROM remote_employees ORDER BY id').all();
  if (srcRows.length === 0) {
    console.log('(tabela vazia, nada a comparar)');
    return [];
  }
  const { rows: dstRows } = await pool.query('SELECT id, cpf, password_hash FROM remote_employees ORDER BY id');
  const dstById = new Map(dstRows.map(r => [r.id, r]));

  const mismatches = [];
  for (const src of srcRows) {
    const dst = dstById.get(src.id);
    if (!dst) {
      mismatches.push({ id: src.id, reason: 'ausente no destino' });
      continue;
    }
    if (sha256(src.cpf) !== sha256(dst.cpf) || sha256(src.password_hash) !== sha256(dst.password_hash)) {
      mismatches.push({ id: src.id, reason: 'checksum diferente' });
    }
  }
  console.log(`${srcRows.length} funcionários comparados, ${mismatches.length} divergência(s).`);
  return mismatches;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não setada (ver server/.env.postgres.example)');

  const sqlite = new Database(path.resolve(args.sqlitePath), { readonly: true, fileMustExist: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', err => console.error('[validate] pool error', err.message));

  try {
    const countMismatches = await validateCounts(sqlite, pool);
    const checksumMismatches = await validateRemoteEmployeesChecksum(sqlite, pool);

    const totalProblems = countMismatches.length + checksumMismatches.length;
    if (totalProblems > 0) {
      console.error(`\n${totalProblems} problema(s) encontrado(s) -- NÃO considerar a carga válida.`);
      process.exitCode = 1;
    } else {
      console.log('\nValidação OK: contagens e checksums batem.');
    }
  } finally {
    sqlite.close();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[validate] falhou:', err.message);
    process.exitCode = 1;
  });
}
