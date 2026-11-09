'use strict';

/**
 * Testes da indexação incremental de NF-Ce no ACK handler (postProcessNfceMonths /
 * postProcessNfceIndex). Usa DB :memory: real (mesmo padrão dos demais db.*.test.js)
 * em vez de mockar '../db' — agent.js e o teste compartilham a mesma instância de
 * módulo depois do jest.resetModules(), então o teste cobre o SQL de verdade.
 */

beforeEach(() => {
  jest.resetModules();
  process.env.DB_PATH = ':memory:';
});

afterEach(() => {
  delete process.env.DB_PATH;
});

function pendingCommandDays(db, machineId) {
  return db.getDb()
    .prepare(`SELECT json_extract(params, '$.day') as day FROM commands
               WHERE machine_id = ? AND type = 'aloha-index-nfce-day' ORDER BY day`)
    .all(machineId)
    .map(r => r.day);
}

describe('postProcessNfceMonths — indexação incremental de histórico', () => {
  it('primeira execução enfileira todos os dias retornados pelo agente', () => {
    const db = require('../db');
    const { postProcessNfceMonths } = require('./agent');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    const message = JSON.stringify({
      months: [{ year: '2026', month: '06', days: ['01', '02', '03'] }],
    });
    postProcessNfceMonths('m1', message);

    expect(pendingCommandDays(db, 'm1')).toEqual(['01', '02', '03']);
  });

  it('segunda execução pula dias já indexados (exceto hoje)', () => {
    const db = require('../db');
    const { postProcessNfceMonths } = require('./agent');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    const todayKey = db.todayDayKey(); // "YYYY-MM-DD"
    const [todayYear, todayMonth, todayDay] = todayKey.split('-');

    // 01 já foi indexado (dia fechado, passado); hoje ainda não.
    db.markNFCeDayIndexed('m1', `${todayYear}-${todayMonth}-01`, 5);

    const message = JSON.stringify({
      months: [{ year: todayYear, month: todayMonth, days: ['01', todayDay] }],
    });
    postProcessNfceMonths('m1', message);

    // Só o dia de hoje foi reenfileirado — "01" foi pulado.
    expect(pendingCommandDays(db, 'm1')).toEqual([todayDay]);
  });

  it('dia de hoje é sempre reenfileirado mesmo já marcado como indexado', () => {
    const db = require('../db');
    const { postProcessNfceMonths } = require('./agent');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    const todayKey = db.todayDayKey();
    const [todayYear, todayMonth, todayDay] = todayKey.split('-');
    db.markNFCeDayIndexed('m1', todayKey, 3); // loja já vendeu algo hoje antes

    const message = JSON.stringify({
      months: [{ year: todayYear, month: todayMonth, days: [todayDay] }],
    });
    postProcessNfceMonths('m1', message);

    expect(pendingCommandDays(db, 'm1')).toEqual([todayDay]);
  });

  it('não indexados de lojas diferentes não se misturam', () => {
    const db = require('../db');
    const { postProcessNfceMonths } = require('./agent');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });
    db.registerMachine({ machineId: 'm2', hostname: 'LOJA2BOH', agentVersion: '1.0' });

    db.markNFCeDayIndexed('m1', '2026-06-01', 2);

    const message = JSON.stringify({ months: [{ year: '2026', month: '06', days: ['01'] }] });
    postProcessNfceMonths('m2', message);

    // m2 não tinha nada indexado — dia 01 deve ser enfileirado normalmente.
    expect(pendingCommandDays(db, 'm2')).toEqual(['01']);
  });

  it('mensagem malformada não lança exceção', () => {
    const { postProcessNfceMonths } = require('./agent');
    expect(() => postProcessNfceMonths('m1', 'não é json')).not.toThrow();
  });
});

describe('postProcessNfceIndex — marca dia como processado', () => {
  it('grava os registros e marca o dia como indexado', () => {
    const db = require('../db');
    const { postProcessNfceIndex } = require('./agent');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    const message = JSON.stringify({
      month: '2026-06', day: '05',
      records: [{ chave: 'abc', n_nf: 1, dh_emi: '2026-06-05T10:00:00', v_nf: 50, danfe: {} }],
      skipped: 0, error_count: 0,
    });
    postProcessNfceIndex('m1', message);

    expect(db.getIndexedDayKeysSet('m1').has('2026-06-05')).toBe(true);
    expect(db.getNFCeByChave('m1', 'abc')).not.toBeNull();
  });

  it('dia sem nenhuma NF-Ce (loja fechada) ainda fica marcado como indexado', () => {
    const db = require('../db');
    const { postProcessNfceIndex } = require('./agent');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    const message = JSON.stringify({ month: '2026-06', day: '05', records: [], skipped: 0, error_count: 0 });
    postProcessNfceIndex('m1', message);

    expect(db.getIndexedDayKeysSet('m1').has('2026-06-05')).toBe(true);
  });

  it('mensagem malformada não lança exceção e não marca nada', () => {
    const db = require('../db');
    const { postProcessNfceIndex } = require('./agent');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    expect(() => postProcessNfceIndex('m1', 'não é json')).not.toThrow();
    expect(db.getIndexedDayKeysSet('m1').size).toBe(0);
  });
});
