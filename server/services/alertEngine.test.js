'use strict';

/**
 * Testes unitários do AlertEngine.
 * Cada bloco de testes re-importa o módulo via resetModules para garantir
 * Maps internos (cpuAlertStart, offlineAlertCooldown) em estado limpo.
 */

describe('alertEngine', () => {
  let alertEngine;
  let dbMock;
  let broadcastMock;
  let sendMailMock;

  // Configura e re-importa o módulo do zero em cada teste
  function setupModule({ emailEnabled = false } = {}) {
    jest.resetModules();

    sendMailMock  = jest.fn().mockResolvedValue({});
    broadcastMock = jest.fn();

    const cfg = emailEnabled
      ? {
          alerts: {
            email: {
              enabled:   true,
              to:        ['ti@delirio.com.br'],
              smtp_host: 'smtp.test',
              smtp_port: 587,
              user:      'u',
              pass:      'p',
            },
            teams: { enabled: false },
          },
        }
      : { alerts: { email: { enabled: false }, teams: { enabled: false } } };

    dbMock = {
      getMachinesStale:          jest.fn(() => []),
      getAllMachines:             jest.fn(() => []),
      setMachineStatus:          jest.fn(),
      addEvent:                  jest.fn(),
      getMetrics:                jest.fn(() => []),
      getAlerts:                 jest.fn(() => []),
      getMachinesDRDue:          jest.fn(() => []),
      getMachinesWolTesting:     jest.fn(() => []),
      getMachinesAutoWolTesting: jest.fn(() => []),
      getMachinesOfflineForWake: jest.fn(() => []),
      createCommand:             jest.fn(),
      setWolStatus:              jest.fn(),
    };

    jest.doMock('../db', () => dbMock);
    jest.doMock('./websocket', () => ({ broadcast: broadcastMock }));
    jest.doMock('./wolBiosGuide', () => ({
      getBiosGuide: jest.fn(() => ({
        manufacturer: 'ASUS',
        model:        'ROG STRIX',
        path:         'Advanced > APM Configuration > Power On By LAN',
        note:         null,
      })),
    }));
    jest.doMock('nodemailer', () => ({
      createTransport: jest.fn(() => ({ sendMail: sendMailMock })),
    }));
    jest.doMock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: jest.fn().mockImplementation((p, ...args) => {
        if (String(p).includes('config.json')) return JSON.stringify(cfg);
        return jest.requireActual('fs').readFileSync(p, ...args);
      }),
    }));

    alertEngine = require('./alertEngine');
  }

  beforeEach(() => setupModule());

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── checkAll smoke ────────────────────────────────────────────────────────
  describe('checkAll', () => {
    it('executa sem erro quando db retorna listas vazias', () => {
      expect(() => alertEngine.checkAll()).not.toThrow();
    });

    it('não chama db.setMachineStatus quando não há máquinas stale', () => {
      alertEngine.checkAll();
      expect(dbMock.setMachineStatus).not.toHaveBeenCalled();
    });
  });

  // ── checkOffline ─────────────────────────────────────────────────────────
  describe('checkOffline', () => {
    const MACHINE = {
      id:           'mach-01',
      hostname:     'PC-BOH',
      display_name: 'BOH Principal',
      location:     'Cidade',
      last_seen:    '2026-07-10T20:00:00Z',
      online_since: null,
    };

    it('marca máquina stale como offline no banco', () => {
      dbMock.getMachinesStale.mockReturnValue([MACHINE]);
      alertEngine.checkAll();
      expect(dbMock.setMachineStatus).toHaveBeenCalledWith('mach-01', 'offline');
    });

    it('emite broadcast machine:offline com campos corretos', () => {
      dbMock.getMachinesStale.mockReturnValue([MACHINE]);
      alertEngine.checkAll();
      const [, payload] = broadcastMock.mock.calls.find(([e]) => e === 'machine:offline');
      expect(payload).toMatchObject({
        machineId:   'mach-01',
        displayName: 'BOH Principal',
        location:    'Cidade',
      });
    });

    it('usa hostname como displayName quando display_name é null', () => {
      dbMock.getMachinesStale.mockReturnValue([{ ...MACHINE, display_name: null }]);
      alertEngine.checkAll();
      const [, payload] = broadcastMock.mock.calls.find(([e]) => e === 'machine:offline');
      expect(payload.displayName).toBe('PC-BOH');
    });

    it('usa "Sem localidade" quando location é null', () => {
      dbMock.getMachinesStale.mockReturnValue([{ ...MACHINE, location: null }]);
      alertEngine.checkAll();
      const [, payload] = broadcastMock.mock.calls.find(([e]) => e === 'machine:offline');
      expect(payload.location).toBe('Sem localidade');
    });

    it('registra addEvent offline para a máquina', () => {
      dbMock.getMachinesStale.mockReturnValue([MACHINE]);
      alertEngine.checkAll();
      expect(dbMock.addEvent).toHaveBeenCalledWith('mach-01', 'offline', expect.any(String));
    });

    it('emite broadcast alert via fireAlert', () => {
      dbMock.getMachinesStale.mockReturnValue([MACHINE]);
      alertEngine.checkAll();
      const call = broadcastMock.mock.calls.find(([e, p]) => e === 'alert' && p?.type === 'offline');
      expect(call).toBeDefined();
      expect(call[1].machineId).toBe('mach-01');
    });

    it('processa múltiplas máquinas stale independentemente', () => {
      const m2 = { ...MACHINE, id: 'mach-02', hostname: 'PC-ECF' };
      dbMock.getMachinesStale.mockReturnValue([MACHINE, m2]);
      alertEngine.checkAll();
      expect(dbMock.setMachineStatus).toHaveBeenCalledTimes(2);
      expect(dbMock.setMachineStatus).toHaveBeenCalledWith('mach-01', 'offline');
      expect(dbMock.setMachineStatus).toHaveBeenCalledWith('mach-02', 'offline');
    });
  });

  // ── cooldown de email offline ─────────────────────────────────────────────
  describe('checkOffline — cooldown de email (30 min)', () => {
    const MACHINE = {
      id:           'mach-cd',
      hostname:     'PC-CD',
      display_name: 'PC Cooldown',
      location:     'Loja',
      last_seen:    '2026-07-10T20:00:00Z',
      online_since: null,
    };

    beforeEach(() => setupModule({ emailEnabled: true }));

    it('envia email na primeira detecção offline', () => {
      dbMock.getMachinesStale.mockReturnValue([MACHINE]);
      alertEngine.checkAll();
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it('suprime email na segunda detecção dentro do cooldown de 30min', () => {
      dbMock.getMachinesStale.mockReturnValue([MACHINE]);
      alertEngine.checkAll();
      alertEngine.checkAll();
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it('clearOfflineCooldown permite email imediato na próxima queda', () => {
      dbMock.getMachinesStale.mockReturnValue([MACHINE]);
      alertEngine.checkAll();                           // 1º alerta — envia email
      alertEngine.clearOfflineCooldown('mach-cd');      // reseta cooldown
      alertEngine.checkAll();                           // 2º alerta — deve enviar email novamente
      expect(sendMailMock).toHaveBeenCalledTimes(2);
    });

    it('broadcast machine:offline sempre dispara, mesmo no cooldown', () => {
      dbMock.getMachinesStale.mockReturnValue([MACHINE]);
      alertEngine.checkAll();
      alertEngine.checkAll();
      const offlineCalls = broadcastMock.mock.calls.filter(([e]) => e === 'machine:offline');
      expect(offlineCalls).toHaveLength(2); // broadcast sempre, email só 1x
    });
  });

  // ── checkMetricThresholds ─────────────────────────────────────────────────
  describe('checkMetricThresholds', () => {
    function machine(extra = {}) {
      return {
        id:           'mach-t',
        hostname:     'PC-T',
        display_name: 'PC Threshold',
        status:       'online',
        last_metrics: JSON.stringify({ cpuPct: 0, cpuTempC: 0, diskFreeGB: 100 }),
        ...extra,
      };
    }

    function rule(type, threshold, duration_mins = 0) {
      return [{ enabled: 1, type, threshold, duration_mins }];
    }

    it('ignora máquina com status offline', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ status: 'offline' })]);
      dbMock.getAlerts.mockReturnValue(rule('cpu_high', 80));
      alertEngine.checkAll();
      expect(broadcastMock).not.toHaveBeenCalledWith('alert', expect.objectContaining({ type: 'cpu_high' }));
    });

    it('ignora máquina sem last_metrics', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: null })]);
      alertEngine.checkAll();
      expect(broadcastMock).not.toHaveBeenCalledWith('alert', expect.anything());
    });

    it('não lança exceção com last_metrics corrompido', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: 'not{json' })]);
      expect(() => alertEngine.checkAll()).not.toThrow();
    });

    it('regra desabilitada (enabled = 0) não gera alerta', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: JSON.stringify({ cpuPct: 99 }) })]);
      dbMock.getAlerts.mockReturnValue([{ enabled: 0, type: 'cpu_high', threshold: 80, duration_mins: 0 }]);
      alertEngine.checkAll();
      expect(broadcastMock).not.toHaveBeenCalledWith('alert', expect.objectContaining({ type: 'cpu_high' }));
    });

    // CPU high ─────────────────────────────────────────────────────────────
    it('CPU abaixo do threshold — sem alerta cpu_high', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: JSON.stringify({ cpuPct: 50 }) })]);
      dbMock.getAlerts.mockReturnValue(rule('cpu_high', 80, 5));
      alertEngine.checkAll();
      expect(broadcastMock).not.toHaveBeenCalledWith('alert', expect.objectContaining({ type: 'cpu_high' }));
    });

    it('CPU acima do threshold mas tempo insuficiente — sem alerta ainda', () => {
      jest.useFakeTimers();
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: JSON.stringify({ cpuPct: 90 }) })]);
      dbMock.getAlerts.mockReturnValue(rule('cpu_high', 80, 5));
      alertEngine.checkAll(); // inicia timer — elapsed = 0 min
      expect(broadcastMock).not.toHaveBeenCalledWith('alert', expect.objectContaining({ type: 'cpu_high' }));
    });

    it('CPU acima do threshold por tempo suficiente — alerta cpu_high dispara', () => {
      jest.useFakeTimers();
      const m = machine({ last_metrics: JSON.stringify({ cpuPct: 90 }) });
      dbMock.getAllMachines.mockReturnValue([m]);
      dbMock.getAlerts.mockReturnValue(rule('cpu_high', 80, 5));

      alertEngine.checkAll();              // inicia timer em t=0
      jest.advanceTimersByTime(6 * 60000); // avança 6 min → elapsed 6 >= 5
      alertEngine.checkAll();              // dispara alerta

      const call = broadcastMock.mock.calls.find(([e, p]) => e === 'alert' && p?.type === 'cpu_high');
      expect(call).toBeDefined();
      expect(call[1].machineId).toBe('mach-t');
    });

    it('alerta cpu_high reseta timer após disparar (não faz spam)', () => {
      jest.useFakeTimers();
      const m = machine({ last_metrics: JSON.stringify({ cpuPct: 90 }) });
      dbMock.getAllMachines.mockReturnValue([m]);
      dbMock.getAlerts.mockReturnValue(rule('cpu_high', 80, 5));

      alertEngine.checkAll();
      jest.advanceTimersByTime(6 * 60000);
      alertEngine.checkAll(); // dispara e reseta timer
      alertEngine.checkAll(); // elapsed = 0 → não dispara
      jest.advanceTimersByTime(6 * 60000);
      alertEngine.checkAll(); // dispara novamente após nova espera

      const calls = broadcastMock.mock.calls.filter(([e, p]) => e === 'alert' && p?.type === 'cpu_high');
      expect(calls).toHaveLength(2); // apenas 2 disparos, não 3
    });

    it('CPU cai abaixo do threshold — timer limpo, sem alerta mesmo após espera', () => {
      jest.useFakeTimers();
      const mHigh = machine({ last_metrics: JSON.stringify({ cpuPct: 90 }) });
      const mLow  = machine({ last_metrics: JSON.stringify({ cpuPct: 30 }) });
      dbMock.getAllMachines.mockReturnValue([mHigh]);
      dbMock.getAlerts.mockReturnValue(rule('cpu_high', 80, 5));

      alertEngine.checkAll();           // inicia timer
      dbMock.getAllMachines.mockReturnValue([mLow]);
      jest.advanceTimersByTime(6 * 60000);
      alertEngine.checkAll();           // CPU baixa → timer limpo, sem alerta

      expect(broadcastMock).not.toHaveBeenCalledWith('alert', expect.objectContaining({ type: 'cpu_high' }));
    });

    // Temperatura high ─────────────────────────────────────────────────────
    it('temperatura acima do threshold — alerta temp_high', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: JSON.stringify({ cpuPct: 0, cpuTempC: 75 }) })]);
      dbMock.getAlerts.mockReturnValue(rule('temp_high', 70));
      alertEngine.checkAll();
      expect(broadcastMock).toHaveBeenCalledWith('alert', expect.objectContaining({
        machineId: 'mach-t',
        type:      'temp_high',
      }));
    });

    it('temperatura abaixo do threshold — sem alerta temp_high', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: JSON.stringify({ cpuPct: 0, cpuTempC: 60 }) })]);
      dbMock.getAlerts.mockReturnValue(rule('temp_high', 70));
      alertEngine.checkAll();
      expect(broadcastMock).not.toHaveBeenCalledWith('alert', expect.objectContaining({ type: 'temp_high' }));
    });

    it('temperatura = 0 não dispara temp_high (sensor ausente)', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: JSON.stringify({ cpuPct: 0, cpuTempC: 0 }) })]);
      dbMock.getAlerts.mockReturnValue(rule('temp_high', 0));
      alertEngine.checkAll();
      expect(broadcastMock).not.toHaveBeenCalledWith('alert', expect.objectContaining({ type: 'temp_high' }));
    });

    // Disco low ────────────────────────────────────────────────────────────
    it('disco livre abaixo do threshold — alerta disk_low', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: JSON.stringify({ cpuPct: 0, cpuTempC: 0, diskFreeGB: 3 }) })]);
      dbMock.getAlerts.mockReturnValue(rule('disk_low', 5));
      alertEngine.checkAll();
      expect(broadcastMock).toHaveBeenCalledWith('alert', expect.objectContaining({
        machineId: 'mach-t',
        type:      'disk_low',
      }));
    });

    it('disco livre acima do threshold — sem alerta disk_low', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: JSON.stringify({ cpuPct: 0, cpuTempC: 0, diskFreeGB: 20 }) })]);
      dbMock.getAlerts.mockReturnValue(rule('disk_low', 5));
      alertEngine.checkAll();
      expect(broadcastMock).not.toHaveBeenCalledWith('alert', expect.objectContaining({ type: 'disk_low' }));
    });

    it('diskFreeGB = 0 não dispara disk_low (sem dados de disco)', () => {
      dbMock.getAllMachines.mockReturnValue([machine({ last_metrics: JSON.stringify({ diskFreeGB: 0 }) })]);
      dbMock.getAlerts.mockReturnValue(rule('disk_low', 5));
      alertEngine.checkAll();
      expect(broadcastMock).not.toHaveBeenCalledWith('alert', expect.objectContaining({ type: 'disk_low' }));
    });
  });

  // ── clearOfflineCooldown ──────────────────────────────────────────────────
  describe('clearOfflineCooldown', () => {
    it('é exportado como função', () => {
      expect(typeof alertEngine.clearOfflineCooldown).toBe('function');
    });

    it('não lança exceção para machineId inexistente no cooldown', () => {
      expect(() => alertEngine.clearOfflineCooldown('nao-existe')).not.toThrow();
    });
  });

  // ── start / stop ──────────────────────────────────────────────────────────
  describe('start / stop', () => {
    it('start não lança exceção', () => {
      jest.useFakeTimers();
      expect(() => alertEngine.start()).not.toThrow();
    });

    it('stop não lança exceção mesmo sem start prévio', () => {
      expect(() => alertEngine.stop()).not.toThrow();
    });

    it('stop após start não lança exceção', () => {
      jest.useFakeTimers();
      alertEngine.start();
      expect(() => alertEngine.stop()).not.toThrow();
    });
  });
});
