'use strict';

jest.mock('../db', () => ({
  ncrUpdate:             jest.fn(),
  ncrGetByMessageId:     jest.fn(),
  ncrInsertEmail:        jest.fn(),
  getMachineByHostname:  jest.fn(),
}));

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return { ...real, readFileSync: jest.fn(), writeFileSync: jest.fn() };
});

const db = require('../db');
const fs = require('fs');
const {
  buildStoreUnresolvableEmail,
  sendStoreUnresolvableAlert,
  processNcrEmail,
  parseLeadMinutes,
} = require('./ncrMonitor');

// ── helpers ───────────────────────────────────────────────────────────────────

const MS_GRAPH_CFG = {
  tenantId:     'tenant-aaa',
  clientId:     'client-bbb',
  clientSecret: 'secret-ccc',
  refreshToken: 'rt-initial',
};

function setupFsConfig(msGraph = MS_GRAPH_CFG) {
  fs.readFileSync.mockReturnValue(JSON.stringify({ msGraph }));
}

function makeOkFetch(jsonBody) {
  return {
    ok:     true,
    status: 200,
    json:   jest.fn().mockResolvedValue(jsonBody),
    text:   jest.fn().mockResolvedValue(JSON.stringify(jsonBody)),
  };
}

function makeFailFetch(status, body = 'Graph error') {
  return {
    ok:     false,
    status,
    json:   jest.fn().mockResolvedValue({}),
    text:   jest.fn().mockResolvedValue(body),
  };
}

const TOKEN_RESP = { access_token: 'tok-xyz', refresh_token: 'rt-initial' };

const SAMPLE_ROW = {
  id:                 63,
  order_ref:          'abc-order-123',
  enterprise_unit_id: '3222f8b3a0e24271a2e3e44d75b67fea',
  store_name:         null,
  date_brt:           '2026-07-22',
  total_value:        294.94,
  products_json:      JSON.stringify(['FOLHAS ORGÂNICAS R$173', 'CAESAR SALAD R$99']),
};

