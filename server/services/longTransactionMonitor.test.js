'use strict';

jest.mock('../db-pg', () => ({
  getLongRunningTransactions: jest.fn(async () => []),
}));

jest.mock('./resendAlert', () => ({
  sendAlert: jest.fn(async () => ({ sent: true })),
}));

// default: lider, preserva o comportamento de todos os testes já existentes
// abaixo (nenhum deles mocka leaderElection) -- só os describes que usam
// jest.resetModules()/jest.doMock() no fim do arquivo sobrescrevem isso.
jest.mock('./leaderElection', () => ({ isLeader: () => true }));

const { checkOnce, stop, THRESHOLD_MINUTES } = require('./longTransactionMonitor');

afterEach(() => {
  stop();
  jest.clearAllMocks();
});

// IMPORTANTE: nenhum teste acima deste comentário pode chamar
// jest.resetModules() -- isso desconectaria o `checkOnce`/`stop` importados
// no topo do arquivo dos mocks de ../db-pg e ./resendAlert usados por eles.
// Os describes que precisam de resetModules() (erro de conexão, leader guard,
// start/stop) ficam todos DEPOIS dos describes que usam os mocks do topo,
// mesmo padrão de dbSizeMonitor.test.js ("leader guard" sempre no fim).

describe('checkOnce sem transação longa', () => {
  it('não alerta quando getLongRunningTransactions retorna vazio', async () => {
    const db = require('../db-pg');
    const { sendAlert } = require('./resendAlert');
    db.getLongRunningTransactions.mockResolvedValueOnce([]);

    const result = await checkOnce();

    // 2o argumento é o pool isolado do monitor (nunca o pool compartilhado
    // de db-pg.js) -- achado ALTO do code-reviewer, ver longTransactionMonitor.js.
    expect(db.getLongRunningTransactions.mock.calls[0][0]).toBe(THRESHOLD_MINUTES);
    expect(db.getLongRunningTransactions.mock.calls[0][1]).toBeDefined();
    expect(sendAlert).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, alerted: false });
  });
});

describe('checkOnce com transação longa', () => {
  const row = {
    pid: 4242,
    usename: 'delirio_app',
    applicationName: 'node',
    state: 'active',
    query: 'UPDATE machines SET id=$1 WHERE id=$2',
    xactDurationSeconds: 420,
    queryDurationSeconds: 410,
  };

  it('alerta com cooldownKey e detail útil, e alerted reflete se o e-mail saiu', async () => {
    const db = require('../db-pg');
    const { sendAlert } = require('./resendAlert');
    db.getLongRunningTransactions.mockResolvedValueOnce([row]);

    const result = await checkOnce();

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const call = sendAlert.mock.calls[0][0];
    expect(call.source).toBe('Postgres');
    expect(call.cooldownKey).toBe('pg:long-transaction');
    expect(call.detail).toContain('4242');
    expect(call.detail).toContain('420');
    expect(result).toEqual({ checked: 1, alerted: true });
  });

  it('alerted é false quando sendAlert não manda de verdade (cooldown/alertas desligados/sem api key)', async () => {
    const db = require('../db-pg');
    const { sendAlert } = require('./resendAlert');
    db.getLongRunningTransactions.mockResolvedValueOnce([row]);
    sendAlert.mockResolvedValueOnce({ sent: false, reason: 'cooldown' });

    const result = await checkOnce();

    expect(result).toEqual({ checked: 1, alerted: false });
  });
});

describe('checkOnce trunca a query do alerta a 200 chars (defesa em profundidade)', () => {
  it('detail não contém mais que os primeiros 200 chars da query, mesmo que db-pg mande mais', async () => {
    const db = require('../db-pg');
    const { sendAlert } = require('./resendAlert');
    const longQuery = 'x'.repeat(500);
    db.getLongRunningTransactions.mockResolvedValueOnce([{
      pid: 1, usename: 'u', applicationName: 'a', state: 'active',
      query: longQuery, xactDurationSeconds: 10, queryDurationSeconds: 10,
    }]);

    await checkOnce();

    const call = sendAlert.mock.calls[0][0];
    expect(call.detail).toContain('x'.repeat(200));
    expect(call.detail).not.toContain('x'.repeat(201));
  });
});

