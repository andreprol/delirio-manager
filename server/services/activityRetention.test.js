'use strict';

jest.mock('../db-pg', () => ({
  purgeActivityLog: jest.fn(() => 3),
  purgeOrphanCommands: jest.fn(async () => 0),
  purgeOldTerminalCommands: jest.fn(async () => 0),
}));

const {
  runPurgeOnce, runCommandsPurgeOnce, scheduleDailyPurge, stop,
  RETENTION_DAYS, COMMANDS_RETENTION_DAYS,
} = require('./activityRetention');

afterEach(() => stop());

describe('runPurgeOnce', () => {
  it('chama purgeActivityLog com 90 dias e retorna quantas linhas removeu', async () => {
    const db = require('../db-pg');
    const removed = await runPurgeOnce();
    expect(db.purgeActivityLog).toHaveBeenCalledWith(RETENTION_DAYS);
    expect(removed).toBe(3);
  });

  it('erro no purge não lança — retorna 0 e segue', async () => {
    const db = require('../db-pg');
    db.purgeActivityLog.mockImplementationOnce(() => {
      throw new Error('disco cheio');
    });
    const removed = await runPurgeOnce();
    expect(removed).toBe(0);
  });
});

describe('runCommandsPurgeOnce', () => {
  it('chama purgeOrphanCommands e purgeOldTerminalCommands (com COMMANDS_RETENTION_DAYS) e retorna o resultado', async () => {
    const db = require('../db-pg');
    db.purgeOrphanCommands.mockResolvedValueOnce(56171);
    db.purgeOldTerminalCommands.mockResolvedValueOnce(120);

    const result = await runCommandsPurgeOnce();

    expect(db.purgeOrphanCommands).toHaveBeenCalledWith();
    expect(db.purgeOldTerminalCommands).toHaveBeenCalledWith(COMMANDS_RETENTION_DAYS);
    expect(result).toEqual({ orphans: 56171, old: 120 });
  });

  it('erro no purge de órfãos não lança — retorna zeros e segue (sem chamar o purge de antigos)', async () => {
    const db = require('../db-pg');
    db.purgeOrphanCommands.mockRejectedValueOnce(new Error('disco cheio'));
    db.purgeOldTerminalCommands.mockClear();

    const result = await runCommandsPurgeOnce();

    expect(result).toEqual({ orphans: 0, old: 0 });
    expect(db.purgeOldTerminalCommands).not.toHaveBeenCalled();
  });

  it('erro no purge de antigos não lança — retorna zeros e segue', async () => {
    const db = require('../db-pg');
    db.purgeOldTerminalCommands.mockRejectedValueOnce(new Error('disco cheio'));

    const result = await runCommandsPurgeOnce();

    expect(result).toEqual({ orphans: 0, old: 0 });
  });
});

describe('scheduleDailyPurge / stop', () => {
  it('roda o purge imediatamente no boot', () => {
    const db = require('../db-pg');
    db.purgeActivityLog.mockClear();
    db.purgeOrphanCommands.mockClear();
    scheduleDailyPurge();
    expect(db.purgeActivityLog).toHaveBeenCalledTimes(1);
    expect(db.purgeOrphanCommands).toHaveBeenCalledTimes(1);
  });

  it('stop() sem agendamento ativo não lança', () => {
    expect(() => stop()).not.toThrow();
  });

  it('stop() cancela o reagendamento, sem deixar timer pendente', () => {
    jest.useFakeTimers();
    try {
      scheduleDailyPurge();
      stop();
      // Avança bem além de 24h — se o timer não foi cancelado, isso chamaria
      // purgeActivityLog de novo e o teste falharia na contagem abaixo.
      const db = require('../db-pg');
      const callsAfterStop = db.purgeActivityLog.mock.calls.length;
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(db.purgeActivityLog.mock.calls.length).toBe(callsAfterStop);
    } finally {
      jest.useRealTimers();
    }
  });
});
