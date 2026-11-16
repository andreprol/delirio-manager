'use strict';

/**
 * Testes do Grupo 14 (remote_employees, remote_sessions,
 * remote_time_entries) de server/db-pg.js contra um Postgres real
 * (instância dev). ÚLTIMO grupo da Fase 2. FK CASCADE de remote_sessions/
 * remote_time_entries pra remote_employees -- limpeza via afterEach
 * apagando o employee. Dado sensível (cpf fictício só, nunca real).
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.pontoremoto.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 14: Ponto Remoto)', () => {
  let db;
  const createdEmployeeIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdEmployeeIds.length) {
      await pool.query('DELETE FROM remote_employees WHERE id=$1', [createdEmployeeIds.pop()]); // FK CASCADE limpa sessions/time_entries
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  function fakeCpf() {
    // CPF fictício só pra satisfazer a coluna UNIQUE -- nunca dado real.
    return String(Math.floor(10000000000 + Math.random() * 89999999999));
  }

  async function createEmployee(overrides = {}) {
    const employee = await db.createRemoteEmployee({
      cpf: fakeCpf(), name: 'Funcionário Teste', store: 'Loja Teste', passwordHash: 'hash-fake',
      ...overrides,
    });
    createdEmployeeIds.push(employee.id);
    return employee;
  }

  describe('createRemoteEmployee / getRemoteEmployeeByCpf / getRemoteEmployeeById / listRemoteEmployees / setRemoteEmployeeActive', () => {
    it('cria (RETURNING *) com active=1 e lê de volta pelos 2 jeitos', async () => {
      const employee = await createEmployee();
      expect(employee.active).toBe(1);
      expect(employee.id).toBeDefined();

      const byCpf = await db.getRemoteEmployeeByCpf(employee.cpf);
      expect(byCpf.id).toBe(employee.id);
      const byId = await db.getRemoteEmployeeById(employee.id);
      expect(byId.cpf).toBe(employee.cpf);
    });

    it('listRemoteEmployees ordena por nome e nunca expõe password_hash', async () => {
      await createEmployee({ name: 'Zeta' });
      await createEmployee({ name: 'Alfa' });

      const list = await db.listRemoteEmployees();
      const names = list.filter(e => e.name === 'Zeta' || e.name === 'Alfa').map(e => e.name);
      expect(names.indexOf('Alfa')).toBeLessThan(names.indexOf('Zeta'));
      // list[0] seria uma linha qualquer da instância dev compartilhada,
      // não necessariamente Zeta/Alfa -- checa a lista inteira de verdade.
      expect(list.every(e => !('password_hash' in e))).toBe(true);
    });

    it('setRemoteEmployeeActive desativa e atualiza updated_at', async () => {
      const employee = await createEmployee();
      const before = employee.updated_at;

      await db.setRemoteEmployeeActive(employee.id, false);

      const after = await db.getRemoteEmployeeById(employee.id);
      expect(after.active).toBe(0);
      expect(after.updated_at).not.toBe(before);
    });
  });

  describe('createRemoteSession / getRemoteSession / deleteRemoteSession', () => {
    it('fluxo completo: cria, lê, apaga', async () => {
      const employee = await createEmployee();
      const tokenHash = crypto.randomUUID();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3600000).toISOString();

      await db.createRemoteSession({ tokenHash, employeeId: employee.id, createdAt: now, expiresAt });

      const session = await db.getRemoteSession(tokenHash);
      expect(session.employee_id).toBe(employee.id);
      expect(session.expires_at).toBe(expiresAt);

      await db.deleteRemoteSession(tokenHash);
      expect(await db.getRemoteSession(tokenHash)).toBeUndefined();
    });

    it('sessão é apagada em cascata quando o employee é apagado (FK CASCADE)', async () => {
      const employee = await createEmployee();
      const tokenHash = crypto.randomUUID();
      await db.createRemoteSession({
        tokenHash, employeeId: employee.id,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });

      await db.getPool().query('DELETE FROM remote_employees WHERE id=$1', [employee.id]);
      createdEmployeeIds.pop(); // já apagado manualmente, não deixa o afterEach tentar de novo

      expect(await db.getRemoteSession(tokenHash)).toBeUndefined();
    });
  });

  describe('insertRemoteTimeEntry / getRemoteTimeEntryById / listRemoteTimeEntriesForEmployee / listAllRemoteTimeEntries', () => {
    it('insere (RETURNING *) convertendo withinGeofence boolean->0/1, lê por id', async () => {
      const employee = await createEmployee();
      const entry = await db.insertRemoteTimeEntry({
        employeeId: employee.id, type: 'in', serverTs: new Date().toISOString(),
        lat: -22.9, lng: -43.2, accuracy: 5.5, withinGeofence: true,
      });
      expect(entry.within_geofence).toBe(1);
      expect(entry.created_by).toBe('employee'); // default

      const byId = await db.getRemoteTimeEntryById(entry.id);
      expect(byId.type).toBe('in');
      expect(byId.lat).toBeCloseTo(-22.9, 5);
    });

    it('withinGeofence null/undefined preserva NULL (não força 0)', async () => {
      const employee = await createEmployee();
      const entry = await db.insertRemoteTimeEntry({
        employeeId: employee.id, type: 'out', serverTs: new Date().toISOString(),
      });
      expect(entry.within_geofence).toBeNull();
    });

    it('correção administrativa referencia o registro original via corrects_id (append-only)', async () => {
      const employee = await createEmployee();
      const original = await db.insertRemoteTimeEntry({
        employeeId: employee.id, type: 'in', serverTs: new Date().toISOString(),
      });
      const correction = await db.insertRemoteTimeEntry({
        employeeId: employee.id, type: 'in', serverTs: new Date().toISOString(),
        correctsId: original.id, correctionReason: 'horário errado', createdBy: 'admin',
      });

      expect(correction.corrects_id).toBe(original.id);
      expect(correction.created_by).toBe('admin');
      // append-only: o original continua existindo, intacto
      expect((await db.getRemoteTimeEntryById(original.id)).corrects_id).toBeNull();
    });

    it('listRemoteTimeEntriesForEmployee respeita limit e ordem DESC por server_ts', async () => {
      const employee = await createEmployee();
      const t1 = new Date(Date.now() - 2000).toISOString();
      const t2 = new Date().toISOString();
      await db.insertRemoteTimeEntry({ employeeId: employee.id, type: 'in', serverTs: t1 });
      await db.insertRemoteTimeEntry({ employeeId: employee.id, type: 'out', serverTs: t2 });

      const list = await db.listRemoteTimeEntriesForEmployee(employee.id, 1);
      expect(list).toHaveLength(1);
      expect(list[0].server_ts).toBe(t2); // mais recente primeiro
    });

    it('listAllRemoteTimeEntries com employeeId filtra; sem employeeId traz de todos', async () => {
      const employeeA = await createEmployee();
      const employeeB = await createEmployee();
      await db.insertRemoteTimeEntry({ employeeId: employeeA.id, type: 'in', serverTs: new Date().toISOString() });
      await db.insertRemoteTimeEntry({ employeeId: employeeB.id, type: 'in', serverTs: new Date().toISOString() });

      const onlyA = await db.listAllRemoteTimeEntries({ employeeId: employeeA.id, limit: 500 });
      expect(onlyA.every(e => e.employee_id === employeeA.id)).toBe(true);
      expect(onlyA.length).toBeGreaterThanOrEqual(1);

      const all = await db.listAllRemoteTimeEntries({ limit: 500 });
      const ids = all.map(e => e.employee_id);
      expect(ids).toContain(employeeA.id);
      expect(ids).toContain(employeeB.id);
    });
  });
});
