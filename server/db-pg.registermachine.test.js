'use strict';

/**
 * Testes do Grupo 7 (registerMachine + dr_backups) de server/db-pg.js
 * contra um Postgres real (instância dev). registerMachine é a função
 * mais arriscada do arquivo (re-key de UUID + merge de duplicatas) --
 * cobertura extra aqui, incluindo as 10 tabelas com FK ON UPDATE CASCADE
 * e as 5 sem FK que precisam de UPDATE/DELETE manual.
 *
 * Task 4 (plano 2026-11-27-registermachine-rekey-fix): registerMachine só
 * faz mais a Fase A do re-key (rápida, enfileira em machine_rekey_queue) --
 * a troca de fato de machines.id + cascade + dedup de duplicatas virou Fase
 * B, em segundo plano, em services/machineRekeyWorker.js. Os testes de
 * "caso 2"/"caso 2b"/"prefere canonical" abaixo chamam
 * machineRekeyWorker.runCycleOnce() diretamente (não via setTimeout) pra
 * completar a Fase B dentro do teste, sem depender do scheduler real.
 * leaderElection é mockado pra isLeader() sempre true -- sem isso,
 * runCycleOnce() faria no-op (not-leader) sem leaderElection.start() ter
 * ganhado o advisory lock de sessão numa conexão própria, o que exigiria
 * outro Client real só pra isto.
 */

