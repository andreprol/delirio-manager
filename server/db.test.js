'use strict';

/**
 * Confirma que a migração cria as tabelas de acesso remoto.
 * Usa DB :memory: (mesmo padrão dos demais db.*.test.js) para não travar
 * o arquivo no Windows ao limpar no afterAll.
 */

describe('migração de schema — acesso remoto', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.DB_PATH = ':memory:';
  });

  afterEach(() => {
    delete process.env.DB_PATH;
  });

  it('cria watchlist_keywords, activity_log e live_sessions', () => {
    const { getDb } = require('./db');
    const db = getDb();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('watchlist_keywords','activity_log','live_sessions')
    `).all().map(r => r.name).sort();
    expect(tables).toEqual(['activity_log', 'live_sessions', 'watchlist_keywords']);
  });
});
