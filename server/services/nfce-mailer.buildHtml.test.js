'use strict';

/**
 * Testes do QR code no e-mail de DANFE. Bug real (09/11/2026): danfe.qrCode é
 * a URL de consulta do SEFAZ (texto), não uma imagem — <img src="<url>"> nunca
 * renderizava nada. buildHtml agora gera a imagem de verdade via lib 'qrcode'.
 */

const { buildHtml } = require('./nfce-mailer');

function baseDanfe(overrides = {}) {
  return {
    nNF: 123, series: '1', dhEmi: '2026-11-03T17:01:56-03:00', vNF: 50,
    chave: '33261128301505000105650350001956201581549417',
    emit: { xNome: 'Loja Teste', cnpj: '12345678000199' },
    products: [], payment: [], totals: { vNF: 50 },
    ...overrides,
  };
}

describe('buildHtml — QR code', () => {
  it('gera <img> com data URI (imagem de verdade) quando qrCode presente', async () => {
    const html = await buildHtml(baseDanfe({ qrCode: 'https://www.sefaz.rj.gov.br/nfce/qrcode?p=abc' }));
    expect(html).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" width="130" height="130" alt="QR Code NFC-e" \/>/);
  });

  it('não inclui bloco de QR quando qrCode está vazio (bug do agente ainda não corrigido nessa nota)', async () => {
    const html = await buildHtml(baseDanfe({ qrCode: '' }));
    expect(html).not.toMatch(/QR Code NFC-e/);
    expect(html).not.toContain('<img');
  });

  it('nunca usa a URL crua como src do <img> (era o bug original)', async () => {
    const url = 'https://www.sefaz.rj.gov.br/nfce/qrcode?p=abc';
    const html = await buildHtml(baseDanfe({ qrCode: url }));
    expect(html).not.toContain(`src="${url}"`);
  });

  it('e-mail continua montando normalmente mesmo sem qrCode (resto do conteúdo intacto)', async () => {
    const html = await buildHtml(baseDanfe({ qrCode: '', chave: '123' }));
    expect(html).toContain('DANFE NFC-e');
    expect(html).toContain('Chave de Acesso');
  });
});
