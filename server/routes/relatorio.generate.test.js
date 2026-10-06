'use strict';

/**
 * Testes de auth + dedup do POST /api/relatorio/generate — endpoint que
 * dispara chamada paga à API da Anthropic + geração de DOCX/PDF.
 * Antes desta mudança, era público, sem nenhuma autenticação, e sem dedup
 * (POST repetido pra mesma loja+mês pagava a API de novo toda vez).
 */

const express = require('express');
const request = require('supertest');

jest.mock('../db', () => ({
  getRecentReportRun: jest.fn(() => null),
  saveReportRun:       jest.fn(() => 42),
  getTopics:           jest.fn(() => []),
}));

jest.mock('../services/freshdesk', () => ({
  syncIfStale: jest.fn(async () => {}),
}));

jest.mock('../services/reportEngine', () => ({
  buildStoreContext: jest.fn(() => ({ openTopics: [] })),
  callClaude:         jest.fn(async () => 'raw-ai-response'),
  parseClaudeScore:   jest.fn(() => ({
    score_total: 80, score_hardware: 80, score_software: 80, score_connectivity: 80,
    score_security: 80, score_incidents: 80, score_operational: 80,
    ai_narrative: 'tudo ok', ai_recommendations: [], inconclusivos: [],
  })),
  generateDocx: jest.fn(async () => '/tmp/relatorio_Loja_2026-10.docx'),
  generatePdf:  jest.fn(async () => '/tmp/relatorio_Loja_2026-10.pdf'),
}));

jest.mock('../services/nfce-mailer', () => ({
  sendSimpleEmail: jest.fn(async () => {}),
}));

function makeApp() {
  jest.resetModules();
  const router = require('./relatorio');
  const app = express();
  app.use(express.json());
  app.use('/api/relatorio', router);
  return app;
}

const ORIGINAL_ENV = process.env.INTERNAL_API_KEY;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = ORIGINAL_ENV;
});

describe('POST /api/relatorio/generate — auth', () => {
  it('401 sem header de auth', async () => {
    process.env.INTERNAL_API_KEY = 'segredo-123';
    const app = makeApp();
    const res = await request(app)
      .post('/api/relatorio/generate')
      .send({ store: 'Loja', month: '2026-10' });
    expect(res.status).toBe(401);
  });

  it('503 quando o servidor não tem INTERNAL_API_KEY configurada', async () => {
    delete process.env.INTERNAL_API_KEY;
    const app = makeApp();
    const res = await request(app)
      .post('/api/relatorio/generate')
      .send({ store: 'Loja', month: '2026-10' });
    expect(res.status).toBe(503);
  });

  it('400 quando falta store/month, mesmo com auth correta', async () => {
    process.env.INTERNAL_API_KEY = 'segredo-123';
    const app = makeApp();
    const res = await request(app)
      .post('/api/relatorio/generate')
      .set('x-internal-key', 'segredo-123')
      .send({ store: 'Loja' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/relatorio/generate — happy path e dedup', () => {
  it('gera normalmente e chama a API quando não há relatório recente', async () => {
    process.env.INTERNAL_API_KEY = 'segredo-123';
    const app = makeApp();
    const db = require('../db');
    const reportEngine = require('../services/reportEngine');
    db.getRecentReportRun.mockReturnValue(null);

    const res = await request(app)
      .post('/api/relatorio/generate')
      .set('x-internal-key', 'segredo-123')
      .send({ store: 'Loja', month: '2026-10' });

    expect(res.status).toBe(200);
    expect(reportEngine.callClaude).toHaveBeenCalledTimes(1);
    expect(res.body.cached).toBeFalsy();
  });

  it('2ª chamada pra mesma loja+mês dentro da janela NÃO chama a API de novo', async () => {
    process.env.INTERNAL_API_KEY = 'segredo-123';
    const app = makeApp();
    const db = require('../db');
    const reportEngine = require('../services/reportEngine');
    db.getRecentReportRun.mockReturnValue({
      id: 7, store_name: 'Loja', month: '2026-10', score_total: 80,
      docx_path: '/tmp/relatorio_Loja_2026-10.docx', pdf_path: '/tmp/relatorio_Loja_2026-10.pdf',
      ai_narrative: 'tudo ok', ai_recommendations: '[]',
    });

    const res = await request(app)
      .post('/api/relatorio/generate')
      .set('x-internal-key', 'segredo-123')
      .send({ store: 'Loja', month: '2026-10' });

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.runId).toBe(7);
    expect(reportEngine.callClaude).not.toHaveBeenCalled();
    // Mesmo shape do branch fresco — ai_recommendations sempre array, nunca a
    // string JSON crua da coluna (achado do review).
    expect(Array.isArray(res.body.scores.ai_recommendations)).toBe(true);
    expect(res.body.scores.score_total).toBe(80);
  });

  it('coluna ai_recommendations corrompida não derruba a resposta cacheada', async () => {
    process.env.INTERNAL_API_KEY = 'segredo-123';
    const app = makeApp();
    const db = require('../db');
    db.getRecentReportRun.mockReturnValue({
      id: 9, store_name: 'Loja', month: '2026-10', score_total: 80,
      docx_path: null, pdf_path: null,
      ai_narrative: 'tudo ok', ai_recommendations: '{not valid json',
    });

    const res = await request(app)
      .post('/api/relatorio/generate')
      .set('x-internal-key', 'segredo-123')
      .send({ store: 'Loja', month: '2026-10' });

    expect(res.status).toBe(200);
    expect(res.body.recommendations).toEqual([]);
  });
});
