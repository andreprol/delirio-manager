'use strict';

/**
 * Testes do Grupo 5 (clock_offboard_log + clock_operation_log, LGPD Art.
 * 15/16) de server/db-pg.js contra um Postgres real (instância dev). Mesmo
 * padrão dos grupos anteriores. Sem FK pra machines -- limpeza por
 * cpf/operation únicos (afterEach, mesmo padrão de db-pg.alerts-groups.test.js)
 * pra nunca vazar linha na instância dev compartilhada mesmo se um teste falhar.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.clocklog.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 5: clock_offboard_log + clock_operation_log)', () => {
  let db;
  const createdCpfs = [];
  const createdOperations = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdCpfs.length) {
      await pool.query('DELETE FROM clock_offboard_log WHERE cpf=$1', [createdCpfs.pop()]);
    }
    while (createdOperations.length) {
      await pool.query('DELETE FROM clock_operation_log WHERE operation=$1', [createdOperations.pop()]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  function trackCpf() {
    const cpf = `TEST-${crypto.randomUUID()}`;
    createdCpfs.push(cpf);
    return cpf;
  }

  function trackOperation() {
    const operation = `test-op-${crypto.randomUUID()}`;
    createdOperations.push(operation);
    return operation;
  }

  describe('logClockOffboard / getClockOffboardLog', () => {
    it('grava todos os campos corretamente e lê de volta ordenado por timestamp DESC', async () => {
      const cpf = trackCpf();
      // Timestamps relativos a "agora" (não fixos no passado): getClockOffboardLog
      // não filtra por cpf (lê os 500 mais recentes globais da instância dev
      // compartilhada) -- data fixa no passado sairia da janela assim que a
      // tabela acumulasse >500 linhas mais recentes, quebrando de forma
      // determinística, não só flaky.
      const t1 = new Date(Date.now() - 1000).toISOString();
      const t2 = new Date().toISOString();
      await db.logClockOffboard({
        cpf, employeeName: 'Fulano', triggeredBy: 'admin',
        timestamp: t1, success: 1, removed: 1,
        alreadyAbsent: 0, failed: 0, detail: '[]',
      });
      await db.logClockOffboard({
        cpf, employeeName: 'Fulano', triggeredBy: 'admin',
        timestamp: t2, success: 1, removed: 1,
        alreadyAbsent: 0, failed: 0, detail: '["ok"]',
      });

      const log = await db.getClockOffboardLog(500);
      const mine = log.filter(r => r.cpf === cpf);
      expect(mine).toHaveLength(2);
      expect(mine[0].timestamp).toBe(t2); // DESC: a mais recente primeiro
      expect(mine[0]).toMatchObject({
        employee_name: 'Fulano', triggered_by: 'admin', success: 1,
        removed: 1, already_absent: 0, failed: 0, detail: '["ok"]',
      });
    });

    it('grava o caminho de falha (success=0, failed=-1 sentinel, removed=0)', async () => {
      const cpf = trackCpf();
      await db.logClockOffboard({
        cpf, employeeName: 'Ciclano', triggeredBy: 'scheduler',
        timestamp: new Date().toISOString(), success: 0, removed: 0,
        alreadyAbsent: 0, failed: -1, detail: '["erro: clock-proxy timeout"]',
      });

      const log = await db.getClockOffboardLog(500);
      const mine = log.find(r => r.cpf === cpf);
      expect(mine).toMatchObject({ success: 0, removed: 0, already_absent: 0, failed: -1 });
    });
  });

  describe('logClockOperation / getClockOperationLog', () => {
    it('aplica defaults (employeeName/triggeredBy/total/okCount/failedCount) e serializa detail objeto', async () => {
      const operation = trackOperation();
      const cpf = trackCpf();
      await db.logClockOperation({
        operation, cpf, timestamp: new Date().toISOString(), success: true,
        detail: { foo: 'bar' },
      });

      const log = await db.getClockOperationLog(500, operation);
      expect(log).toHaveLength(1);
      const row = log[0];
      expect(row.employee_name).toBe('');
      expect(row.triggered_by).toBe('');
      expect(row.total).toBe(0);
      expect(row.ok_count).toBe(0);
      expect(row.failed_count).toBe(0);
      expect(row.success).toBe(1);
      expect(JSON.parse(row.detail)).toEqual({ foo: 'bar' });
    });

    it('success=false grava 0; detail string não é re-serializado', async () => {
      const operation = trackOperation();
      await db.logClockOperation({
        operation, cpf: trackCpf(), timestamp: new Date().toISOString(),
        success: false, detail: 'ja-string',
      });

      const log = await db.getClockOperationLog(500, operation);
      expect(log[0].success).toBe(0);
      expect(log[0].detail).toBe('ja-string');
    });

    it('getClockOperationLog sem operation traz de todas as operações', async () => {
      const operation = trackOperation();
      await db.logClockOperation({
        operation, cpf: trackCpf(), timestamp: new Date().toISOString(), success: true,
      });

      const all = await db.getClockOperationLog(1000);
      expect(all.some(r => r.operation === operation)).toBe(true);
    });
  });
});
