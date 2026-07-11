'use strict';

/**
 * Testes de integração das rotas críticas do servidor.
 * Usa supertest contra o app Express sem bind de porta.
 * Todos os módulos externos (db, websocket, serviços) são mockados.
 */

const request = require('supertest');
const fs      = require('fs');

// ── Mocks de dependências externas ───────────────────────────────────────────
// jest.mock é hoisted automaticamente — não precisa preceder os requires

jest.mock('./db', () => ({
  getMachineByToken:    jest.fn(),
  registerMachine:      jest.fn(),
  getAllMachines:        jest.fn(() => []),
  getMachineById:       jest.fn(),
  getIntegrationsStatus: jest.fn(() => ({ zamak: { syncing: false } })),
  getDb: jest.fn(() => ({
    prepare: jest.fn(() => ({ get: jest.fn(() => ({ c: 42 })) })),
  })),
  setMachineStatus:     jest.fn(),
  saveMetrics:          jest.fn(),
  updateMachine:        jest.fn(),
  setWolStatus:         jest.fn(),
  insertMetricsHourly:  jest.fn(),
  insertOfflineEvent:   jest.fn(),
  getPendingCommands:   jest.fn(() => []),
  createCommand:        jest.fn(),
  ackCommand:           jest.fn(),
  addEvent:             jest.fn(),
  getCommandById:       jest.fn(() => null),
  ncrGetByCommandId:    jest.fn(() => null),
  upsertNFCeRecords:    jest.fn(),
  updateMachineDRStatus: jest.fn(),
  insertDRBackup:       jest.fn(),
}));

jest.mock('./services/websocket', () => ({
  initWebSocket: jest.fn(),
  broadcast:     jest.fn(),
}));

jest.mock('./services/alertEngine', () => ({
  start:                jest.fn(),
  stop:                 jest.fn(),
  clearOfflineCooldown: jest.fn(),
}));

jest.mock('./services/zamak', () => ({
  isSyncing:          jest.fn(() => false),
  scheduleDailySync:  jest.fn(),
}));

jest.mock('./services/insightEngine', () => ({
  start: jest.fn(),
  stop:  jest.fn(),
}));

jest.mock('./services/metricsEmailReport', () => ({
  scheduleDailyMetricsEmail: jest.fn(),
}));

jest.mock('./services/ncrMonitor', () => ({
  start:              jest.fn(),
  sendNcrResultEmail: jest.fn(),
}));

