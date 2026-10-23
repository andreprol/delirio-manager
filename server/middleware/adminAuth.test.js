'use strict';

const express = require('express');
const request = require('supertest');
const { adminAuth, safeSecretEqual } = require('./adminAuth');

function makeApp() {
  const app = express();
  app.get('/protegido', adminAuth, (req, res) => res.json({ ok: true }));
  return app;
}

const ORIGINAL_SECRET = process.env.ADMIN_SECRET;
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIGINAL_SECRET;
});

describe('adminAuth', () => {
  it('401 sem header', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const res = await request(makeApp()).get('/protegido');
    expect(res.status).toBe(401);
  });

  it('401 com header errado', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const res = await request(makeApp()).get('/protegido').set('x-admin-secret', 'errado');
    expect(res.status).toBe(401);
  });

  it('401 quando ADMIN_SECRET não está configurado', async () => {
    delete process.env.ADMIN_SECRET;
    const res = await request(makeApp()).get('/protegido').set('x-admin-secret', 'qualquer');
    expect(res.status).toBe(401);
  });

  it('200 com header correto', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const res = await request(makeApp()).get('/protegido').set('x-admin-secret', 'segredo-123');
    expect(res.status).toBe(200);
  });
});

describe('safeSecretEqual', () => {
  it('true pra strings iguais', () => {
    expect(safeSecretEqual('abc', 'abc')).toBe(true);
  });

  it('false pra strings diferentes, mesmo tamanho', () => {
    expect(safeSecretEqual('abc', 'abd')).toBe(false);
  });

  it('false pra strings de tamanho diferente, sem lançar erro', () => {
    expect(safeSecretEqual('abc', 'abcdef')).toBe(false);
  });

  it('false pra valores não-string', () => {
    expect(safeSecretEqual(null, 'abc')).toBe(false);
    expect(safeSecretEqual('abc', undefined)).toBe(false);
  });
});
