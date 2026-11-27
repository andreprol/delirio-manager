'use strict';

jest.mock('../db-pg', () => ({
  recordDbSizeSnapshot: jest.fn(async () => 5),
  getDbSizeGrowth: jest.fn(async () => []),
  purgeDbSizeSnapshots: jest.fn(async () => 0),
  getTablesAlertedWithinDays: jest.fn(async () => []),
  recordAlertsSent: jest.fn(async () => {}),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(() => JSON.stringify({ msGraph: { tenantId: 't', clientId: 'c', clientSecret: 's', refreshToken: 'r' } })),
  writeFileSync: jest.fn(),
}));

global.fetch = jest.fn();

// default: lider, preserva o comportamento de todos os testes já existentes
// abaixo (nenhum deles mocka leaderElection) — só o describe "leader guard"
// no fim do arquivo sobrescreve isso com seu próprio doMock + resetModules.
jest.mock('./leaderElection', () => ({ isLeader: () => true }));

const {
  runSnapshotOnce, runGrowthCheckOnce, runPurgeSnapshotsOnce, scheduleDailyMonitor, stop,
  isAlertable, formatBytes,
  GROWTH_PCT_THRESHOLD, GROWTH_BYTES_THRESHOLD, LARGE_TABLE_BYTES_THRESHOLD, SNAPSHOT_RETENTION_DAYS,
} = require('./dbSizeMonitor');

afterEach(() => {
  stop();
  jest.clearAllMocks();
});

describe('isAlertable', () => {
  it('alerta quando cresce rápido (% e bytes acima do threshold)', () => {
    const row = { growthPct: GROWTH_PCT_THRESHOLD + 10, growthBytes: GROWTH_BYTES_THRESHOLD + 1, bytesNow: 1000 };
    expect(isAlertable(row)).toBe(true);
  });

  it('não alerta só com % alto se bytes absolutos forem pequenos (tabela minúscula dobrando)', () => {
    const row = { growthPct: 200, growthBytes: 1024, bytesNow: 2048 };
    expect(isAlertable(row)).toBe(false);
  });

  it('não alerta com crescimento normal e tabela pequena', () => {
    const row = { growthPct: 5, growthBytes: 1024, bytesNow: 1024 * 1024 };
    expect(isAlertable(row)).toBe(false);
  });

  it('alerta quando já está grande, mesmo sem crescimento rápido', () => {
    const row = { growthPct: 1, growthBytes: 1024, bytesNow: LARGE_TABLE_BYTES_THRESHOLD + 1 };
    expect(isAlertable(row)).toBe(true);
  });

  it('growthPct null (sem baseline) não quebra, só considera bytesNow', () => {
    const row = { growthPct: null, growthBytes: 0, bytesNow: LARGE_TABLE_BYTES_THRESHOLD + 1 };
    expect(isAlertable(row)).toBe(true);
  });
});

describe('formatBytes', () => {
  it('formata GB/MB/KB de acordo com a magnitude', () => {
    expect(formatBytes(2 * 1024 ** 3)).toMatch(/GB/);
    expect(formatBytes(2 * 1024 ** 2)).toMatch(/MB/);
    expect(formatBytes(2 * 1024)).toMatch(/KB/);
  });
});

describe('runSnapshotOnce', () => {
  it('chama recordDbSizeSnapshot e retorna quantas tabelas gravou', async () => {
    const db = require('../db-pg');
    const count = await runSnapshotOnce();
    expect(db.recordDbSizeSnapshot).toHaveBeenCalled();
    expect(count).toBe(5);
  });

  it('erro não lança -- retorna 0 e segue', async () => {
    const db = require('../db-pg');
    db.recordDbSizeSnapshot.mockRejectedValueOnce(new Error('disco cheio'));
    const count = await runSnapshotOnce();
    expect(count).toBe(0);
  });
});

