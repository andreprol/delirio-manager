'use strict';

/**
 * Testes de POST /api/aloha/nfce/:chave/whatsapp — envio manual da DANFE por
 * WhatsApp (botão no dashboard). Postgres real (ver aloha.test.js); mocka só
 * a geração de PDF e o serviço de envio (sem bater em rede de verdade).
 */

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

let app, db, sendDanfeWhatsapp;
let machineId, chave;
const createdMachineIds = [];

beforeAll(() => {
  if (!hasDb) return;
  jest.resetModules();
  jest.doMock('../services/danfe', () => ({ generateDanfePdf: jest.fn(() => Promise.resolve(Buffer.from('%PDF-fake'))) }));
  jest.doMock('../services/nfce-whatsapp', () => ({
    sendDanfeWhatsapp: jest.fn(() => Promise.resolve()),
    normalizePhone:    jest.requireActual('../services/nfce-whatsapp').normalizePhone,
  }));

  db = require('../db-pg');
  ({ sendDanfeWhatsapp } = require('../services/nfce-whatsapp'));
  const router = require('./aloha');

  app = express();
  app.use(express.json());
  app.use('/api/aloha', router);
});

beforeEach(async () => {
  if (!hasDb) return;
  sendDanfeWhatsapp.mockClear();
  machineId = crypto.randomUUID();
  createdMachineIds.push(machineId);
  chave = `chave-${crypto.randomUUID()}`;
  // hostname único por teste (não fixo): hostname repetido bate no caminho de
  // re-key assíncrono de registerMachine (Task 4) -- machines.id só troca
  // pro machineId novo quando o worker (Fase B, fora deste teste) processar
  // a fila, então o INSERT em nfce_index abaixo, que usa machineId direto,
  // violaria a FK enquanto ainda não trocou. Hostname novo a cada teste
  // garante o caminho "máquina genuinamente nova" (síncrono).
  await db.registerMachine({ machineId, hostname: `LOJA1BOH-${machineId.slice(0, 8)}`, agentVersion: '1.0' });
  await db.upsertNFCeRecords(machineId, [{ chave, n_nf: 123, dh_emi: '2026-11-09T10:00:00', v_nf: 50, danfe: { nNF: '123' } }]);
});

afterAll(async () => {
  if (!hasDb) return;
  const pool = db.getPool();
  if (createdMachineIds.length) {
    await pool.query('DELETE FROM machines WHERE id = ANY($1)', [createdMachineIds]);
  }
  await db.closePool();
});

describeDb('POST /api/aloha/nfce/:chave/whatsapp', () => {
  it('400 sem machineId ou toPhone', async () => {
    const res = await request(app).post(`/api/aloha/nfce/${chave}/whatsapp`).send({ machineId });
    expect(res.status).toBe(400);
    expect(sendDanfeWhatsapp).not.toHaveBeenCalled();
  });

  it('400 quando toPhone não é um número válido (sem bater no serviço)', async () => {
    const res = await request(app).post(`/api/aloha/nfce/${chave}/whatsapp`)
      .send({ machineId, toPhone: '123' });
    expect(res.status).toBe(400);
    expect(sendDanfeWhatsapp).not.toHaveBeenCalled();
  });

  it('404 quando a NF-Ce não existe', async () => {
    const res = await request(app).post('/api/aloha/nfce/inexistente/whatsapp')
      .send({ machineId, toPhone: '21998765432' });
    expect(res.status).toBe(404);
  });

  it('gera o PDF e envia via WhatsApp com sucesso', async () => {
    const res = await request(app).post(`/api/aloha/nfce/${chave}/whatsapp`)
      .send({ machineId, toPhone: '21998765432', customerName: 'Maria' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sendDanfeWhatsapp).toHaveBeenCalledWith(expect.objectContaining({
      toPhone: '21998765432', customerName: 'Maria',
    }));
  });

  it('500 quando o envio falha, com a mensagem de erro', async () => {
    sendDanfeWhatsapp.mockRejectedValueOnce(new Error('Erro ao enviar DANFE via WhatsApp: template rejeitado'));

    const res = await request(app).post(`/api/aloha/nfce/${chave}/whatsapp`)
      .send({ machineId, toPhone: '21998765432' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('template rejeitado');
  });
});
