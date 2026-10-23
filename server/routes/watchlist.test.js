'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../db', () => ({
  getWatchlistKeywords:      jest.fn(() => []),
  createWatchlistKeyword:    jest.fn(() => 1),
  setWatchlistKeywordActive: jest.fn(),
  deleteWatchlistKeyword:    jest.fn(),
}));

function makeApp() {
  const router = require('./watchlist');
  const app = express();
  app.use(express.json());
  app.use('/api/watchlist', router);
  return app;
}

describe('GET /api/watchlist', () => {
  it('lista as keywords', async () => {
    const db = require('../db');
    db.getWatchlistKeywords.mockReturnValue([{ id: 1, keyword: 'vaga', active: 1 }]);
    const app = makeApp();
    const res = await request(app).get('/api/watchlist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, keyword: 'vaga', active: 1 }]);
  });
});

describe('POST /api/watchlist', () => {
  it('400 quando keyword vazia', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/watchlist').send({ keyword: '   ' });
    expect(res.status).toBe(400);
  });

  it('400 e não cria quando keyword não é string', async () => {
    const db = require('../db');
    db.createWatchlistKeyword.mockClear();
    const app = makeApp();
    const res = await request(app).post('/api/watchlist').send({ keyword: 123 });
    expect(res.status).toBe(400);
    expect(db.createWatchlistKeyword).not.toHaveBeenCalled();
  });

  it('201 e cria a keyword quando válida', async () => {
    const db = require('../db');
    const app = makeApp();
    const res = await request(app).post('/api/watchlist').send({ keyword: 'vaga de emprego' });
    expect(res.status).toBe(201);
    expect(db.createWatchlistKeyword).toHaveBeenCalledWith('vaga de emprego');
  });
});

describe('PUT /api/watchlist/:id', () => {
  it('ativa/desativa a keyword', async () => {
    const db = require('../db');
    const app = makeApp();
    const res = await request(app).put('/api/watchlist/1').send({ active: false });
    expect(res.status).toBe(200);
    expect(db.setWatchlistKeywordActive).toHaveBeenCalledWith('1', false);
  });
});

describe('DELETE /api/watchlist/:id', () => {
  it('remove a keyword', async () => {
    const db = require('../db');
    const app = makeApp();
    const res = await request(app).delete('/api/watchlist/1');
    expect(res.status).toBe(200);
    expect(db.deleteWatchlistKeyword).toHaveBeenCalledWith('1');
  });
});