describe('runGrowthCheckOnce', () => {
  it('sem nenhuma tabela alertável, não manda e-mail', async () => {
    const db = require('../db-pg');
    db.getDbSizeGrowth.mockResolvedValueOnce([
      { table_name: 'small', growthPct: 5, growthBytes: 100, bytesNow: 1000 },
    ]);
    const result = await runGrowthCheckOnce();
    expect(result).toEqual({ checked: 1, alerted: 0, skippedCooldown: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('com tabela alertável, manda e-mail via Graph e registra o alerta enviado', async () => {
    const db = require('../db-pg');
    const row = { table_name: 'ncr_monitor_emails', growthPct: 80, growthBytes: GROWTH_BYTES_THRESHOLD + 1, bytesNow: 10_000_000, bytesBefore: 1, rowsNow: 10, rowsBefore: 1 };
    db.getDbSizeGrowth.mockResolvedValueOnce([row]);
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok' }) }) // token
      .mockResolvedValueOnce({ ok: true }); // sendMail

    const result = await runGrowthCheckOnce();
    expect(result).toEqual({ checked: 1, alerted: 1, skippedCooldown: 0 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const sendMailCall = global.fetch.mock.calls[1];
    expect(sendMailCall[0]).toMatch(/sendMail/);
    expect(db.recordAlertsSent).toHaveBeenCalledWith([row]);
  });

  it('tabela já alertada dentro do cooldown é pulada -- não manda e-mail de novo', async () => {
    const db = require('../db-pg');
    db.getDbSizeGrowth.mockResolvedValueOnce([
      { table_name: 'ncr_monitor_emails', growthPct: 1, growthBytes: 0, bytesNow: LARGE_TABLE_BYTES_THRESHOLD + 1, bytesBefore: 1, rowsNow: 10, rowsBefore: 1 },
    ]);
    db.getTablesAlertedWithinDays.mockResolvedValueOnce(['ncr_monitor_emails']);

    const result = await runGrowthCheckOnce();
    expect(result).toEqual({ checked: 1, alerted: 0, skippedCooldown: 1 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.recordAlertsSent).not.toHaveBeenCalled();
  });

  it('mistura tabela no cooldown com tabela nova alertável -- só manda/registra a nova', async () => {
    const db = require('../db-pg');
    const stale = { table_name: 'ja_alertada', growthPct: 1, growthBytes: 0, bytesNow: LARGE_TABLE_BYTES_THRESHOLD + 1, bytesBefore: 1, rowsNow: 1, rowsBefore: 1 };
    const fresh = { table_name: 'nova', growthPct: 1, growthBytes: 0, bytesNow: LARGE_TABLE_BYTES_THRESHOLD + 1, bytesBefore: 1, rowsNow: 1, rowsBefore: 1 };
    db.getDbSizeGrowth.mockResolvedValueOnce([stale, fresh]);
    db.getTablesAlertedWithinDays.mockResolvedValueOnce(['ja_alertada']);
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true });

    const result = await runGrowthCheckOnce();
    expect(result).toEqual({ checked: 2, alerted: 1, skippedCooldown: 1 });
    expect(db.recordAlertsSent).toHaveBeenCalledWith([fresh]);
  });

  it('erro no getDbSizeGrowth não lança -- retorna zeros', async () => {
    const db = require('../db-pg');
    db.getDbSizeGrowth.mockRejectedValueOnce(new Error('disco cheio'));
    const result = await runGrowthCheckOnce();
    expect(result).toEqual({ checked: 0, alerted: 0, skippedCooldown: 0 });
  });
});

describe('runPurgeSnapshotsOnce', () => {
  it('chama purgeDbSizeSnapshots com SNAPSHOT_RETENTION_DAYS', async () => {
    const db = require('../db-pg');
    db.purgeDbSizeSnapshots.mockResolvedValueOnce(42);
    const removed = await runPurgeSnapshotsOnce();
    expect(db.purgeDbSizeSnapshots).toHaveBeenCalledWith(SNAPSHOT_RETENTION_DAYS);
    expect(removed).toBe(42);
  });

  it('erro não lança -- retorna 0', async () => {
    const db = require('../db-pg');
    db.purgeDbSizeSnapshots.mockRejectedValueOnce(new Error('disco cheio'));
    const removed = await runPurgeSnapshotsOnce();
    expect(removed).toBe(0);
  });
});

describe('scheduleDailyMonitor / stop', () => {
  it('stop() sem agendamento ativo não lança', () => {
    expect(() => stop()).not.toThrow();
  });

  it('stop() cancela o reagendamento, sem deixar timer pendente', () => {
    jest.useFakeTimers();
    try {
      scheduleDailyMonitor();
      stop();
      const db = require('../db-pg');
      const callsAfterStop = db.recordDbSizeSnapshot.mock.calls.length;
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(db.recordDbSizeSnapshot.mock.calls.length).toBe(callsAfterStop);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('leader guard', () => {
  it('runSnapshotOnce nao grava snapshot quando nao e o lider', async () => {
    jest.resetModules();
    jest.doMock('./leaderElection', () => ({ isLeader: () => false }));
    const recordDbSizeSnapshotMock = jest.fn();
    jest.doMock('../db-pg', () => ({
      recordDbSizeSnapshot: recordDbSizeSnapshotMock,
      getDbSizeGrowth: jest.fn(), purgeDbSizeSnapshots: jest.fn(),
      getTablesAlertedWithinDays: jest.fn(), recordAlertsSent: jest.fn(),
    }));
    const fresh = require('./dbSizeMonitor');

    const result = await fresh.runSnapshotOnce();

    expect(recordDbSizeSnapshotMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('runGrowthCheckOnce nao checa crescimento nem alerta quando nao e o lider', async () => {
    jest.resetModules();
    jest.doMock('./leaderElection', () => ({ isLeader: () => false }));
    const getDbSizeGrowthMock = jest.fn();
    jest.doMock('../db-pg', () => ({
      recordDbSizeSnapshot: jest.fn(),
      getDbSizeGrowth: getDbSizeGrowthMock, purgeDbSizeSnapshots: jest.fn(),
      getTablesAlertedWithinDays: jest.fn(), recordAlertsSent: jest.fn(),
    }));
    const fresh = require('./dbSizeMonitor');

    const result = await fresh.runGrowthCheckOnce();

    expect(getDbSizeGrowthMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('runPurgeSnapshotsOnce nao purga snapshots antigos quando nao e o lider', async () => {
    jest.resetModules();
    jest.doMock('./leaderElection', () => ({ isLeader: () => false }));
    const purgeDbSizeSnapshotsMock = jest.fn();
    jest.doMock('../db-pg', () => ({
      recordDbSizeSnapshot: jest.fn(), getDbSizeGrowth: jest.fn(),
      purgeDbSizeSnapshots: purgeDbSizeSnapshotsMock,
      getTablesAlertedWithinDays: jest.fn(), recordAlertsSent: jest.fn(),
    }));
    const fresh = require('./dbSizeMonitor');

    const result = await fresh.runPurgeSnapshotsOnce();

    expect(purgeDbSizeSnapshotsMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
