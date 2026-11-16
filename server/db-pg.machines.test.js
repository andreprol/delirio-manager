'use strict';

/**
 * Testes do Grupo 1 (machines + metrics) de server/db-pg.js contra um
 * Postgres real (instância dev, ver reference_postgres_dev_dt_manager na
 * memória do projeto) -- sem mock, mesmo espírito dos db.*.test.js originais
 * (que usam SQLite `:memory:` real, não mockado).
 *
 * Pula a suite inteira se DATABASE_URL não estiver setada (CI e qualquer
 * sessão sem acesso à instância dev) -- essa instância tem firewall restrito
 * a 1 IP, não dá pra assumir acesso em todo ambiente.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.machines.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 1: machines + metrics)', () => {
  let db;
  const createdIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdIds.length) {
      const id = createdIds.pop();
      // metrics/commands/events não têm FK pra machines (igual no SQLite
      // original, ver comentário de deleteMachine) -- precisam de limpeza
      // manual, senão ficam órfãs pra sempre na instância dev compartilhada.
      await pool.query('DELETE FROM metrics WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM commands WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM events WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM deleted_machines WHERE id=$1', [id]);
      await pool.query('DELETE FROM machines WHERE id=$1', [id]); // FK CASCADE limpa o resto
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  function newId() {
    const id = crypto.randomUUID();
    createdIds.push(id);
    return id;
  }

  async function insertMachine(overrides = {}) {
    const id = overrides.id || newId();
    const now = new Date().toISOString();
    const row = {
      hostname: `HOST-${id.slice(0, 8)}`,
      display_name: null,
      token: crypto.randomUUID(),
      registered_at: now,
      status: 'online',
      last_seen: now,
      wol_status: 'unknown',
      wol_tested_at: null,
      mac: '',
      location: 'Loja Teste',
      ...overrides,
    };
    await db.getPool().query(
      `INSERT INTO machines (id, hostname, display_name, token, registered_at, status, last_seen, wol_status, wol_tested_at, mac, location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, row.hostname, row.display_name, row.token, row.registered_at, row.status, row.last_seen, row.wol_status, row.wol_tested_at, row.mac, row.location]
    );
    return id;
  }

  describe('getMachineById / getMachineByToken / getMachineByHostname', () => {
    it('recupera a máquina pelos 3 jeitos', async () => {
      const token = crypto.randomUUID();
      const id = await insertMachine({ hostname: 'PDV-01', token });

      expect((await db.getMachineById(id)).id).toBe(id);
      expect((await db.getMachineByToken(token)).id).toBe(id);
      expect((await db.getMachineByHostname('pdv-01')).id).toBe(id); // case-insensitive
    });

    it('retorna undefined quando não acha', async () => {
      expect(await db.getMachineById(crypto.randomUUID())).toBeUndefined();
      expect(await db.getMachineByToken('token-inexistente')).toBeUndefined();
      expect(await db.getMachineByHostname('HOST-QUE-NAO-EXISTE')).toBeUndefined();
    });
  });

  describe('getAllMachines', () => {
    it('inclui last_metrics como STRING JSON (não objeto já parseado)', async () => {
      const id = await insertMachine();
      await db.saveMetrics(id, { cpuPct: 42, ramFreeMB: 1000, ramTotalMB: 2000 });

      const all = await db.getAllMachines();
      const row = all.find(m => m.id === id);
      expect(row).toBeDefined();
      expect(typeof row.last_metrics).toBe('string');
      const parsed = JSON.parse(row.last_metrics);
      expect(parsed.cpuPct).toBe(42);
    });

    it('last_metrics null quando a máquina nunca mandou métrica', async () => {
      const id = await insertMachine();
      const all = await db.getAllMachines();
      expect(all.find(m => m.id === id).last_metrics).toBeNull();
    });
  });

  describe('deleteMachine', () => {
    it('apaga metrics/commands/events e marca em deleted_machines', async () => {
      const id = await insertMachine();
      await db.saveMetrics(id, { cpuPct: 1 });
      const pool = db.getPool();
      await pool.query(
        `INSERT INTO commands (id, machine_id, type, created_at) VALUES ($1,$2,'noop',$3)`,
        [crypto.randomUUID(), id, new Date().toISOString()]
      );
      await pool.query(
        `INSERT INTO events (machine_id, ts, type) VALUES ($1,$2,'test')`,
        [id, new Date().toISOString()]
      );

      await db.deleteMachine(id);

      expect(await db.getMachineById(id)).toBeUndefined();
      expect(await db.isDeletedMachine(id)).toBe(true);
      const metrics = await pool.query('SELECT 1 FROM metrics WHERE machine_id=$1', [id]);
      expect(metrics.rowCount).toBe(0);
    });

    it('é idempotente (rodar duas vezes não lança)', async () => {
      const id = await insertMachine();
      await db.deleteMachine(id);
      await expect(db.deleteMachine(id)).resolves.not.toThrow();
    });
  });

  describe('isDeletedMachine', () => {
    it('false quando não há registro', async () => {
      expect(await db.isDeletedMachine(crypto.randomUUID())).toBe(false);
    });

    it('false depois de 10 minutos (reinstalação manual liberada)', async () => {
      const id = newId();
      const longAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      await db.getPool().query(
        'INSERT INTO deleted_machines (id, deleted_at) VALUES ($1,$2)', [id, longAgo]
      );
      expect(await db.isDeletedMachine(id)).toBe(false);
    });
  });

  describe('updateMachine', () => {
    it('só atualiza campos da allowlist, ignora o resto', async () => {
      const id = await insertMachine();
      await db.updateMachine(id, { display_name: 'PDV Novo', hostname: 'HACK', critica: 1 });

      const m = await db.getMachineById(id);
      expect(m.display_name).toBe('PDV Novo');
      expect(m.critica).toBe(1);
      expect(m.hostname).not.toBe('HACK'); // hostname não está na allowlist
    });

    it('sem campos válidos não lança e não altera nada', async () => {
      const id = await insertMachine({ display_name: 'Original' });
      await expect(db.updateMachine(id, { nao_existe: 'x' })).resolves.toBeUndefined();
      expect((await db.getMachineById(id)).display_name).toBe('Original');
    });
  });

  describe('setMachineStatus', () => {
    it('online atualiza online_since; outro status não', async () => {
      const id = await insertMachine({ status: 'offline' });
      await db.setMachineStatus(id, 'online');
      const online = await db.getMachineById(id);
      expect(online.status).toBe('online');
      expect(online.online_since).not.toBeNull();

      await db.setMachineStatus(id, 'offline');
      const offline = await db.getMachineById(id);
      expect(offline.status).toBe('offline');
    });
  });

  describe('getMachinesStale', () => {
    it('só retorna online com last_seen velho ou nulo', async () => {
      const staleId = await insertMachine({ status: 'online', last_seen: '2020-01-01T00:00:00.000Z' });
      const freshId = await insertMachine({ status: 'online', last_seen: new Date().toISOString() });
      const offlineId = await insertMachine({ status: 'offline', last_seen: '2020-01-01T00:00:00.000Z' });

      const stale = await db.getMachinesStale('2025-01-01T00:00:00.000Z');
      const ids = stale.map(m => m.id);
      expect(ids).toContain(staleId);
      expect(ids).not.toContain(freshId);
      expect(ids).not.toContain(offlineId);
    });
  });

  describe('setWolStatus', () => {
    it('com testedAt + wol_confirmed marca wol_ever_confirmed', async () => {
      const id = await insertMachine();
      await db.setWolStatus(id, 'wol_confirmed', '2026-01-01T00:00:00.000Z');
      const m = await db.getMachineById(id);
      expect(m.wol_status).toBe('wol_confirmed');
      expect(m.wol_tested_at).toBe('2026-01-01T00:00:00.000Z');
      expect(m.wol_ever_confirmed).toBe(1);
    });

    it('com testedAt mas status diferente de wol_confirmed não marca wol_ever_confirmed', async () => {
      const id = await insertMachine();
      await db.setWolStatus(id, 'testing', '2026-01-01T00:00:00.000Z');
      const m = await db.getMachineById(id);
      expect(m.wol_status).toBe('testing');
      expect(m.wol_tested_at).toBe('2026-01-01T00:00:00.000Z');
      expect(m.wol_ever_confirmed).toBe(0);
    });

    it('com wol_confirmed e sem testedAt marca wol_ever_confirmed sem tocar wol_tested_at', async () => {
      const id = await insertMachine({ wol_tested_at: '2020-01-01T00:00:00.000Z' });
      await db.setWolStatus(id, 'wol_confirmed');
      const m = await db.getMachineById(id);
      expect(m.wol_status).toBe('wol_confirmed');
      expect(m.wol_ever_confirmed).toBe(1);
      expect(m.wol_tested_at).toBe('2020-01-01T00:00:00.000Z');
    });

    it('sem testedAt nem wol_confirmed só atualiza wol_status', async () => {
      const id = await insertMachine({ wol_tested_at: '2020-01-01T00:00:00.000Z' });
      await db.setWolStatus(id, 'bios_needed');
      const m = await db.getMachineById(id);
      expect(m.wol_status).toBe('bios_needed');
      expect(m.wol_ever_confirmed).toBe(0);
      expect(m.wol_tested_at).toBe('2020-01-01T00:00:00.000Z');
    });
  });

  describe('getMachinesWolTesting / BiosNeeded / OfflineForWake / AutoWolTesting', () => {
    it('cada query traz só a máquina que bate com seu filtro, excluindo as outras 3', async () => {
      const testingId = await insertMachine({ wol_status: 'testing', wol_tested_at: '2020-01-01T00:00:00.000Z' });
      const biosId = await insertMachine({ wol_status: 'bios_needed' });
      const wakeId = await insertMachine({
        status: 'offline', wol_status: 'wol_confirmed', mac: 'AA:BB:CC', last_seen: '2020-01-01T00:00:00.000Z',
      });
      const autoId = await insertMachine({ wol_status: 'wol_auto_testing', wol_tested_at: '2020-01-01T00:00:00.000Z' });
      const others = (excludeId) => [testingId, biosId, wakeId, autoId].filter(id => id !== excludeId);

      const testing = (await db.getMachinesWolTesting('2025-01-01T00:00:00.000Z')).map(m => m.id);
      expect(testing).toContain(testingId);
      for (const id of others(testingId)) expect(testing).not.toContain(id);

      const bios = (await db.getMachinesBiosNeeded()).map(m => m.id);
      expect(bios).toContain(biosId);
      for (const id of others(biosId)) expect(bios).not.toContain(id);

      const wake = (await db.getMachinesOfflineForWake('2025-01-01T00:00:00.000Z')).map(m => m.id);
      expect(wake).toContain(wakeId);
      for (const id of others(wakeId)) expect(wake).not.toContain(id);

      const auto = (await db.getMachinesAutoWolTesting('2025-01-01T00:00:00.000Z')).map(m => m.id);
      expect(auto).toContain(autoId);
      for (const id of others(autoId)) expect(auto).not.toContain(id);
    });
  });

  describe('updateMachineInsightCursor', () => {
    it('atualiza os dois cursores', async () => {
      const id = await insertMachine();
      await db.updateMachineInsightCursor(id, { lastWinEventId: 42, lastOfflineEventId: 7 });
      const m = await db.getMachineById(id);
      expect(m.last_win_event_id).toBe(42);
      expect(m.last_offline_event_id).toBe(7);
    });
  });

  describe('saveMetrics / getMetrics', () => {
    it('grava e lê de volta dentro da janela de horas', async () => {
      const id = await insertMachine();
      await db.saveMetrics(id, { cpuPct: 55, ramFreeMB: 500, ramTotalMB: 1000, roomTempC: 23.5 });

      const metrics = await db.getMetrics(id, 1);
      expect(metrics).toHaveLength(1);
      expect(metrics[0].cpu_pct).toBe(55);
      expect(metrics[0].room_temp_c).toBe(23.5);
    });

    it('purga métricas da mesma máquina com mais de 24h ao salvar uma nova', async () => {
      const id = await insertMachine();
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await db.getPool().query(
        `INSERT INTO metrics (machine_id, ts, cpu_pct) VALUES ($1,$2,1)`, [id, old]
      );

      await db.saveMetrics(id, { cpuPct: 99 });

      const remaining = await db.getMetrics(id, 48);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].cpu_pct).toBe(99);
    });

    it('getMetrics respeita a janela de horas (não traz métrica fora da janela)', async () => {
      const id = await insertMachine();
      const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
      await db.getPool().query(
        `INSERT INTO metrics (machine_id, ts, cpu_pct) VALUES ($1,$2,7)`, [id, old]
      );

      expect(await db.getMetrics(id, 1)).toHaveLength(0);
      expect(await db.getMetrics(id, 24)).toHaveLength(1);
    });
  });
});
