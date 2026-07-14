'use strict';

/**
 * Unit tests para registerMachine — cobre os 3 passos e o guard de máquina ativa.
 */

function makeDb() {
  jest.resetModules();
  process.env.DB_PATH = ':memory:';
  return require('./db');
}

afterEach(() => { delete process.env.DB_PATH; });

describe('registerMachine — passo 3 e passo 1', () => {
  it('passo 3: nova máquina vai para Temporário', () => {
    const { registerMachine, getDb } = makeDb();
    const token = registerMachine({ machineId: 'uuid-A', hostname: 'NOVA', agentVersion: '1.5.24' });
    expect(typeof token).toBe('string');
    const m = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-A');
    expect(m.location).toBe('Temporário');
    expect(m.hostname).toBe('NOVA');
  });

  it('passo 1: UUID conhecido preserva location e atualiza agent_version', () => {
    const { registerMachine, getDb } = makeDb();
    registerMachine({ machineId: 'uuid-B', hostname: 'KNOWN', agentVersion: '1.5.23' });
    getDb().prepare("UPDATE machines SET location='Escritório Central' WHERE id=?").run('uuid-B');
    registerMachine({ machineId: 'uuid-B', hostname: 'KNOWN', agentVersion: '1.5.25' });
    const m = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-B');
    expect(m.location).toBe('Escritório Central');
    expect(m.agent_version).toBe('1.5.25');
  });
});

describe('registerMachine — passo 2a: reinstall (offline > 5 min)', () => {
  it('re-key preserva location e remove entrada antiga', () => {
    const { registerMachine, getDb } = makeDb();
    registerMachine({ machineId: 'uuid-OLD', hostname: 'REINSTALL', agentVersion: '1.5.23' });
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().prepare("UPDATE machines SET location='Gávea', last_seen=? WHERE id=?").run(staleTs, 'uuid-OLD');

    const token = registerMachine({ machineId: 'uuid-NEW', hostname: 'REINSTALL', agentVersion: '1.5.25' });
    expect(token).toBeTruthy();
    const m = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-NEW');
    expect(m.location).toBe('Gávea');
    const old = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-OLD');
    expect(old).toBeUndefined();
  });
});

describe('registerMachine — passo 2c: migração hostname→UUID (isHostnameBased)', () => {
  it('canonical hostname-based ativo (< 5 min) → re-key e herda localidade', () => {
    const { registerMachine, getDb } = makeDb();
    // Simula máquina pré-v1.5.18: machineId == hostname
    const db = getDb();
    const hostnameId = 'Nutricionista';
    db.prepare(`INSERT INTO machines (id, hostname, display_name, location, token, agent_version, status, last_seen, online_since, registered_at)
      VALUES (?, ?, ?, 'Escritório Central', 'tok-old', '1.5.17', 'online', ?, ?, ?)`
    ).run(hostnameId, hostnameId, hostnameId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    // Novo UUID registra com mesmo hostname (agente v1.5.26 migrou config)
    const token = registerMachine({ machineId: 'uuid-NEW', hostname: 'Nutricionista', agentVersion: '1.5.26' });
    expect(token).toBeTruthy();
    const m = db.prepare('SELECT * FROM machines WHERE id=?').get('uuid-NEW');
    expect(m.location).toBe('Escritório Central');
    const old = db.prepare('SELECT * FROM machines WHERE id=?').get(hostnameId);
    expect(old).toBeUndefined();
  });
});

describe('registerMachine — passo 2b: guard máquina ativa (< 5 min)', () => {
  it('máquina diferente com mesmo hostname vai para Temporário sem re-key', () => {
    const { registerMachine, getDb } = makeDb();
    registerMachine({ machineId: 'uuid-EC', hostname: 'NUTRICIONISTA', agentVersion: '1.5.23' });
    getDb().prepare("UPDATE machines SET location='Escritório Central', last_seen=? WHERE id=?")
      .run(new Date().toISOString(), 'uuid-EC');

    const token = registerMachine({ machineId: 'uuid-HOME', hostname: 'NUTRICIONISTA', agentVersion: '1.5.24' });
    expect(token).toBeTruthy();
    const ec = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-EC');
    expect(ec.location).toBe('Escritório Central');
    const home = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-HOME');
    expect(home.location).toBe('Temporário');
  });

  it('EC heartbeat normal após home em Temporário', () => {
    const { registerMachine, getDb } = makeDb();
    registerMachine({ machineId: 'uuid-EC', hostname: 'NUTRICIONISTA', agentVersion: '1.5.23' });
    getDb().prepare("UPDATE machines SET location='Escritório Central', last_seen=? WHERE id=?")
      .run(new Date().toISOString(), 'uuid-EC');
    registerMachine({ machineId: 'uuid-HOME', hostname: 'NUTRICIONISTA', agentVersion: '1.5.24' });

    registerMachine({ machineId: 'uuid-EC', hostname: 'NUTRICIONISTA', agentVersion: '1.5.23' });
    const ec = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-EC');
    expect(ec.location).toBe('Escritório Central');
    const home = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-HOME');
    expect(home.location).toBe('Temporário');
  });
});
