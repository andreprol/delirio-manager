'use strict';

/**
 * Testes de POST /api/aloha/:machineId/index/trigger — indexação incremental
 * do mês atual. Fase 4 (cutover): rodava contra SQLite `:memory:` real via
 * `../db`; agora roda contra Postgres real (`../db-pg`, mesmo padrão dos
 * db-pg.*.test.js da Fase 2) — pula sozinho se DATABASE_URL não setada.
 */

const express = require('express');
const request = require('supertest');
const crypto  = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[aloha.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('POST /api/aloha/:machineId/index/trigger', () => {
  let db, app;
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('../db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdMachineIds.length) {
      await pool.query('DELETE FROM machines WHERE id=$1', [createdMachineIds.pop()]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  function makeApp() {
    const router = require('./aloha');
    const a = express();
    a.use(express.json());
    a.use('/api/aloha', router);
    return a;
  }

  async function registerMachine(hostname) {
    const machineId = crypto.randomUUID();
    createdMachineIds.push(machineId);
    await db.registerMachine({ machineId, hostname, agentVersion: '1.0' });
    return machineId;
  }

  function todayMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  it('404 quando a máquina não existe', async () => {
    app = makeApp();
    const res = await request(app).post('/api/aloha/inexistente/index/trigger').send({});
    expect(res.status).toBe(404);
  });

  it('primeira chamada enfileira todos os dias do mês até hoje, sem pular nenhum', async () => {
    const m1 = await registerMachine(`LOJA1BOH-${crypto.randomUUID().slice(0, 8)}`);
    app = makeApp();

    const res = await request(app).post(`/api/aloha/${m1}/index/trigger`).send({});

    const today = new Date().getDate();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.days).toBe(today);
    expect(res.body.skipped).toBe(0);
    expect(res.body.commandIds).toHaveLength(today);
  });

  it('segunda chamada pula dias já indexados — só reenfileira hoje', async () => {
    const m1 = await registerMachine(`LOJA1BOH-${crypto.randomUUID().slice(0, 8)}`);
    const month = todayMonthKey();
    const today = new Date().getDate();
    // Marca todos os dias 1..today como já indexados (simula execução anterior completa).
    for (let d = 1; d <= today; d++) {
      await db.markNFCeDayIndexed(m1, `${month}-${String(d).padStart(2, '0')}`, 1);
    }
    app = makeApp();

    const res = await request(app).post(`/api/aloha/${m1}/index/trigger`).send({});

    expect(res.status).toBe(200);
    // Só o dia de hoje é reenfileirado — todos os outros (today-1) foram pulados.
    expect(res.body.days).toBe(1);
    expect(res.body.skipped).toBe(today - 1);
    expect(res.body.commandIds).toHaveLength(1);
  });

  it('dias indexados de uma loja não afetam o trigger de outra', async () => {
    const m1 = await registerMachine(`LOJA1BOH-${crypto.randomUUID().slice(0, 8)}`);
    const m2 = await registerMachine(`LOJA2BOH-${crypto.randomUUID().slice(0, 8)}`);

    const month = todayMonthKey();
    await db.markNFCeDayIndexed(m1, `${month}-01`, 1);
    app = makeApp();

    const res = await request(app).post(`/api/aloha/${m2}/index/trigger`).send({});

    const today = new Date().getDate();
    expect(res.body.days).toBe(today); // nada pulado pra m2
    expect(res.body.skipped).toBe(0);
  });
});