function makeNcrMsg(overrides = {}) {
  const payload = JSON.stringify({
    channel:            'NCR',
    referenceId:        'test-order-999',
    enterpriseUnitId:   'unknown-id-9999',
    enterpriseUnitName: '',
    totals:             [{ type: 'Net', value: '50.00' }],
    orderLines:         [{ description: 'PRODUTO TESTE' }],
    dateCreated:        '2026-07-22T21:21:00Z',
  });
  return {
    id:               'msg-id-001',
    receivedDateTime: '2026-07-22T21:21:00Z',
    body:             { content: `<html><body>${payload}</body></html>` },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

// ── buildStoreUnresolvableEmail ───────────────────────────────────────────────

describe('buildStoreUnresolvableEmail', () => {
  it('exibe enterprise_unit_id quando presente', () => {
    const html = buildStoreUnresolvableEmail(SAMPLE_ROW);
    expect(html).toContain('3222f8b3a0e24271a2e3e44d75b67fea');
    expect(html).toContain('não mapeado em UNIT_TO_BOH');
  });

  it('exibe "(ausente)" quando enterprise_unit_id está faltando', () => {
    const html = buildStoreUnresolvableEmail({ ...SAMPLE_ROW, enterprise_unit_id: null });
    expect(html).toContain('enterprise_unit_id:</b> (ausente no e-mail)');
  });

  it('exibe store_name quando presente', () => {
    const html = buildStoreUnresolvableEmail({ ...SAMPLE_ROW, store_name: 'Niterói Plaza' });
    expect(html).toContain('Niterói Plaza');
    expect(html).toContain('não corresponde a nenhuma entrada em STORE_NAME_TO_BOH');
  });

  it('exibe "(ausente)" quando store_name está faltando', () => {
    const html = buildStoreUnresolvableEmail({ ...SAMPLE_ROW, store_name: null });
    expect(html).toContain('store_name:</b> (ausente no e-mail');
  });

  it('inclui order_ref na tabela', () => {
    const html = buildStoreUnresolvableEmail(SAMPLE_ROW);
    expect(html).toContain('#abc-order-123');
  });

  it('inclui valor formatado em BRL', () => {
    const html = buildStoreUnresolvableEmail(SAMPLE_ROW);
    expect(html).toContain('R$ 294,94');
  });

  it('renderiza produtos da lista', () => {
    const html = buildStoreUnresolvableEmail(SAMPLE_ROW);
    expect(html).toContain('FOLHAS ORGÂNICAS R$173');
    expect(html).toContain('CAESAR SALAD R$99');
  });

  it('não exibe linha de produtos quando lista vazia', () => {
    const html = buildStoreUnresolvableEmail({ ...SAMPLE_ROW, products_json: '[]' });
    expect(html).not.toContain('<b>Produtos</b>');
  });

  it('escapa caracteres HTML no enterprise_unit_id', () => {
    const html = buildStoreUnresolvableEmail({
      ...SAMPLE_ROW,
      enterprise_unit_id: '<xss>',
    });
    expect(html).not.toContain('<xss>');
    expect(html).toContain('&lt;xss&gt;');
  });

  it('inclui trecho de código para adicionar mapeamento', () => {
    const html = buildStoreUnresolvableEmail(SAMPLE_ROW);
    expect(html).toContain("'3222f8b3a0e24271a2e3e44d75b67fea': 'BOH_DA_LOJA'");
  });
});

// ── sendStoreUnresolvableAlert ────────────────────────────────────────────────

describe('sendStoreUnresolvableAlert', () => {
  it('happy path — sendMail ok → loga sucesso e atualiza DB', async () => {
    setupFsConfig();
    global.fetch
      .mockResolvedValueOnce(makeOkFetch(TOKEN_RESP))   // token
      .mockResolvedValueOnce(makeOkFetch({}));           // sendMail

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await sendStoreUnresolvableAlert(SAMPLE_ROW);

    expect(db.ncrUpdate).toHaveBeenCalledWith(63, expect.objectContaining({ danfe_found: -1 }));
    expect(db.ncrUpdate.mock.calls[0][1].notified_at).toBeTruthy();
    consoleSpy.mockRestore();
  });

  it('sendMail retorna erro HTTP → loga erro mas DB ainda atualizado', async () => {
    setupFsConfig();
    global.fetch
      .mockResolvedValueOnce(makeOkFetch(TOKEN_RESP))
      .mockResolvedValueOnce(makeFailFetch(403, 'Forbidden'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await sendStoreUnresolvableAlert(SAMPLE_ROW);

    expect(db.ncrUpdate).toHaveBeenCalledWith(63, expect.objectContaining({ danfe_found: -1 }));
    consoleSpy.mockRestore();
  });

  it('fetch lança exceção → catch loga, DB ainda atualizado via finally', async () => {
    setupFsConfig();
    global.fetch
      .mockResolvedValueOnce(makeOkFetch(TOKEN_RESP))
      .mockRejectedValueOnce(new Error('Network failure'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await sendStoreUnresolvableAlert(SAMPLE_ROW);

    expect(db.ncrUpdate).toHaveBeenCalledWith(63, expect.objectContaining({ danfe_found: -1 }));
    consoleSpy.mockRestore();
  });

  it('token fetch lança exceção → catch loga, DB ainda atualizado', async () => {
    setupFsConfig();
    global.fetch.mockRejectedValueOnce(new Error('Token endpoint down'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await sendStoreUnresolvableAlert(SAMPLE_ROW);

    expect(db.ncrUpdate).toHaveBeenCalledWith(63, expect.objectContaining({ danfe_found: -1 }));
    consoleSpy.mockRestore();
  });

  it('msGraph não configurado (sem tenantId) → retorna cedo, DB ainda atualizado', async () => {
    setupFsConfig({ clientId: 'x' }); // sem tenantId

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await sendStoreUnresolvableAlert(SAMPLE_ROW);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.ncrUpdate).toHaveBeenCalledWith(63, expect.objectContaining({ danfe_found: -1 }));
    consoleSpy.mockRestore();
  });

  it('config.json ilegível → retorna cedo, DB ainda atualizado', async () => {
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await sendStoreUnresolvableAlert(SAMPLE_ROW);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.ncrUpdate).toHaveBeenCalledWith(63, expect.objectContaining({ danfe_found: -1 }));
    consoleSpy.mockRestore();
  });

  it('envia email para andre@delirio.com.br com subject correto', async () => {
    setupFsConfig();
    global.fetch
      .mockResolvedValueOnce(makeOkFetch(TOKEN_RESP))
      .mockResolvedValueOnce(makeOkFetch({}));

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await sendStoreUnresolvableAlert(SAMPLE_ROW);

    const sendMailCall = global.fetch.mock.calls[1];
    const body = JSON.parse(sendMailCall[1].body);
    expect(body.message.toRecipients[0].emailAddress.address).toBe('andre@delirio.com.br');
    expect(body.message.subject).toContain('abc-order-123');
    consoleSpy.mockRestore();
  });
});

// ── processNcrEmail — caminho loja não identificada ───────────────────────────

describe('processNcrEmail — store unresolvable', () => {
  it('quando row existe sem machine_id → chama sendStoreUnresolvableAlert (danfe_found=-1)', async () => {
    const msg = makeNcrMsg();
    const insertedRow = {
      id:                 99,
      order_ref:          'test-order-999',
      enterprise_unit_id: 'unknown-id-9999',
      store_name:         '',
      machine_id:         null,
      products_json:      '[]',
      total_value:        50,
      date_brt:           '2026-07-22',
    };

    db.ncrGetByMessageId
      .mockReturnValueOnce(null)       // dedup check → passa
      .mockReturnValueOnce(insertedRow); // após insert
    db.ncrInsertEmail.mockReturnValue(1);
    db.getMachineByHostname.mockReturnValue(null);

    setupFsConfig();
    global.fetch
      .mockResolvedValueOnce(makeOkFetch(TOKEN_RESP))
      .mockResolvedValueOnce(makeOkFetch({}));

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processNcrEmail(msg);

    expect(db.ncrUpdate).toHaveBeenCalledWith(99, expect.objectContaining({ danfe_found: -1 }));
    expect(result).toBe(0);
    consoleSpy.mockRestore();
  });

  it('quando row nula após insert → console.warn, sem atualização DB', async () => {
    const msg = makeNcrMsg();

    db.ncrGetByMessageId
      .mockReturnValueOnce(null)  // dedup
      .mockReturnValueOnce(null); // após insert (edge case)
    db.ncrInsertEmail.mockReturnValue(1);
    db.getMachineByHostname.mockReturnValue(null);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await processNcrEmail(msg);

    expect(db.ncrUpdate).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BOH não mapeado'));
    expect(result).toBe(0);
    warnSpy.mockRestore();
  });

  it('email duplicado (dedup) → retorna 0 sem inserir', async () => {
    const msg = makeNcrMsg();
    db.ncrGetByMessageId.mockReturnValueOnce({ id: 1 }); // dedup hit

    const result = await processNcrEmail(msg);

    expect(db.ncrInsertEmail).not.toHaveBeenCalled();
    expect(result).toBe(0);
  });

  it('email anterior ao since → retorna 0', async () => {
    const msg = makeNcrMsg({ receivedDateTime: '2026-07-01T00:00:00Z' });
    const since = new Date('2026-07-22T00:00:00Z');

    const result = await processNcrEmail(msg, since);

    expect(db.ncrInsertEmail).not.toHaveBeenCalled();
    expect(result).toBe(0);
  });
});

// ── parseLeadMinutes ──────────────────────────────────────────────────────────

describe('parseLeadMinutes', () => {
  it('retorna 0 quando fulfillment ausente', () => {
    expect(parseLeadMinutes({})).toBe(0);
  });

  it('retorna 0 quando leadTimes vazio', () => {
    expect(parseLeadMinutes({ fulfillment: { leadTimes: [] } })).toBe(0);
  });

  it('retorna 0 quando interval não é número', () => {
    expect(parseLeadMinutes({ fulfillment: { leadTimes: [{ interval: 'fast', intervalUnits: 'Minutes' }] } })).toBe(0);
  });

  it('retorna minutos quando intervalUnits=Minutes', () => {
    expect(parseLeadMinutes({
      fulfillment: { leadTimes: [{ interval: 60, intervalUnits: 'Minutes' }] },
    })).toBe(60);
  });

  it('converte horas para minutos quando intervalUnits=Hours', () => {
    expect(parseLeadMinutes({
      fulfillment: { leadTimes: [{ interval: 2, intervalUnits: 'Hours' }] },
    })).toBe(120);
  });

  it('assume Minutes quando intervalUnits ausente', () => {
    expect(parseLeadMinutes({
      fulfillment: { leadTimes: [{ interval: 30 }] },
    })).toBe(30);
  });

  it('usa apenas o primeiro leadTime', () => {
    expect(parseLeadMinutes({
      fulfillment: { leadTimes: [
        { interval: 45, intervalUnits: 'Minutes' },
        { interval: 999, intervalUnits: 'Minutes' },
      ]},
    })).toBe(45);
  });

  it('case-insensitive em intervalUnits', () => {
    expect(parseLeadMinutes({
      fulfillment: { leadTimes: [{ interval: 1, intervalUnits: 'HOURS' }] },
    })).toBe(60);
  });
});
