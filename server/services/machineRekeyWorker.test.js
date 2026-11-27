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

  // Pelo menos 1 linha em cada uma das 15 tabelas de ALL_CHILD_TABLES --
  // inclui as 2 grandes com FK (activity_log/nfce_index, pré-processadas em
  // lote agora que new_id é clonado antes de qualquer UPDATE filho, ver
  // cloneMachineRow) e as 3 SEM coluna `id` própria (nfce_indexed_days,
  // nfce_auto_email_log, service_status -- migradas via
  // updateMachineIdDirect, não updateMachineIdInBatches).
  async function seedAllChildTables(machineId) {
    await db.insertActivityLog(machineId, 'Bloco de Notas', 'notepad.exe');
    await db.upsertNFCeRecords(machineId, [{ chave: crypto.randomUUID(), n_nf: 1, dh_emi: '2026-01-01T00:00:00', v_nf: 10 }]);
    await db.createCommand(machineId, 'ping', {});
    await db.addEvent(machineId, 'teste', 'evento antes do re-key');
    await db.saveInsight({ machineId, severity: 'warning', pattern: 'p', patternHash: crypto.randomUUID() });
    await db.insertDRBackup(machineId, { backedAt: new Date().toISOString(), status: 'ok', storageGb: 1 });
    await db.createLiveSession(machineId, 'normal');
    await db.insertMetricsHourly(machineId, { snapshotTs: Math.floor(Date.now() / 1000), cpuPct: 1, ramPct: 1, diskPct: 1, cpuTempC: 40 });
    await db.insertOfflineEvent(machineId, { offlineAt: new Date().toISOString(), onlineAt: new Date().toISOString(), durationMin: 5 });
    await db.markNFCeDayIndexed(machineId, '2026-01-01', 3); // sem coluna id (PK composta machine_id+day_key)
    await db.insertReadingMiss(machineId, { expectedHour: 10, machineStatus: 'offline' });
    await db.saveMetrics(machineId, { cpuPct: 10 });
    await db.claimAutoEmail(crypto.randomUUID(), machineId, 'loja@exemplo.com'); // sem coluna id (PK em `chave`)
    await db.upsertServiceStatus(machineId, 'NCRPOS', 'running', null, null); // sem coluna id (PK composta machine_id+service_name)
  }

  // Confirma que as 15 tabelas migraram pro novo id -- 1 linha cada,
  // incluindo as 3 sem coluna `id` (updateMachineIdDirect).
  async function expectAllChildTablesMigrated(machineId) {
    expect(await db.getActivityLog(machineId, 10)).toHaveLength(1);
    const { rows: nfce } = await db.getPool().query('SELECT 1 FROM nfce_index WHERE machine_id=$1', [machineId]);
    expect(nfce).toHaveLength(1);
    expect(await db.getCommandHistory(machineId, 10)).toHaveLength(1);
    expect(await db.getEvents(machineId, 10)).toHaveLength(1);
    expect(await db.getInsights({ machineId })).toHaveLength(1);
    const { rows: drBackups } = await db.getPool().query('SELECT 1 FROM dr_backups WHERE machine_id=$1', [machineId]);
    expect(drBackups).toHaveLength(1);
    const { rows: liveSessions } = await db.getPool().query('SELECT 1 FROM live_sessions WHERE machine_id=$1', [machineId]);
    expect(liveSessions).toHaveLength(1);
    const { rows: hourly } = await db.getPool().query('SELECT 1 FROM machine_metrics_hourly WHERE machine_id=$1', [machineId]);
    expect(hourly).toHaveLength(1);
    const { rows: offlineEvents } = await db.getPool().query('SELECT 1 FROM machine_offline_events WHERE machine_id=$1', [machineId]);
    expect(offlineEvents).toHaveLength(1);
    expect(await db.getIndexedDayKeysSet(machineId)).toEqual(new Set(['2026-01-01'])); // sem coluna id
    const { rows: readingMiss } = await db.getPool().query('SELECT 1 FROM reading_miss_events WHERE machine_id=$1', [machineId]);
    expect(readingMiss).toHaveLength(1);
    expect(await db.getMetrics(machineId, 24)).toHaveLength(1);
    const { rows: autoEmail } = await db.getPool().query('SELECT 1 FROM nfce_auto_email_log WHERE machine_id=$1', [machineId]);
    expect(autoEmail).toHaveLength(1); // sem coluna id
    const { rows: svcStatus } = await db.getPool().query('SELECT 1 FROM service_status WHERE machine_id=$1', [machineId]);
    expect(svcStatus).toHaveLength(1); // sem coluna id
  }

  it('clone-and-swap: clona old_id -> new_id, migra em lote TODAS as 15 tabelas filhas (as 10 com FK + as 5 sem FK, incluindo as 3 sem coluna id), remove duplicata e marca done', async () => {
    const hostname = `WORKER-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const newId = trackMachine(crypto.randomUUID());
    await insertMachine(oldId, hostname);
    await seedAllChildTables(oldId);

    // Duplicata (sobra de reinstalação anterior) com filho COM FK
    // (win_events) e filho SEM FK (metrics) -- dedup é parte da MESMA
    // transação de finalização.
    const dupId = crypto.randomUUID(); // não rastreado -- a própria Fase B deve apagar
    await insertMachine(dupId, hostname);
    await db.saveMetrics(dupId, { cpuPct: 77 });
    await db.saveWinEvents(dupId, [{
      eventTime: new Date().toISOString(), eventId: 1, source: 'Kernel', level: 'Info', translation: 'duplicata',
    }]);

    // Job enfileirado diretamente (sem passar pela Fase A de registerMachine
    // -- cobertura isolada da Fase B).
    await db.getPool().query(
      `INSERT INTO machine_rekey_queue (old_id, new_id, hostname, status) VALUES ($1,$2,$3,'pending')`,
      [oldId, newId, hostname]
    );

    await runUntilDone(hostname);

    expect(await db.getMachineById(oldId)).toBeUndefined(); // linha antiga DELETADA (não re-chaveada no lugar)
    expect(await db.getMachineById(dupId)).toBeUndefined(); // duplicata removida

    const newMachine = await db.getMachineById(newId);
    expect(newMachine).toBeDefined();
    expect(newMachine.hostname).toBe(hostname);

    await expectAllChildTablesMigrated(newId);

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

  it('CRÍTICO (achado do revisor): heartbeat do MESMO agente não trava durante a Fase B -- nunca segura a linha old_id por mais que a transação final curta', async () => {
    const hostname = `WORKER-HEARTBEAT-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const newId = trackMachine(crypto.randomUUID());
    await insertMachine(oldId, hostname);

    // 2500 linhas em activity_log -- não precisa simular os 23GB reais do
    // incidente, mas precisa ser mais que PURGE_BATCH_SIZE (1000, ver
    // db-pg.js) pra garantir PELO MENOS 3 lotes com PURGE_BATCH_SLEEP_MS
    // (100ms) entre eles -- 🔴 achado real do revisor (2ª rodada): com
    // menos linhas (1 lote só), o pré-processamento podia terminar rápido
    // demais, e o teste não provava nada sobre ausência de contenção
    // DURANTE o lote (só mediria um heartbeat que corre antes/depois dele,
    // por sorte de timing). INSERT direto em 1 round-trip (não via
    // db.insertActivityLog, que faz 1 SELECT de dedupe + 1 INSERT por
    // chamada -- chamadas sequenciais contra o Postgres de dev via rede
    // real excediam o timeout de 5s do Jest só no SETUP).
    await db.getPool().query(
      `INSERT INTO activity_log (machine_id, window_title, process_name, captured_at)
       SELECT $1, 'Janela ' || g, 'app.exe', now() - (g || ' seconds')::interval
       FROM generate_series(1, 2500) AS g`,
      [oldId]
    );

    await db.getPool().query(
      `INSERT INTO machine_rekey_queue (old_id, new_id, hostname, status) VALUES ($1,$2,$3,'pending')`,
      [oldId, newId, hostname]
    );

    const cyclePromise = worker.runCycleOnce(hostname);

    // 1 tick pro clone + início do pré-processamento em lote começarem
    // antes de disparar o heartbeat concorrente (sem isso, corremos o risco
    // de medir um heartbeat que terminou ANTES do ciclo nem começar a
    // tocar a linha antiga).
    await new Promise(resolve => setTimeout(resolve, 20));

    const heartbeatStart = Date.now();
    await db.setMachineStatus(oldId, 'online'); // mesmo UPDATE machines ... WHERE id=oldId que um heartbeat real dispara (routes/agent.js)
    const heartbeatMs = Date.now() - heartbeatStart;

    // O CRÍTICO do revisor: no desenho antigo (UPDATE machines SET id=...
    // segurando o advisory lock durante TODO o cascade residual de
    // activity_log/nfce_index), este UPDATE ficaria preso esperando o row
    // lock da linha old_id -- reproduzindo o incidente original de dentro
    // do worker. Limiar bem generoso (1s): no desenho novo, a linha antiga
    // só é travada (FOR UPDATE) dentro da transação final CURTA, nunca
    // durante o pré-processamento em lote.
    expect(heartbeatMs).toBeLessThan(1000);

    await cyclePromise; // garante que o ciclo termina de verdade, sem deixar promise solta
    expect(await db.getMachineById(oldId)).toBeUndefined();
    expect(await db.getMachineById(newId)).toBeDefined();
  });

  it('job preso em processing com claimed_at antigo é resetado pra pending e reclamado no mesmo ciclo', async () => {
    const hostname = `WORKER-STUCK-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const newId = trackMachine(crypto.randomUUID());
    await insertMachine(oldId, hostname);

    const { rows } = await db.getPool().query(
      `INSERT INTO machine_rekey_queue (old_id, new_id, hostname, status, claimed_at, attempts)
       VALUES ($1,$2,$3,'processing', now() - interval '10 minutes', 0)
       RETURNING id`,
      [oldId, newId, hostname]
    );
    const jobId = rows[0].id;

    // runCycleOnce(hostname) roda _reclaimStuckJobs() logo no início (antes
    // do claim) -- o job preso vira 'pending' (attempts incrementado) e é
    // reclamado na MESMA chamada, concluindo o re-key.
    await runUntilDone(hostname);

    const { rows: after } = await db.getPool().query(
      'SELECT status, attempts FROM machine_rekey_queue WHERE id=$1', [jobId]
    );
    expect(after[0].status).toBe('done');
    expect(after[0].attempts).toBeGreaterThanOrEqual(1);
    expect(await db.getMachineById(newId)).toBeDefined();
  });

  it('job travado que já esgotou attempts vira failed -- para de ser reclamado automaticamente', async () => {
    const hostname = `WORKER-FAILED-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const newId = trackMachine(crypto.randomUUID());
    await insertMachine(oldId, hostname);

    // attempts=4: a próxima reclamação (_reclaimStuckJobs, MAX_ATTEMPTS=5)
    // incrementa pra 5 e marca 'failed' em vez de devolver pra 'pending'.
    const { rows } = await db.getPool().query(
      `INSERT INTO machine_rekey_queue (old_id, new_id, hostname, status, claimed_at, attempts)
       VALUES ($1,$2,$3,'processing', now() - interval '10 minutes', 4)
       RETURNING id`,
      [oldId, newId, hostname]
    );
    const jobId = rows[0].id;

    const result = await worker.runCycleOnce(hostname);
    expect(result).toEqual({ processed: false, reason: 'no-pending-job' }); // virou 'failed', não 'pending' -- nada pra reclamar

    const { rows: after } = await db.getPool().query(
      'SELECT status, attempts FROM machine_rekey_queue WHERE id=$1', [jobId]
    );
    expect(after[0].status).toBe('failed');
    expect(after[0].attempts).toBe(5);

    // Máquina antiga nunca foi tocada -- o job falhou antes de qualquer claim.
    expect(await db.getMachineById(oldId)).toBeDefined();
    expect(await db.getMachineById(newId)).toBeUndefined();
  });

  it('🔴 achado real do revisor (2ª rodada): cloneMachineRow é idempotente -- job que crashou depois do clone (new_id já existe em machines) completa no próximo ciclo sem violar a PK', async () => {
    const hostname = `WORKER-RECLONE-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const newId = trackMachine(crypto.randomUUID());
    await insertMachine(oldId, hostname);

    // Simula um ciclo anterior que clonou a linha (newId já existe em
    // machines, com token placeholder -- exatamente o que cloneMachineRow
    // produziria) e crashou/falhou antes do DELETE final de oldId. Antes do
    // fix, o próximo cloneMachineRow(oldId, newId, ...) tentava inserir de
    // novo e violava machines_id_pkey -- martelando o mesmo erro pra
    // sempre (o catch de runCycleOnce nunca aplicava MAX_ATTEMPTS).
    await db.getPool().query(
      `INSERT INTO machines (id, hostname, token, registered_at, status) VALUES ($1,$2,$3,$4,'online')`,
      [newId, hostname, crypto.randomUUID(), new Date().toISOString()]
    );
    await db.getPool().query(
      `INSERT INTO machine_rekey_queue (old_id, new_id, hostname, status) VALUES ($1,$2,$3,'pending')`,
      [oldId, newId, hostname]
    );

    await runUntilDone(hostname); // não deve lançar (nem martelar attempts)

    expect(await db.getMachineById(oldId)).toBeUndefined();
    const newMachine = await db.getMachineById(newId);
    expect(newMachine).toBeDefined();
    expect(newMachine.status).toBe('online'); // _syncMutableFields resincronizou a partir da linha antiga
  });

  it('🔴 achado real do revisor (2ª rodada): erro determinístico (não só travamento por tempo) também respeita MAX_ATTEMPTS -- vira failed, não martela pra sempre', async () => {
    const hostname = `WORKER-DETERR-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const newId = trackMachine(crypto.randomUUID());
    await insertMachine(oldId, hostname);
    const { rows } = await db.getPool().query(
      `INSERT INTO machine_rekey_queue (old_id, new_id, hostname, status) VALUES ($1,$2,$3,'pending') RETURNING id`,
      [oldId, newId, hostname]
    );
    const jobId = rows[0].id;

    // Força um erro determinístico e repetível no passo de migração em lote
    // (depois do clone, que já tem seu próprio teste de idempotência acima)
    // -- spy em vez de um cenário real de borda: `old_id === new_id`
    // (tentado antes) não funciona como erro de verdade, porque
    // cloneMachineRow trata `newId` já existente como idempotente e segue
    // adiante sem falhar (a mesma linha acaba sendo deletada e recriada
    // como "nova", um resultado degenerado, não um erro). Isso prova o
    // catch de runCycleOnce (não só _reclaimStuckJobs) aplicando
    // MAX_ATTEMPTS pra QUALQUER erro repetido, como o brief original pedia.
    const spy = jest.spyOn(db, 'updateMachineIdInBatches').mockRejectedValue(new Error('erro forçado pelo teste'));
    try {
      for (let i = 0; i < 6; i++) {
        await worker.runCycleOnce(hostname).catch(() => {}); // runCycleOnce relança o erro -- ignora aqui, só o estado final importa
      }
    } finally {
      spy.mockRestore();
    }

    const { rows: after } = await db.getPool().query(
      'SELECT status, attempts FROM machine_rekey_queue WHERE id=$1', [jobId]
    );
    expect(after[0].status).toBe('failed'); // nunca ficou martelando 'pending' indefinidamente
    expect(after[0].attempts).toBeGreaterThanOrEqual(5);
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
