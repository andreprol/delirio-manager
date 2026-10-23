'use strict';

/**
 * Confirma que a migração cria as tabelas de acesso remoto.
 * Usa DB :memory: (mesmo padrão dos demais db.*.test.js) para não travar
 * o arquivo no Windows ao limpar no afterAll.
 */

beforeEach(() => {
  jest.resetModules();
  process.env.DB_PATH = ':memory:';
});

afterEach(() => {
  delete process.env.DB_PATH;
});

describe('migração de schema — acesso remoto', () => {
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

describe('activity_log', () => {
  function insertTestMachine(db, id) {
    const now = new Date().toISOString();
    db.getDb().prepare(`
      INSERT INTO machines (id, hostname, token, registered_at)
      VALUES (?, 'TESTE', ?, ?)
    `).run(id, 'token-' + id, now);
  }

  it('insere e lista por máquina, mais recente primeiro', () => {
    const db = require('./db');
    insertTestMachine(db, 'm1');

    db.insertActivityLog('m1', 'Excel - planilha.xlsx', 'EXCEL.EXE');
    db.insertActivityLog('m1', 'Vagas - LinkedIn', 'chrome.exe');

    const rows = db.getActivityLog('m1', 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].window_title).toBe('Vagas - LinkedIn');
    expect(rows[1].window_title).toBe('Excel - planilha.xlsx');
  });

  it('purgeActivityLog remove linhas mais antigas que N dias', () => {
    const db = require('./db');
    insertTestMachine(db, 'm2');
    const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.getDb().prepare(
      'INSERT INTO activity_log (machine_id, window_title, process_name, captured_at) VALUES (?,?,?,?)'
    ).run('m2', 'janela antiga', 'app.exe', oldTs);
    db.insertActivityLog('m2', 'janela recente', 'app.exe');

    const removed = db.purgeActivityLog(90);
    expect(removed).toBe(1);
    expect(db.getActivityLog('m2', 10)).toHaveLength(1);
  });
});
