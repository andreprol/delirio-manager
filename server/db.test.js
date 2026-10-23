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

  it('purgeActivityLog com days <= 0 não remove nada', () => {
    const db = require('./db');
    insertTestMachine(db, 'm3');
    db.insertActivityLog('m3', 'janela', 'app.exe');

    expect(db.purgeActivityLog(0)).toBe(0);
    expect(db.purgeActivityLog(-5)).toBe(0);
    expect(db.getActivityLog('m3', 10)).toHaveLength(1);
  });

  it('getActivityLog com limit inválido cai no default de 100', () => {
    const db = require('./db');
    insertTestMachine(db, 'm4');
    db.insertActivityLog('m4', 'janela', 'app.exe');

    expect(db.getActivityLog('m4', -1)).toHaveLength(1);
    expect(db.getActivityLog('m4', 0)).toHaveLength(1);
  });
});

describe('live_sessions', () => {
  function insertTestMachine(db, id) {
    const now = new Date().toISOString();
    db.getDb().prepare(`
      INSERT INTO machines (id, hostname, token, registered_at)
      VALUES (?, 'TESTE', ?, ?)
    `).run(id, 'token-' + id, now);
  }

  it('cria, encerra e marca gravação', () => {
    const db = require('./db');
    insertTestMachine(db, 'm3');

    const sessionId = db.createLiveSession('m3', 'shadow');
    expect(typeof sessionId).toBe('string');

    let session = db.getLiveSession(sessionId);
    expect(session.mode).toBe('shadow');
    expect(session.ended_at).toBeNull();

    db.setLiveSessionRecorded(sessionId);
    db.endLiveSession(sessionId);

    session = db.getLiveSession(sessionId);
    expect(session.recorded).toBe(1);
    expect(session.ended_at).not.toBeNull();
  });

  it('rejeita mode inválido sem inserir linha', () => {
    const db = require('./db');
    insertTestMachine(db, 'm4');
    expect(() => db.createLiveSession('m4', 'invalido')).toThrow(/mode inválido/);
    const rows = db.getDb().prepare('SELECT COUNT(*) AS c FROM live_sessions WHERE machine_id = ?').get('m4');
    expect(rows.c).toBe(0);
  });
});

describe('registerMachine — re-key não deixa watchlist_matches órfão', () => {
  it('deleta watchlist_matches junto quando a máquina duplicada (dupe) é removida', () => {
    const db = require('./db');
    const rawDb = db.getDb();
    const now = new Date().toISOString();

    // canonical: será preservado (re-keyed pro novo UUID)
    rawDb.prepare(`
      INSERT INTO machines (id, hostname, location, token, registered_at, last_seen)
      VALUES ('canonical-id', 'DUPTEST', 'Loja X', 'tok-canonical', ?, ?)
    `).run(now, now);

    // dupe: será deletado — tem activity_log + watchlist_matches vinculados
    rawDb.prepare(`
      INSERT INTO machines (id, hostname, location, token, registered_at, last_seen)
      VALUES ('dupe-id', 'DUPTEST', 'Temporário', 'tok-dupe', ?, ?)
    `).run(now, now);

    const { id: activityLogId } = db.insertActivityLog('dupe-id', 'Vagas - LinkedIn', 'chrome.exe');
    rawDb.prepare(`
      INSERT INTO watchlist_matches (activity_log_id, keyword, matched_at)
      VALUES (?, 'vaga', ?)
    `).run(activityLogId, now);

    db.registerMachine({ machineId: 'novo-uuid', hostname: 'DUPTEST', agentVersion: '1.0' });

    // dupe-id foi removido (re-key preservou o canonical sob o novo UUID)
    const dupeRow = rawDb.prepare('SELECT id FROM machines WHERE id = ?').get('dupe-id');
    expect(dupeRow).toBeUndefined();

    // watchlist_matches não pode sobrar órfão apontando pro activity_log deletado
    const orphan = rawDb.prepare('SELECT * FROM watchlist_matches WHERE activity_log_id = ?').get(activityLogId);
    expect(orphan).toBeUndefined();
  });
});