jest.mock('./services/leaderElection', () => ({ isLeader: () => true }));

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.registermachine.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 7: registerMachine + dr_backups)', () => {
  let db, machineRekeyWorker;
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('./db-pg');
    machineRekeyWorker = require('./services/machineRekeyWorker');
  });

  afterEach(async () => {
    const pool = db.getPool();
    if (createdMachineIds.length) {
      // machine_rekey_queue não tem FK pra machines (de propósito -- um job
      // 'done' sobrevive mesmo depois da linha antiga deixar de existir) --
      // limpeza manual antes de apagar as máquinas, senão vaza na instância
      // dev compartilhada.
      await pool.query(
        'DELETE FROM machine_rekey_queue WHERE old_id = ANY($1) OR new_id = ANY($1)',
        [createdMachineIds]
      );
    }
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

  // runCycleOnce() sem argumento pega o job 'pending' GLOBALMENTE mais
  // antigo (correto em produção -- não precisa saber de hostname, a UNIQUE
  // parcial + advisory lock por hostname já isolam tudo). Jest roda arquivos
  // de teste em paralelo (workers separados) contra a MESMA instância dev
  // do Postgres -- sem filtro, uma única chamada podia acabar roubando o job
  // de OUTRO arquivo em voo e, se aquele processo terminasse no meio, deixar
  // o job preso em 'processing' pra sempre (🔴 achado rodando a suíte
  // completa de verdade). Por isso runCycleOnce(hostname) aqui -- filtro só
  // de teste, nunca usado em produção. Ainda assim drena ciclos (em vez de
  // assumir que a 1ª chamada bastou) e falha com mensagem clara se não
  // ficar 'done' a tempo.
  async function runWorkerUntilDone(hostname, { maxCycles = 20 } = {}) {
    for (let i = 0; i < maxCycles; i++) {
      const { rows } = await db.getPool().query(
        'SELECT status FROM machine_rekey_queue WHERE hostname=$1', [hostname]
      );
      if (rows[0]?.status === 'done') return;
      const result = await machineRekeyWorker.runCycleOnce(hostname);
      if (!result.processed) break; // sem job pending pra este hostname
    }
    const { rows } = await db.getPool().query(
      'SELECT status FROM machine_rekey_queue WHERE hostname=$1', [hostname]
    );
    if (rows[0]?.status !== 'done') {
      throw new Error(`job de ${hostname} nao ficou 'done' apos ${maxCycles} ciclos (status atual: ${rows[0]?.status})`);
    }
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

    it('caso 2: re-key por hostname -- Fase A enfileira e marca online rápido SEM tocar NENHUMA tabela filha; Fase B (clone-and-swap) migra todas, preserva token, apaga a linha antiga', async () => {
      const hostname = `REKEY-${crypto.randomUUID().slice(0, 8)}`;
      const oldId = trackMachine(crypto.randomUUID());
      const originalToken = await db.registerMachine({ machineId: oldId, hostname, agentVersion: '1.0' });

      // Popula filho COM FK (win_events), filho SEM FK (metrics), o caso
      // específico do `insights` (tinha FK mas NUNCA esteve na lista
      // _MACHINE_CHILD_TABLES do SQLite original -- bug corrigido de graça
      // no port original, ver comentário em registerMachine) e outro filho
      // SEM FK (commands) -- usados abaixo pra provar que a Fase A (fix-wave
      // pós-revisão, Step 10 do brief) não toca NENHUM deles, só a Fase B.
      await db.saveWinEvents(oldId, [{
        eventTime: new Date().toISOString(), eventId: 41, source: 'Kernel', level: 'Error', translation: 'Antes do re-key',
      }]);
      await db.saveMetrics(oldId, { cpuPct: 10 });
      await db.saveInsight({ machineId: oldId, severity: 'warning', pattern: 'p', patternHash: crypto.randomUUID() });
      await db.createCommand(oldId, 'ping', {});

      const newId = trackMachine(crypto.randomUUID());
      const returnedToken = await db.registerMachine({ machineId: newId, hostname, agentVersion: '2.0' });
      expect(returnedToken).toBe(originalToken); // token do canonical, já preservado na Fase A

      // ── Fase A (síncrona, dentro de registerMachine) já terminou ──
      // machines.id AINDA é oldId -- só a Fase B (clone-and-swap) troca isso.
      const oldMachineAfterPhaseA = await db.getMachineById(oldId);
      expect(oldMachineAfterPhaseA).toBeDefined();
      expect(oldMachineAfterPhaseA.agent_version).toBe('2.0'); // já refletido, sem esperar o worker
      expect(oldMachineAfterPhaseA.status).toBe('online');
      expect(await db.getMachineById(newId)).toBeUndefined(); // a linha só passa a existir com esse id na Fase B (clone)

      // NENHUMA tabela filha migrou ainda -- Fase A (pós fix-wave) não toca
      // tabela filha nenhuma, nem as pequenas sem FK.
      expect(await db.getMetrics(newId, 24)).toHaveLength(0);
      expect(await db.getMetrics(oldId, 24)).toHaveLength(1);
      expect(await db.getCommandHistory(newId, 10)).toHaveLength(0);
      expect(await db.getCommandHistory(oldId, 10)).toHaveLength(1);
      expect(await db.getWinEvents(newId, 'all')).toHaveLength(0);
      expect(await db.getInsights({ machineId: newId })).toHaveLength(0);

      // evento 'agent_reregistered' já disparado na Fase A -- addEvent grava
      // direto com o NOVO id (events não tem FK, nasce já correto, não
      // precisa de migração nenhuma).
      expect((await db.getEvents(newId, 10)).some(e => e.type === 'agent_reregistered')).toBe(true);

      // exatamente 1 job pending enfileirado pra este hostname
      const { rows: queueRows } = await db.getPool().query(
        'SELECT * FROM machine_rekey_queue WHERE hostname=$1', [hostname]
      );
      expect(queueRows).toHaveLength(1);
      expect(queueRows[0].status).toBe('pending');
      expect(queueRows[0].old_id).toBe(oldId);
      expect(queueRows[0].new_id).toBe(newId);

      // ── Fase B (worker, chamada direta -- não via setTimeout) ──
      await runWorkerUntilDone(hostname);

      expect(await db.getMachineById(oldId)).toBeUndefined(); // oldId não existe mais -- a linha foi DELETADA (clone-and-swap), não re-chaveada no lugar

      const newMachine = await db.getMachineById(newId);
      expect(newMachine.token).toBe(originalToken);
      expect(newMachine.agent_version).toBe('2.0');

      expect(await db.getWinEvents(newId, 'all')).toHaveLength(1); // migrado em lote (updateMachineIdInBatches, Fase B)
      expect(await db.getMetrics(newId, 24)).toHaveLength(1); // migrado em lote (updateMachineIdDirect/InBatches, Fase B)
      expect(await db.getInsights({ machineId: newId })).toHaveLength(1); // migrado em lote (Fase B)
      expect(await db.getCommandHistory(newId, 10)).toHaveLength(1); // migrado em lote pela Fase B (updateMachineIdInBatches)

      const { rows: queueAfter } = await db.getPool().query(
        'SELECT status FROM machine_rekey_queue WHERE old_id=$1', [oldId]
      );
      expect(queueAfter[0].status).toBe('done');
    });

    it('Fase B: rodar o worker de novo sobre um job já done não duplica nem quebra (idempotência)', async () => {
      const hostname = `REKEY-IDEMPOTENT-${crypto.randomUUID().slice(0, 8)}`;
      const oldId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: oldId, hostname, agentVersion: '1.0' });

      const newId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: newId, hostname, agentVersion: '2.0' });

      await runWorkerUntilDone(hostname);

      // Job já 'done' -- chamar o worker de novo com o MESMO filtro de
      // hostname (nunca sem filtro aqui: outro arquivo de teste rodando em
      // paralelo pode ter um job 'pending' em voo, e uma chamada sem filtro
      // roubaria esse trabalho, deixando aquele outro teste ler 'processing'
      // no meio de uma sequência de asserts -- 🔴 reproduzido ao vivo) não
      // acha nada pra este hostname (já 'done'), não duplica nem quebra:
      // continua existindo exatamente 1 linha pra este hostname, ainda 'done'.
      await machineRekeyWorker.runCycleOnce(hostname).catch(() => {});

      const { rows } = await db.getPool().query(
        'SELECT status FROM machine_rekey_queue WHERE hostname=$1', [hostname]
      );
      expect(rows).toHaveLength(1); // nenhum job duplicado
      expect(rows[0].status).toBe('done');
    });

    it('Fase A é idempotente por hostname (Step 8 do brief): 2ª chamada antes do worker processar só atualiza o new_id da fila, nunca cria um 2º job', async () => {
      const hostname = `REKEY-QUEUE-${crypto.randomUUID().slice(0, 8)}`;
      const oldId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: oldId, hostname, agentVersion: '1.0' });

      const machineId1 = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: machineId1, hostname, agentVersion: '2.0' });

      const machineId2 = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: machineId2, hostname, agentVersion: '3.0' });

      const { rows } = await db.getPool().query(
        'SELECT old_id, new_id, status FROM machine_rekey_queue WHERE hostname=$1', [hostname]
      );
      expect(rows).toHaveLength(1); // nunca 2 jobs concorrentes pro mesmo hostname -- UNIQUE parcial
      expect(rows[0].status).toBe('pending');
      expect(rows[0].old_id).toBe(oldId);
      expect(rows[0].new_id).toBe(machineId2); // o mais recente prevalece (machineId1 nunca foi aplicado)

      await runWorkerUntilDone(hostname); // limpeza -- processa o job antes do afterEach
    });

    it('hostname em case diferente não cria 2 jobs ativos -- UNIQUE por UPPER(hostname) (Step 9/10 do brief, fix-wave pós-revisão)', async () => {
      const base = `CaseTest-${crypto.randomUUID().slice(0, 8)}`;
      const oldId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: oldId, hostname: base, agentVersion: '1.0' });

      const newId1 = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: newId1, hostname: base.toUpperCase(), agentVersion: '2.0' });

      const newId2 = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: newId2, hostname: base.toLowerCase(), agentVersion: '3.0' });

      // A coluna `hostname` da fila nunca é reescrita depois do 1º INSERT
      // (só `new_id` é atualizado -- ver _rekeyAndMergeMachine) -- por isso
      // o UPPER() na query, não o valor exato de `base`.
      const { rows } = await db.getPool().query(
        'SELECT old_id, new_id, hostname, status FROM machine_rekey_queue WHERE UPPER(hostname) = UPPER($1)', [base]
      );
      expect(rows).toHaveLength(1); // nunca 2 jobs ativos, mesmo com hostname chegando em case diferente
      expect(rows[0].status).toBe('pending');
      expect(rows[0].old_id).toBe(oldId);
      expect(rows[0].new_id).toBe(newId2); // o mais recente prevalece (newId1 nunca foi aplicado)

      await runWorkerUntilDone(base); // limpeza -- o hostname armazenado na fila é o original (base), nunca sobrescrito
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

    it('caso 2b: re-key com duplicata -- Fase A não remove nada ainda, Fase B apaga a duplicata e seus filhos (com e sem FK)', async () => {
      const hostname = `REKEY-DUP-${crypto.randomUUID().slice(0, 8)}`;
      const canonicalId = trackMachine(crypto.randomUUID());
      await db.registerMachine({ machineId: canonicalId, hostname, agentVersion: '1.0' });

      // Simula uma 2ª máquina física/registro remanescente com o MESMO
      // hostname (cenário que o dedup existe pra limpar).
      const dupId = crypto.randomUUID(); // não rastreado -- deve ser apagada pela Fase B
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

      // Fase A (Step 2.4 do brief) nunca remove duplicata -- isso é Fase B.
      expect(await db.getMachineById(dupId)).toBeDefined();

      await runWorkerUntilDone(hostname);

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

      // Fase A ainda não trocou machines.id -- é a MESMA linha física
      // (realId) que vai sobreviver depois da Fase B, location intocado
      // (Fase A nunca mexe nessa coluna).
      expect((await db.getMachineById(realId)).location).toBe('Loja Real');

      await runWorkerUntilDone(hostname); // Fase B -- também limpa tempDupId (dedup)

      const newMachine = await db.getMachineById(newId);
      expect(newMachine.location).toBe('Loja Real'); // herdou do canonical real (mesma linha física), não do Temporário
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
