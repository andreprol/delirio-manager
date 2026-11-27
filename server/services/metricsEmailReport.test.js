'use strict';

// msGraph configurado de propósito: sem config, sendDailyMetricsEmail() já
// retornaria cedo por config ausente e o teste não provaria nada sobre o
// guard de liderança.
const MS_GRAPH_CFG = {
  tenantId: 't', clientId: 'c', clientSecret: 's', refreshToken: 'rt',
};

function loadFresh({ isLeader }) {
  jest.resetModules();
  jest.doMock('./leaderElection', () => ({ isLeader: () => isLeader }));
  jest.doMock('fs', () => ({
    readFileSync: jest.fn(() => JSON.stringify({ msGraph: MS_GRAPH_CFG })),
    writeFileSync: jest.fn(),
  }));
  const db = {
    getDailyMetricsSummary: jest.fn().mockResolvedValue([]),
    getReadingMissesForDate: jest.fn().mockResolvedValue([]),
  };
  jest.doMock('../db-pg', () => db);
  return { mod: require('./metricsEmailReport'), db };
}

describe('sendDailyMetricsEmail — leader guard', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at' }),
      text: async () => '',
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('lider: consulta o resumo e envia o e-mail (controle positivo)', async () => {
    const { mod, db } = loadFresh({ isLeader: true });

    await mod.sendDailyMetricsEmail();

    expect(db.getDailyMetricsSummary).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/sendMail'), expect.any(Object)
    );
  });

  it('nao-lider: nao consulta o banco nem envia e-mail', async () => {
    const { mod, db } = loadFresh({ isLeader: false });

    const result = await mod.sendDailyMetricsEmail();

    expect(db.getDailyMetricsSummary).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
