'use strict';

/**
 * Testes do Grupo 6 (NF-Ce: nfce_index, nfce_indexed_days,
 * nfce_auto_email_log) de server/db-pg.js contra um Postgres real
 * (instância dev). Mesmo padrão dos grupos anteriores.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.nfce.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 6: NF-Ce)', () => {
  let db;
  const createdMachineIds = [];
  const createdChaves = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    // nfce_auto_email_log.machine_id não tem FK/CASCADE pra machines
    // (confirmado no schema) -- limpeza manual por chave, ANTES de
    // qualquer assert do corpo do teste poder falhar e pular essa linha.
    while (createdChaves.length) {
      await pool.query('DELETE FROM nfce_auto_email_log WHERE chave=$1', [createdChaves.pop()]);
    }
    while (createdMachineIds.length) {
      const id = createdMachineIds.pop();
      // commands não tem FK pra machines (mesmo caso do Grupo 2) --
      // limpeza manual, senão vaza na instância dev compartilhada.
      await pool.query('DELETE FROM commands WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM machines WHERE id=$1', [id]); // FK CASCADE limpa nfce_index/nfce_indexed_days
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

  function fakeChave() {
    return crypto.randomUUID().replace(/-/g, '').padEnd(44, '0').slice(0, 44);
  }

  describe('upsertNFCeRecords / getNFCeByChave / searchNFCe', () => {
    it('insere e lê de volta, parseando danfe_json', async () => {
      const machineId = await insertMachine();
      const chave = fakeChave();
      await db.upsertNFCeRecords(machineId, [{
        chave, n_nf: 123, dh_emi: '2026-03-15T10:00:00', v_nf: 55.5,
        day_folder: '2026-03-15', danfe: { products: [{ xProd: 'Coca-Cola' }, { xProd: 'Pizza' }] },
      }]);

      const row = await db.getNFCeByChave(machineId, chave);
      expect(row.n_nf).toBe(123);
      expect(row.month_year).toBe('2026-03');
      expect(row.products_text).toBe('Coca-Cola | Pizza');
      expect(row.danfe).toEqual({ products: [{ xProd: 'Coca-Cola' }, { xProd: 'Pizza' }] });
    });

    it('ON CONFLICT faz update (mesma machine_id+chave não duplica)', async () => {
      const machineId = await insertMachine();
      const chave = fakeChave();
      await db.upsertNFCeRecords(machineId, [{ chave, n_nf: 1, dh_emi: '2026-01-01T00:00:00', v_nf: 10 }]);
      await db.upsertNFCeRecords(machineId, [{ chave, n_nf: 1, dh_emi: '2026-01-01T00:00:00', v_nf: 20 }]);

      const { rows } = await db.getPool().query(
        'SELECT COUNT(*) as c FROM nfce_index WHERE machine_id=$1 AND chave=$2', [machineId, chave]
      );
      expect(Number(rows[0].c)).toBe(1);
      expect((await db.getNFCeByChave(machineId, chave)).v_nf).toBe(20);
    });

    it('getNFCeByChave undefined quando não acha', async () => {
      const machineId = await insertMachine();
      expect(await db.getNFCeByChave(machineId, fakeChave())).toBeNull();
    });

    it('searchNFCe filtra por produto com ILIKE (sem diferenciar maiúscula/minúscula)', async () => {
      const machineId = await insertMachine();
      await db.upsertNFCeRecords(machineId, [
        { chave: fakeChave(), dh_emi: '2026-05-01T00:00:00', v_nf: 10, danfe: { products: [{ xProd: 'Coca-Cola Lata' }] } },
        { chave: fakeChave(), dh_emi: '2026-05-02T00:00:00', v_nf: 20, danfe: { products: [{ xProd: 'Suco de Laranja' }] } },
      ]);

      const result = await db.searchNFCe({ machineId, product: 'coca' }); // minúsculo, produto salvo com maiúscula
      expect(result.total).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].products_text).toContain('Coca-Cola');
    });

    it('searchNFCe filtra por dateFrom/dateTo/valueMin/valueMax e respeita limit/offset', async () => {
      const machineId = await insertMachine();
      await db.upsertNFCeRecords(machineId, [
        { chave: fakeChave(), dh_emi: '2026-01-01T00:00:00', v_nf: 10 },
        { chave: fakeChave(), dh_emi: '2026-02-01T00:00:00', v_nf: 50 },
        { chave: fakeChave(), dh_emi: '2026-03-01T00:00:00', v_nf: 100 },
      ]);

      const byDate = await db.searchNFCe({ machineId, dateFrom: '2026-02-01', dateTo: '2026-02-28' });
      expect(byDate.total).toBe(1);

      const byValue = await db.searchNFCe({ machineId, valueMin: 40, valueMax: 90 });
      expect(byValue.total).toBe(1);
      expect(byValue.results[0].v_nf).toBe(50);

      const paged = await db.searchNFCe({ machineId, limit: 1, offset: 1 });
      expect(paged.total).toBe(3); // total não é afetado por limit/offset
      expect(paged.results).toHaveLength(1);
    });
  });

  describe('getNFCeIndexStatus', () => {
    it('sem nenhum comando aloha-list/aloha-index: só totalRecords e months preenchidos', async () => {
      const machineId = await insertMachine();
      await db.upsertNFCeRecords(machineId, [{ chave: fakeChave(), dh_emi: '2026-04-01T00:00:00', v_nf: 1 }]);

      const status = await db.getNFCeIndexStatus(machineId);
      expect(status.totalRecords).toBe(1);
      expect(status.months).toHaveLength(1);
      expect(status.months[0]).toMatchObject({ month_year: '2026-04', total: 1 });
      expect(status.pendingDays).toBe(0);
      expect(status.listMonths).toBeNull();
    });

    it('com aloha-list + aloha-index-nfce-day: calcula totalDays/pendingDays/processedDays', async () => {
      const machineId = await insertMachine();
      const listCmdId = await db.createCommand(machineId, 'aloha-list-nfce-months');
      await db.ackCommand(listCmdId, machineId, true, 'ok');

      await db.createCommand(machineId, 'aloha-index-nfce-day');
      const day2 = await db.createCommand(machineId, 'aloha-index-nfce-day');
      await db.ackCommand(day2, machineId, true, 'ok');

      const status = await db.getNFCeIndexStatus(machineId);
      expect(status.totalDays).toBe(2);
      expect(status.pendingDays).toBe(1); // só o 1º continua pending
      expect(status.processedDays).toBe(1);
      // listMonths não seleciona `id` -- nem no original (db.js) nem aqui,
      // de propósito: SELECT status, acked_at, created_at FROM commands ...
      expect(status.listMonths).toMatchObject({ status: 'acked' });
      expect(status.listMonths.id).toBeUndefined();
    });
  });

  describe('markNFCeDayIndexed / getIndexedDayKeysSet / todayDayKey', () => {
    it('marca, sobrescreve via ON CONFLICT e devolve um Set', async () => {
      const machineId = await insertMachine();
      await db.markNFCeDayIndexed(machineId, '2026-06-01', 5);
      await db.markNFCeDayIndexed(machineId, '2026-06-01', 8); // mesma chave -- update, não duplica
      await db.markNFCeDayIndexed(machineId, '2026-06-02', 3);

      const set = await db.getIndexedDayKeysSet(machineId);
      expect(set).toEqual(new Set(['2026-06-01', '2026-06-02']));

      const { rows } = await db.getPool().query(
        'SELECT record_count FROM nfce_indexed_days WHERE machine_id=$1 AND day_key=$2',
        [machineId, '2026-06-01']
      );
      expect(rows[0].record_count).toBe(8);
    });

    it('todayDayKey devolve a data de hoje no formato YYYY-MM-DD', () => {
      const now = new Date();
      const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      expect(db.todayDayKey()).toBe(expected);
    });
  });

  describe('claimAutoEmail / markAutoEmailSent / markAutoEmailFailed', () => {
    it('1ª chamada ganha a reivindicação, 2ª com a mesma chave perde', async () => {
      const machineId = await insertMachine();
      const chave = fakeChave();
      createdChaves.push(chave); // rastreado antes de qualquer assert -- limpa mesmo se falhar

      expect(await db.claimAutoEmail(chave, machineId, 'a@b.com')).toBe(true);
      expect(await db.claimAutoEmail(chave, machineId, 'outro@b.com')).toBe(false);
    });

    it('markAutoEmailSent/Failed atualizam status', async () => {
      const machineId = await insertMachine();
      const chaveSent = fakeChave();
      const chaveFailed = fakeChave();
      createdChaves.push(chaveSent, chaveFailed); // rastreado antes dos asserts abaixo
      await db.claimAutoEmail(chaveSent, machineId, 'a@b.com');
      await db.claimAutoEmail(chaveFailed, machineId, 'a@b.com');

      await db.markAutoEmailSent(chaveSent);
      await db.markAutoEmailFailed(chaveFailed, new Error('SMTP timeout'));

      const { rows } = await db.getPool().query(
        'SELECT chave, status, error, sent_at FROM nfce_auto_email_log WHERE chave=ANY($1) ORDER BY chave',
        [[chaveSent, chaveFailed]]
      );
      const sent = rows.find(r => r.chave === chaveSent);
      const failed = rows.find(r => r.chave === chaveFailed);
      expect(sent.status).toBe('sent');
      expect(sent.sent_at).not.toBeNull();
      expect(failed.status).toBe('failed');
      expect(failed.error).toBe('Error: SMTP timeout');
    });
  });
});
