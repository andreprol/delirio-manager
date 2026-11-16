'use strict';

/**
 * Testes do Grupo 3 (alerts + groups) de server/db-pg.js contra um Postgres
 * real (instância dev). Mesmo padrão dos Grupos 1-2 (pula se DATABASE_URL
 * não setada).
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.alerts-groups.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 3: alerts + groups)', () => {
  let db;
  const createdAlertIds = [];
  const createdGroupNames = [];
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdAlertIds.length) {
      await pool.query('DELETE FROM alerts WHERE id=$1', [createdAlertIds.pop()]);
    }
    while (createdGroupNames.length) {
      await pool.query('DELETE FROM groups WHERE name=$1', [createdGroupNames.pop()]);
    }
    while (createdMachineIds.length) {
      await pool.query('DELETE FROM machines WHERE id=$1', [createdMachineIds.pop()]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  function trackGroup(name) {
    createdGroupNames.push(name);
    return name;
  }

  async function insertMachine(location) {
    const id = crypto.randomUUID();
    createdMachineIds.push(id);
    await db.getPool().query(
      `INSERT INTO machines (id, hostname, token, registered_at, location) VALUES ($1,$2,$3,$4,$5)`,
      [id, `HOST-${id.slice(0, 8)}`, crypto.randomUUID(), new Date().toISOString(), location]
    );
    return id;
  }

  describe('createAlert / getAlerts / deleteAlert', () => {
    it('createAlert devolve o id (RETURNING) e getAlerts(machineId) traz dela + as globais', async () => {
      const machineId = await insertMachine('Loja Teste');
      const globalId = await db.createAlert({ type: 'disk_low', threshold: 90 });
      createdAlertIds.push(globalId);
      const specificId = await db.createAlert({ machineId, type: 'cpu_high', threshold: 95, durationMins: 5 });
      createdAlertIds.push(specificId);

      const alerts = await db.getAlerts(machineId);
      const ids = alerts.map(a => a.id);
      expect(ids).toContain(globalId); // machine_id IS NULL entra pra qualquer machineId
      expect(ids).toContain(specificId);

      const specific = alerts.find(a => a.id === specificId);
      expect(specific.threshold).toBe(95);
      expect(specific.duration_mins).toBe(5);
      expect(JSON.parse(specific.channels)).toEqual(['push']);
    });

    it('getAlerts sem machineId traz todas, ordenadas por id', async () => {
      const id1 = await db.createAlert({ type: 'a' });
      const id2 = await db.createAlert({ type: 'b' });
      createdAlertIds.push(id1, id2);

      const all = await db.getAlerts();
      const ids = all.map(a => a.id);
      expect(ids.indexOf(id1)).toBeLessThan(ids.indexOf(id2));
    });

    it('deleteAlert remove', async () => {
      const id = await db.createAlert({ type: 'x' });
      await db.deleteAlert(id);
      expect((await db.getAlerts()).map(a => a.id)).not.toContain(id);
    });
  });

  describe('createGroup / getGroups', () => {
    it('cria com sort_order incremental e ignora duplicata (ON CONFLICT DO NOTHING)', async () => {
      const a = trackGroup(`Grupo-A-${crypto.randomUUID().slice(0, 8)}`);
      const b = trackGroup(`Grupo-B-${crypto.randomUUID().slice(0, 8)}`);
      await db.createGroup(a);
      await db.createGroup(b);

      const before = await db.getGroups();
      const orderA = before.find(g => g.name === a).sort_order;
      const orderB = before.find(g => g.name === b).sort_order;
      expect(orderB).toBeGreaterThan(orderA);

      await db.createGroup(a); // duplicata -- não deve lançar nem duplicar
      const after = await db.getGroups();
      expect(after.filter(g => g.name === a)).toHaveLength(1);
    });
  });

  describe('deleteGroup', () => {
    it('apaga o grupo e move máquinas dele para location vazio', async () => {
      const name = trackGroup(`Grupo-Del-${crypto.randomUUID().slice(0, 8)}`);
      await db.createGroup(name);
      const machineId = await insertMachine(name);

      await db.deleteGroup(name);

      expect((await db.getGroups()).map(g => g.name)).not.toContain(name);
      const { rows } = await db.getPool().query('SELECT location FROM machines WHERE id=$1', [machineId]);
      expect(rows[0].location).toBe('');
    });
  });

  describe('renameGroup', () => {
    it('renomeia o grupo e atualiza location das máquinas dele', async () => {
      const oldName = trackGroup(`Grupo-Old-${crypto.randomUUID().slice(0, 8)}`);
      const newName = trackGroup(`Grupo-New-${crypto.randomUUID().slice(0, 8)}`);
      await db.createGroup(oldName);
      const machineId = await insertMachine(oldName);

      await db.renameGroup(oldName, newName);

      expect((await db.getGroups()).map(g => g.name)).not.toContain(oldName);
      expect((await db.getGroups()).map(g => g.name)).toContain(newName);
      const { rows } = await db.getPool().query('SELECT location FROM machines WHERE id=$1', [machineId]);
      expect(rows[0].location).toBe(newName);
    });
  });

  describe('reorderGroups', () => {
    it('aplica a nova ordem na sequência passada', async () => {
      const names = [
        trackGroup(`Grupo-1-${crypto.randomUUID().slice(0, 8)}`),
        trackGroup(`Grupo-2-${crypto.randomUUID().slice(0, 8)}`),
        trackGroup(`Grupo-3-${crypto.randomUUID().slice(0, 8)}`),
      ];
      for (const n of names) await db.createGroup(n);

      const reversed = [...names].reverse();
      await db.reorderGroups(reversed);

      const groups = await db.getGroups();
      const ordered = reversed.map(n => groups.find(g => g.name === n).sort_order);
      expect(ordered[0]).toBeLessThan(ordered[1]);
      expect(ordered[1]).toBeLessThan(ordered[2]);
    });
  });
});
