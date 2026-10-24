'use strict';

jest.mock('../db', () => ({
  purgeActivityLog: jest.fn(() => 3),
}));

const { runPurgeOnce, scheduleDailyPurge, stop, RETENTION_DAYS } = require('./activityRetention');

afterEach(() => stop());

describe('runPurgeOnce', () => {
  it('chama purgeActivityLog com 90 dias e retorna quantas linhas removeu', () => {
    const db = require('../db');
    const removed = runPurgeOnce();
    expect(db.purgeActivityLog).toHaveBeenCalledWith(RETENTION_DAYS);
    expect(removed).toBe(3);
  });

  it('erro no purge não lança — retorna 0 e segue', () => {
    const db = require('../db');
    db.purgeActivityLog.mockImplementationOnce(() => {
      throw new Error('disco cheio');
    });
    let removed;
    expect(() => { removed = runPurgeOnce(); }).not.toThrow();
    expect(removed).toBe(0);
  });
});

describe('scheduleDailyPurge / stop', () => {
  it('roda o purge imediatamente no boot', () => {
    const db = require('../db');
    db.purgeActivityLog.mockClear();
    scheduleDailyPurge();
    expect(db.purgeActivityLog).toHaveBeenCalledTimes(1);
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
      const db = require('../db');
      const callsAfterStop = db.purgeActivityLog.mock.calls.length;
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(db.purgeActivityLog.mock.calls.length).toBe(callsAfterStop);
    } finally {
      jest.useRealTimers();
    }
  });
});
