'use strict';

/**
 * Testes do Grupo 11 (machine_metrics_hourly, machine_offline_events,
 * reading_miss_events) de server/db-pg.js contra um Postgres real
 * (instância dev). Todas as 3 tabelas têm FK ON DELETE CASCADE pra
 * machines -- limpeza só via afterEach apagando a máquina.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.metricashorarias.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 11: métricas horárias/offline/reading-miss)', () => {
  let db;
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdMachineIds.length) {
      await pool.query('DELETE FROM machines WHERE id=$1', [createdMachineIds.pop()]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  async function insertMachine(location) {
    const id = crypto.randomUUID();
    createdMachineIds.push(id);
    await db.getPool().query(
      `INSERT INTO machines (id, hostname, token, registered_at, location, status) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, `HOST-${id.slice(0, 8)}`, crypto.randomUUID(), new Date().toISOString(), location || 'Loja Teste', 'online']
    );
    return id;
  }

  function tsAt(daysAgo, hour) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  describe('insertMetricsHourly / getWeightedMetricsForStore', () => {
    it('grava com hour_weight correto (2 no horário comercial, 1 fora) e atualiza last_hourly_at', async () => {
      const id = await insertMachine();
      const comercial = tsAt(0, 14); // 14h -- dentro de 8-22
      const madrugada = tsAt(0, 3); // 3h -- fora

      await db.insertMetricsHourly(id, { snapshotTs: comercial, cpuPct: 50 });
      await db.insertMetricsHourly(id, { snapshotTs: madrugada, cpuPct: 10 });

      const { rows } = await db.getPool().query(
        'SELECT snapshot_ts, hour_weight FROM machine_metrics_hourly WHERE machine_id=$1 ORDER BY snapshot_ts',
        [id]
      );
      const weights = Object.fromEntries(rows.map(r => [r.snapshot_ts, r.hour_weight]));
      expect(weights[madrugada]).toBe(1);
      expect(weights[comercial]).toBe(2);

      const m = await db.getMachineById(id);
      expect(m.last_hourly_at).not.toBeNull();
    });

    it('getWeightedMetricsForStore calcula média ponderada e total_readings como number', async () => {
      const location = `LOJA-${crypto.randomUUID().slice(0, 8)}`;
      const id = await insertMachine(location);
      const month = new Date().toISOString().slice(0, 7);

      await db.insertMetricsHourly(id, { snapshotTs: tsAt(0, 14), cpuPct: 80 }); // weight 2
      await db.insertMetricsHourly(id, { snapshotTs: tsAt(0, 3), cpuPct: 20 }); // weight 1

      const result = await db.getWeightedMetricsForStore(location, month);
      expect(typeof result.total_readings).toBe('number');
      expect(result.total_readings).toBe(2);
      // (80*2 + 20*1) / (2+1) = 60
      expect(result.avg_cpu_pct).toBeCloseTo(60, 5);
    });

    it('getWeightedMetricsForStore sem nenhuma leitura devolve o fallback', async () => {
      const location = `LOJA-VAZIA-${crypto.randomUUID().slice(0, 8)}`;
      const result = await db.getWeightedMetricsForStore(location, '2020-01');
      expect(result).toEqual({
        avg_cpu_pct: null, avg_ram_pct: null, avg_disk_pct: null, avg_cpu_temp: null, total_readings: 0,
      });
    });
  });

  describe('insertOfflineEvent / getOfflineEventsForStore', () => {
    it('conta eventos offline da loja no mês, como number', async () => {
      const location = `LOJA-OFF-${crypto.randomUUID().slice(0, 8)}`;
      const id = await insertMachine(location);
      const now = new Date();
      const month = now.toISOString().slice(0, 7);

      await db.insertOfflineEvent(id, {
        offlineAt: now.toISOString(), onlineAt: new Date(now.getTime() + 60000).toISOString(), durationMin: 1,
      });

      const total = await db.getOfflineEventsForStore(location, month);
      expect(total).toBe(1);
      expect(typeof total).toBe('number');
    });
  });

  describe('insertReadingMiss / getReadingMissesForDate / getReadingMissesForMonth', () => {
    it('grava e lê por data exata, com dados da máquina via JOIN', async () => {
      const id = await insertMachine();
      const todayStr = new Date().toISOString().slice(0, 10);
      const expectedHour = Math.floor(new Date(`${todayStr}T10:00:00Z`).getTime() / 1000);

      await db.insertReadingMiss(id, {
        expectedHour, machineStatus: 'online', agentVersion: '1.0', diagnosis: 'timeout',
      });

      const misses = await db.getReadingMissesForDate(todayStr);
      const mine = misses.find(m => m.machine_id === id);
      expect(mine).toBeDefined();
      expect(mine.diagnosis).toBe('timeout');
      expect(mine.hostname).toBeDefined(); // veio do JOIN
    });

    it('getReadingMissesForMonth agrega total/online/offline misses como number', async () => {
      const location = `LOJA-MISS-${crypto.randomUUID().slice(0, 8)}`;
      const id = await insertMachine(location);
      const month = new Date().toISOString().slice(0, 7);
      const baseHour = tsAt(0, 10);

      await db.insertReadingMiss(id, { expectedHour: baseHour, machineStatus: 'online' });
      await db.insertReadingMiss(id, { expectedHour: baseHour + 3600, machineStatus: 'offline' });
      await db.insertReadingMiss(id, { expectedHour: baseHour + 7200, machineStatus: 'offline' });

      const results = await db.getReadingMissesForMonth(location, month);
      expect(results).toHaveLength(1);
      expect(results[0].total_misses).toBe(3);
      expect(results[0].online_misses).toBe(1);
      expect(results[0].offline_misses).toBe(2);
      expect(typeof results[0].total_misses).toBe('number');
    });
  });

  describe('getMachinesOnlineMissingReading', () => {
    it('traz só máquinas online cuja última leitura é nula ou antiga (HAVING sem alias)', async () => {
      const missingId = await insertMachine();
      const recentId = await insertMachine();
      const offlineId = await insertMachine();
      await db.updateMachine(offlineId, {}); // noop, só pra reutilizar helper
      await db.setMachineStatus(offlineId, 'offline');

      await db.insertMetricsHourly(recentId, { snapshotTs: Math.floor(Date.now() / 1000), cpuPct: 1 });
      // missingId nunca recebeu metrics -- last_snapshot_ts deve ser NULL

      const sinceTs = Math.floor(Date.now() / 1000) - 3600;
      const missing = await db.getMachinesOnlineMissingReading(sinceTs);
      const ids = missing.map(m => m.id);
      expect(ids).toContain(missingId);
      expect(ids).not.toContain(recentId);
      expect(ids).not.toContain(offlineId); // offline não entra, só online
    });
  });

  describe('getMachineDataForMonth / getMachinesWithoutMetrics', () => {
    it('getMachineDataForMonth calcula médias e reading_count como number, inclui máquina sem leitura (LEFT JOIN)', async () => {
      const location = `LOJA-MONTH-${crypto.randomUUID().slice(0, 8)}`;
      const withDataId = await insertMachine(location);
      const withoutDataId = await insertMachine(location);
      const month = new Date().toISOString().slice(0, 7);

      await db.insertMetricsHourly(withDataId, { snapshotTs: tsAt(0, 12), cpuPct: 40, ramPct: 50, diskPct: 60 });

      const data = await db.getMachineDataForMonth(location, month);
      const withData = data.find(d => d.id === withDataId);
      const withoutData = data.find(d => d.id === withoutDataId);
      expect(withData.reading_count).toBe(1);
      expect(typeof withData.reading_count).toBe('number');
      expect(Number(withData.avg_cpu)).toBeCloseTo(40, 5);
      expect(withoutData.reading_count).toBe(0); // LEFT JOIN preserva a linha
    });

    it('getMachinesWithoutMetrics só traz quem não tem nenhuma leitura no mês', async () => {
      const location = `LOJA-NOMETRICS-${crypto.randomUUID().slice(0, 8)}`;
      const withDataId = await insertMachine(location);
      const withoutDataId = await insertMachine(location);
      const month = new Date().toISOString().slice(0, 7);

      await db.insertMetricsHourly(withDataId, { snapshotTs: tsAt(0, 12), cpuPct: 1 });

      const without = await db.getMachinesWithoutMetrics(location, month);
      const ids = without.map(m => m.id);
      expect(ids).toContain(withoutDataId);
      expect(ids).not.toContain(withDataId);
    });
  });

  describe('getDailyMetricsSummary / getHourlyMetricsDiag', () => {
    it('ambas trazem readings_24h como number, incluindo máquinas sem nenhuma leitura', async () => {
      const id = await insertMachine();
      await db.insertMetricsHourly(id, { snapshotTs: Math.floor(Date.now() / 1000) - 3600, cpuPct: 1 });

      const summary = await db.getDailyMetricsSummary();
      const mySummary = summary.find(m => m.id === id);
      expect(mySummary.readings_24h).toBe(1);
      expect(typeof mySummary.readings_24h).toBe('number');

      const diag = await db.getHourlyMetricsDiag();
      const myDiag = diag.find(m => m.id === id);
      expect(myDiag.readings_24h).toBe(1);
      expect(myDiag.last_snapshot_ts).not.toBeNull();
    });
  });
});
