'use strict';

jest.mock('../db-pg', () => ({
  getLongRunningTransactions: jest.fn(async () => []),
}));

jest.mock('./resendAlert', () => ({
  sendAlert: jest.fn(async () => ({ sent: true })),
}));

// default: lider, preserva o comportamento de todos os testes já existentes
// abaixo (nenhum deles mocka leaderElection) -- só o describe "leader guard"
// no fim do arquivo sobrescreve isso com seu próprio doMock + resetModules.
jest.mock('./leaderElection', () => ({ isLeader: () => true }));

const { checkOnce, stop, THRESHOLD_MINUTES } = require('./longTransactionMonitor');

afterEach(() => {
  stop();
  jest.clearAllMocks();
});

describe('checkOnce sem transação longa', () => {
  it('não alerta quando getLongRunningTransactions retorna vazio', async () => {
    const db = require('../db-pg');
    const { sendAlert } = require('./resendAlert');
    db.getLongRunningTransactions.mockResolvedValueOnce([]);

    const result = await checkOnce();

    expect(db.getLongRunningTransactions).toHaveBeenCalledWith(THRESHOLD_MINUTES);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, alerted: false });
  });

  it('quando getLongRunningTransactions rejeita, não lança -- loga e retorna sem alertar', async () => {
    const db = require('../db-pg');
    const { sendAlert } = require('./resendAlert');
    db.getLongRunningTransactions.mockRejectedValueOnce(new Error('conexão perdida'));

    const result = await checkOnce();

    expect(result).toEqual({ checked: 0, alerted: false });
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('checkOnce com transação longa', () => {
  it('com 1+ transações longas, alerta com cooldownKey e detail útil', async () => {
    const db = require('../db-pg');
    const { sendAlert } = require('./resendAlert');
    const row = {
      pid: 4242,
      usename: 'delirio_app',
      applicationName: 'node',
      state: 'active',
      query: "UPDATE machines SET id=$1 WHERE id=$2",
      xactDurationSeconds: 420,
      queryDurationSeconds: 410,
    };
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
