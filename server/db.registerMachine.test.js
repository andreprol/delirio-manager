'use strict';

/**
 * Unit tests para registerMachine — cobre os 3 passos e o guard de máquina ativa.
 */

describe('registerMachine', () => {
  let registerMachine, getDb;

  beforeEach(() => {
    jest.resetModules();
    process.env.DB_PATH = ':memory:';
    ({ registerMachine, getDb } = require('./db'));
  });

  afterEach(() => {
    delete process.env.DB_PATH;
  });

  // ── Passo 3: máquina genuinamente nova ──────────────────────────────────────

  it('passo 3: nova máquina vai para Temporário', () => {
    const token = registerMachine({ machineId: 'uuid-A', hostname: 'NOVA', agentVersion: '1.5.24' });
    expect(typeof token).toBe('string');
    const m = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-A');
    expect(m.location).toBe('Temporário');
    expect(m.hostname).toBe('NOVA');
  });

  // ── Passo 1: UUID já conhecido ───────────────────────────────────────────────

  it('passo 1: UUID conhecido preserva location e atualiza agent_version', () => {
    registerMachine({ machineId: 'uuid-B', hostname: 'KNOWN', agentVersion: '1.5.23' });
    getDb().prepare("UPDATE machines SET location='Escritório Central' WHERE id=?").run('uuid-B');

    registerMachine({ machineId: 'uuid-B', hostname: 'KNOWN', agentVersion: '1.5.25' });
    const m = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-B');
    expect(m.location).toBe('Escritório Central');
    expect(m.agent_version).toBe('1.5.25');
  });

  // ── Passo 2a: reinstall (máquina offline > 5 min) ───────────────────────────

  it('passo 2a: reinstall com máquina offline preserva location via re-key', () => {
    registerMachine({ machineId: 'uuid-OLD', hostname: 'REINSTALL', agentVersion: '1.5.23' });
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().prepare("UPDATE machines SET location='Gávea', last_seen=? WHERE id=?").run(staleTs, 'uuid-OLD');

    const token = registerMachine({ machineId: 'uuid-NEW', hostname: 'REINSTALL', agentVersion: '1.5.25' });
    expect(token).toBeTruthy();
    const m = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-NEW');
    expect(m.location).toBe('Gávea');
    // entrada antiga deve ter sido re-keyed (não existir mais)
    const old = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-OLD');
    expect(old).toBeUndefined();
  });

  // ── Passo 2b: guard — máquina ativa (< 5 min) ───────────────────────────────

  it('passo 2b: máquina diferente com mesmo hostname (EC ativa) vai para Temporário, sem re-key', () => {
    // EC NUTRICIONISTA — ativa
    registerMachine({ machineId: 'uuid-EC', hostname: 'NUTRICIONISTA', agentVersion: '1.5.23' });
    getDb().prepare("UPDATE machines SET location='Escritório Central', last_seen=? WHERE id=?")
      .run(new Date().toISOString(), 'uuid-EC');

    // Home NUTRICIONISTA — UUID diferente, mesmo hostname
    const token = registerMachine({ machineId: 'uuid-HOME', hostname: 'NUTRICIONISTA', agentVersion: '1.5.24' });
    expect(token).toBeTruthy();

    // EC deve estar intacta em Escritório Central
    const ec = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-EC');
    expect(ec).toBeDefined();
    expect(ec.location).toBe('Escritório Central');

    // Home deve ir para Temporário
    const home = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-HOME');
    expect(home).toBeDefined();
    expect(home.location).toBe('Temporário');
  });

  it('passo 2b: EC heartbeats normalmente após home ser inserida em Temporário', () => {
    // Simula estado pós-fix: EC no slot correto, home em Temporário
    registerMachine({ machineId: 'uuid-EC', hostname: 'NUTRICIONISTA', agentVersion: '1.5.23' });
    getDb().prepare("UPDATE machines SET location='Escritório Central', last_seen=? WHERE id=?")
      .run(new Date().toISOString(), 'uuid-EC');
    registerMachine({ machineId: 'uuid-HOME', hostname: 'NUTRICIONISTA', agentVersion: '1.5.24' });

    // EC faz heartbeat (passo 1 — UUID conhecido)
    registerMachine({ machineId: 'uuid-EC', hostname: 'NUTRICIONISTA', agentVersion: '1.5.23' });
    const ec = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-EC');
    expect(ec.location).toBe('Escritório Central');

    // Home mantém Temporário
    const home = getDb().prepare('SELECT * FROM machines WHERE id=?').get('uuid-HOME');
    expect(home.location).toBe('Temporário');
  });
});
