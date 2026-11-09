'use strict';

/**
 * Testes de generateDanfePdf — foco no QR code (mesmo bug do e-mail: qrCode é
 * a URL de consulta do SEFAZ, precisa virar imagem antes de entrar no PDF).
 */

const { generateDanfePdf } = require('./danfe');

function baseDanfe(overrides = {}) {
  return {
    nNF: 123, series: '1', dhEmi: '2026-11-03T17:01:56-03:00', vNF: 50,
    chave: '33261128301505000105650350001956201581549417',
    emit: { xNome: 'Loja Teste', cnpj: '12345678000199' },
    products: [{ nItem: '1', xProd: 'Produto X', qCom: 1, uCom: 'UN', vUnCom: 50, vProd: 50 }],
    payment: [{ tPag: '17', vPag: 50 }],
    totals: { vNF: 50, vProd: 50 },
    ...overrides,
  };
}

describe('generateDanfePdf', () => {
  it('gera um PDF válido (magic bytes %PDF) com qrCode presente', async () => {
    const buf = await generateDanfePdf(baseDanfe({ qrCode: 'https://www.sefaz.rj.gov.br/nfce/qrcode?p=abc' }));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('gera PDF válido mesmo sem qrCode (nota indexada antes do fix do agente)', async () => {
    const buf = await generateDanfePdf(baseDanfe({ qrCode: '' }));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('PDF com QR fica maior que o mesmo PDF sem QR (confirma que a imagem entrou)', async () => {
    const semQr = await generateDanfePdf(baseDanfe({ qrCode: '' }));
    const comQr = await generateDanfePdf(baseDanfe({ qrCode: 'https://www.sefaz.rj.gov.br/nfce/qrcode?p=abc' }));
    expect(comQr.length).toBeGreaterThan(semQr.length);
  });
});

describe('generateDanfePdf — falha na geração do QR', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('qrcode', () => ({
      toBuffer: jest.fn(() => Promise.reject(new Error('falha simulada'))),
    }));
  });

  afterEach(() => {
    jest.dontMock('qrcode');
  });

  it('não quebra a geração do PDF — só sai sem o QR', async () => {
    const { generateDanfePdf: generateDanfePdfMocked } = require('./danfe');
    const buf = await generateDanfePdfMocked(baseDanfe({ qrCode: 'https://www.sefaz.rj.gov.br/nfce/qrcode?p=abc' }));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
