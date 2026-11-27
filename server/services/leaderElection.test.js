'use strict';

jest.mock('pg', () => ({ Client: jest.fn() }));

function makeFakeClient({ acquired = true } = {}) {
  const handlers = {};
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    query:   jest.fn().mockResolvedValue({ rows: [{ acquired }] }),
    end:     jest.fn().mockResolvedValue(undefined),
    on:      jest.fn((event, cb) => { handlers[event] = cb; }),
    _emit:   (event, ...args) => handlers[event]?.(...args),
  };
}

describe('leaderElection', () => {
  let leaderElection;
  let Client;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    leaderElection = require('./leaderElection');
    // jest.resetModules() invalida o cache de módulos, inclusive o mock de
    // 'pg' -- um `Client` capturado fora do beforeEach seria uma instância
    // de jest.fn() diferente da que leaderElection.js vê internamente
    // (confirmado ao vivo: comparação de identidade dava false). Pegar o
    // Client de novo aqui, na mesma "passada" do require acima, garante que
    // seja a mesma instância que leaderElection.js importou.
    ({ Client } = require('pg'));
  });

  afterEach(async () => {
    await leaderElection.stop();
    jest.useRealTimers();
  });

  it('isLeader() comeca false antes de start()', () => {
    expect(leaderElection.isLeader()).toBe(false);
  });

  it('vira lider quando pg_try_advisory_lock retorna true', async () => {
    const fake = makeFakeClient({ acquired: true });
    Client.mockImplementation(() => fake);

    leaderElection.start();
    await Promise.resolve(); // deixa a Promise interna do tryAcquire resolver
    await Promise.resolve();

    expect(leaderElection.isLeader()).toBe(true);
    expect(fake.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      expect.any(Array)
    );
  });

  it('nao vira lider quando pg_try_advisory_lock retorna false', async () => {
    const fake = makeFakeClient({ acquired: false });
    Client.mockImplementation(() => fake);

    leaderElection.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(leaderElection.isLeader()).toBe(false);
  });

  it('perde lideranca quando a conexao emite erro', async () => {
    const fake = makeFakeClient({ acquired: true });
    Client.mockImplementation(() => fake);

    leaderElection.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(leaderElection.isLeader()).toBe(true);

    fake._emit('error', new Error('connection lost'));
    expect(leaderElection.isLeader()).toBe(false);
  });

  it('stop() encerra a conexao e isLeader() volta a false', async () => {
    const fake = makeFakeClient({ acquired: true });
    Client.mockImplementation(() => fake);

    leaderElection.start();
    await Promise.resolve();
    await Promise.resolve();

    await leaderElection.stop();

    expect(fake.end).toHaveBeenCalled();
    expect(leaderElection.isLeader()).toBe(false);
  });
});
