'use strict';

/**
 * Testes do Grupo 2 (commands + events) de server/db-pg.js contra um
 * Postgres real (instância dev). Pula a suite se DATABASE_URL não setada —
 * ver db-pg.machines.test.js pro mesmo padrão.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.commands.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 2: commands + events)', () => {
  let db;
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdMachineIds.length) {
      const id = createdMachineIds.pop();
      await pool.query('DELETE FROM commands WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM events WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM machines WHERE id=$1', [id]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  async function insertMachine() {
    const id = crypto.randomUUID();
    createdMachineIds.push(id);
    const now = new Date().toISOString();
    await db.getPool().query(
      `INSERT INTO machines (id, hostname, token, registered_at) VALUES ($1,$2,$3,$4)`,
      [id, `HOST-${id.slice(0, 8)}`, crypto.randomUUID(), now]
    );
    return id;
  }

  async function insertRawCommand(machineId, { status, createdAt, type = 'noop' }) {
    const id = crypto.randomUUID();
    await db.getPool().query(
      `INSERT INTO commands (id, machine_id, type, status, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, machineId, type, status, createdAt]
    );
    return id;
  }

  function daysAgoIso(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  describe('createCommand / getPendingCommands', () => {
    it('cria pending e getPendingCommands marca como sent', async () => {
      const machineId = await insertMachine();
      const id = await db.createCommand(machineId, 'noop', { foo: 'bar' });

      const pending = await db.getPendingCommands(machineId);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toEqual({ id, type: 'noop', params: { foo: 'bar' } });

      // Segunda chamada não traz mais nada -- já foi marcado 'sent'
      expect(await db.getPendingCommands(machineId)).toHaveLength(0);
      expect((await db.getCommandById(id)).status).toBe('sent');
    });

    it('não quebra quando não há pending (sem UPDATE com IN vazio)', async () => {
      const machineId = await insertMachine();
      await expect(db.getPendingCommands(machineId)).resolves.toEqual([]);
    });
  });

  describe('ackCommand', () => {
    it('success=true marca acked, success=false marca failed', async () => {
      const machineId = await insertMachine();
      const okId = await db.createCommand(machineId, 'noop');
      const failId = await db.createCommand(machineId, 'noop');

      await db.ackCommand(okId, machineId, true, 'tudo certo');
      await db.ackCommand(failId, machineId, false, 'deu erro');

      expect((await db.getCommandResult(okId)).status).toBe('acked');
      expect((await db.getCommandResult(okId)).result).toBe('tudo certo');
      expect((await db.getCommandResult(failId)).status).toBe('failed');
      expect((await db.getCommandResult(failId)).result).toBe('deu erro');
    });

    it('não afeta comando de outra máquina (WHERE id AND machine_id)', async () => {
      const machineA = await insertMachine();
      const machineB = await insertMachine();
      const id = await db.createCommand(machineA, 'noop');

      await db.ackCommand(id, machineB, true, 'nao deveria aplicar');

      expect((await db.getCommandResult(id)).status).toBe('pending');
    });
  });

  describe('getCommandHistory / getLastAlohaScan / getCommandById / getCommandResult', () => {
    it('getCommandHistory respeita limit e ordem DESC', async () => {
      const machineId = await insertMachine();
      await insertRawCommand(machineId, { status: 'acked', createdAt: daysAgoIso(2) });
      await insertRawCommand(machineId, { status: 'acked', createdAt: daysAgoIso(1) });
      await insertRawCommand(machineId, { status: 'acked', createdAt: daysAgoIso(0) });

      const history = await db.getCommandHistory(machineId, 2);
      expect(history).toHaveLength(2);
      expect(new Date(history[0].created_at).getTime())
        .toBeGreaterThan(new Date(history[1].created_at).getTime());
    });

    it('getLastAlohaScan só considera aloha-scan acked com result', async () => {
      const machineId = await insertMachine();
      await insertRawCommand(machineId, { status: 'acked', createdAt: daysAgoIso(1), type: 'other-type' });
      const id = await insertRawCommand(machineId, { status: 'acked', createdAt: daysAgoIso(0), type: 'aloha-scan' });
      await db.getPool().query(`UPDATE commands SET result='{"ok":true}', acked_at=$1 WHERE id=$2`, [new Date().toISOString(), id]);

      const scan = await db.getLastAlohaScan(machineId);
      expect(scan.id).toBe(id);
    });

    it('getLastAlohaScan undefined quando não há nenhum', async () => {
      const machineId = await insertMachine();
      expect(await db.getLastAlohaScan(machineId)).toBeUndefined();
    });
  });

  describe('purgeOrphanCommands', () => {
    // O caso "machines genuinamente vazia -> não apaga nada" já está coberto
    // em server/db.commandsRetention.test.js (versão SQLite, mesma lógica de
    // salvaguarda). Aqui confirmamos que a porta pra Postgres apaga o órfão
    // de verdade e preserva o comando da máquina viva.
    it('apaga órfão de machine_id inexistente, preserva comando de máquina viva', async () => {
      const machineId = await insertMachine();
      const liveCommandId = await db.createCommand(machineId, 'noop');

      const orphanMachineId = crypto.randomUUID(); // nunca inserida em machines
      const orphanCommandId = await insertRawCommand(
        orphanMachineId, { status: 'pending', createdAt: new Date().toISOString() }
      );

      const removed = await db.purgeOrphanCommands();

      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await db.getCommandById(orphanCommandId)).toBeUndefined();
      expect(await db.getCommandById(liveCommandId)).toBeDefined();
    });

    // Lacuna conhecida: nenhum teste aqui exercita o loop de múltiplos lotes
    // de deleteCommandsInBatches (COMMANDS_PURGE_BATCH_SIZE=1000) -- exigiria
    // inserir >1000 linhas num teste de integração, custo que não compensa
    // aqui já que a lógica do loop em si (não a tradução de sintaxe) já foi
    // testada na versão SQLite (server/db.commandsRetention.test.js, caso
    // "pagina em lotes até apagar tudo"). Revisar se algum dia o tamanho do
    // batch ou a condição de parada mudar.
  });

  describe('purgeOldTerminalCommands', () => {
    // purgeOldTerminalCommands é global (sem filtro por machine_id, igual
    // no db.js original) -- rodando contra a instância dev COMPARTILHADA,
    // `removed` pode incluir lixo de outro teste/execução/dev. Por isso
    // `toBeGreaterThanOrEqual` (nunca `toBe` exato) pro total, e a asserção
    // real do que este teste criou fica restrita a `getCommandHistory`
    // (escopado por machineId).
    it('apaga terminais antigos, preserva pending/sent e terminais recentes', async () => {
      const machineId = await insertMachine();
      await insertRawCommand(machineId, { status: 'acked', createdAt: daysAgoIso(31) });
      await insertRawCommand(machineId, { status: 'failed', createdAt: daysAgoIso(45) });
      await insertRawCommand(machineId, { status: 'sent', createdAt: daysAgoIso(60) });
      await insertRawCommand(machineId, { status: 'acked', createdAt: daysAgoIso(1) });

      const removed = await db.purgeOldTerminalCommands(30);

      expect(removed).toBeGreaterThanOrEqual(2);
      const remaining = await db.getCommandHistory(machineId, 10);
      expect(remaining).toHaveLength(2);
    });

    it('days<=0 é noop', async () => {
      const machineId = await insertMachine();
      await insertRawCommand(machineId, { status: 'acked', createdAt: daysAgoIso(100) });
      expect(await db.purgeOldTerminalCommands(0)).toBe(0);
      expect(await db.getCommandHistory(machineId, 10)).toHaveLength(1);
    });
  });

  describe('addEvent / getEvents', () => {
    it('grava e lê de volta, DESC, respeitando limit', async () => {
      const machineId = await insertMachine();
      await db.addEvent(machineId, 'agent_installed', 'v1.0');
      await db.addEvent(machineId, 'agent_reregistered', 'v1.1');

      const events = await db.getEvents(machineId, 1);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('agent_reregistered');
    });
  });
});