// A partir daqui, todo teste usa jest.resetModules() + jest.doMock() próprio
// (nenhum usa mais o `checkOnce`/`db`/`sendAlert` do topo do arquivo).

describe('checkOnce com erro ao consultar pg_stat_activity', () => {
  it('não lança -- loga via logger.error E alerta com cooldownKey própria (pool/Postgres esgotado é o cenário mais crítico)', async () => {
    jest.resetModules();
    const loggerMock = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    jest.doMock('./logger', () => loggerMock);
    const getLongRunningTransactionsMock = jest.fn(async () => { throw new Error('conexão perdida'); });
    jest.doMock('../db-pg', () => ({ getLongRunningTransactions: getLongRunningTransactionsMock }));
    const sendAlertMock = jest.fn(async () => ({ sent: true }));
    jest.doMock('./resendAlert', () => ({ sendAlert: sendAlertMock }));
    jest.doMock('./leaderElection', () => ({ isLeader: () => true }));
    const fresh = require('./longTransactionMonitor');

    const result = await fresh.checkOnce();

    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('pg_stat_activity'),
      expect.objectContaining({ error: 'conexão perdida' })
    );
    expect(sendAlertMock).toHaveBeenCalledWith(expect.objectContaining({
      cooldownKey: 'pg:monitor-sem-conexao',
    }));
    expect(result).toEqual({ checked: 0, alerted: false });
  });
});

describe('leader guard', () => {
  it('checkOnce não consulta nem alerta quando não é o líder', async () => {
    jest.resetModules();
    jest.doMock('./leaderElection', () => ({ isLeader: () => false }));
    const getLongRunningTransactionsMock = jest.fn();
    jest.doMock('../db-pg', () => ({
      getLongRunningTransactions: getLongRunningTransactionsMock,
    }));
    const sendAlertMock = jest.fn();
    jest.doMock('./resendAlert', () => ({ sendAlert: sendAlertMock }));
    const fresh = require('./longTransactionMonitor');

    const result = await fresh.checkOnce();

    expect(getLongRunningTransactionsMock).not.toHaveBeenCalled();
    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

describe('start / stop', () => {
  it('stop() sem start() ativo não lança', () => {
    jest.resetModules();
    jest.doMock('./leaderElection', () => ({ isLeader: () => true }));
    jest.doMock('../db-pg', () => ({ getLongRunningTransactions: jest.fn(async () => []) }));
    jest.doMock('./resendAlert', () => ({ sendAlert: jest.fn(async () => ({ sent: true })) }));
    const fresh = require('./longTransactionMonitor');

    expect(() => fresh.stop()).not.toThrow();
  });

  it('chamar start() duas vezes seguidas não dispara um 2o ciclo (idempotente)', async () => {
    jest.resetModules();
    jest.doMock('./leaderElection', () => ({ isLeader: () => true }));
    const getLongRunningTransactionsMock = jest.fn(async () => []);
    jest.doMock('../db-pg', () => ({ getLongRunningTransactions: getLongRunningTransactionsMock }));
    jest.doMock('./resendAlert', () => ({ sendAlert: jest.fn(async () => ({ sent: true })) }));
    const fresh = require('./longTransactionMonitor');

    fresh.start();
    fresh.start(); // 2a chamada -- não deve criar um 2o ciclo nem vazar o timer do 1o
    await new Promise(resolve => setTimeout(resolve, 0)); // flush do macrotask -- deixa o checkOnce inicial (promise) resolver

    expect(getLongRunningTransactionsMock).toHaveBeenCalledTimes(1);
    fresh.stop();
  });
});
