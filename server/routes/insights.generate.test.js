'use strict';

/**
 * Testes de auth do POST /api/insights/generate — endpoint que dispara
 * reanálise de todas as máquinas (chamada paga à API da Anthropic).
 * Antes desta mudança, era público e sem nenhuma autenticação.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../db', () => ({
  getInsights:     jest.fn(() => []),
  markInsightRead: jest.fn(),
}));

jest.mock('../services/insightEngine', () => ({
  runNow: jest.fn(async () => 3),
}));

function makeApp() {
  jest.resetModules();
  const router = require('./insights');
  const app = express();
  app.use(express.json());
  app.use('/api/insights', router);
  return app;
}

const ORIGINAL_ENV = process.env.INTERNAL_API_KEY;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = ORIGINAL_ENV;
});

describe('POST /api/insights/generate', () => {
  it('401 sem header de auth', async () => {
    process.env.INTERNAL_API_KEY = 'segredo-123';
    const app = makeApp();
    const res = await request(app).post('/api/insights/generate');
    expect(res.status).toBe(401);
  });

  it('503 quando o servidor não tem INTERNAL_API_KEY configurada', async () => {
    delete process.env.INTERNAL_API_KEY;
    const app = makeApp();
    const res = await request(app).post('/api/insights/generate');
    expect(res.status).toBe(503);
  });

  it('200 e dispara runNow() com header correto', async () => {
    process.env.INTERNAL_API_KEY = 'segredo-123';
    const app = makeApp();
    const insightEngine = require('../services/insightEngine');

    const res = await request(app)
      .post('/api/insights/generate')
      .set('x-internal-key', 'segredo-123');

    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(3);
    expect(insightEngine.runNow).toHaveBeenCalledTimes(1);
  });

  it('GET /api/insights continua público (leitura, sem custo)', async () => {
    delete process.env.INTERNAL_API_KEY;
    const app = makeApp();
    const res = await request(app).get('/api/insights');
    expect(res.status).toBe(200);
  });
});
