'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../db-pg', () => ({ getPool: jest.fn() }));
const { getPool } = require('../db-pg');

function makeApp() {
  const router = require('./healthz');
  const app = express();
  app.use('/api/healthz', router);
  return app;
}

describe('GET /api/healthz', () => {
  it('200 { ok: true } quando o Postgres responde', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) });
    const res = await request(makeApp()).get('/api/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('503 { ok: false, db: false } quando a query rejeita', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockRejectedValue(new Error('connection refused')) });
    const res = await request(makeApp()).get('/api/healthz');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.db).toBe(false);
  });

  it('503 quando a query demora mais que o timeout (nao trava a resposta)', async () => {
    getPool.mockReturnValue({
      query: jest.fn(() => new Promise(() => {})), // nunca resolve
    });
    const res = await request(makeApp()).get('/api/healthz');
    expect(res.status).toBe(503);
  }, 5000);
});
