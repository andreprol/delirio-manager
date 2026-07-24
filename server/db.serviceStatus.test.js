'use strict';

/**
 * Testes unitários para upsertServiceStatus e getServiceStatusBOH.
 * Usa DB :memory: para isolamento total.
 */

function makeDb() {
  jest.resetModules();
  process.env.DB_PATH = ':memory:';
  return require('./db');
}

afterEach(() => { delete process.env.DB_PATH; });

describe('upsertServiceStatus — insert e update', () => {
  it('insere novo registro com status running', () => {
    const { upsertServiceStatus, getDb } = makeDb();
    upsertServiceStatus('machine-1', 'NCR Voyix Takeout and Delivery', 'running', null, null);
    const row = getDb().prepare('SELECT * FROM service_status WHERE machine_id=? AND service_name=?')
      .get('machine-1', 'NCR Voyix Takeout and Delivery');
    expect(row).not.toBeNull();
    expect(row.status).toBe('running');
    expect(row.last_restart_at).toBeNull();
    expect(row.last_restart_ok).toBeNull();
  });

  it('insere com lastRestartAt e lastRestartOk', () => {
    const { upsertServiceStatus, getDb } = makeDb();
    const ts = new Date().toISOString();
    upsertServiceStatus('machine-2', 'NCR Voyix Takeout Service Monitor', 'stopped', ts, 0);
    const row = getDb().prepare('SELECT * FROM service_status WHERE machine_id=? AND service_name=?')
      .get('machine-2', 'NCR Voyix Takeout Service Monitor');
    expect(row.status).toBe('stopped');
    expect(row.last_restart_at).toBe(ts);
    expect(row.last_restart_ok).toBe(0);
  });

  it('update: status muda, last_restart_at null preserva valor anterior', () => {
    const { upsertServiceStatus, getDb } = makeDb();
    const ts = '2026-07-24T10:00:00.000Z';
    upsertServiceStatus('machine-3', 'NCR Voyix Takeout and Delivery', 'stopped', ts, 1);
    // segunda chamada sem restart (running normal)
    upsertServiceStatus('machine-3', 'NCR Voyix Takeout and Delivery', 'running', null, null);
    const row = getDb().prepare('SELECT * FROM service_status WHERE machine_id=? AND service_name=?')
      .get('machine-3', 'NCR Voyix Takeout and Delivery');
    expect(row.status).toBe('running');
    // COALESCE preserva valor anterior quando novo é null
    expect(row.last_restart_at).toBe(ts);
    expect(row.last_restart_ok).toBe(1);
  });

  it('update: novo lastRestartAt substitui o anterior', () => {
    const { upsertServiceStatus, getDb } = makeDb();
    const ts1 = '2026-07-24T08:00:00.000Z';
    const ts2 = '2026-07-24T10:00:00.000Z';
    upsertServiceStatus('machine-4', 'NCR Voyix Takeout and Delivery', 'stopped', ts1, 0);
    upsertServiceStatus('machine-4', 'NCR Voyix Takeout and Delivery', 'running', ts2, 1);
    const row = getDb().prepare('SELECT * FROM service_status WHERE machine_id=? AND service_name=?')
      .get('machine-4', 'NCR Voyix Takeout and Delivery');
    expect(row.last_restart_at).toBe(ts2);
    expect(row.last_restart_ok).toBe(1);
  });
});

describe('getServiceStatusBOH — filtro BOH via JOIN', () => {
  it('retorna apenas máquinas cujo hostname termina com BOH', () => {
    const { upsertServiceStatus, getServiceStatusBOH, getDb } = makeDb();

    // Inserir máquinas
    getDb().prepare(`INSERT INTO machines (id, hostname, location, token, status, registered_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))`).run('boh-id', 'CAXIASBOH', 'Caxias', 'tok1', 'online');
    getDb().prepare(`INSERT INTO machines (id, hostname, location, token, status, registered_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))`).run('desk-id', 'CAIXA01', 'Caxias', 'tok2', 'online');

    upsertServiceStatus('boh-id', 'NCR Voyix Takeout and Delivery', 'running', null, null);
    upsertServiceStatus('desk-id', 'NCR Voyix Takeout and Delivery', 'running', null, null);

    const rows = getServiceStatusBOH();
    expect(rows).toHaveLength(1);
    expect(rows[0].machine_id).toBe('boh-id');
  });

  it('retorna todos os serviços de uma máquina BOH ordenados por service_name', () => {
    const { upsertServiceStatus, getServiceStatusBOH, getDb } = makeDb();

    getDb().prepare(`INSERT INTO machines (id, hostname, location, token, status, registered_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))`).run('boh-id', 'TIJUCABOH', 'Tijuca', 'tok3', 'online');

    upsertServiceStatus('boh-id', 'NCR Voyix Takeout and Delivery', 'running', null, null);
    upsertServiceStatus('boh-id', 'NCR Voyix Takeout Service Monitor', 'stopped', '2026-07-24T06:00:00.000Z', 0);

    const rows = getServiceStatusBOH();
    expect(rows).toHaveLength(2);
    // ORDER BY service_name ASC
    expect(rows[0].service_name).toBe('NCR Voyix Takeout Service Monitor');
    expect(rows[1].service_name).toBe('NCR Voyix Takeout and Delivery');
    expect(rows[0].service_status).toBe('stopped');
    expect(rows[1].service_status).toBe('running');
  });

  it('retorna vazio quando nenhuma BOH registrada', () => {
    const { getServiceStatusBOH } = makeDb();
    expect(getServiceStatusBOH()).toEqual([]);
  });
});
