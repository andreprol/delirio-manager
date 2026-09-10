'use strict';

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return { ...real, readFileSync: jest.fn() };
});

const fs = require('fs');
const { sendAlert } = require('./resendAlert');

function makeOkFetch() {
  return { ok: true, status: 200, text: jest.fn().mockResolvedValue('{}') };
}

function makeFailFetch(status, body = 'Resend error') {
  return { ok: false, status, text: jest.fn().mockResolvedValue(body) };
}

describe('resendAlert.sendAlert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RESEND_API_KEY;
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    global.fetch = jest.fn();
  });

  it('happy path — envia e-mail via Resend e retorna sent:true', async () => {
    process.env.RESEND_API_KEY = 'key-abc';
    global.fetch.mockResolvedValueOnce(makeOkFetch());

    const result = await sendAlert({
      source: 'Teste', stage: 'Falha X', detail: 'detalhe da falha',
      cooldownKey: 'happy-path',
    });

    expect(result).toEqual({ sent: true });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer key-abc' }),
      })
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.to).toEqual(['andreprol1980@gmail.com']);
    expect(body.subject).toContain('Falha X');
    expect(body.html).toContain('detalhe da falha');
  });

  it('sem RESEND_API_KEY configurada — não crasha, retorna no-api-key, não chama fetch', async () => {
    const result = await sendAlert({
      source: 'Teste', stage: 'Falha Y', detail: 'sem chave',
      cooldownKey: 'no-key',
    });

    expect(result).toEqual({ sent: false, reason: 'no-api-key' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('cooldown — segunda chamada com a mesma cooldownKey dentro da janela é bloqueada', async () => {
    process.env.RESEND_API_KEY = 'key-abc';
    global.fetch.mockResolvedValue(makeOkFetch());

    const r1 = await sendAlert({ source: 'Teste', stage: 'A', detail: 'd1', cooldownKey: 'cd-key', cooldownMs: 60000 });
    const r2 = await sendAlert({ source: 'Teste', stage: 'A', detail: 'd2', cooldownKey: 'cd-key', cooldownMs: 60000 });

    expect(r1).toEqual({ sent: true });
    expect(r2).toEqual({ sent: false, reason: 'cooldown' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('falha da API do Resend (não-2xx) — não lança exceção, retorna sent:false com motivo', async () => {
    process.env.RESEND_API_KEY = 'key-abc';
    global.fetch.mockResolvedValueOnce(makeFailFetch(429, 'rate limited'));

    const result = await sendAlert({ source: 'Teste', stage: 'B', detail: 'd', cooldownKey: 'fail-status' });

    expect(result).toEqual({ sent: false, reason: 'resend-429' });
  });

  it('fetch lança exceção de rede — não propaga, retorna sent:false com motivo exception', async () => {
    process.env.RESEND_API_KEY = 'key-abc';
    global.fetch.mockRejectedValueOnce(new Error('network down'));

    const result = await sendAlert({ source: 'Teste', stage: 'C', detail: 'd', cooldownKey: 'fail-network' });

    expect(result).toEqual({ sent: false, reason: 'exception', error: 'network down' });
  });

  it('lê a chave do config.json quando RESEND_API_KEY não está no ambiente', async () => {
    fs.readFileSync.mockImplementation(() => JSON.stringify({ resendApiKey: 'key-from-config' }));
    global.fetch.mockResolvedValueOnce(makeOkFetch());

    const result = await sendAlert({ source: 'Teste', stage: 'D', detail: 'd', cooldownKey: 'from-config' });

    expect(result).toEqual({ sent: true });
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer key-from-config');
  });
});
