'use strict';

/**
 * Cobre purgeOrphanCommands / purgeOldTerminalCommands (incidente 15/11/2026
 * — `commands` chegou a 106.220 linhas, 56.171 órfãs de uma máquina removida
 * há 2 meses, sem nenhuma retenção). Ambas batchadas (1000 linhas/lote) pra
 * nunca travar o writer síncrono do better-sqlite3 com um DELETE gigante.
 * Usa DB :memory: (mesmo padrão dos demais db.*.test.js).
 */

const crypto = require('crypto');

beforeEach(() => {
  jest.resetModules();
  process.env.DB_PATH = ':memory:';
});

afterEach(() => {
  delete process.env.DB_PATH;
});

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function insertRawCommand(db, { machineId, status, createdAt }) {
  db.getDb().prepare(
    `INSERT INTO commands (id, machine_id, type, status, created_at) VALUES (?,?,?,?,?)`
  ).run(crypto.randomUUID(), machineId, 'noop', status, createdAt);
}

function countCommands(db, machineId) {
  return db.getDb().prepare('SELECT COUNT(*) as c FROM commands WHERE machine_id=?').get(machineId).c;
}

describe('purgeOrphanCommands', () => {
  it('não apaga nada se `machines` estiver vazia (salvaguarda contra anti-join sobre tabela toda)', async () => {
    const db = require('./db');
    const orphanId = crypto.randomUUID();
    insertRawCommand(db, { machineId: orphanId, status: 'pending', createdAt: new Date().toISOString() });

    const removed = await db.purgeOrphanCommands();

    expect(removed).toBe(0);
    expect(countCommands(db, orphanId)).toBe(1);
  });

  it('apaga comandos de machine_id órfão, preservando os de máquina viva', async () => {
    const db = require('./db');
    const machineId = crypto.randomUUID();
    db.registerMachine({ machineId, hostname: 'LOJA-01', agentVersion: '1.0' });
    db.createCommand(machineId, 'noop');

    const orphanId = crypto.randomUUID();
    insertRawCommand(db, { machineId: orphanId, status: 'pending', createdAt: new Date().toISOString() });

    const removed = await db.purgeOrphanCommands();

    expect(removed).toBe(1);
    expect(countCommands(db, orphanId)).toBe(0);
    expect(countCommands(db, machineId)).toBe(1);
  });

  it('pagina em lotes até apagar tudo, mesmo acima do tamanho de um lote', async () => {
    const db = require('./db');
    const machineId = crypto.randomUUID();
    db.registerMachine({ machineId, hostname: 'LOJA-02', agentVersion: '1.0' });

    const orphanId = crypto.randomUUID();
    const raw = db.getDb();
    const insert = raw.prepare(
      `INSERT INTO commands (id, machine_id, type, status, created_at) VALUES (?,?,?,?,?)`
    );
    const BATCH_SIZE = 1000;
    const TOTAL = BATCH_SIZE * 2 + 500; // força 3 iterações do loop de purge
    raw.transaction(() => {
      for (let i = 0; i < TOTAL; i++) {
        insert.run(crypto.randomUUID(), orphanId, 'noop', 'pending', new Date().toISOString());
      }
    })();

    const removed = await db.purgeOrphanCommands();

    expect(removed).toBe(TOTAL);
    expect(countCommands(db, orphanId)).toBe(0);
  });
});

describe('purgeOldTerminalCommands', () => {
  it('apaga comandos terminais (acked/failed) antigos', async () => {
    const db = require('./db');
    const machineId = crypto.randomUUID();
    db.registerMachine({ machineId, hostname: 'LOJA-03', agentVersion: '1.0' });
    insertRawCommand(db, { machineId, status: 'acked', createdAt: daysAgoIso(31) });
    insertRawCommand(db, { machineId, status: 'failed', createdAt: daysAgoIso(45) });

    const removed = await db.purgeOldTerminalCommands(30);

    expect(removed).toBe(2);
    expect(countCommands(db, machineId)).toBe(0);
  });

  it('não apaga pending/sent nem terminais recentes, nem com days<=0 (noop)', async () => {
    const db = require('./db');
    const machineId = crypto.randomUUID();
    db.registerMachine({ machineId, hostname: 'LOJA-04', agentVersion: '1.0' });
    db.createCommand(machineId, 'noop'); // pending, recente
    insertRawCommand(db, { machineId, status: 'sent', createdAt: daysAgoIso(60) }); // sent é "em voo", mesmo velho
    insertRawCommand(db, { machineId, status: 'acked', createdAt: daysAgoIso(1) }); // terminal mas recente

    const removed = await db.purgeOldTerminalCommands(30);

    expect(removed).toBe(0);
    expect(countCommands(db, machineId)).toBe(3);

    const noop = await db.purgeOldTerminalCommands(0);
    expect(noop).toBe(0);
    expect(countCommands(db, machineId)).toBe(3);
  });
});
