'use strict';

/**
 * Testes do Grupo 13 (ncr_monitor_emails, service_status) de
 * server/db-pg.js contra um Postgres real (instância dev). Nenhuma das 2
 * tabelas tem FK pra machines -- limpeza manual.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.ncr.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 13: NCR Monitor + service_status)', () => {
  let db;
  const createdMessageIds = [];
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdMessageIds.length) {
      await pool.query('DELETE FROM ncr_monitor_emails WHERE message_id=$1', [createdMessageIds.pop()]);
    }
    while (createdMachineIds.length) {
      const id = createdMachineIds.pop();
      await pool.query('DELETE FROM service_status WHERE machine_id=$1', [id]); // sem FK, manual
      await pool.query('DELETE FROM machines WHERE id=$1', [id]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  async function insertMachine(hostname) {
    const id = crypto.randomUUID();
    createdMachineIds.push(id);
    await db.getPool().query(
      `INSERT INTO machines (id, hostname, token, registered_at) VALUES ($1,$2,$3,$4)`,
      [id, hostname, crypto.randomUUID(), new Date().toISOString()]
    );
    return id;
  }

  function trackMessage(messageId) {
    createdMessageIds.push(messageId);
    return messageId;
  }

  describe('ncrInsertEmail / ncrGetByMessageId / ncrGetByCommandId / ncrUpdate', () => {
    it('insere, ON CONFLICT DO NOTHING em message_id duplicado (rowCount reflete)', async () => {
      const messageId = trackMessage(`msg-${crypto.randomUUID()}`);
      const inserted = await db.ncrInsertEmail({ message_id: messageId, received_at: new Date().toISOString(), order_ref: '123' });
      expect(inserted).toBe(1);

      const duplicated = await db.ncrInsertEmail({ message_id: messageId, received_at: new Date().toISOString(), order_ref: '999' });
      expect(duplicated).toBe(0); // ignorado

      const row = await db.ncrGetByMessageId(messageId);
      expect(row.order_ref).toBe('123'); // não sobrescreveu
    });

    it('ncrUpdate atualiza campos dinâmicos e ncrGetByCommandId lê de volta', async () => {
      const messageId = trackMessage(`msg-${crypto.randomUUID()}`);
      await db.ncrInsertEmail({ message_id: messageId, received_at: new Date().toISOString() });
      const row = await db.ncrGetByMessageId(messageId);

      const commandId = crypto.randomUUID();
      await db.ncrUpdate(row.id, { command_id: commandId, retry_count: 2 });

      const byCommand = await db.ncrGetByCommandId(commandId);
      expect(byCommand.id).toBe(row.id);
      expect(byCommand.retry_count).toBe(2);
    });

    it('ncrUpdate sem campos é noop', async () => {
      const messageId = trackMessage(`msg-${crypto.randomUUID()}`);
      await db.ncrInsertEmail({ message_id: messageId, received_at: new Date().toISOString() });
      const row = await db.ncrGetByMessageId(messageId);
      await expect(db.ncrUpdate(row.id, {})).resolves.toBeUndefined();
    });
  });

  describe('ncrGetPendingRetries', () => {
    it('só traz danfe_found NULL, retry_count 1-4, machine_id e command_id setados, next_retry_at vencido ou nulo', async () => {
      const machineId = await insertMachine(`HOST-${crypto.randomUUID().slice(0, 8)}`);
      const commandId = crypto.randomUUID();

      const dueId = trackMessage(`due-${crypto.randomUUID()}`);
      await db.ncrInsertEmail({ message_id: dueId, received_at: new Date().toISOString() });
      await db.ncrUpdate((await db.ncrGetByMessageId(dueId)).id, {
        retry_count: 1, machine_id: machineId, command_id: commandId,
        next_retry_at: new Date(Date.now() - 60000).toISOString(), // já venceu
      });

      const notDueId = trackMessage(`notdue-${crypto.randomUUID()}`);
      await db.ncrInsertEmail({ message_id: notDueId, received_at: new Date().toISOString() });
      await db.ncrUpdate((await db.ncrGetByMessageId(notDueId)).id, {
        retry_count: 1, machine_id: machineId, command_id: commandId,
        next_retry_at: new Date(Date.now() + 3600000).toISOString(), // no futuro
      });

      const exhaustedId = trackMessage(`exhausted-${crypto.randomUUID()}`);
      await db.ncrInsertEmail({ message_id: exhaustedId, received_at: new Date().toISOString() });
      await db.ncrUpdate((await db.ncrGetByMessageId(exhaustedId)).id, {
        retry_count: 5, machine_id: machineId, command_id: commandId,
      });

      const pending = await db.ncrGetPendingRetries();
      const ids = pending.map(p => p.message_id);
      expect(ids).toContain(dueId);
      expect(ids).not.toContain(notDueId);
      expect(ids).not.toContain(exhaustedId);
    });
  });

  describe('ncrGetAckTimedOut', () => {
    it('traz só quando o commando não foi acked e passou do cutoff', async () => {
      const machineId = await insertMachine(`HOST-${crypto.randomUUID().slice(0, 8)}`);
      const oldCommandId = await db.createCommand(machineId, 'ncr-lookup');
      // força created_at pro passado (createCommand usa now())
      await db.getPool().query(`UPDATE commands SET created_at=$1 WHERE id=$2`, [new Date(Date.now() - 3600000).toISOString(), oldCommandId]);

      const timedOutId = trackMessage(`timedout-${crypto.randomUUID()}`);
      await db.ncrInsertEmail({ message_id: timedOutId, received_at: new Date().toISOString() });
      await db.ncrUpdate((await db.ncrGetByMessageId(timedOutId)).id, { machine_id: machineId, command_id: oldCommandId });

      const cutoff = new Date(Date.now() - 1800000).toISOString(); // 30min atrás
      const timedOut = await db.ncrGetAckTimedOut(cutoff);
      expect(timedOut.map(t => t.order_ref !== undefined)).toBeTruthy();
      expect(timedOut.some(t => t.command_id === oldCommandId)).toBe(true);

      await db.getPool().query('DELETE FROM commands WHERE id=$1', [oldCommandId]);
    });
  });

  describe('upsertServiceStatus / getServiceStatusBOH', () => {
    it('ON CONFLICT(machine_id,service_name) atualiza em vez de duplicar', async () => {
      const machineId = await insertMachine(`BOH-${crypto.randomUUID().slice(0, 8)}`);
      await db.upsertServiceStatus(machineId, 'AlohaService', 'running', null, null);
      await db.upsertServiceStatus(machineId, 'AlohaService', 'stopped', new Date().toISOString(), 1);

      const { rows } = await db.getPool().query(
        'SELECT status, last_restart_ok FROM service_status WHERE machine_id=$1 AND service_name=$2',
        [machineId, 'AlohaService']
      );
      expect(rows).toHaveLength(1); // não duplicou
      expect(rows[0].status).toBe('stopped');
      expect(rows[0].last_restart_ok).toBe(1);
    });

    it('getServiceStatusBOH só traz hostnames terminados em BOH (UPPER, sem ILIKE)', async () => {
      const bohId = await insertMachine(`LOJA-${crypto.randomUUID().slice(0, 6)}-boh`); // minúsculo de propósito
      const notBohId = await insertMachine(`LOJA-${crypto.randomUUID().slice(0, 6)}-PDV`);

      await db.upsertServiceStatus(bohId, 'Svc', 'running', null, null);
      await db.upsertServiceStatus(notBohId, 'Svc', 'running', null, null);

      const results = await db.getServiceStatusBOH();
      const ids = results.map(r => r.machine_id);
      expect(ids).toContain(bohId); // "-boh" minúsculo ainda bate via UPPER()
      expect(ids).not.toContain(notBohId);
    });
  });
});
