'use strict';

/**
 * Testes de isMsGraphConfigured() — usada por GET /api/status/integrations pra
 * diagnosticar se o envio de DANFE por email está pronto, SEM vazar o valor
 * dos segredos (tenantId/clientId/clientSecret/refreshToken), só um booleano.
 */

jest.mock('fs');
const fs = require('fs');
const { isMsGraphConfigured } = require('./nfce-mailer');

beforeEach(() => {
  jest.clearAllMocks();
});

function mockConfig(msGraph) {
  fs.readFileSync.mockReturnValue(JSON.stringify(msGraph ? { msGraph } : {}));
}

describe('isMsGraphConfigured', () => {
  it('true quando os 4 campos obrigatórios estão presentes', () => {
    mockConfig({ tenantId: 't', clientId: 'c', clientSecret: 's', refreshToken: 'r' });
    expect(isMsGraphConfigured()).toBe(true);
  });

  it('false quando msGraph está ausente do config.json', () => {
    mockConfig(null);
    expect(isMsGraphConfigured()).toBe(false);
  });

  it('false quando falta um campo obrigatório (clientSecret)', () => {
    mockConfig({ tenantId: 't', clientId: 'c', refreshToken: 'r' });
    expect(isMsGraphConfigured()).toBe(false);
  });

  it('false quando config.json não existe / não parseia, sem lançar exceção', () => {
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => isMsGraphConfigured()).not.toThrow();
    expect(isMsGraphConfigured()).toBe(false);
  });

  it('nunca retorna os valores dos campos — só o booleano', () => {
    mockConfig({ tenantId: 't', clientId: 'c', clientSecret: 'super-secreto', refreshToken: 'r' });
    const result = isMsGraphConfigured();
    expect(result).toBe(true);
    expect(typeof result).toBe('boolean');
  });
});
