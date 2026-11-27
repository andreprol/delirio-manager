'use strict';

/**
 * Testes do guard de liderança em zamak.js (Task 4 do plano
 * 2026-11-27-leader-election-and-healthz). Não existia arquivo de teste
 * para este serviço antes desta sessão — criado agora só com os 2 casos
 * do guard (syncIfStale + runDailySync), não uma suíte completa do
 * arquivo, que está fora do escopo desta task.
 */

describe('syncIfStale — leader guard', () => {
  it('nao consulta a idade do cache quando nao e o lider', async () => {
    jest.resetModules();
    jest.doMock('./leaderElection', () => ({ isLeader: () => false }));
    const getZamakCacheAgeMock = jest.fn();
    jest.doMock('../db-pg', () => ({ getZamakCacheAge: getZamakCacheAgeMock }));
    const freshZamak = require('./zamak');

    const result = await freshZamak.syncIfStale(6);

    expect(getZamakCacheAgeMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

describe('runDailySync (via scheduleDailySync) — leader guard', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('nao roda o sync diario quando nao e o lider, mesmo no horario agendado (05:00 UTC)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-24T04:59:00Z')); // 1min antes de 05:00 UTC
    jest.resetModules();
    jest.doMock('./leaderElection', () => ({ isLeader: () => false }));
    jest.doMock('../config.json', () => ({ zamak: { server: 'srv', apiKey: 'key' } }), { virtual: true });
    const getZamakCacheAgeMock        = jest.fn().mockResolvedValue(0); // nao-stale: a chamada de startup do syncIfStale nao interfere
    const getZamakCachedDeviceIdsMock = jest.fn();
    jest.doMock('../db-pg', () => ({
      getZamakCacheAge:        getZamakCacheAgeMock,
      getZamakCachedDeviceIds: getZamakCachedDeviceIdsMock,
    }));
    const freshZamak = require('./zamak');

    freshZamak.scheduleDailySync();
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(60 * 1000); // dispara o setTimeout agendado pra 05:00 UTC
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(getZamakCachedDeviceIdsMock).not.toHaveBeenCalled();
  });
});
