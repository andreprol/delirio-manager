'use strict';

/**
 * Testes de server/services/machineRekeyWorker.js (Fase B do re-key
 * assíncrono, Task 4 do plano 2026-11-27-registermachine-rekey-fix) contra
 * um Postgres real (mesmo padrão describeDb de db-pg.registermachine.test.js
 * -- pula sozinho sem DATABASE_URL). Constrói o cenário direto no banco (sem
 * passar por registerMachine) pra ter controle total sobre o estado inicial
 * da fila e das tabelas grandes/sem FK que a Fase A não toca.
 *
 * leaderElection é mockado pra isLeader() sempre true -- sem isso,
 * runCycleOnce() faria no-op (not-leader) sem precisar de outra conexão real
 * só pra disputar o advisory lock de sessão.
 */

jest.mock('./leaderElection', () => ({ isLeader: () => true }));

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[machineRekeyWorker.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('machineRekeyWorker (Fase B)', () => {
  let db, worker;
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('../db-pg');
    worker = require('./machineRekeyWorker');
  });

  afterEach(async () => {
    const pool = db.getPool();
    if (createdMachineIds.length) {
      await pool.query(
        'DELETE FROM machine_rekey_queue WHERE old_id = ANY($1) OR new_id = ANY($1)',
        [createdMachineIds]
      );
    }
    while (createdMachineIds.length) {
      const id = createdMachineIds.pop();
      await pool.query('DELETE FROM metrics WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM commands WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM events WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM nfce_auto_email_log WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM service_status WHERE machine_id=$1', [id]);
      await pool.query('DELETE FROM deleted_machines WHERE id=$1', [id]);
      await pool.query('DELETE FROM machines WHERE id=$1', [id]); // cascade cuida de activity_log/nfce_index/win_events/...
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  function trackMachine(id) {
    createdMachineIds.push(id);
    return id;
  }

  // Mesma cautela de db-pg.registermachine.test.js: Jest roda arquivos em
  // paralelo contra a MESMA instância dev -- passa hostname pra
  // runCycleOnce() (filtro só de teste, ver comentário na própria função)
  // pra nunca roubar o job de outro arquivo em voo, e ainda assim drena até
  // o NOSSO hostname ficar 'done' em vez de assumir que a 1ª chamada processou.
  async function runUntilDone(hostname, { maxCycles = 20 } = {}) {
    for (let i = 0; i < maxCycles; i++) {
      const { rows } = await db.getPool().query(
        'SELECT status FROM machine_rekey_queue WHERE hostname=$1', [hostname]
      );
      if (rows[0]?.status === 'done') return;
      const result = await worker.runCycleOnce(hostname);
      if (!result.processed) break;
    }
    const { rows } = await db.getPool().query(
      'SELECT status FROM machine_rekey_queue WHERE hostname=$1', [hostname]
    );
    if (rows[0]?.status !== 'done') {
      throw new Error(`job de ${hostname} nao ficou 'done' apos ${maxCycles} ciclos (status atual: ${rows[0]?.status})`);
    }
  }

  async function insertMachine(id, hostname, extra = {}) {
    await db.getPool().query(
      `INSERT INTO machines (id, hostname, token, registered_at, status)
       VALUES ($1,$2,$3,$4,'online')`,
      [id, hostname, crypto.randomUUID(), new Date().toISOString()]
    );
    if (extra.location) await db.updateMachine(id, { location: extra.location });
  }

  it('Step 6: processa 1 job pending -- migra em lote as tabelas grandes/sem FK (activity_log, nfce_index, events, commands), troca machines.id, remove duplicata e marca done', async () => {
    const hostname = `WORKER-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const newId = trackMachine(crypto.randomUUID());
    await insertMachine(oldId, hostname);

    // Popula as 2 tabelas grandes com FK (pré-processadas em lote por
    // updateMachineIdInBatches) + as 2 sem FK que a Fase A deixa pra Fase B.
    await db.insertActivityLog(oldId, 'Bloco de Notas', 'notepad.exe');
    await db.upsertNFCeRecords(oldId, [{ chave: crypto.randomUUID(), n_nf: 1, dh_emi: '2026-01-01T00:00:00', v_nf: 10 }]);
    await db.createCommand(oldId, 'ping', {});
    await db.addEvent(oldId, 'teste', 'evento antes do re-key');

    // Duplicata (sobra de reinstalação anterior) com filho COM FK
    // (win_events) e filho SEM FK (metrics) -- dedup é parte da MESMA
    // transação de finalização (Step 3.5 do brief).
    const dupId = crypto.randomUUID(); // não rastreado -- a própria Fase B deve apagar
    await insertMachine(dupId, hostname);
    await db.saveMetrics(dupId, { cpuPct: 77 });
    await db.saveWinEvents(dupId, [{
      eventTime: new Date().toISOString(), eventId: 1, source: 'Kernel', level: 'Info', translation: 'duplicata',
    }]);

    // Job enfileirado diretamente (sem passar pela Fase A de registerMachine
    // -- Step 6 do brief pede cobertura isolada da Fase B).
    await db.getPool().query(
      `INSERT INTO machine_rekey_queue (old_id, new_id, hostname, status) VALUES ($1,$2,$3,'pending')`,
      [oldId, newId, hostname]
    );

    await runUntilDone(hostname);

    expect(await db.getMachineById(oldId)).toBeUndefined();
    expect(await db.getMachineById(dupId)).toBeUndefined(); // duplicata removida

    const newMachine = await db.getMachineById(newId);
    expect(newMachine).toBeDefined();
    expect(newMachine.hostname).toBe(hostname);

    expect(await db.getActivityLog(newId, 10)).toHaveLength(1);
    const { rows: nfce } = await db.getPool().query('SELECT 1 FROM nfce_index WHERE machine_id=$1', [newId]);
    expect(nfce).toHaveLength(1);
    expect(await db.getCommandHistory(newId, 10)).toHaveLength(1);
    expect(await db.getEvents(newId, 10)).toHaveLength(1);

    // Filhos da duplicata -- nem migrados, nem sobrando (foram apagados
    // junto da duplicata, não junto da máquina sobrevivente).
    const { rows: dupMetrics } = await db.getPool().query('SELECT 1 FROM metrics WHERE machine_id=$1', [dupId]);
    expect(dupMetrics).toHaveLength(0);
    expect(await db.getWinEvents(dupId, 'all')).toHaveLength(0);

    const { rows: queueRows } = await db.getPool().query(
      'SELECT status FROM machine_rekey_queue WHERE hostname=$1', [hostname]
    );
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].status).toBe('done');
  });

  it('Step 6: idempotência -- rodar o worker de novo depois do job já done não duplica nem quebra', async () => {
    const hostname = `WORKER-IDEMP-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const newId = trackMachine(crypto.randomUUID());
    await insertMachine(oldId, hostname);
    await db.getPool().query(
      `INSERT INTO machine_rekey_queue (old_id, new_id, hostname, status) VALUES ($1,$2,$3,'pending')`,
      [oldId, newId, hostname]
    );

    await runUntilDone(hostname);
    const newMachineAfterFirst = await db.getMachineById(newId);
    expect(newMachineAfterFirst).toBeDefined();

    // Chamar de novo com o MESMO filtro de hostname (nunca sem filtro: outro
    // arquivo de teste em paralelo pode ter um job 'pending' em voo, e uma
    // chamada sem filtro roubaria esse trabalho -- 🔴 reproduzido ao vivo).
    // _claimNextJob(hostname) só enxerga status='pending' deste hostname,
    // que já é 'done' -- nunca reprocessa, nunca duplica a linha, nunca quebra.
    await worker.runCycleOnce(hostname).catch(() => {});

    const { rows } = await db.getPool().query(
      'SELECT status FROM machine_rekey_queue WHERE hostname=$1', [hostname]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('done');
    expect(await db.getMachineById(newId)).toBeDefined(); // ainda lá, sem efeito colateral
  });

  it('isLeader() === false: runCycleOnce() não processa nada (not-leader)', async () => {
    // jest.resetModules() isolado nesta passada: `db`/`worker` capturados no
    // beforeAll continuam válidos depois (referência direta ao objeto do
    // módulo, não ao registro do Jest) -- usado no mesmo padrão de
    // agent.nfce.test.js/leaderElection.test.js.
    jest.resetModules();
    jest.doMock('./leaderElection', () => ({ isLeader: () => false }));
    const freshWorker = require('./machineRekeyWorker');

    const result = await freshWorker.runCycleOnce();
    expect(result).toEqual({ processed: false, reason: 'not-leader' });
  });
});
