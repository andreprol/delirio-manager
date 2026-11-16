'use strict';

/**
 * Testes do Grupo 8 (acesso remoto: watchlist_keywords, activity_log,
 * live_sessions) de server/db-pg.js contra um Postgres real (instância
 * dev). Mesmo padrão dos grupos anteriores.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.remoteaccess.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 8: acesso remoto)', () => {
  let db;
  const createdMachineIds = [];
  const createdKeywordIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdKeywordIds.length) {
      await pool.query('DELETE FROM watchlist_keywords WHERE id=$1', [createdKeywordIds.pop()]);
    }
    while (createdMachineIds.length) {
      const id = createdMachineIds.pop();
      await pool.query('DELETE FROM machines WHERE id=$1', [id]); // FK CASCADE limpa activity_log/live_sessions/watchlist_matches
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

  describe('createWatchlistKeyword / getWatchlistKeywords / getActiveWatchlistKeywords', () => {
    it('cria (RETURNING id), lista DESC e filtra só as ativas', async () => {
      const id1 = await db.createWatchlistKeyword('vaga de emprego');
      createdKeywordIds.push(id1);
      const id2 = await db.createWatchlistKeyword('currículo');
      createdKeywordIds.push(id2);

      const all = await db.getWatchlistKeywords();
      expect(all.findIndex(k => k.id === id2)).toBeLessThan(all.findIndex(k => k.id === id1)); // DESC

      await db.setWatchlistKeywordActive(id1, false);
      const active = await db.getActiveWatchlistKeywords();
      expect(active.map(k => k.id)).not.toContain(id1);
      expect(active.map(k => k.id)).toContain(id2);
    });

    it('deleteWatchlistKeyword remove', async () => {
      const id = await db.createWatchlistKeyword('teste-delete');
      await db.deleteWatchlistKeyword(id);
      expect((await db.getWatchlistKeywords()).map(k => k.id)).not.toContain(id);
    });
  });

  describe('insertActivityLog / getActivityLog / purgeActivityLog', () => {
    it('insere (RETURNING id+capturedAt) e lê DESC por captured_at,id', async () => {
      const machineId = await insertMachine();
      const r1 = await db.insertActivityLog(machineId, 'Chrome', 'chrome.exe');
      expect(r1.id).toBeDefined();
      expect(r1.capturedAt).toBeDefined();
      const r2 = await db.insertActivityLog(machineId, 'Notepad', 'notepad.exe');

      const log = await db.getActivityLog(machineId, 10);
      expect(log[0].id).toBe(r2.id); // mais recente primeiro
      expect(log[1].id).toBe(r1.id);
    });

    it('getActivityLog cai pro default 100 com limit inválido', async () => {
      const machineId = await insertMachine();
      await db.insertActivityLog(machineId, 'X', 'x.exe');
      await expect(db.getActivityLog(machineId, -5)).resolves.toHaveLength(1);
      await expect(db.getActivityLog(machineId, NaN)).resolves.toHaveLength(1);
    });

    it('purgeActivityLog em lotes apaga só linhas antigas, preserva recentes', async () => {
      const machineId = await insertMachine();
      const pool = db.getPool();
      const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      await pool.query(
        `INSERT INTO activity_log (machine_id, window_title, process_name, captured_at) VALUES ($1,'old','old.exe',$2)`,
        [machineId, old]
      );
      await db.insertActivityLog(machineId, 'recente', 'recente.exe');

      const removed = await db.purgeActivityLog(90);
      expect(removed).toBeGreaterThanOrEqual(1);
      const remaining = await db.getActivityLog(machineId, 10);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].window_title).toBe('recente');
    });

    it('purgeActivityLog paginando em lotes (>1000 linhas) apaga tudo', async () => {
      const machineId = await insertMachine();
      const pool = db.getPool();
      const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      const BATCH_SIZE = 1000;
      const TOTAL = BATCH_SIZE * 2 + 250; // força 3 iterações do loop de purge
      // generate_series insere as TOTAL linhas num único round-trip --
      // um loop de INSERTs individuais contra a instância Azure (latência
      // de rede real) levaria minutos pra 2250 linhas e estouraria o
      // timeout do teste sem isso.
      await pool.query(
        `INSERT INTO activity_log (machine_id, window_title, process_name, captured_at)
         SELECT $1, 'old', 'old.exe', $2 FROM generate_series(1, $3)`,
        [machineId, old, TOTAL]
      );

      const removed = await db.purgeActivityLog(90);
      // purgeActivityLog é global (sem filtro por machine_id, igual ao
      // original) rodando contra a instância dev COMPARTILHADA -- toBe()
      // exato flakaria se sobrar qualquer outra linha antiga de outro
      // teste/execução (mesmo padrão já corrigido em
      // db-pg.commands.test.js pro purgeOldTerminalCommands).
      expect(removed).toBeGreaterThanOrEqual(TOTAL);
      expect(await db.getActivityLog(machineId, 10)).toHaveLength(0); // escopado pela própria machineId
    }, 15000);

    it('days<=0 é noop', async () => {
      expect(await db.purgeActivityLog(0)).toBe(0);
    });
  });

  describe('createLiveSession / getLiveSession / endLiveSession / setLiveSessionRecorded', () => {
    it('valida mode -- rejeita valor diferente de normal/shadow', async () => {
      const machineId = await insertMachine();
      await expect(db.createLiveSession(machineId, 'invalido')).rejects.toThrow(/mode inválido/);
    });

    it('fluxo completo: cria, lê, encerra e marca gravada', async () => {
      const machineId = await insertMachine();
      const sessionId = await db.createLiveSession(machineId, 'normal');

      let session = await db.getLiveSession(sessionId);
      expect(session.mode).toBe('normal');
      expect(session.ended_at).toBeNull();
      expect(session.recorded).toBe(0);

      await db.endLiveSession(sessionId);
      await db.setLiveSessionRecorded(sessionId);

      session = await db.getLiveSession(sessionId);
      expect(session.ended_at).not.toBeNull();
      expect(session.recorded).toBe(1);
    });

    it('getLiveSession undefined quando não acha', async () => {
      expect(await db.getLiveSession(crypto.randomUUID())).toBeUndefined();
    });
  });
});
