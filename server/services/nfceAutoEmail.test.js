'use strict';

/**
 * Testes de nfceAutoEmail.js — auto-envio de DANFE por e-mail pra notas
 * novas (encomendas = sempre vêm com e-mail; balcão = raro, mas se vier,
 * também envia). Cobre: validação de e-mail, corte de data (nunca retroativo)
 * e a trava anti-duplicata (claim), sem bater em rede de verdade.
 *
 * jest.resetModules() em cada teste (pra _cutoffCache do módulo nunca vazar
 * de um teste pro outro) exige requerer tudo de novo DEPOIS do reset —
 * requerer no topo do arquivo prenderia o teste num mock de 'fs' já obsoleto.
 */

function freshModule(configOverride) {
  jest.resetModules();
  jest.mock('fs');
  jest.mock('../db', () => ({
    claimAutoEmail:      jest.fn(() => true),
    markAutoEmailSent:   jest.fn(),
    markAutoEmailFailed: jest.fn(),
  }));
  jest.mock('./danfe', () => ({ generateDanfePdf: jest.fn(() => Promise.resolve(Buffer.from('%PDF-fake'))) }));
  jest.mock('./nfce-mailer', () => ({ sendDanfeEmail: jest.fn(() => Promise.resolve()) }));

  const fs = require('fs');
  fs.readFileSync.mockReturnValue(configOverride ? JSON.stringify(configOverride) : '{}');
  fs.writeFileSync.mockImplementation(() => {});

  return {
    fs,
    db: require('../db'),
    generateDanfePdf: require('./danfe').generateDanfePdf,
    sendDanfeEmail:   require('./nfce-mailer').sendDanfeEmail,
    ...require('./nfceAutoEmail'),
  };
}

function baseRecord(overrides = {}) {
  return {
    chave: 'chave-abc',
    danfe: {
      dhEmi: '2099-01-01T10:00:00-03:00', // bem no futuro, sempre depois de qualquer cutoff
      dest: { email: 'cliente@teste.com' },
    },
    ...overrides,
  };
}

describe('isValidEmail', () => {
  it('aceita e-mails válidos', () => {
    const { isValidEmail } = freshModule();
    expect(isValidEmail('cliente@teste.com')).toBe(true);
    expect(isValidEmail('a.b+c@sub.dominio.com.br')).toBe(true);
  });

  it('rejeita formatos inválidos ou ausentes', () => {
    const { isValidEmail } = freshModule();
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail('sem-arroba')).toBe(false);
    expect(isValidEmail('sem-dominio@')).toBe(false);
  });
});

describe('getCutoffAt', () => {
  it('primeira chamada grava no config.json e retorna "agora"', () => {
    const { getCutoffAt, fs } = freshModule();
    const before = Date.now();
    const cutoff = getCutoffAt();
    expect(new Date(cutoff).getTime()).toBeGreaterThanOrEqual(before);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('reusa o valor já persistido no config.json, sem reescrever', () => {
    const { getCutoffAt, fs } = freshModule({ nfceAutoEmail: { cutoffAt: '2026-01-01T00:00:00.000Z' } });
    expect(getCutoffAt()).toBe('2026-01-01T00:00:00.000Z');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('maybeAutoSendDanfe — elegibilidade', () => {
  it('nota sem e-mail — não reivindica nem envia', async () => {
    const { maybeAutoSendDanfe, db, sendDanfeEmail } = freshModule();
    await maybeAutoSendDanfe('m1', baseRecord({ danfe: { dhEmi: '2099-01-01T10:00:00-03:00', dest: {} } }));
    expect(db.claimAutoEmail).not.toHaveBeenCalled();
    expect(sendDanfeEmail).not.toHaveBeenCalled();
  });

  it('e-mail malformado — não reivindica nem envia', async () => {
    const { maybeAutoSendDanfe, db } = freshModule();
    await maybeAutoSendDanfe('m1', baseRecord({ danfe: { dhEmi: '2099-01-01T10:00:00-03:00', dest: { email: 'invalido' } } }));
    expect(db.claimAutoEmail).not.toHaveBeenCalled();
  });

  it('nota emitida ANTES do corte — nunca envia, mesmo com e-mail válido', async () => {
    const { maybeAutoSendDanfe, db } = freshModule({ nfceAutoEmail: { cutoffAt: '2026-11-09T00:00:00.000Z' } });
    await maybeAutoSendDanfe('m1', baseRecord({
      danfe: { dhEmi: '2026-01-01T10:00:00-03:00', dest: { email: 'cliente@teste.com' } },
    }));
    expect(db.claimAutoEmail).not.toHaveBeenCalled();
  });
});

describe('maybeAutoSendDanfe — envio', () => {
  it('nota emitida DEPOIS do corte, e-mail válido — reivindica, gera PDF e envia', async () => {
    const { maybeAutoSendDanfe, db, generateDanfePdf, sendDanfeEmail } =
      freshModule({ nfceAutoEmail: { cutoffAt: '2026-11-09T00:00:00.000Z' } });
    const record = baseRecord({
      chave: 'chave-xyz',
      danfe: { dhEmi: '2026-11-09T15:00:00-03:00', dest: { email: 'cliente@teste.com' } },
    });

    await maybeAutoSendDanfe('m1', record);

    expect(db.claimAutoEmail).toHaveBeenCalledWith('chave-xyz', 'm1', 'cliente@teste.com');
    expect(generateDanfePdf).toHaveBeenCalledWith(record.danfe);
    expect(sendDanfeEmail).toHaveBeenCalledWith(expect.objectContaining({ toEmail: 'cliente@teste.com' }));
    expect(db.markAutoEmailSent).toHaveBeenCalledWith('chave-xyz');
  });

  it('claim já reivindicado (duplicata) — não gera PDF nem envia de novo', async () => {
    const { maybeAutoSendDanfe, db, generateDanfePdf, sendDanfeEmail } = freshModule();
    db.claimAutoEmail.mockReturnValue(false);
    await maybeAutoSendDanfe('m1', baseRecord());
    expect(generateDanfePdf).not.toHaveBeenCalled();
    expect(sendDanfeEmail).not.toHaveBeenCalled();
  });

  it('falha no envio — marca failed, não lança (fire-and-forget seguro)', async () => {
    const { maybeAutoSendDanfe, db, sendDanfeEmail } = freshModule();
    sendDanfeEmail.mockRejectedValue(new Error('Graph indisponível'));
    await expect(maybeAutoSendDanfe('m1', baseRecord({ chave: 'chave-falha' }))).resolves.not.toThrow();
    expect(db.markAutoEmailFailed).toHaveBeenCalledWith('chave-falha', 'Graph indisponível');
  });

  it('registro sem chave — não tenta nada (defensivo)', async () => {
    const { maybeAutoSendDanfe, db } = freshModule();
    await maybeAutoSendDanfe('m1', baseRecord({ chave: undefined }));
    expect(db.claimAutoEmail).not.toHaveBeenCalled();
  });
});
