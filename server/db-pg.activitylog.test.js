'use strict';

/**
 * Testes de insertActivityLog (dedupe) contra um Postgres real (instância
 * dev). Incidente de 23/11: activity_log cresceu a 59M linhas/23GB em 3
 * meses porque o companion reporta janela/processo a cada ~4s mesmo sem
 * mudança -- esta suite prova que chamadas consecutivas com o mesmo
 * (windowTitle, processName) reutilizam a última linha em vez de inserir
 * uma nova.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.activitylog.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (activity_log dedupe)', () => {
  let db;
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdMachineIds.length) {
      const id = createdMachineIds.pop();
      await pool.query('DELETE FROM activity_log WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM machines WHERE id=$1', [id]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  function trackMachine(id) {
    createdMachineIds.push(id);
    return id;
  }

  async function makeMachine() {
    const id = trackMachine(crypto.randomUUID());
    await db.registerMachine({ machineId: id, hostname: `ACT-${id.slice(0, 8)}`, agentVersion: '1.0' });
    return id;
  }

  describe('insertActivityLog', () => {
    it('primeira chamada para uma máquina sem linha anterior insere normalmente', async () => {
      const machineId = await makeMachine();

      const result = await db.insertActivityLog(machineId, 'Chrome - abc', 'chrome.exe');
      expect(result.id).toBeDefined();
      expect(result.capturedAt).toBeDefined();

      const { rows } = await db.getPool().query(
        'SELECT count(*) c FROM activity_log WHERE machine_id=$1', [machineId]
      );
      expect(Number(rows[0].c)).toBe(1);
    });

    it('nao insere linha nova quando windowTitle e processName sao iguais aos da ultima captura dessa maquina', async () => {
      const machineId = await makeMachine();

      const first = await db.insertActivityLog(machineId, 'Chrome - abc', 'chrome.exe');
      const second = await db.insertActivityLog(machineId, 'Chrome - abc', 'chrome.exe');

      expect(second.id).toBe(first.id); // mesma linha, nao criou outra

      const { rows } = await db.getPool().query(
        'SELECT count(*) c FROM activity_log WHERE machine_id=$1', [machineId]
      );
      expect(Number(rows[0].c)).toBe(1);

      // captured_at avancou (a linha existente foi "tocada", nao substituida)
      const row = await db.getPool().query(
        'SELECT captured_at FROM activity_log WHERE id=$1', [first.id]
      );
      expect(row.rows[0].captured_at).toBe(second.capturedAt);
    });

    it('insere linha nova quando windowTitle muda', async () => {
      const machineId = await makeMachine();

      const first = await db.insertActivityLog(machineId, 'Chrome - abc', 'chrome.exe');
      const second = await db.insertActivityLog(machineId, 'Excel - xyz', 'excel.exe');

      expect(second.id).not.toBe(first.id);

      const { rows } = await db.getPool().query(
        'SELECT count(*) c FROM activity_log WHERE machine_id=$1', [machineId]
      );
      expect(Number(rows[0].c)).toBe(2);
    });

    it('insere linha nova quando so processName muda (windowTitle igual)', async () => {
      const machineId = await makeMachine();

      const first = await db.insertActivityLog(machineId, 'Terminal', 'bash.exe');
      const second = await db.insertActivityLog(machineId, 'Terminal', 'pwsh.exe');

      expect(second.id).not.toBe(first.id);

      const { rows } = await db.getPool().query(
        'SELECT count(*) c FROM activity_log WHERE machine_id=$1', [machineId]
      );
      expect(Number(rows[0].c)).toBe(2);
    });

    it('getActivityLog continua ordenando por captured_at DESC apos dedupe (linha tocada vai pro topo)', async () => {
      const machineId = await makeMachine();

      await db.insertActivityLog(machineId, 'Chrome - abc', 'chrome.exe');
      const other = await db.insertActivityLog(machineId, 'Excel - xyz', 'excel.exe');
      // repete o Excel -- deve atualizar a linha do Excel (id = other.id), empurrando-a pro topo
      const touched = await db.insertActivityLog(machineId, 'Excel - xyz', 'excel.exe');
      expect(touched.id).toBe(other.id);

      const log = await db.getActivityLog(machineId, 10);
      expect(log[0].id).toBe(other.id);
      expect(log).toHaveLength(2); // nao criou 3a linha
    });
  });
});
