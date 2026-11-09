'use strict';

/**
 * Testes de POST /api/aloha/nfce/:chave/whatsapp — envio manual da DANFE por
 * WhatsApp (botão no dashboard). DB :memory: real; mocka só a geração de PDF
 * e o serviço de envio (sem bater em rede de verdade).
 */

const express = require('express');
const request = require('supertest');

let app, db, sendDanfeWhatsapp;

beforeEach(() => {
  jest.resetModules();
  process.env.DB_PATH = ':memory:';
  jest.doMock('../services/danfe', () => ({ generateDanfePdf: jest.fn(() => Promise.resolve(Buffer.from('%PDF-fake'))) }));
  jest.doMock('../services/nfce-whatsapp', () => ({
    sendDanfeWhatsapp: jest.fn(() => Promise.resolve()),
    normalizePhone:    jest.requireActual('../services/nfce-whatsapp').normalizePhone,
  }));

  db = require('../db');
  ({ sendDanfeWhatsapp } = require('../services/nfce-whatsapp'));
  const router = require('./aloha');

  app = express();
  app.use(express.json());
  app.use('/api/aloha', router);

  db.registerMachine({ machineId: 'm1', hostname: 'LOJA1BOH', agentVersion: '1.0' });
  db.upsertNFCeRecords('m1', [{ chave: 'chave-abc', n_nf: 123, dh_emi: '2026-11-09T10:00:00', v_nf: 50, danfe: { nNF: '123' } }]);
});

afterEach(() => {
  delete process.env.DB_PATH;
});

describe('POST /api/aloha/nfce/:chave/whatsapp', () => {
  it('400 sem machineId ou toPhone', async () => {
    const res = await request(app).post('/api/aloha/nfce/chave-abc/whatsapp').send({ machineId: 'm1' });
    expect(res.status).toBe(400);
    expect(sendDanfeWhatsapp).not.toHaveBeenCalled();
  });

  it('400 quando toPhone não é um número válido (sem bater no serviço)', async () => {
    const res = await request(app).post('/api/aloha/nfce/chave-abc/whatsapp')
      .send({ machineId: 'm1', toPhone: '123' });
    expect(res.status).toBe(400);
    expect(sendDanfeWhatsapp).not.toHaveBeenCalled();
  });

  it('404 quando a NF-Ce não existe', async () => {
    const res = await request(app).post('/api/aloha/nfce/inexistente/whatsapp')
      .send({ machineId: 'm1', toPhone: '21998765432' });
    expect(res.status).toBe(404);
  });

  it('gera o PDF e envia via WhatsApp com sucesso', async () => {
    const res = await request(app).post('/api/aloha/nfce/chave-abc/whatsapp')
      .send({ machineId: 'm1', toPhone: '21998765432', customerName: 'Maria' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sendDanfeWhatsapp).toHaveBeenCalledWith(expect.objectContaining({
      toPhone: '21998765432', customerName: 'Maria',
    }));
  });

  it('500 quando o envio falha, com a mensagem de erro', async () => {
    sendDanfeWhatsapp.mockRejectedValueOnce(new Error('Erro ao enviar DANFE via WhatsApp: template rejeitado'));

    const res = await request(app).post('/api/aloha/nfce/chave-abc/whatsapp')
      .send({ machineId: 'm1', toPhone: '21998765432' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('template rejeitado');
  });
});
