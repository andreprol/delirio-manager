'use strict';

/**
 * Testes de claimAutoEmail/markAutoEmailSent/markAutoEmailFailed — a trava
 * anti-duplicata do auto-envio de DANFE por e-mail. DB :memory: real (mesmo
 * padrão dos demais db.*.test.js).
 */

beforeEach(() => {
  jest.resetModules();
  process.env.DB_PATH = ':memory:';
});

afterEach(() => {
  delete process.env.DB_PATH;
});

describe('claimAutoEmail', () => {
  it('primeira chamada pra uma chave ganha a reivindicação (true)', () => {
    const db = require('./db');
    expect(db.claimAutoEmail('chave-1', 'm1', 'cliente@teste.com')).toBe(true);
  });

  it('segunda chamada pra MESMA chave não ganha (false) — trava anti-duplicata', () => {
    const db = require('./db');
    db.claimAutoEmail('chave-1', 'm1', 'cliente@teste.com');
    expect(db.claimAutoEmail('chave-1', 'm1', 'cliente@teste.com')).toBe(false);
  });

  it('chaves diferentes não interferem entre si', () => {
    const db = require('./db');
    expect(db.claimAutoEmail('chave-1', 'm1', 'a@teste.com')).toBe(true);
    expect(db.claimAutoEmail('chave-2', 'm1', 'b@teste.com')).toBe(true);
  });

  it('grava status pending e email_to na primeira reivindicação', () => {
    const db = require('./db');
    db.claimAutoEmail('chave-1', 'm1', 'cliente@teste.com');
    const row = db.getDb().prepare('SELECT * FROM nfce_auto_email_log WHERE chave=?').get('chave-1');
    expect(row.status).toBe('pending');
    expect(row.email_to).toBe('cliente@teste.com');
    expect(row.machine_id).toBe('m1');
  });
});

describe('markAutoEmailSent / markAutoEmailFailed', () => {
  it('marca sent com sent_at preenchido', () => {
    const db = require('./db');
    db.claimAutoEmail('chave-1', 'm1', 'cliente@teste.com');
    db.markAutoEmailSent('chave-1');
    const row = db.getDb().prepare('SELECT * FROM nfce_auto_email_log WHERE chave=?').get('chave-1');
    expect(row.status).toBe('sent');
    expect(row.sent_at).not.toBeNull();
  });

  it('marca failed com a mensagem de erro', () => {
    const db = require('./db');
    db.claimAutoEmail('chave-1', 'm1', 'cliente@teste.com');
    db.markAutoEmailFailed('chave-1', 'Erro ao enviar email via Graph: 500');
    const row = db.getDb().prepare('SELECT * FROM nfce_auto_email_log WHERE chave=?').get('chave-1');
    expect(row.status).toBe('failed');
    expect(row.error).toContain('Erro ao enviar email via Graph');
  });

  it('mesmo depois de failed, uma segunda reivindicação continua bloqueada (não reenvia sozinho)', () => {
    const db = require('./db');
    db.claimAutoEmail('chave-1', 'm1', 'cliente@teste.com');
    db.markAutoEmailFailed('chave-1', 'timeout');
    expect(db.claimAutoEmail('chave-1', 'm1', 'cliente@teste.com')).toBe(false);
  });
});
