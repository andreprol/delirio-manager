'use strict';

/**
 * Testes da indexação incremental de NF-Ce no ACK handler (postProcessNfceMonths /
 * postProcessNfceIndex). Postgres real (ver aloha.test.js) — agent.js e o teste
 * compartilham a mesma instância de módulo depois do jest.resetModules().
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

let db, postProcessNfceMonths, postProcessNfceIndex, maybeAutoSendDanfe;
let m1;
const createdMachineIds = [];

beforeEach(async () => {
  if (!hasDb) return;
  jest.resetModules();
  jest.doMock('../services/nfceAutoEmail', () => ({ maybeAutoSendDanfe: jest.fn(() => Promise.resolve()) }));
  db = require('../db-pg');
  ({ postProcessNfceMonths, postProcessNfceIndex } = require('./agent'));
  ({ maybeAutoSendDanfe } = require('../services/nfceAutoEmail'));
  m1 = crypto.randomUUID();
  createdMachineIds.push(m1);
  await db.registerMachine({ machineId: m1, hostname: `LOJA1BOH-${m1.slice(0, 8)}`, agentVersion: '1.0' });
});

afterAll(async () => {
  if (!hasDb) return;
  const pool = db.getPool();
  if (createdMachineIds.length) {
    await pool.query('DELETE FROM machines WHERE id = ANY($1)', [createdMachineIds]);
  }
  await db.closePool();
});

async function pendingCommandDays(machineId) {
  const pool = db.getPool();
  const { rows } = await pool.query(
    `SELECT (params::json->>'day') as day FROM commands
     WHERE machine_id = $1 AND type = 'aloha-index-nfce-day' ORDER BY day`,
    [machineId]
  );
  return rows.map(r => r.day);
}

describeDb('postProcessNfceMonths — indexação incremental de histórico', () => {
  it('primeira execução enfileira todos os dias retornados pelo agente', async () => {
    const message = JSON.stringify({
      months: [{ year: '2026', month: '06', days: ['01', '02', '03'] }],
    });
    await postProcessNfceMonths(m1, message);

    expect(await pendingCommandDays(m1)).toEqual(['01', '02', '03']);
  });

  it('segunda execução pula dias já indexados (exceto hoje)', async () => {
    const todayKey = db.todayDayKey(); // "YYYY-MM-DD"
    const [todayYear, todayMonth, todayDay] = todayKey.split('-');

    // 01 já foi indexado (dia fechado, passado); hoje ainda não.
    await db.markNFCeDayIndexed(m1, `${todayYear}-${todayMonth}-01`, 5);

    const message = JSON.stringify({
      months: [{ year: todayYear, month: todayMonth, days: ['01', todayDay] }],
    });
    await postProcessNfceMonths(m1, message);

    // Só o dia de hoje foi reenfileirado — "01" foi pulado.
    expect(await pendingCommandDays(m1)).toEqual([todayDay]);
  });

  it('dia de hoje é sempre reenfileirado mesmo já marcado como indexado', async () => {
    const todayKey = db.todayDayKey();
    const [todayYear, todayMonth, todayDay] = todayKey.split('-');
    await db.markNFCeDayIndexed(m1, todayKey, 3); // loja já vendeu algo hoje antes

    const message = JSON.stringify({
      months: [{ year: todayYear, month: todayMonth, days: [todayDay] }],
    });
    await postProcessNfceMonths(m1, message);

    expect(await pendingCommandDays(m1)).toEqual([todayDay]);
  });

  it('dias indexados de uma loja não se misturam com outra', async () => {
    const m2 = crypto.randomUUID();
    createdMachineIds.push(m2);
    await db.registerMachine({ machineId: m2, hostname: `LOJA2BOH-${m2.slice(0, 8)}`, agentVersion: '1.0' });
    await db.markNFCeDayIndexed(m1, '2026-06-01', 2);

    const message = JSON.stringify({ months: [{ year: '2026', month: '06', days: ['01'] }] });
    await postProcessNfceMonths(m2, message);

    // m2 não tinha nada indexado — dia 01 deve ser enfileirado normalmente.
    expect(await pendingCommandDays(m2)).toEqual(['01']);
  });

  it('mensagem malformada não lança exceção', async () => {
    await expect(postProcessNfceMonths(m1, 'não é json')).resolves.not.toThrow();
  });
});

describeDb('postProcessNfceIndex — marca dia como processado', () => {
  it('grava os registros e marca o dia como indexado', async () => {
    const chave = `abc-${crypto.randomUUID()}`;
    const message = JSON.stringify({
      month: '2026-06', day: '05',
      records: [{ chave, n_nf: 1, dh_emi: '2026-06-05T10:00:00', v_nf: 50, danfe: {} }],
      skipped: 0, error_count: 0,
    });
    await postProcessNfceIndex(m1, message);

    expect((await db.getIndexedDayKeysSet(m1)).has('2026-06-05')).toBe(true);
    expect(await db.getNFCeByChave(m1, chave)).not.toBeNull();
  });

  it('dia sem nenhuma NF-Ce (loja fechada) ainda fica marcado como indexado', async () => {
    const message = JSON.stringify({ month: '2026-06', day: '05', records: [], skipped: 0, error_count: 0 });
    await postProcessNfceIndex(m1, message);

    expect((await db.getIndexedDayKeysSet(m1)).has('2026-06-05')).toBe(true);
  });

  it('mensagem malformada não lança exceção e não marca nada', async () => {
    await expect(postProcessNfceIndex(m1, 'não é json')).resolves.not.toThrow();
    expect((await db.getIndexedDayKeysSet(m1)).size).toBe(0);
  });
});

describeDb('postProcessNfceIndex — aciona o auto-envio de e-mail', () => {
  it('chama maybeAutoSendDanfe pra cada registro indexado', async () => {
    const chaveA = `abc-${crypto.randomUUID()}`;
    const chaveB = `def-${crypto.randomUUID()}`;
    const r1 = { chave: chaveA, n_nf: 1, dh_emi: '2026-06-05T10:00:00', v_nf: 50, danfe: { dest: { email: 'a@teste.com' } } };
    const r2 = { chave: chaveB, n_nf: 2, dh_emi: '2026-06-05T11:00:00', v_nf: 30, danfe: {} };
    const message = JSON.stringify({ month: '2026-06', day: '05', records: [r1, r2], skipped: 0, error_count: 0 });

    await postProcessNfceIndex(m1, message);

    expect(maybeAutoSendDanfe).toHaveBeenCalledTimes(2);
    expect(maybeAutoSendDanfe).toHaveBeenCalledWith(m1, expect.objectContaining({ chave: chaveA }));
    expect(maybeAutoSendDanfe).toHaveBeenCalledWith(m1, expect.objectContaining({ chave: chaveB }));
  });

  it('dia sem nenhum registro — não chama o auto-envio', async () => {
    const message = JSON.stringify({ month: '2026-06', day: '05', records: [], skipped: 0, error_count: 0 });
    await postProcessNfceIndex(m1, message);
    expect(maybeAutoSendDanfe).not.toHaveBeenCalled();
  });
});
