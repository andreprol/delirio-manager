'use strict';

/**
 * Testes do Grupo 7 (registerMachine + dr_backups) de server/db-pg.js
 * contra um Postgres real (instância dev). registerMachine é a função
 * mais arriscada do arquivo (re-key de UUID + merge de duplicatas) --
 * cobertura extra aqui, incluindo as 10 tabelas com FK ON UPDATE CASCADE
 * e as 5 sem FK que precisam de UPDATE/DELETE manual.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.registermachine.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 7: registerMachine + dr_backups)', () => {
  let db;
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdMachineIds.length) {
      const id = createdMachineIds.pop();
      // Tabelas sem FK pra machines (mesmas do MACHINE_CHILD_TABLES_NO_FK
      // em db-pg.js) -- limpeza manual, senão vaza na instância dev
      // compartilhada. As com FK CASCADE limpam sozinhas ao apagar machines.
      await pool.query('DELETE FROM metrics WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM commands WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM events WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM nfce_auto_email_log WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM service_status WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM deleted_machines WHERE id=$1', [id]);
      await pool.query('DELETE FROM machines WHERE id=$1', [id]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  function trackMachine(id) {
    createdMachineIds.push(id);
    return id;
  }

  describe('registerMachine', () => {
    it('caso 1: UUID já conhecido -- atualiza presença e devolve o token existente', async () => {
      const id = trackMachine(crypto.randomUUID());
      const token1 = await db.registerMachine({ machineId: id, hostname: 'PDV-NOVO', agentVersion: '1.0' });

      const token2 = await db.registerMachine({ machineId: id, hostname: 'PDV-NOVO', agentVersion: '1.1' });
      expect(token2).toBe(token1);

      const m = await db.getMachineById(id);
      expect(m.agent_version).toBe('1.1');
      expect(m.status).toBe('online');
    });

    it('caso 3: máquina genuinamente nova -- cria com location Temporário e dispara evento', async () => {
      const id = trackMachine(crypto.randomUUID());
      const token = await db.registerMachine({ machineId: id, hostname: `NOVA-${id.slice(0, 8)}`, agentVersion: '1.0' });

      const m = await db.getMachineById(id);
      expect(m.token).toBe(token);
      expect(m.location).toBe('Temporário');
      expect(m.status).toBe('online');

      const events = await db.getEvents(id, 10);
      expect(events.some(e => e.type === 'agent_installed')).toBe(true);
    });

    it('caso 2: re-key por hostname -- migra filhos COM FK (ON UPDATE CASCADE) e SEM FK, preserva token', async () => {
      const hostname = `REKEY-${crypto.randomUUID().slice(0, 8)}`;
      const oldId = trackMachine(crypto.randomUUID());
      const originalToken = await db.registerMachine({ machineId: oldId, hostname, agentVersion: '1.0' });

      // Popula filho COM FK (win_events), filho SEM FK (metrics) e o caso
      // específico do `insights` (tinha FK mas NUNCA esteve na lista
      // _MACHINE_CHILD_TABLES do SQLite original -- bug corrigido de graça
      // no port, ver comentário em registerMachine; único comportamento
      // desta migração sem equivalente direto pra comparar, por isso
      // cobertura própria aqui, não só validação manual via information_schema).
      await db.saveWinEvents(oldId, [{
        eventTime: new Date().toISOString(), eventId: 41, source: 'Kernel', level: 'Error', translation: 'Antes do re-key',
      }]);
      await db.saveMetrics(oldId, { cpuPct: 10 });
      await db.saveInsight({ machineId: oldId, severity: 'warning', pattern: 'p', patternHash: crypto.randomUUID() });

      const newId = trackMachine(crypto.randomUUID());
      const returnedToken = await db.registerMachine({ machineId: newId, hostname, agentVersion: '2.0' });

      expect(returnedToken).toBe(originalToken); // token do canonical, preservado
      expect(await db.getMachineById(oldId)).toBeUndefined(); // oldId não existe mais (foi re-keyed pro newId)

      const newMachine = await db.getMachineById(newId);
      expect(newMachine.token).toBe(originalToken);
      expect(newMachine.agent_version).toBe('2.0');

      const winEvents = await db.getWinEvents(newId, 'all');
      expect(winEvents).toHaveLength(1); // migrado via ON UPDATE CASCADE

      const metrics = await db.getMetrics(newId, 24);
      expect(metrics).toHaveLength(1); // migrado via UPDATE manual (metrics não tem FK)

      const insights = await db.getInsights({ machineId: newId });
      expect(insights).toHaveLength(1); // migrado via ON UPDATE CASCADE -- bug do original corrigido

      const events = await db.getEvents(newId, 10);
      expect(events.some(e => e.type === 'agent_reregistered')).toBe(true);
    });

    it('2 chamadas concorrentes pro MESMO hostname (machineIds diferentes) não perdem nenhuma máquina/filho', async () => {
      // Achado 🔴 CRÍTICO do review: sem o advisory lock por hostname, a
      // 2ª chamada podia ler o `canonical` antes do commit da 1ª e, na sua
      // própria passada de dedup, apagar a máquina que a 1ª JUSTAGORA
      // recriou -- perda real de identidade/histórico. Dispara as duas de
      // propósito via Promise.all (mesmo hostname, sem await entre elas)
      // pra forçar a race que o SQLite original nunca tinha (síncrono).
      const hostname = `REKEY-RACE-${crypto.randomUUID().slice(0, 8)}`;
      const seedId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: seedId, hostname, agentVersion: '1.0' });

      const idA = trackMachine(crypto.randomUUID());
      const idB = trackMachine(crypto.randomUUID());

      const [tokenA, tokenB] = await Promise.all([
        db.registerMachine({ machineId: idA, hostname, agentVersion: 'A' }),
        db.registerMachine({ machineId: idB, hostname, agentVersion: 'B' }),
      ]);

      // As 2 chamadas devem ter concordado numa única máquina sobrevivente
      // com o MESMO token original -- nunca 2 máquinas "Temporário"
      // duplicadas nem a perda total do registro.
      expect(tokenA).toBe(tokenB);

      const { rows } = await db.getPool().query(
        'SELECT id FROM machines WHERE UPPER(hostname) = UPPER($1)', [hostname]
      );
      expect(rows).toHaveLength(1); // exatamente 1 sobrevivente, nunca 0 nem 2+
      trackMachine(rows[0].id); // garante limpeza seja qual for o id sobrevivente
    });

    it('caso 2b: re-key com duplicata -- apaga a duplicata e seus filhos (com e sem FK)', async () => {
      const hostname = `REKEY-DUP-${crypto.randomUUID().slice(0, 8)}`;
      const canonicalId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: canonicalId, hostname, agentVersion: '1.0' });

      // Simula uma 2ª máquina física/registro remanescente com o MESMO
      // hostname (cenário que o dedup existe pra limpar).
      const dupId = crypto.randomUUID(); // não rastreado -- deve ser apagada pelo próprio registerMachine
      await db.getPool().query(
        `INSERT INTO machines (id, hostname, token, registered_at) VALUES ($1,$2,$3,$4)`,
        [dupId, hostname, crypto.randomUUID(), new Date().toISOString()]
      );
      await db.saveMetrics(dupId, { cpuPct: 99 }); // filho sem FK da duplicata
      await db.saveWinEvents(dupId, [{
        eventTime: new Date().toISOString(), eventId: 41, source: 'Kernel', level: 'Error', translation: 'Da duplicata',
      }]); // filho com FK da duplicata

      const newId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: newId, hostname, agentVersion: '3.0' });

      expect(await db.getMachineById(dupId)).toBeUndefined();
      const { rows: dupMetrics } = await db.getPool().query('SELECT 1 FROM metrics WHERE machine_id=$1', [dupId]);
      expect(dupMetrics).toHaveLength(0);
      const dupWinEvents = await db.getWinEvents(dupId, 'all');
      expect(dupWinEvents).toHaveLength(0);
    });

    it('prefere canonical não-Temporário sobre Temporário mais recente (ORDER BY da query)', async () => {
      const hostname = `REKEY-PREF-${crypto.randomUUID().slice(0, 8)}`;
      const realId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: realId, hostname, agentVersion: '1.0' });
      await db.updateMachine(realId, { location: 'Loja Real' });

      // Uma 2ª entrada "Temporário" com last_seen mais recente que a real --
      // a query de canonical deve preferir a não-Temporário mesmo assim.
      const tempDupId = crypto.randomUUID();
      await db.getPool().query(
        `INSERT INTO machines (id, hostname, location, token, registered_at, last_seen)
         VALUES ($1,$2,'Temporário',$3,$4,$4)`,
        [tempDupId, hostname, crypto.randomUUID(), new Date(Date.now() + 1000).toISOString()]
      );

      const newId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: newId, hostname, agentVersion: '4.0' });

      const newMachine = await db.getMachineById(newId);
      expect(newMachine.location).toBe('Loja Real'); // herdou do canonical real, não do Temporário
    });
  });

  describe('updateMachineDRStatus / insertDRBackup / getDRHistory / getDROverview / getMachinesDRDue', () => {
    it('updateMachineDRStatus só atualiza os campos presentes', async () => {
      const id = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: id, hostname: `DR-${id.slice(0, 8)}`, agentVersion: '1.0' });

      await db.updateMachineDRStatus(id, { setup: 'configured', storageGb: 12.5 });
      let m = await db.getMachineById(id);
      expect(m.dr_setup).toBe('configured');
      expect(m.dr_storage_gb).toBe(12.5);

      await db.updateMachineDRStatus(id, { lastOk: '2026-06-01T00:00:00.000Z' });
      m = await db.getMachineById(id);
      expect(m.dr_last_ok).toBe('2026-06-01T00:00:00.000Z');
      expect(m.dr_setup).toBe('configured'); // não foi tocado na 2ª chamada

      await expect(db.updateMachineDRStatus(id, {})).resolves.toBeUndefined(); // noop sem campos
    });

    it('insertDRBackup / getDRHistory respeitam a janela de dias', async () => {
      const id = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: id, hostname: `DR-HIST-${id.slice(0, 8)}`, agentVersion: '1.0' });

      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      await db.insertDRBackup(id, { backedAt: old, status: 'ok', storageGb: 5 });
      await db.insertDRBackup(id, { backedAt: recent, status: 'ok', storageGb: 6 });

      const history = await db.getDRHistory(id, 28);
      expect(history).toHaveLength(1);
      expect(history[0].storage_gb).toBe(6);
    });

    it('getDROverview agrega total/okLast24h/totalGb/failing corretamente', async () => {
      const idOk = trackMachine(crypto.randomUUID());
      const idFail = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: idOk, hostname: `DR-OK-${idOk.slice(0, 8)}`, agentVersion: '1.0' });
      await db.registerMachine({ machineId: idFail, hostname: `DR-FAIL-${idFail.slice(0, 8)}`, agentVersion: '1.0' });

      await db.updateMachineDRStatus(idOk, {
        setup: 'configured', storageGb: 10, lastOk: new Date().toISOString(),
      });
      await db.updateMachineDRStatus(idFail, { setup: 'error' });

      const overview = await db.getDROverview();
      expect(overview.total).toBeGreaterThanOrEqual(1);
      expect(overview.okLast24h).toBeGreaterThanOrEqual(1);
      expect(overview.failing).toBeGreaterThanOrEqual(1);
      expect(typeof overview.totalGb).toBe('number');
      expect(overview.totalGb).toBeGreaterThanOrEqual(10);
    });

    it('getMachinesDRDue traz configured com dr_last_ok nulo ou antigo', async () => {
      const dueNullId = trackMachine(crypto.randomUUID());
      const dueOldId = trackMachine(crypto.randomUUID());
      const notDueId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: dueNullId, hostname: `DUE-NULL-${dueNullId.slice(0, 8)}`, agentVersion: '1.0' });
      await db.registerMachine({ machineId: dueOldId, hostname: `DUE-OLD-${dueOldId.slice(0, 8)}`, agentVersion: '1.0' });
      await db.registerMachine({ machineId: notDueId, hostname: `NOT-DUE-${notDueId.slice(0, 8)}`, agentVersion: '1.0' });

      await db.updateMachineDRStatus(dueNullId, { setup: 'configured' }); // dr_last_ok fica NULL
      await db.updateMachineDRStatus(dueOldId, { setup: 'configured', lastOk: '2020-01-01T00:00:00.000Z' });
      await db.updateMachineDRStatus(notDueId, { setup: 'configured', lastOk: new Date().toISOString() });

      const due = await db.getMachinesDRDue('2025-01-01T00:00:00.000Z');
      const dueIds = due.map(m => m.id);
      expect(dueIds).toContain(dueNullId);
      expect(dueIds).toContain(dueOldId);
      expect(dueIds).not.toContain(notDueId);
    });
  });
});
