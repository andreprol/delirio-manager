'use strict';

/**
 * Testes de nfce-whatsapp.js — envio manual da DANFE por WhatsApp (botão no
 * dashboard, nunca automático). Mocka fs (config.json) e fetch global (upload
 * de mídia + envio de template), sem bater em rede de verdade.
 */

jest.mock('fs');
const fs = require('fs');
const { sendDanfeWhatsapp, isWhatsappConfigured, normalizePhone } = require('./nfce-whatsapp');

const FULL_CFG = { accessToken: 'tok', phoneNumberId: '895200763665905', templateName: 'envio_danfe', templateLang: 'pt_BR' };

function mockConfig(whatsapp) {
  fs.readFileSync.mockReturnValue(JSON.stringify(whatsapp ? { whatsapp } : {}));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('normalizePhone', () => {
  it('adiciona 55 a número BR de 11 dígitos (com 9)', () => {
    expect(normalizePhone('(21) 99876-5432')).toBe('5521998765432');
  });

  it('adiciona 55 a número BR de 10 dígitos (sem 9)', () => {
    expect(normalizePhone('21 3876-5432')).toBe('552138765432');
  });

  it('mantém número já com 55', () => {
    expect(normalizePhone('5521998765432')).toBe('5521998765432');
  });

  it('retorna null pra entrada vazia', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('retorna null pra número curto demais pra ser real', () => {
    expect(normalizePhone('123')).toBeNull();
  });
});

describe('isWhatsappConfigured', () => {
  it('true com os 3 campos obrigatórios', () => {
    mockConfig(FULL_CFG);
    expect(isWhatsappConfigured()).toBe(true);
  });

  it('false quando whatsapp está ausente do config.json', () => {
    mockConfig(null);
    expect(isWhatsappConfigured()).toBe(false);
  });

  it('false quando falta phoneNumberId', () => {
    mockConfig({ accessToken: 'tok', templateName: 'envio_danfe' });
    expect(isWhatsappConfigured()).toBe(false);
  });

  it('false sem lançar se config.json não existe / não parseia', () => {
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => isWhatsappConfigured()).not.toThrow();
    expect(isWhatsappConfigured()).toBe(false);
  });
});

const danfe = { nNF: '123' };

describe('sendDanfeWhatsapp — validação', () => {
  beforeEach(() => {
    mockConfig(FULL_CFG);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('lança erro se configuração ausente', async () => {
    mockConfig(null);
    await expect(sendDanfeWhatsapp({ danfe, pdfBuffer: Buffer.from('x'), toPhone: '21999998888' }))
      .rejects.toThrow('Configuração WhatsApp ausente');
  });

  it('lança erro se telefone inválido', async () => {
    await expect(sendDanfeWhatsapp({ danfe, pdfBuffer: Buffer.from('x'), toPhone: '' }))
      .rejects.toThrow('Número de telefone inválido');
  });
});

describe('sendDanfeWhatsapp — envio', () => {
  beforeEach(() => {
    mockConfig(FULL_CFG);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('faz upload da mídia e envia o template com sucesso', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'media-123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ id: 'wamid.abc' }] }) });

    await sendDanfeWhatsapp({ danfe, pdfBuffer: Buffer.from('%PDF'), toPhone: '21998765432', customerName: 'Maria' });

    expect(global.fetch).toHaveBeenCalledTimes(2);

    const [uploadUrl, uploadOpts] = global.fetch.mock.calls[0];
    expect(uploadUrl).toContain('/895200763665905/media');
    expect(uploadOpts.headers.Authorization).toBe('Bearer tok');

    const [sendUrl, sendOpts] = global.fetch.mock.calls[1];
    expect(sendUrl).toContain('/895200763665905/messages');
    const body = JSON.parse(sendOpts.body);
    expect(body.to).toBe('5521998765432');
    expect(body.template.name).toBe('envio_danfe');
    expect(body.template.components[0].parameters[0].document.id).toBe('media-123');
    expect(body.template.components[1].parameters[0].text).toBe('Maria');
  });

  it('usa "cliente" como nome quando customerName não informado', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'media-123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await sendDanfeWhatsapp({ danfe, pdfBuffer: Buffer.from('%PDF'), toPhone: '21998765432' });

    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.template.components[1].parameters[0].text).toBe('cliente');
  });
});

describe('sendDanfeWhatsapp — falhas de rede', () => {
  beforeEach(() => {
    mockConfig(FULL_CFG);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('lança erro se upload de mídia falhar', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, text: async () => 'erro upload' });
    await expect(sendDanfeWhatsapp({ danfe, pdfBuffer: Buffer.from('%PDF'), toPhone: '21998765432' }))
      .rejects.toThrow('Erro ao enviar PDF ao WhatsApp');
  });

  it('lança erro se envio do template falhar', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'media-123' }) })
      .mockResolvedValueOnce({ ok: false, text: async () => 'template rejeitado' });
    await expect(sendDanfeWhatsapp({ danfe, pdfBuffer: Buffer.from('%PDF'), toPhone: '21998765432' }))
      .rejects.toThrow('Erro ao enviar DANFE via WhatsApp');
  });
});
