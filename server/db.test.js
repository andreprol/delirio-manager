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

  it('cria watchlist_keywords, watchlist_matches, activity_log e live_sessions', () => {
    const { getDb } = require('./db');
    const db = getDb();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('watchlist_keywords','watchlist_matches','activity_log','live_sessions')
    `).all().map(r => r.name).sort();
    expect(tables).toEqual(['activity_log', 'live_sessions', 'watchlist_keywords', 'watchlist_matches']);
  });
});

describe('watchlist_keywords CRUD', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.DB_PATH = ':memory:';
  });

  afterEach(() => {
    delete process.env.DB_PATH;
  });

  it('cria, lista, desativa e deleta uma keyword', () => {
    const db = require('./db');
    const id = db.createWatchlistKeyword('vaga de emprego');

    let all = db.getWatchlistKeywords();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id, keyword: 'vaga de emprego', active: 1 });

    db.setWatchlistKeywordActive(id, false);
    all = db.getWatchlistKeywords();
    expect(all[0].active).toBe(0);

    const active = db.getActiveWatchlistKeywords();
    expect(active).toHaveLength(0);

    db.deleteWatchlistKeyword(id);
    expect(db.getWatchlistKeywords()).toHaveLength(0);
  });

  it('com duas keywords, lista na ordem DESC e a desativada sai do filtro de ativas', () => {
    const db = require('./db');
    const antigaId = db.createWatchlistKeyword('primeira');
    const novaId = db.createWatchlistKeyword('segunda');

    db.setWatchlistKeywordActive(antigaId, false);

    const all = db.getWatchlistKeywords();
    expect(all.map(k => k.id)).toEqual([novaId, antigaId]);
    expect(all.map(k => k.active)).toEqual([1, 0]);

    const active = db.getActiveWatchlistKeywords();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: novaId, keyword: 'segunda', active: 1 });
  });
});
