'use strict';

/**
 * Testes de recordDbSizeSnapshot / getLatestDbSizeByTable / getDbSizeGrowth /
 * purgeDbSizeSnapshots (server/db-pg.js) contra um Postgres real (instância
 * dev). db_size_snapshots não tem FK -- limpeza manual via DELETE direto
 * (não há coluna de identificação única por teste além do id gerado).
 */

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.dbsize.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (db_size_snapshots)', () => {
  let db;
  const createdIds = [];

  const createdAlertTables = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdIds.length) {
      await pool.query('DELETE FROM db_size_snapshots WHERE id=$1', [createdIds.pop()]);
    }
    while (createdAlertTables.length) {
      await pool.query('DELETE FROM db_size_alerts_sent WHERE table_name=$1', [createdAlertTables.pop()]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  async function insertSnapshot(tableName, bytes, rows, daysAgo) {
    const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const { rows: inserted } = await db.getPool().query(
      `INSERT INTO db_size_snapshots (table_name, bytes_total, row_count, snapshot_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tableName, bytes, rows, at]
    );
    createdIds.push(inserted[0].id);
    return inserted[0].id;
  }

  describe('recordDbSizeSnapshot', () => {
    it('grava 1 linha por tabela de usuário e retorna quantas tabelas', async () => {
      const before = (await db.getPool().query('SELECT count(*) FROM db_size_snapshots')).rows[0].count;
      const count = await db.recordDbSizeSnapshot();
      expect(count).toBeGreaterThan(0); // pelo menos machines, commands etc existem no schema
      const after = (await db.getPool().query('SELECT count(*) FROM db_size_snapshots')).rows[0].count;
      expect(Number(after)).toBe(Number(before) + count);
      // limpeza do snapshot real gravado (não rastreado por createdIds -- apaga pelo snapshot_at do teste)
      await db.getPool().query(`DELETE FROM db_size_snapshots WHERE snapshot_at > $1`, [new Date(Date.now() - 5000).toISOString()]);
    });
  });

  describe('getLatestDbSizeByTable', () => {
    it('traz só o snapshot mais recente de cada tabela', async () => {
      const tableName = `fake_tbl_${Date.now()}`;
      await insertSnapshot(tableName, 1000, 10, 5);
      await insertSnapshot(tableName, 2000, 20, 0);

      const latest = await db.getLatestDbSizeByTable();
      const row = latest.find(r => r.table_name === tableName);
      expect(Number(row.bytes_total)).toBe(2000);
      expect(Number(row.row_count)).toBe(20);
    });
  });

  describe('getDbSizeGrowth', () => {
    it('calcula crescimento comparando com o snapshot mais próximo de N dias atrás', async () => {
      const tableName = `fake_growth_${Date.now()}`;
      await insertSnapshot(tableName, 1_000_000, 100, 10); // antes do corte de 7d
      await insertSnapshot(tableName, 2_000_000, 200, 0);  // agora

      const growth = await db.getDbSizeGrowth(7);
      const row = growth.find(r => r.table_name === tableName);
      expect(row).toBeDefined();
      expect(row.bytesNow).toBe(2_000_000);
      expect(row.bytesBefore).toBe(1_000_000);
      expect(row.growthBytes).toBe(1_000_000);
      expect(row.growthPct).toBeCloseTo(100, 0);
    });

    it('tabela sem snapshot antigo o bastante fica de fora', async () => {
      const tableName = `fake_recent_only_${Date.now()}`;
      await insertSnapshot(tableName, 1000, 1, 0); // só hoje, nada de 7d atrás

      const growth = await db.getDbSizeGrowth(7);
      expect(growth.find(r => r.table_name === tableName)).toBeUndefined();
    });
  });

  describe('purgeDbSizeSnapshots', () => {
    it('remove só snapshots mais velhos que N dias', async () => {
      const tableName = `fake_purge_${Date.now()}`;
      const oldId = await insertSnapshot(tableName, 1000, 1, 200);
      const recentId = await insertSnapshot(tableName, 2000, 2, 1);

      const removed = await db.purgeDbSizeSnapshots(180);
      expect(removed).toBeGreaterThanOrEqual(1);

      const { rows } = await db.getPool().query('SELECT id FROM db_size_snapshots WHERE id = ANY($1)', [[oldId, recentId]]);
      const remainingIds = rows.map(r => r.id);
      expect(remainingIds).not.toContain(oldId);
      expect(remainingIds).toContain(recentId);
      createdIds.length = 0; // oldId já foi apagado pelo purge; recentId segue rastreado abaixo
      createdIds.push(recentId);
    });

    it('days inválido (<=0 ou NaN) não lança e retorna 0', async () => {
      await expect(db.purgeDbSizeSnapshots(0)).resolves.toBe(0);
      await expect(db.purgeDbSizeSnapshots(NaN)).resolves.toBe(0);
    });
  });

  describe('getTablesAlertedWithinDays / recordAlertsSent', () => {
    it('recordAlertsSent grava e getTablesAlertedWithinDays traz de volta dentro da janela', async () => {
      const tableName = `fake_alert_${Date.now()}`;
      createdAlertTables.push(tableName);
      await db.recordAlertsSent([{ table_name: tableName, bytesNow: 1000 }]);

      const within = await db.getTablesAlertedWithinDays(7);
      expect(within).toContain(tableName);

      const withinZero = await db.getTablesAlertedWithinDays(0);
      expect(withinZero).not.toContain(tableName); // janela de 0 dias não cobre "agora mesmo" (cutoff = now)
    });

    it('recordAlertsSent faz upsert (segunda chamada atualiza alerted_at, não duplica)', async () => {
      const tableName = `fake_alert_upsert_${Date.now()}`;
      createdAlertTables.push(tableName);
      await db.recordAlertsSent([{ table_name: tableName, bytesNow: 1000 }]);
      await db.recordAlertsSent([{ table_name: tableName, bytesNow: 2000 }]);

      const { rows } = await db.getPool().query('SELECT bytes_at_alert FROM db_size_alerts_sent WHERE table_name=$1', [tableName]);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].bytes_at_alert)).toBe(2000);
    });

    it('recordAlertsSent([]) é noop', async () => {
      await expect(db.recordAlertsSent([])).resolves.toBeUndefined();
    });
  });
});
