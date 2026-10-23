'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../db', () => ({
  getMachineByToken:          jest.fn(),
  insertActivityLog:          jest.fn(() => ({ id: 42, capturedAt: '2026-10-23T12:00:00.000Z' })),
  getActiveWatchlistKeywords: jest.fn(() => []),
  createCommand:              jest.fn(() => 'cmd-id-1'),
}));

function makeApp() {
  const router = require('./activity');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

describe('POST /api/activity', () => {
  it('401 sem header Authorization', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/activity')
      .send({ windowTitle: 'Chrome', processName: 'chrome.exe' });
    expect(res.status).toBe(401);
  });

  it('401 com token inválido', async () => {
    const db = require('../db');
    db.getMachineByToken.mockReturnValue(null);
    const app = makeApp();
    const res = await request(app).post('/api/activity')
      .set('Authorization', 'Bearer tok-invalido')
      .send({ windowTitle: 'Chrome', processName: 'chrome.exe' });
    expect(res.status).toBe(401);
  });

  it('400 quando windowTitle ou processName não são string', async () => {
    const db = require('../db');
    db.getMachineByToken.mockReturnValue({ id: 'm1' });
    db.insertActivityLog.mockClear();
    const app = makeApp();
    const res = await request(app).post('/api/activity')
      .set('Authorization', 'Bearer tok')
      .send({ windowTitle: 123, processName: 'chrome.exe' });
    expect(res.status).toBe(400);
    expect(db.insertActivityLog).not.toHaveBeenCalled();
  });

  it('salva o log e não dispara comando quando não bate watchlist', async () => {
    const db = require('../db');
    db.getMachineByToken.mockReturnValue({ id: 'm1' });
    db.getActiveWatchlistKeywords.mockReturnValue([{ id: 1, keyword: 'vaga' }]);
    db.createCommand.mockClear();
    const app = makeApp();

    const res = await request(app).post('/api/activity')
      .set('Authorization', 'Bearer tok')
      .send({ windowTitle: 'Excel', processName: 'EXCEL.EXE' });

    expect(res.status).toBe(200);
    expect(db.insertActivityLog).toHaveBeenCalledWith('m1', 'Excel', 'EXCEL.EXE');
    expect(db.createCommand).not.toHaveBeenCalled();
  });

  it('dispara capture-screenshot quando bate a watchlist', async () => {
    const db = require('../db');
    db.getMachineByToken.mockReturnValue({ id: 'm1' });
    db.getActiveWatchlistKeywords.mockReturnValue([{ id: 1, keyword: 'vaga' }]);
    const app = makeApp();

    const res = await request(app).post('/api/activity')
      .set('Authorization', 'Bearer tok')
      .send({ windowTitle: 'Vagas - LinkedIn', processName: 'chrome.exe' });

    expect(res.status).toBe(200);
    expect(db.createCommand).toHaveBeenCalledWith('m1', 'capture-screenshot', { activityLogId: 42 });
  });
});
