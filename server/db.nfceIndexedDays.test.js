'use strict';

/**
 * Testes do rastreamento de dias já indexados (nfce_indexed_days), base da
 * indexação incremental de NF-Ce. Usa DB :memory: (mesmo padrão dos demais
 * db.*.test.js) para não travar o arquivo no Windows ao limpar no afterAll.
 */

beforeEach(() => {
  jest.resetModules();
  process.env.DB_PATH = ':memory:';
});

afterEach(() => {
  delete process.env.DB_PATH;
});

describe('markNFCeDayIndexed / getIndexedDayKeysSet', () => {
  it('marca um dia e o retorna no Set da máquina', () => {
    const db = require('./db');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    db.markNFCeDayIndexed('m1', '2026-11-05', 12);

    const set = db.getIndexedDayKeysSet('m1');
    expect(set.has('2026-11-05')).toBe(true);
    expect(set.size).toBe(1);
  });

  it('dia com 0 registros (loja fechada) ainda fica marcado como indexado', () => {
    const db = require('./db');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    db.markNFCeDayIndexed('m1', '2026-11-05', 0);

    expect(db.getIndexedDayKeysSet('m1').has('2026-11-05')).toBe(true);
  });

  it('marcar o mesmo dia de novo atualiza o registro em vez de duplicar', () => {
    const db = require('./db');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    db.markNFCeDayIndexed('m1', '2026-11-05', 3);
    db.markNFCeDayIndexed('m1', '2026-11-05', 9);

    const row = db.getDb()
      .prepare('SELECT record_count FROM nfce_indexed_days WHERE machine_id = ? AND day_key = ?')
      .get('m1', '2026-11-05');
    expect(row.record_count).toBe(9);
    expect(db.getIndexedDayKeysSet('m1').size).toBe(1);
  });

  it('isola o Set por machine_id — dia de uma loja não aparece na outra', () => {
    const db = require('./db');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });
    db.registerMachine({ machineId: 'm2', hostname: 'LOJA2BOH', agentVersion: '1.0' });

    db.markNFCeDayIndexed('m1', '2026-11-05', 1);

    expect(db.getIndexedDayKeysSet('m1').has('2026-11-05')).toBe(true);
    expect(db.getIndexedDayKeysSet('m2').has('2026-11-05')).toBe(false);
  });

  it('máquina sem nenhum dia indexado retorna Set vazio', () => {
    const db = require('./db');
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    expect(db.getIndexedDayKeysSet('m1').size).toBe(0);
  });
});

describe('todayDayKey', () => {
  it('formata a data local do servidor como YYYY-MM-DD', () => {
    const db = require('./db');
    jest.useFakeTimers().setSystemTime(new Date(2026, 10, 5, 23, 0, 0)); // 05/11/2026 local
    expect(db.todayDayKey()).toBe('2026-11-05');
    jest.useRealTimers();
  });

  it('usa zero-padding para mês e dia de um dígito', () => {
    const db = require('./db');
    jest.useFakeTimers().setSystemTime(new Date(2026, 0, 3, 12, 0, 0)); // 03/01/2026 local
    expect(db.todayDayKey()).toBe('2026-01-03');
    jest.useRealTimers();
  });
});
