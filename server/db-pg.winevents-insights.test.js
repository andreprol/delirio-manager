'use strict';

/**
 * Testes do Grupo 4 (win_events + insights) de server/db-pg.js contra um
 * Postgres real (instância dev). Mesmo padrão dos grupos anteriores.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.winevents-insights.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 4: win_events + insights)', () => {
  let db;
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdMachineIds.length) {
      const id = createdMachineIds.pop();
      await pool.query('DELETE FROM machines WHERE id=$1', [id]); // win_events/insights têm FK CASCADE
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  async function insertMachine() {
    const id = crypto.randomUUID();
    createdMachineIds.push(id);
    await db.getPool().query(
      `INSERT INTO machines (id, hostname, token, registered_at) VALUES ($1,$2,$3,$4)`,
      [id, `HOST-${id.slice(0, 8)}`, crypto.randomUUID(), new Date().toISOString()]
    );
    return id;
  }

  describe('saveWinEvents / getWinEvents / markWinEventsRead / countUnreadWinEvents', () => {
    it('grava em lote, lê de volta e purga eventos >30 dias', async () => {
      const machineId = await insertMachine();
      const now = new Date().toISOString();
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

      await db.saveWinEvents(machineId, [
        { eventTime: old, eventId: 41, source: 'Kernel', level: 'Error', translation: 'Antigo demais' },
        { eventTime: now, eventId: 41, source: 'Kernel', level: 'Error', translation: 'Recente' },
      ]);

      const all = await db.getWinEvents(machineId, 'all');
      expect(all).toHaveLength(1); // o antigo foi purgado pelo próprio saveWinEvents
      expect(all[0].translation).toBe('Recente');
    });

    it('scope focused só traz event_id da lista FOCUSED_EVENT_IDS', async () => {
      const machineId = await insertMachine();
      const now = new Date().toISOString();
      await db.saveWinEvents(machineId, [
        { eventTime: now, eventId: 41, source: 'Kernel', level: 'Error', translation: 'Focado' },
        { eventTime: now, eventId: 9999, source: 'Kernel', level: 'Info', translation: 'Fora da lista' },
      ]);

      const focused = await db.getWinEvents(machineId, 'focused');
      expect(focused.map(e => e.translation)).toEqual(['Focado']);

      const all = await db.getWinEvents(machineId, 'all');
      expect(all).toHaveLength(2);
    });

    it('markWinEventsRead zera countUnreadWinEvents', async () => {
      const machineId = await insertMachine();
      await db.saveWinEvents(machineId, [
        { eventTime: new Date().toISOString(), eventId: 41, source: 'Kernel', level: 'Error', translation: 'X' },
      ]);

      expect(await db.countUnreadWinEvents(machineId)).toBe(1);
      await db.markWinEventsRead(machineId);
      expect(await db.countUnreadWinEvents(machineId)).toBe(0);
    });
  });

  describe('saveInsight / getInsights / markInsightRead / countUnreadInsights', () => {
    function uniqueHash() {
      return crypto.randomUUID();
    }

    it('saveInsight ignora duplicata de pattern_hash (ON CONFLICT DO NOTHING)', async () => {
      const machineId = await insertMachine();
      const patternHash = uniqueHash();
      await db.saveInsight({ machineId, severity: 'warning', pattern: 'p1', solution: 's1', patternHash });
      await db.saveInsight({ machineId, severity: 'critical', pattern: 'p1-dup', solution: 's2', patternHash });

      const insights = await db.getInsights({ machineId });
      expect(insights.filter(i => i.pattern_hash === patternHash)).toHaveLength(1);
      expect(insights[0].severity).toBe('warning'); // a 2ª chamada não sobrescreveu
    });

    it('getInsights(machineId) filtra por máquina, ordenado por generated_at DESC', async () => {
      const machineId = await insertMachine();
      await db.saveInsight({ machineId, severity: 'warning', pattern: 'a', patternHash: uniqueHash() });
      await db.saveInsight({ machineId, severity: 'warning', pattern: 'b', patternHash: uniqueHash() });

      const insights = await db.getInsights({ machineId, limit: 10 });
      expect(insights).toHaveLength(2);
      expect(new Date(insights[0].generated_at).getTime())
        .toBeGreaterThanOrEqual(new Date(insights[1].generated_at).getTime());
    });

    it('getInsights() sem machineId ordena critical antes de warning antes do resto, com display_name via JOIN', async () => {
      const machineId = await insertMachine();
      await db.getPool().query('UPDATE machines SET display_name=$1 WHERE id=$2', ['PDV Teste', machineId]);

      const warningHash = uniqueHash();
      const criticalHash = uniqueHash();
      await db.saveInsight({ machineId, severity: 'warning', pattern: 'w', patternHash: warningHash });
      await db.saveInsight({ machineId, severity: 'critical', pattern: 'c', patternHash: criticalHash });

      // getInsights({limit:500}) lê o estado GLOBAL da instância dev
      // compartilhada -- se outro processo tiver >500 insights mais
      // recentes, um dos dois hashes cairia fora da janela do LIMIT e
      // findIndex devolveria -1 silenciosamente (toBeLessThan(-1, N) passa
      // sem checar nada de verdade). Filtra só pelos 2 hashes deste teste
      // e confirma que ambos foram encontrados antes de comparar a ordem.
      const all = await db.getInsights({ limit: 500 });
      const mine = all.filter(i => i.pattern_hash === warningHash || i.pattern_hash === criticalHash);
      const warningIdx = mine.findIndex(i => i.pattern_hash === warningHash);
      const criticalIdx = mine.findIndex(i => i.pattern_hash === criticalHash);
      expect(warningIdx).not.toBe(-1);
      expect(criticalIdx).not.toBe(-1);
      expect(criticalIdx).toBeLessThan(warningIdx);
      expect(mine[criticalIdx].display_name).toBe('PDV Teste');
    });

    it('markInsightRead zera countUnreadInsights(machineId) e decrementa countUnreadInsights() global', async () => {
      const machineId = await insertMachine();
      const patternHash = uniqueHash();
      await db.saveInsight({ machineId, severity: 'warning', pattern: 'p', patternHash });
      const [row] = await db.getInsights({ machineId });

      expect(await db.countUnreadInsights(machineId)).toBeGreaterThanOrEqual(1);
      const globalBefore = await db.countUnreadInsights();
      expect(globalBefore).toBeGreaterThanOrEqual(1);

      await db.markInsightRead(row.id);

      expect(await db.countUnreadInsights(machineId)).toBe(0);
      const globalAfter = await db.countUnreadInsights();
      expect(globalAfter).toBe(globalBefore - 1);
    });
  });
});
