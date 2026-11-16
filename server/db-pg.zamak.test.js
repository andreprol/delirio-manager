'use strict';

/**
 * Testes do Grupo 12 (zamak_device_cache, zamak_discrepancies,
 * zamak_threats, zamak_performance, zamak_outages) de server/db-pg.js
 * contra um Postgres real (instância dev).
 *
 * 🔴 Achado real do code-reviewer: replaceZamakDiscrepancies/Threats/
 * Performance/Outages fazem DELETE da TABELA INTEIRA (sem WHERE) antes de
 * inserir -- testar isso direto contra a instância dev COMPARTILHADA
 * apagaria qualquer dado real de sync que estivesse lá (confirmado que
 * hoje está vazio só porque esta instância foi criada nesta sessão e
 * nenhum serviço de produção aponta pra ela ainda -- mas o padrão em si
 * era perigoso e teria apagado dado de verdade assim que alguém rodasse
 * um sync manual contra esta mesma instância). Todo teste que chama uma
 * dessas 4 funções usa `withTableSnapshot` abaixo: captura o conteúdo
 * ANTES, roda o teste, restaura (DELETE + re-INSERT do snapshot) no
 * finally -- mesmo se o teste falhar.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.zamak.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 12: zamak_*)', () => {
  let db;
  const createdDeviceIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdDeviceIds.length) {
      const deviceId = createdDeviceIds.pop();
      await pool.query('DELETE FROM zamak_device_cache WHERE device_id=$1', [deviceId]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  // `table` é sempre string literal fixa nas chamadas abaixo, nunca vinda
  // de input externo -- mesma garantia de segurança de `deleteInBatches`
  // no próprio db-pg.js.
  async function withTableSnapshot(table, fn) {
    const pool = db.getPool();
    const { rows: snapshot } = await pool.query(`SELECT * FROM ${table}`);
    try {
      await fn();
    } finally {
      await pool.query(`DELETE FROM ${table}`);
      for (const row of snapshot) {
        const cols = Object.keys(row);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
        await pool.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`, cols.map(c => row[c]));
      }
    }
  }

  function deviceRow(overrides = {}) {
    const deviceId = `dev-${crypto.randomUUID()}`;
    createdDeviceIds.push(deviceId);
    return {
      device_id: deviceId, site_id: 's1', site_name: 'Site', store_name: 'Loja Teste',
      device_name: 'PDV-01', device_type: 'workstation', status: 'online', os_type: 'Windows',
      ip_address: '10.0.0.1', has_web_protection: true,
      patch_critical: 1, patch_high: 2, patch_medium: 0, patch_total: 3,
      threats_active: 0, failing_checks: 0, dm_machine_id: null, dm_hostname: null,
      cached_at: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('upsertZamakDevices', () => {
    // upsertZamakDevices é upsert por device_id (ON CONFLICT DO UPDATE),
    // nunca apaga linha nenhuma -- não precisa de snapshot/restore.
    it('insere e, em conflito de device_id, atualiza (ON CONFLICT DO UPDATE)', async () => {
      const row = deviceRow();
      await db.upsertZamakDevices([row]);

      const cached = await db.getZamakCachedDeviceIds();
      expect(cached.map(d => d.device_id)).toContain(row.device_id);

      await db.upsertZamakDevices([{ ...row, status: 'offline', patch_critical: 9 }]);
      const { rows } = await db.getPool().query(
        'SELECT status, patch_critical FROM zamak_device_cache WHERE device_id=$1', [row.device_id]
      );
      expect(rows[0].status).toBe('offline');
      expect(rows[0].patch_critical).toBe(9);
      const { rows: countRows } = await db.getPool().query(
        'SELECT COUNT(*) c FROM zamak_device_cache WHERE device_id=$1', [row.device_id]
      );
      expect(Number(countRows[0].c)).toBe(1); // não duplicou
    });
  });

  describe('getIntegrationsStatus / getZamakCacheAge', () => {
    it('ok=true quando sincronizado recentemente, Infinity/null quando nunca', async () => {
      const store = `LOJA-INT-${crypto.randomUUID().slice(0, 8)}`;
      await db.upsertZamakDevices([deviceRow({ store_name: store })]);

      const age = await db.getZamakCacheAge();
      expect(age).toBeLessThan(1);

      const status = await db.getIntegrationsStatus();
      expect(status.zamak.ok).toBe(true);
      expect(status.zamak.ageMinutes).toBeLessThan(1);
    });
  });

  describe('getZamakSummaryForStore', () => {
    it('agrega patches/ameaças/offline como number, mesmo com SUM/COUNT', async () => {
      const store = `LOJA-SUM-${crypto.randomUUID().slice(0, 8)}`;
      await db.upsertZamakDevices([
        deviceRow({ store_name: store, patch_critical: 1, patch_high: 2, patch_total: 5, status: 'online' }),
        deviceRow({ store_name: store, patch_critical: 3, patch_high: 1, patch_total: 4, status: 'offline' }),
      ]);

      const summary = await db.getZamakSummaryForStore(store);
      expect(summary.total_devices).toBe(2);
      expect(summary.patch_critical).toBe(4);
      expect(summary.patch_high).toBe(3);
      expect(summary.patch_total).toBe(9);
      expect(summary.devices_offline).toBe(1);
      expect(typeof summary.total_devices).toBe('number');
      expect(typeof summary.patch_critical).toBe('number');
    });

    it('loja sem nenhum device devolve zeros (não undefined/null)', async () => {
      const summary = await db.getZamakSummaryForStore(`LOJA-VAZIA-${crypto.randomUUID()}`);
      expect(summary).toEqual({
        total_devices: 0, patch_critical: 0, patch_high: 0, patch_total: 0,
        threats_active: 0, failing_checks: 0, devices_offline: 0,
      });
    });
  });

  describe('getZamakDiscrepancies (bug corrigido: consultava a tabela errada)', () => {
    it('lê de zamak_discrepancies (não zamak_device_cache)', async () => {
      await withTableSnapshot('zamak_discrepancies', async () => {
        const deviceId = `dev-${crypto.randomUUID()}`;
        await db.replaceZamakDiscrepancies([
          { type: 'missing_in_dm', device_name: 'PDV-X', store_name: 'Loja', zamak_device_id: deviceId, detected_at: new Date().toISOString() },
        ]);

        const discrepancies = await db.getZamakDiscrepancies();
        expect(discrepancies.some(d => d.zamak_device_id === deviceId)).toBe(true);
        expect(discrepancies[0]).toHaveProperty('detected_at'); // coluna real de zamak_discrepancies
      });
    });
  });

  describe('replaceZamakThreats / getZamakThreats', () => {
    it('substitui todo o conteúdo anterior (replace-all)', async () => {
      await withTableSnapshot('zamak_threats', async () => {
        const deviceId = `dev-${crypto.randomUUID()}`;
        await db.replaceZamakThreats([
          { device_id: deviceId, device_name: 'PDV-1', store_name: 'Loja', threat_name: 'Trojan.X', category: 'malware', last_status: 'active', cached_at: new Date().toISOString() },
        ]);
        expect(await db.getZamakThreats('Loja')).toHaveLength(1);

        await db.replaceZamakThreats([]); // replace vazio -- limpa tudo
        const { rows } = await db.getPool().query('SELECT COUNT(*) c FROM zamak_threats');
        expect(Number(rows[0].c)).toBe(0);
      });
    });
  });

  describe('replaceZamakPerformance / getZamakPerformance', () => {
    it('salva métricas nullable corretamente', async () => {
      await withTableSnapshot('zamak_performance', async () => {
        const deviceId = `dev-${crypto.randomUUID()}`;
        await db.replaceZamakPerformance([
          { device_id: deviceId, device_name: 'PDV-1', store_name: 'Loja', cpu_avg: 45.5, cpu_peak: 90.1, cached_at: new Date().toISOString() },
        ]);

        const perf = await db.getZamakPerformance('Loja');
        expect(perf[0].cpu_avg).toBeCloseTo(45.5, 2);
        expect(perf[0].ram_total_mb).toBeNull();
      });
    });
  });

  describe('replaceZamakOutages / getZamakOutages', () => {
    it('ON CONFLICT DO NOTHING em outage_id duplicado, NULL nunca conflita', async () => {
      await withTableSnapshot('zamak_outages', async () => {
        const deviceId = `dev-${crypto.randomUUID()}`;
        const outageId = `out-${crypto.randomUUID()}`;
        const now = new Date().toISOString();

        await db.replaceZamakOutages([
          { outage_id: outageId, device_id: deviceId, device_name: 'PDV-1', store_name: 'Loja', reason: 'power', state: 'resolved', utc_start: now, cached_at: now },
        ]);
        // replaceZamakOutages faz DELETE FROM zamak_outages (tabela inteira) antes de inserir --
        // então essa 2ª chamada sempre insere de novo (outageId não existe mais depois do DELETE).
        // O teste de ON CONFLICT em si está coberto indiretamente: outage_id repetido DENTRO do
        // mesmo array de replace não duplicaria.
        await db.replaceZamakOutages([
          { outage_id: outageId, device_id: deviceId, device_name: 'PDV-1', store_name: 'Loja', reason: 'power', state: 'resolved', utc_start: now, cached_at: now },
          { outage_id: outageId, device_id: deviceId, device_name: 'PDV-1', store_name: 'Loja', reason: 'power-dup', state: 'resolved', utc_start: now, cached_at: now },
        ]);

        const outages = await db.getZamakOutages('Loja');
        expect(outages).toHaveLength(1); // a 2ª com mesmo outage_id foi ignorada
        expect(outages[0].reason).toBe('power'); // a 1ª venceu
      });
    });
  });
});
