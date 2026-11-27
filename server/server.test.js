'use strict';

// Testes de server.js no nível do boot: não sobe HTTP de verdade, não toca
// Postgres. `http.createServer` devolve um servidor falso que só captura o
// callback de listen(); todos os serviços são mocks. Fake timers em todos os
// testes — server.js cria setInterval/setTimeout no carregamento do módulo
// (NFC-e, scan Aloha) que, com timers reais, vazariam pro resto da suíte.

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Carrega server.js isolado, com todos os mocks. Devolve os mocks + o
// callback de listen() capturado.
function loadServer({ isLeader = true, firstAttempt = Promise.resolve(), db = {} } = {}) {
  jest.resetModules();

  let listenCb = null;
  const fakeServer = {
    listen: jest.fn((port, cb) => { listenCb = cb; }),
    on:     jest.fn(),
    close:  jest.fn(),
  };
  jest.doMock('http', () => ({ createServer: jest.fn(() => fakeServer) }));
  jest.doMock('./app', () => ({}));
  jest.doMock('./services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('./services/websocket', () => ({ initWebSocket: jest.fn(() => ({})), broadcast: jest.fn() }));
  jest.doMock('./services/liveSessionRelay', () => ({ initLiveRelay: jest.fn(() => ({})) }));
  jest.doMock('./services/upgradeRouter', () => ({ createUpgradeRouter: jest.fn(() => () => {}) }));
  jest.doMock('./services/resendAlert', () => ({ sendAlert: jest.fn().mockResolvedValue({}) }));

  const leaderElection = {
    start: jest.fn(), stop: jest.fn().mockResolvedValue(undefined),
    isLeader: jest.fn(() => isLeader),
    whenFirstAttemptSettled: jest.fn(() => firstAttempt),
  };
  jest.doMock('./services/leaderElection', () => leaderElection);

  const services = {
    alertEngine:        { start: jest.fn(), stop: jest.fn(), checkAll: jest.fn() },
    insightEngine:      { start: jest.fn(), stop: jest.fn() },
    zamak:              { scheduleDailySync: jest.fn() },
    metricsEmail:       { scheduleDailyMetricsEmail: jest.fn() },
    ncrMonitor:         { start: jest.fn() },
    serviceStatusEmail: { scheduleServiceStatusEmails: jest.fn() },
    rhHealthMonitor:    { start: jest.fn(), stop: jest.fn() },
    activityRetention:  { scheduleDailyPurge: jest.fn(), stop: jest.fn() },
    dbSizeMonitor:      { scheduleDailyMonitor: jest.fn(), stop: jest.fn() },
  };
  jest.doMock('./services/alertEngine',        () => services.alertEngine);
  jest.doMock('./services/insightEngine',      () => services.insightEngine);
  jest.doMock('./services/zamak',              () => services.zamak);
  jest.doMock('./services/metricsEmailReport', () => services.metricsEmail);
  jest.doMock('./services/ncrMonitor',         () => services.ncrMonitor);
  jest.doMock('./services/serviceStatusEmail', () => services.serviceStatusEmail);
  jest.doMock('./services/rhHealthMonitor',    () => services.rhHealthMonitor);
  jest.doMock('./services/activityRetention',  () => services.activityRetention);
  jest.doMock('./services/dbSizeMonitor',      () => services.dbSizeMonitor);

  const dbMock = {
    getAllMachines: jest.fn().mockResolvedValue([
      { id: 'm1', hostname: 'LOJA1BOH', status: 'online' },
    ]),
    createCommand:  jest.fn().mockResolvedValue(undefined),
    getIndexedDayKeysSet: jest.fn().mockResolvedValue(new Set()),
    todayDayKey:    jest.fn(() => '2026-11-27'),
    getMachinesOnlineMissingReading: jest.fn().mockResolvedValue([]),
    getHourlyMetricsDiag: jest.fn().mockResolvedValue([]),
    insertReadingMiss: jest.fn().mockResolvedValue(undefined),
    addEvent:       jest.fn().mockResolvedValue(undefined),
    ...db,
  };
  jest.doMock('./db-pg', () => dbMock);

  require('./server');
  return { listenCb: () => listenCb(), leaderElection, services, db: dbMock };
}

describe('server.js', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    jest.useFakeTimers();
    // server.js registra process.on('SIGTERM') a cada require — não acumular
    // listeners reais no processo do jest.
    jest.spyOn(process, 'on').mockImplementation(() => process);
    process.env.CLOCK_PROXY_TOKEN = 'x'; // evita o alerta de boot (irrelevante aqui)
    process.env.FEATURE_LIVE_ACCESS = 'true';
    process.env.FEATURE_DB_SIZE_MONITOR = 'true';
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  describe('boot — catch-ups imediatos esperam a 1a disputa de lideranca', () => {
    it('zamak/activityRetention/dbSizeMonitor so sao agendados depois de whenFirstAttemptSettled() resolver', async () => {
      const first = deferred();
      const { listenCb, leaderElection, services } = loadServer({ firstAttempt: first.promise });

      listenCb();
      await flush();

      expect(leaderElection.start).toHaveBeenCalled();
      expect(leaderElection.whenFirstAttemptSettled).toHaveBeenCalled();
      // ainda sem saber se é líder: catch-ups NÃO podem ter rodado
      expect(services.zamak.scheduleDailySync).not.toHaveBeenCalled();
      expect(services.activityRetention.scheduleDailyPurge).not.toHaveBeenCalled();
      expect(services.dbSizeMonitor.scheduleDailyMonitor).not.toHaveBeenCalled();
      // os demais serviços não esperam (timing deles não muda)
      expect(services.alertEngine.start).toHaveBeenCalled();
      expect(services.insightEngine.start).toHaveBeenCalled();
      expect(services.metricsEmail.scheduleDailyMetricsEmail).toHaveBeenCalled();
      expect(services.ncrMonitor.start).toHaveBeenCalled();
      expect(services.serviceStatusEmail.scheduleServiceStatusEmails).toHaveBeenCalled();
      expect(services.rhHealthMonitor.start).toHaveBeenCalled();

      first.resolve();
      await flush();

      expect(services.zamak.scheduleDailySync).toHaveBeenCalledTimes(1);
      expect(services.activityRetention.scheduleDailyPurge).toHaveBeenCalledTimes(1);
      expect(services.dbSizeMonitor.scheduleDailyMonitor).toHaveBeenCalledTimes(1);
    });

    it('leaderElection.start() roda antes de whenFirstAttemptSettled() (ordem)', async () => {
      const { listenCb, leaderElection } = loadServer();
      listenCb();
      await flush();
      expect(leaderElection.start.mock.invocationCallOrder[0])
        .toBeLessThan(leaderElection.whenFirstAttemptSettled.mock.invocationCallOrder[0]);
    });
  });

  // Jobs embutidos em server.js que despacham comandos pra frota / gravam no
  // banco: só o líder roda (spec "Restrições" — evita comando duplicado nas
  // ~130 máquinas com 2 instâncias). Disparados pelos próprios timers do
  // server.js: NFC-e 1a rodada em 2min, scan Aloha e monitor horário em 5min.
  describe('leader guard — jobs embutidos em server.js', () => {
    const SIX_MIN = 6 * 60 * 1000;

    async function bootAndRunTimers(isLeader) {
      const ctx = loadServer({ isLeader });
      ctx.listenCb();            // agenda o monitor horário
      await flush();
      jest.advanceTimersByTime(SIX_MIN);
      await flush(50);
      return ctx;
    }

    function commandsOfType(db, type) {
      return db.createCommand.mock.calls.filter(c => c[1] === type);
    }

    it('lider: indexacao NFC-e, scan Aloha e monitor horario rodam (controle positivo)', async () => {
      const { db } = await bootAndRunTimers(true);
      expect(commandsOfType(db, 'aloha-index-nfce-day').length).toBeGreaterThan(0);
      expect(commandsOfType(db, 'aloha-scan')).toHaveLength(1);
      expect(db.getMachinesOnlineMissingReading).toHaveBeenCalled();
    });

    it('nao-lider: _triggerNFCeIndexing nao enfileira aloha-index-nfce-day', async () => {
      const { db } = await bootAndRunTimers(false);
      expect(commandsOfType(db, 'aloha-index-nfce-day')).toHaveLength(0);
      expect(db.getIndexedDayKeysSet).not.toHaveBeenCalled();
    });

    it('nao-lider: refresh do scan Aloha nao enfileira aloha-scan', async () => {
      const { db } = await bootAndRunTimers(false);
      expect(commandsOfType(db, 'aloha-scan')).toHaveLength(0);
      expect(db.getAllMachines).not.toHaveBeenCalled();
    });

    it('nao-lider: monitor horario nao consulta, nao grava miss nem cria comando', async () => {
      const { db } = await bootAndRunTimers(false);
      expect(db.getMachinesOnlineMissingReading).not.toHaveBeenCalled();
      expect(db.getHourlyMetricsDiag).not.toHaveBeenCalled();
      expect(db.insertReadingMiss).not.toHaveBeenCalled();
      expect(commandsOfType(db, 'get_agent_log')).toHaveLength(0);
    });
  });
});
