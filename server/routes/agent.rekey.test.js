'use strict';

/**
 * Step 7/15 do brief da Task 4 (plano 2026-11-27-registermachine-rekey-fix):
 * ruling das rotas que comparam machine.id direto (ver routes/agent.js:
 * GET /api/commands/:machineId e POST /api/machines/:id/service-status;
 * routes/winEvents.js: POST /api/win-events) -- enquanto a Fase B do re-key
 * assíncrono não comitou machines.id, o agente já está usando o novo UUID
 * (pending_rekey_new_id) desde que registerMachine respondeu 201. Testa
 * contra Postgres real (mesmo padrão describeDb de routes/aloha.test.js).
 *
 * Fix-wave pós-revisão (Step 15): achado ALTO do revisor -- service-status e
 * win-events aceitavam o new_id pendente pra AUTORIZAR a request, mas
 * gravavam usando esse id do payload/params em vez de `machine.id` (o id
 * que de fato existe em `machines` até a Fase B comitar) -- win_events tem
 * FK ativa pra machines(id), então isso virava 500 (violação de FK) em vez
 * do 401/403 esperado. Corrigido: as duas rotas gravam sempre com
 * `machine.id` -- ver testes "service-status: grava com machine.id" e
 * "win-events: grava com machine.id" abaixo.
 */

const express = require('express');
const request = require('supertest');
const crypto  = require('crypto');

jest.mock('../services/leaderElection', () => ({ isLeader: () => true }));

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[agent.rekey.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('rotas do agente -- ruling de pending_rekey_new_id (Step 7) e gravação com machine.id (Step 15)', () => {
  let db, worker, app;
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('../db-pg');
    worker = require('../services/machineRekeyWorker');
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
      await pool.query('DELETE FROM win_events WHERE machine_id=$1', [id]);
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

  // Monta as 2 rotas do agente (agent.js + winEvents.js) no mesmo app --
  // reusado por todos os testes deste arquivo, inclusive os de Step 15
  // (service-status/win-events) que precisam de winEvents.js.
  function makeApp() {
    const agentRouter = require('./agent');
    const winEventsRouter = require('./winEvents');
    const a = express();
    a.use(express.json());
    a.use('/api', agentRouter);
    a.use('/api', winEventsRouter);
    return a;
  }

  it('aceita o new_id pendente de re-key (200/404, nunca 403) enquanto a Fase B não comitou machines.id; depois de done, continua autenticando por machine.id direto', async () => {
    const hostname = `REKEY-ROUTE-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const { token: canonicalToken } = await db.registerMachine({ machineId: oldId, hostname, agentVersion: '1.0' });

    const newId = trackMachine(crypto.randomUUID());
    const { token: returnedToken } = await db.registerMachine({ machineId: newId, hostname, agentVersion: '2.0' });
    expect(returnedToken).toBe(canonicalToken); // confirma que ainda estamos na janela do re-key pendente

    app = makeApp();

    // O agente já usa `newId` (seu próprio UUID) no path, com o token do
    // canonical no header -- machine.id ainda é oldId nesse momento
    // (Fase B não rodou), mas pending_rekey_new_id === newId deve bastar.
    const resPending = await request(app)
      .get(`/api/commands/${newId}`)
      .set('Authorization', `Bearer ${canonicalToken}`);
    expect(resPending.status).not.toBe(403);
    expect(resPending.status).toBe(200);
    expect(Array.isArray(resPending.body.commands)).toBe(true);

    // Completa a Fase B -- machines.id agora É newId de verdade.
    await runUntilDone(hostname);

    const resDone = await request(app)
      .get(`/api/commands/${newId}`)
      .set('Authorization', `Bearer ${canonicalToken}`);
    expect(resDone.status).not.toBe(403);
    expect(resDone.status).toBe(200);
  });

  it('403 quando o machineId do path não bate nem com machine.id nem com pending_rekey_new_id', async () => {
    const hostname = `REKEY-ROUTE-WRONG-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const { token } = await db.registerMachine({ machineId: oldId, hostname, agentVersion: '1.0' });

    app = makeApp();
    const res = await request(app)
      .get(`/api/commands/${crypto.randomUUID()}`) // UUID aleatório, não relacionado
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('service-status: grava com machine.id (oldId), nunca com o newId do path, durante a janela pendente', async () => {
    const hostname = `REKEY-SVC-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const { token } = await db.registerMachine({ machineId: oldId, hostname, agentVersion: '1.0' });

    const newId = trackMachine(crypto.randomUUID());
    await db.registerMachine({ machineId: newId, hostname, agentVersion: '2.0' }); // enfileira o re-key, machines.id ainda é oldId

    app = makeApp();
    const res = await request(app)
      .post(`/api/machines/${newId}/service-status`) // agente já usa o newId no path
      .set('Authorization', `Bearer ${token}`)
      .send({ services: [{ name: 'NCRPOS', status: 'running' }] });

    expect(res.status).toBe(200);

    const { rows: onOld } = await db.getPool().query('SELECT 1 FROM service_status WHERE machine_id=$1', [oldId]);
    expect(onOld).toHaveLength(1); // gravou com machine.id (oldId), não com newId do path
    const { rows: onNew } = await db.getPool().query('SELECT 1 FROM service_status WHERE machine_id=$1', [newId]);
    expect(onNew).toHaveLength(0);
  });

  it('win-events: grava com machine.id (oldId), nunca com o machineId do body, durante a janela pendente', async () => {
    const hostname = `REKEY-WINEV-${crypto.randomUUID().slice(0, 8)}`;
    const oldId = trackMachine(crypto.randomUUID());
    const { token } = await db.registerMachine({ machineId: oldId, hostname, agentVersion: '1.0' });

    const newId = trackMachine(crypto.randomUUID());
    await db.registerMachine({ machineId: newId, hostname, agentVersion: '2.0' }); // enfileira o re-key, machines.id ainda é oldId

    app = makeApp();
    const res = await request(app)
      .post('/api/win-events')
      .send({
        machineId: newId, // agente já usa o newId no body
        token,
        events: [{ eventTime: new Date().toISOString(), eventId: 41, source: 'Kernel', level: 'Error', translation: 'teste' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(1);

    const onOld = await db.getWinEvents(oldId, 'all');
    expect(onOld).toHaveLength(1); // gravou com machine.id (oldId), não com o machineId do body
    const onNew = await db.getWinEvents(newId, 'all');
    expect(onNew).toHaveLength(0);
  });
});
