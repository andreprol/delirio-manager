'use strict';

jest.mock('pg', () => ({ Client: jest.fn() }));

// Vários turnos de microtask: tryAcquire() encadeia alguns awaits (connect
// com timeout, query) antes de atualizar o estado.
async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

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
    await flush(); // deixa a Promise interna do tryAcquire resolver

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
    await flush();

    expect(leaderElection.isLeader()).toBe(false);
  });

  it('perde lideranca quando a conexao emite erro', async () => {
    const fake = makeFakeClient({ acquired: true });
    Client.mockImplementation(() => fake);

    leaderElection.start();
    await flush();
    expect(leaderElection.isLeader()).toBe(true);

    fake._emit('error', new Error('connection lost'));
    expect(leaderElection.isLeader()).toBe(false);
  });

  describe('whenFirstAttemptSettled()', () => {
    // Deferred controlável: a Promise só resolve quando o teste mandar,
    // simulando um round-trip de rede que ainda não voltou.
    function deferred() {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }

    it('resolve imediatamente se chamado antes de start() (nunca pendura)', async () => {
      await expect(leaderElection.whenFirstAttemptSettled()).resolves.toBeUndefined();
    });

    it('so resolve depois que connect() e query() da 1a tentativa resolveram', async () => {
      const connectD = deferred();
      const queryD   = deferred();
      const fake = makeFakeClient({ acquired: true });
      fake.connect.mockReturnValue(connectD.promise);
      fake.query.mockReturnValue(queryD.promise);
      Client.mockImplementation(() => fake);

      leaderElection.start();
      let settled = false;
      leaderElection.whenFirstAttemptSettled().then(() => { settled = true; });

      await flush();
      expect(settled).toBe(false); // connect ainda pendente

      connectD.resolve();
      await flush();
      expect(fake.query).toHaveBeenCalled();
      expect(settled).toBe(false); // query ainda pendente

      queryD.resolve({ rows: [{ acquired: true }] });
      await flush();
      expect(settled).toBe(true);
      expect(leaderElection.isLeader()).toBe(true); // já sabe o resultado quando resolve
    });

    it('resolve (nao rejeita) mesmo quando a 1a tentativa falha', async () => {
      const fake = makeFakeClient();
      fake.connect.mockRejectedValue(new Error('ECONNREFUSED'));
      Client.mockImplementation(() => fake);

      leaderElection.start();

      await expect(leaderElection.whenFirstAttemptSettled()).resolves.toBeUndefined();
      expect(leaderElection.isLeader()).toBe(false);
    });
  });

  describe('connect lento/pendurado (cenario 15-16/11)', () => {
    const RETRY_INTERVAL_MS  = 30000;
    const CONNECT_TIMEOUT_MS = 10000;

    it('passa connectionTimeoutMillis pro pg.Client', () => {
      Client.mockImplementation(() => makeFakeClient());
      leaderElection.start();
      expect(Client).toHaveBeenCalledWith(expect.objectContaining({ connectionTimeoutMillis: CONNECT_TIMEOUT_MS }));
    });

    it('nao dispara 2a tentativa (nem cria 2o Client) enquanto a 1a ainda esta pendente', async () => {
      // query nunca volta: a tentativa fica em voo por mais de um ciclo de
      // retry (connect resolve, então o timeout de connect não se aplica).
      const fake = makeFakeClient();
      fake.query.mockReturnValue(new Promise(() => {}));
      Client.mockImplementation(() => fake);

      leaderElection.start();
      await flush();
      expect(fake.query).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(RETRY_INTERVAL_MS * 3);
      await flush();

      expect(Client).toHaveBeenCalledTimes(1);
      expect(fake.query).toHaveBeenCalledTimes(1);
    });

    it('connect que nunca resolve estoura o timeout, descarta o Client e libera nova tentativa', async () => {
      const hung = makeFakeClient();
      hung.connect.mockReturnValue(new Promise(() => {}));
      const good = makeFakeClient({ acquired: true });
      Client.mockImplementationOnce(() => hung).mockImplementation(() => good);

      leaderElection.start();
      let settled = false;
      leaderElection.whenFirstAttemptSettled().then(() => { settled = true; });

      // retry de 30s ainda não chegou; antes do timeout, nada muda
      jest.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1);
      await flush();
      expect(settled).toBe(false);

      jest.advanceTimersByTime(1);
      await flush();
      expect(settled).toBe(true);           // 1a tentativa terminou (falhou), não pendurou
      expect(hung.end).toHaveBeenCalled();  // client meio-conectado descartado
      expect(hung.query).not.toHaveBeenCalled();
      expect(leaderElection.isLeader()).toBe(false);

      // próximo retry cria um Client NOVO (não reaproveita o pendurado)
      jest.advanceTimersByTime(RETRY_INTERVAL_MS);
      await flush();
      expect(Client).toHaveBeenCalledTimes(2);
      expect(leaderElection.isLeader()).toBe(true);
    });

    it('connect que rejeita descarta o Client e o retry seguinte cria um novo', async () => {
      const bad = makeFakeClient();
      bad.connect.mockRejectedValue(new Error('ECONNREFUSED'));
      const good = makeFakeClient({ acquired: true });
      Client.mockImplementationOnce(() => bad).mockImplementation(() => good);

      leaderElection.start();
      await leaderElection.whenFirstAttemptSettled();
      expect(bad.end).toHaveBeenCalled();
      expect(bad.query).not.toHaveBeenCalled();

      jest.advanceTimersByTime(RETRY_INTERVAL_MS);
      await flush();
      expect(Client).toHaveBeenCalledTimes(2);
      expect(good.query).toHaveBeenCalled();
      expect(leaderElection.isLeader()).toBe(true);
    });

    it('erro tardio de um Client descartado nao derruba a lideranca do Client atual', async () => {
      const hung = makeFakeClient();
      hung.connect.mockReturnValue(new Promise(() => {}));
      const good = makeFakeClient({ acquired: true });
      Client.mockImplementationOnce(() => hung).mockImplementation(() => good);

      leaderElection.start();
      jest.advanceTimersByTime(CONNECT_TIMEOUT_MS);
      await flush();
      jest.advanceTimersByTime(RETRY_INTERVAL_MS);
      await flush();
      expect(leaderElection.isLeader()).toBe(true);

      hung._emit('error', new Error('socket hang up'));
      expect(leaderElection.isLeader()).toBe(true);

      // sem o retry achar client === null e abrir uma 3a conexão
      jest.advanceTimersByTime(RETRY_INTERVAL_MS);
      await flush();
      expect(Client).toHaveBeenCalledTimes(2);
    });
  });

  it('stop() encerra a conexao e isLeader() volta a false', async () => {
    const fake = makeFakeClient({ acquired: true });
    Client.mockImplementation(() => fake);

    leaderElection.start();
    await flush();

    await leaderElection.stop();

    expect(fake.end).toHaveBeenCalled();
    expect(leaderElection.isLeader()).toBe(false);
  });
});
