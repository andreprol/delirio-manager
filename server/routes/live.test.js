'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../db', () => ({
  getMachineById:      jest.fn(),
  createLiveSession:   jest.fn(() => 'session-1'),
  getLiveSession:      jest.fn(),
  endLiveSession:      jest.fn(),
  setLiveSessionRecorded: jest.fn(),
  createCommand:       jest.fn(() => 'cmd-1'),
}));

jest.mock('../services/liveSessionRelay', () => ({
  registerSession:   jest.fn(),
  unregisterSession: jest.fn(),
  getSession:        jest.fn(),
}));

jest.mock('../services/blobSas', () => ({
  generateFileTransferUrls: jest.fn(),
  MAX_FILE_BYTES: 2 * 1024 * 1024 * 1024,
}));

function makeApp() {
  const router = require('./live');
  const app = express();
  app.use(express.json());
  app.use('/api/live', router);
  return app;
}

const ORIGINAL_SECRET = process.env.ADMIN_SECRET;
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIGINAL_SECRET;
});

describe('POST /api/live/:machineId/start', () => {
  it('401 sem X-Admin-Secret', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const app = makeApp();
    const res = await request(app).post('/api/live/m1/start').send({ mode: 'shadow' });
    expect(res.status).toBe(401);
  });

  it('400 com mode inválido', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const db = require('../db');
    db.getMachineById.mockReturnValue({ id: 'm1' });
    const app = makeApp();
    const res = await request(app).post('/api/live/m1/start')
      .set('x-admin-secret', 'segredo-123')
      .send({ mode: 'turbo' });
    expect(res.status).toBe(400);
  });

  it('404 quando a máquina não existe', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const db = require('../db');
    db.getMachineById.mockReturnValue(null);
    const app = makeApp();
    const res = await request(app).post('/api/live/m1/start')
      .set('x-admin-secret', 'segredo-123')
      .send({ mode: 'shadow' });
    expect(res.status).toBe(404);
  });

  it('200, cria sessão, registra os dois tokens no relay, manda só o companionToken pro agente, e devolve só o dashboardToken na resposta', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const db = require('../db');
    const relay = require('../services/liveSessionRelay');
    db.getMachineById.mockReturnValue({ id: 'm1' });
    const app = makeApp();

    const res = await request(app).post('/api/live/m1/start')
      .set('x-admin-secret', 'segredo-123')
      .send({ mode: 'normal' });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('session-1');
    expect(res.body.mode).toBe('normal');
    expect(typeof res.body.dashboardToken).toBe('string');
    expect(res.body.dashboardToken.length).toBeGreaterThan(0);
    expect(res.body.companionToken).toBeUndefined();

    expect(relay.registerSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
      machineId: 'm1', mode: 'normal',
      companionToken: expect.any(String),
      dashboardToken: res.body.dashboardToken,
    }));

    const [, cmdType, cmdParams] = db.createCommand.mock.calls[0];
    expect(cmdType).toBe('start-live-session');
    expect(cmdParams.sessionId).toBe('session-1');
    expect(cmdParams.mode).toBe('normal');
    expect(typeof cmdParams.companionToken).toBe('string');
    expect(cmdParams.companionToken.length).toBeGreaterThan(0);
    expect(cmdParams.dashboardToken).toBeUndefined();
  });
});

describe('POST /api/live/:sessionId/file/upload-url', () => {
  it('401 sem X-Admin-Secret', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const app = makeApp();
    const res = await request(app)
      .post('/api/live/s1/file/upload-url')
      .send({ fileName: 'a.txt', fileSize: 100 });
    expect(res.status).toBe(401);
  });

  it('400 sem fileName ou fileSize', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const app = makeApp();
    const res = await request(app)
      .post('/api/live/s1/file/upload-url')
      .set('x-admin-secret', 'segredo-123')
      .send({ fileName: 'a.txt' });
    expect(res.status).toBe(400);
  });

  it('200 com uploadUrl/downloadUrl quando tudo ok', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const blobSas = require('../services/blobSas');
    blobSas.generateFileTransferUrls.mockReturnValue({
      uploadUrl: 'https://acc.blob.core.windows.net/live-transfer/x?sas',
      downloadUrl: 'https://acc.blob.core.windows.net/live-transfer/x?sas2',
      blobName: 'x',
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/live/s1/file/upload-url')
      .set('x-admin-secret', 'segredo-123')
      .send({ fileName: 'instalador.exe', fileSize: 12345 });
    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toContain('live-transfer');
    expect(res.body.downloadUrl).toContain('live-transfer');
  });

  it('400 quando o arquivo passa do limite (validado ANTES de chamar blobSas)', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const blobSas = require('../services/blobSas');
    blobSas.generateFileTransferUrls.mockClear();
    const app = makeApp();
    const res = await request(app)
      .post('/api/live/s1/file/upload-url')
      .set('x-admin-secret', 'segredo-123')
      .send({ fileName: 'enorme.iso', fileSize: 999999999999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2GB/);
    expect(blobSas.generateFileTransferUrls).not.toHaveBeenCalled();
  });

  it('500 quando blobSas lança erro inesperado (ex: config ausente)', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const blobSas = require('../services/blobSas');
    blobSas.generateFileTransferUrls.mockImplementation(() => {
      throw new Error('blobStorage não configurado em config.json (accountName/accountKey)');
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/live/s1/file/upload-url')
      .set('x-admin-secret', 'segredo-123')
      .send({ fileName: 'a.txt', fileSize: 1000 });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/live/:sessionId/stop', () => {
  it('404 quando a sessão não existe', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const db = require('../db');
    db.getLiveSession.mockReturnValue(null);
    const app = makeApp();
    const res = await request(app).post('/api/live/session-x/stop')
      .set('x-admin-secret', 'segredo-123')
      .send({});
    expect(res.status).toBe(404);
  });

  it('200, encerra sessão e envia comando de stop', async () => {
    process.env.ADMIN_SECRET = 'segredo-123';
    const db = require('../db');
    db.getLiveSession.mockReturnValue({ id: 'session-1', machine_id: 'm1', ended_at: null });
    const app = makeApp();

    const res = await request(app).post('/api/live/session-1/stop')
      .set('x-admin-secret', 'segredo-123')
      .send({ recorded: true });

    expect(res.status).toBe(200);
    expect(db.setLiveSessionRecorded).toHaveBeenCalledWith('session-1');
    expect(db.endLiveSession).toHaveBeenCalledWith('session-1');
    expect(db.createCommand).toHaveBeenCalledWith('m1', 'stop-live-session', { sessionId: 'session-1' });
  });
});
