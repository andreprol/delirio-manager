'use strict';

/**
 * Caso de falha externa isolado num arquivo próprio — jest.mock('qrcode') é
 * hoisted e afetaria todo o arquivo, então fica separado dos testes de sucesso
 * em nfce-mailer.buildHtml.test.js.
 */

jest.mock('qrcode', () => ({
  toDataURL: jest.fn(() => Promise.reject(new Error('falha simulada na geração do QR'))),
}));

const { buildHtml } = require('./nfce-mailer');

it('e-mail não quebra se a geração do QR falhar — só sai sem o QR', async () => {
  const danfe = {
    nNF: 123, series: '1', dhEmi: '2026-11-03T17:01:56-03:00',
    chave: '123', emit: {}, products: [], payment: [], totals: { vNF: 50 },
    qrCode: 'https://www.sefaz.rj.gov.br/nfce/qrcode?p=abc',
  };
  const html = await buildHtml(danfe);
  expect(html).toContain('DANFE NFC-e'); // e-mail inteiro ainda se monta
  expect(html).not.toContain('<img');
});
