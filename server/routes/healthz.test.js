'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../db-pg', () => ({ getPool: jest.fn() }));
jest.mock('../services/leaderElection', () => ({ isLeader: jest.fn() }));
const { getPool } = require('../db-pg');
const { isLeader } = require('../services/leaderElection');

function makeApp() {
  const router = require('./healthz');
  const app = express();
  app.use('/api/healthz', router);
  return app;
}

describe('GET /api/healthz', () => {
  it('200 { ok: true, leader: true } quando o Postgres responde e a instancia e lider', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) });
    isLeader.mockReturnValue(true);
    const res = await request(makeApp()).get('/api/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, leader: true });
  });

  it('200 { ok: true, leader: false } quando a instancia nao e lider', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) });
    isLeader.mockReturnValue(false);
    const res = await request(makeApp()).get('/api/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, leader: false });
  });

  it('503 { ok: false, db: false } quando a query rejeita (leader presente mesmo com DB fora)', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockRejectedValue(new Error('connection refused')) });
    isLeader.mockReturnValue(true);
    const res = await request(makeApp()).get('/api/healthz');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.db).toBe(false);
    expect(res.body.leader).toBe(true);
  });

  it('503 quando a query demora mais que o timeout (nao trava a resposta)', async () => {
    getPool.mockReturnValue({
      query: jest.fn(() => new Promise(() => {})), // nunca resolve
    });
    const res = await request(makeApp()).get('/api/healthz');
    expect(res.status).toBe(503);
  }, 5000);
});
