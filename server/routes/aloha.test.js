'use strict';

/**
 * Testes de POST /api/aloha/:machineId/index/trigger — indexação incremental
 * do mês atual. DB :memory: real (mesmo padrão dos demais db.*.test.js).
 */

const express = require('express');
const request = require('supertest');

beforeEach(() => {
  jest.resetModules();
  process.env.DB_PATH = ':memory:';
});

afterEach(() => {
  delete process.env.DB_PATH;
});

function buildApp() {
  const db     = require('../db');
  const router = require('./aloha');
  const app = express();
  app.use(express.json());
  app.use('/api/aloha', router);
  return { app, db };
}

function todayMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

describe('POST /api/aloha/:machineId/index/trigger', () => {
  it('404 quando a máquina não existe', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/aloha/inexistente/index/trigger').send({});
    expect(res.status).toBe(404);
  });

  it('primeira chamada enfileira todos os dias do mês até hoje, sem pular nenhum', async () => {
    const { app, db } = buildApp();
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    const res = await request(app).post('/api/aloha/m1/index/trigger').send({});

    const today = new Date().getDate();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.days).toBe(today);
    expect(res.body.skipped).toBe(0);
    expect(res.body.commandIds).toHaveLength(today);
  });

  it('segunda chamada pula dias já indexados — só reenfileira hoje', async () => {
    const { app, db } = buildApp();
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });

    const month = todayMonthKey();
    const today = new Date().getDate();
    // Marca todos os dias 1..today como já indexados (simula execução anterior completa).
    for (let d = 1; d <= today; d++) {
      db.markNFCeDayIndexed('m1', `${month}-${String(d).padStart(2, '0')}`, 1);
    }

    const res = await request(app).post('/api/aloha/m1/index/trigger').send({});

    expect(res.status).toBe(200);
    // Só o dia de hoje é reenfileirado — todos os outros (today-1) foram pulados.
    expect(res.body.days).toBe(1);
    expect(res.body.skipped).toBe(today - 1);
    expect(res.body.commandIds).toHaveLength(1);
  });

  it('dias indexados de uma loja não afetam o trigger de outra', async () => {
    const { app, db } = buildApp();
    db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });
    db.registerMachine({ machineId: 'm2', hostname: 'LOJA2BOH', agentVersion: '1.0' });

    const month = todayMonthKey();
    db.markNFCeDayIndexed('m1', `${month}-01`, 1);

    const res = await request(app).post('/api/aloha/m2/index/trigger').send({});

    const today = new Date().getDate();
    expect(res.body.days).toBe(today); // nada pulado pra m2
    expect(res.body.skipped).toBe(0);
  });
});