// Importa app depois dos mocks
const app = require('./app');
const db  = require('./db');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Cada teste de heartbeat usa um machineId único para evitar interferência
// com o rate-limit (Map em módulo auth.js persiste entre testes no mesmo processo).
let machineCounter = 0;
function freshMachine(overrides = {}) {
  machineCounter++;
  return {
    id:           `machine-test-${machineCounter}`,
    status:       'online',
    hostname:     `PC-TEST-${machineCounter}`,
    mac:          '',
    ip_interno:   '',
    wol_status:   'unknown',
    agent_version: '',
    motherboard:  '',
    os_version:   '',
    dr_last_ok:   null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /health', () => {
  it('retorna 200 com campos obrigatórios', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toMatchObject({
      status:   'ok',
      version:  expect.any(String),
      uptime:   expect.any(Number),
      machines: 42, // valor mockado pelo getDb stub
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/register
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/register', () => {
  beforeEach(() => {
    db.registerMachine.mockReturnValue('tok-abc123');
  });

  it('201 + token quando payload válido', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ machineId: 'mach-001', hostname: 'PC-BOH', version: '1.5.18' })
      .expect(201);

    expect(res.body).toEqual({ token: 'tok-abc123', machineId: 'mach-001' });
    expect(db.registerMachine).toHaveBeenCalledWith({
      machineId:    'mach-001',
      hostname:     'PC-BOH',
      agentVersion: '1.5.18',
    });
  });

  it('400 quando machineId ausente', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ hostname: 'PC-BOH' })
      .expect(400);
    expect(res.body.error).toMatch(/machineId/);
  });

  it('400 quando hostname ausente', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ machineId: 'mach-001' })
      .expect(400);
    expect(res.body.error).toMatch(/hostname/);
  });

  it('500 quando db.registerMachine lança exceção', async () => {
    db.registerMachine.mockImplementationOnce(() => { throw new Error('DB locked'); });
    await request(app)
      .post('/api/register')
      .send({ machineId: 'mach-001', hostname: 'PC-BOH' })
      .expect(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/heartbeat — middleware auth
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/heartbeat — autenticação', () => {
  it('401 quando Authorization header ausente', async () => {
    const res = await request(app).post('/api/heartbeat').send({}).expect(401);
    expect(res.body.error).toMatch(/ausente/i);
  });

  it('401 quando token inválido', async () => {
    db.getMachineByToken.mockReturnValue(null);
    const res = await request(app)
      .post('/api/heartbeat')
      .set('Authorization', 'Bearer tok-invalido')
      .send({})
      .expect(401);
    expect(res.body.error).toMatch(/invalido/i);
  });

  it('401 quando header malformado (sem Bearer)', async () => {
    const res = await request(app)
      .post('/api/heartbeat')
      .set('Authorization', 'Basic abc123')
      .send({})
      .expect(401);
    expect(res.body.error).toMatch(/ausente|invalido/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/heartbeat — rate limit
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/heartbeat — rate limit', () => {
  it('429 na segunda requisição em menos de 5s para a mesma máquina', async () => {
    const machine = freshMachine();
    const token   = `tok-rate-${machine.id}`;
    db.getMachineByToken.mockImplementation(t => t === token ? machine : null);

    await request(app)
      .post('/api/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);

    const res = await request(app)
      .post('/api/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(429);
    expect(res.body.error).toMatch(/rate limit/i);
  });

  it('200 para máquinas diferentes com o mesmo token pattern', async () => {
    const m1 = freshMachine();
    const m2 = freshMachine();
    db.getMachineByToken
      .mockImplementationOnce(() => m1)
      .mockImplementationOnce(() => m2);

    await request(app)
      .post('/api/heartbeat')
      .set('Authorization', 'Bearer tok-m1')
      .send({})
      .expect(200);

    await request(app)
      .post('/api/heartbeat')
      .set('Authorization', 'Bearer tok-m2')
      .send({})
      .expect(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/heartbeat — validação de payload
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/heartbeat — validação de payload', () => {
  let token;

  beforeEach(() => {
    const machine = freshMachine();
    token = `tok-hb-${machine.id}`;
    db.getMachineByToken.mockImplementation(t => t === token ? machine : null);
  });

  it('200 com payload mínimo (body vazio)', async () => {
    await request(app)
      .post('/api/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
  });

  it('200 com payload completo', async () => {
    const res = await request(app)
      .post('/api/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        agentVersion: '1.5.18',
        hostname:     'PC-BOH',
        metrics: { cpu_pct: 45, ram_pct: 60, disk_pct: 33, temp_c: 55, mac: 'AA:BB:CC:DD:EE:FF', ips: ['192.168.1.10'] },
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.latestVersion).toBeDefined();
  });

  it('400 com cpu_pct acima de 100', async () => {
    const res = await request(app)
      .post('/api/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({ metrics: { cpu_pct: 150 } })
      .expect(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/cpu_pct/)])
    );
  });

  it('400 com ram_pct negativo', async () => {
    const res = await request(app)
      .post('/api/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({ metrics: { ram_pct: -5 } })
      .expect(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/ram_pct/)])
    );
  });

  it('400 com MAC inválido', async () => {
    const res = await request(app)
      .post('/api/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({ metrics: { mac: 'nao-e-mac' } })
      .expect(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/mac/)])
    );
  });

  it('400 com múltiplos campos inválidos simultaneamente', async () => {
    const res = await request(app)
      .post('/api/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        agentVersion: 'A'.repeat(100),
        metrics: { cpu_pct: 999, ram_pct: -1 },
      })
      .expect(400);
    expect(res.body.details.length).toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/update/version
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/update/version', () => {
  it('retorna version info (default quando arquivo ausente)', async () => {
    const res = await request(app).get('/api/update/version').expect(200);
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('sha256');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/update/publish
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/update/publish', () => {
  let writeFileSpy;
  let mkdirSpy;

  beforeEach(() => {
    writeFileSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    mkdirSpy     = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
  });

  afterEach(() => {
    writeFileSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it('400 quando X-Agent-Version header ausente', async () => {
    const res = await request(app)
      .post('/api/update/publish')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(2 * 1024 * 1024, 0x4D))
      .expect(400);
    expect(res.body.error).toMatch(/X-Agent-Version/);
  });

  it('400 quando binário menor que 1 MB', async () => {
    const res = await request(app)
      .post('/api/update/publish')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Agent-Version', '1.5.19')
      .send(Buffer.alloc(512 * 1024, 0x4D))
      .expect(400);
    expect(res.body.error).toMatch(/pequeno/);
  });

  it('400 quando magic bytes não são MZ (0x4D 0x5A)', async () => {
    const buf = Buffer.alloc(2 * 1024 * 1024, 0x00);
    const res = await request(app)
      .post('/api/update/publish')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Agent-Version', '1.5.19')
      .send(buf)
      .expect(400);
    expect(res.body.error).toMatch(/magic bytes/i);
  });

  it('200 com sha256 quando binário válido (MZ + tamanho OK)', async () => {
    const buf = Buffer.alloc(2 * 1024 * 1024, 0x00);
    buf[0] = 0x4D; // M
    buf[1] = 0x5A; // Z

    const res = await request(app)
      .post('/api/update/publish')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Agent-Version', '1.5.19')
      .send(buf)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe('1.5.19');
    expect(res.body.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(writeFileSpy).toHaveBeenCalledTimes(2); // agent exe + version.json
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rotas inexistentes
// ─────────────────────────────────────────────────────────────────────────────
describe('404', () => {
  it('retorna 404 JSON para rota desconhecida', async () => {
    const res = await request(app).get('/api/nao-existe').expect(404);
    expect(res.body.error).toMatch(/nao encontrada/i);
  });
});
