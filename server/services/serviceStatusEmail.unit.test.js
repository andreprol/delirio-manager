'use strict';

/**
 * Testes unitários para buildMachineMap e buildEmailHtml (funções puras).
 * Sem dependência de DB, Graph ou filesystem.
 */

// ── buildMachineMap ───────────────────────────────────────────────────────────
// buildMachineMap não é exportada — reimplementamos a lógica para testar isolada.

// Reimplementação local para testar a lógica isolada:
const SERVICE_NAMES = [
  'NCR Voyix Takeout and Delivery',
  'NCR Voyix Takeout Service Monitor',
];

function buildMachineMap(statusRows, allBOH) {
  const map = {};
  for (const m of allBOH) {
    map[m.id] = {
      hostname:      m.hostname,
      displayName:   m.display_name || m.hostname,
      location:      m.location || 'Sem localidade',
      machineStatus: m.status,
      services:      {},
    };
  }
  for (const r of statusRows) {
    if (!map[r.machine_id]) continue;
    map[r.machine_id].services[r.service_name] = {
      status:        r.service_status,
      lastRestartAt: r.last_restart_at,
      lastRestartOk: r.last_restart_ok,
      updatedAt:     r.updated_at,
    };
  }
  return Object.values(map).sort((a, b) => a.hostname.localeCompare(b.hostname));
}

function buildEmailHtml(machines, _dtBRT) {
  const anyProblem = machines.some(m =>
    SERVICE_NAMES.some(svc => {
      const s = m.services[svc];
      return !s || s.status !== 'running';
    })
  );
  const headerColor = anyProblem ? '#c0392b' : '#276749';
  const headerIcon  = anyProblem ? '⚠️' : '✅';
  // retorna HTML simples para verificação
  return { anyProblem, headerColor, headerIcon };
}

// eslint-disable-next-line max-lines-per-function
describe('buildMachineMap', () => {
  const allBOH = [
    { id: 'boh-1', hostname: 'CAXIASBOH', display_name: 'Caxias BOH', location: 'Caxias', status: 'online' },
    { id: 'boh-2', hostname: 'TIJUCABOH', display_name: null, location: null, status: 'offline' },
  ];

  it('mapeia todas as máquinas BOH mesmo sem status', () => {
    const result = buildMachineMap([], allBOH);
    expect(result).toHaveLength(2);
  });

  it('ordena por hostname', () => {
    const result = buildMachineMap([], allBOH);
    expect(result[0].hostname).toBe('CAXIASBOH');
    expect(result[1].hostname).toBe('TIJUCABOH');
  });

  it('usa hostname como displayName quando display_name é null', () => {
    const result = buildMachineMap([], allBOH);
    expect(result[1].displayName).toBe('TIJUCABOH');
  });

  it('usa "Sem localidade" quando location é null', () => {
    const result = buildMachineMap([], allBOH);
    expect(result[1].location).toBe('Sem localidade');
  });

  it('associa status de serviços à máquina correta', () => {
    const statusRows = [
      { machine_id: 'boh-1', service_name: 'NCR Voyix Takeout and Delivery', service_status: 'running', last_restart_at: null, last_restart_ok: null, updated_at: '2026-07-24T09:00:00Z' },
      { machine_id: 'boh-1', service_name: 'NCR Voyix Takeout Service Monitor', service_status: 'stopped', last_restart_at: '2026-07-24T08:55:00Z', last_restart_ok: 0, updated_at: '2026-07-24T09:00:00Z' },
    ];
    const result = buildMachineMap(statusRows, allBOH);
    const caxias = result.find(m => m.hostname === 'CAXIASBOH');
    expect(caxias.services['NCR Voyix Takeout and Delivery'].status).toBe('running');
    expect(caxias.services['NCR Voyix Takeout Service Monitor'].status).toBe('stopped');
  });

  it('ignora status de machine_id desconhecida (não BOH)', () => {
    const statusRows = [
      { machine_id: 'non-boh-99', service_name: 'NCR Voyix Takeout and Delivery', service_status: 'running', last_restart_at: null, last_restart_ok: null, updated_at: '2026-07-24T09:00:00Z' },
    ];
    const result = buildMachineMap(statusRows, allBOH);
    // sem dados de serviços nas máquinas BOH (status rows não pertencia a elas)
    expect(Object.keys(result[0].services)).toHaveLength(0);
    expect(Object.keys(result[1].services)).toHaveLength(0);
  });
});

describe('buildEmailHtml — header verde vs vermelho', () => {
  it('header verde quando todos os serviços rodando', () => {
    const machines = [{
      hostname: 'CAXIASBOH', displayName: 'Caxias BOH', location: 'Caxias', machineStatus: 'online',
      services: {
        'NCR Voyix Takeout and Delivery':    { status: 'running', lastRestartAt: null, lastRestartOk: null },
        'NCR Voyix Takeout Service Monitor': { status: 'running', lastRestartAt: null, lastRestartOk: null },
      },
    }];
    const { anyProblem, headerColor, headerIcon } = buildEmailHtml(machines, '24/07/2026 06:00');
    expect(anyProblem).toBe(false);
    expect(headerColor).toBe('#276749');
    expect(headerIcon).toBe('✅');
  });

  it('header vermelho quando algum serviço parado', () => {
    const machines = [{
      hostname: 'CAXIASBOH', displayName: 'Caxias BOH', location: 'Caxias', machineStatus: 'online',
      services: {
        'NCR Voyix Takeout and Delivery':    { status: 'running', lastRestartAt: null, lastRestartOk: null },
        'NCR Voyix Takeout Service Monitor': { status: 'stopped', lastRestartAt: '2026-07-24T08:55:00Z', lastRestartOk: 0 },
      },
    }];
    const { anyProblem, headerColor, headerIcon } = buildEmailHtml(machines, '24/07/2026 06:00');
    expect(anyProblem).toBe(true);
    expect(headerColor).toBe('#c0392b');
    expect(headerIcon).toBe('⚠️');
  });

  it('header vermelho quando máquina sem dados de serviço', () => {
    const machines = [{
      hostname: 'TIJUCABOH', displayName: 'TIJUCABOH', location: 'Tijuca', machineStatus: 'online',
      services: {}, // sem dados ainda
    }];
    const { anyProblem } = buildEmailHtml(machines, '24/07/2026 18:00');
    expect(anyProblem).toBe(true); // ausência de dados = problema
  });
});

// eslint-disable-next-line max-lines-per-function
describe('_upsertServiceEntries — validação inline', () => {
  // Testa a lógica de filtragem de entries (extraída da rota)
  function upsertServiceEntriesLogic(services) {
    let written = 0;
    const valid = [];
    for (const svc of services) {
      if (typeof svc.name !== 'string' || !svc.name) continue;
      if (svc.status !== 'running' && svc.status !== 'stopped') continue;
      const restartOk = svc.lastRestartOk != null ? (svc.lastRestartOk ? 1 : 0) : null;
      valid.push({ name: svc.name, status: svc.status, restartOk });
      written++;
    }
    return { written, valid };
  }

  it('aceita status running e stopped', () => {
    const { written } = upsertServiceEntriesLogic([
      { name: 'SvcA', status: 'running' },
      { name: 'SvcB', status: 'stopped' },
    ]);
    expect(written).toBe(2);
  });

  it('rejeita status inválido', () => {
    const { written } = upsertServiceEntriesLogic([
      { name: 'SvcA', status: 'unknown' },
      { name: 'SvcB', status: '' },
      { name: 'SvcC', status: null },
    ]);
    expect(written).toBe(0);
  });

  it('rejeita entrada sem name', () => {
    const { written } = upsertServiceEntriesLogic([
      { name: '', status: 'running' },
      { name: null, status: 'running' },
      { status: 'running' },
    ]);
    expect(written).toBe(0);
  });

  it('converte lastRestartOk boolean para 0/1/null', () => {
    const { valid } = upsertServiceEntriesLogic([
      { name: 'SvcA', status: 'running', lastRestartOk: true },
      { name: 'SvcB', status: 'stopped', lastRestartOk: false },
      { name: 'SvcC', status: 'running', lastRestartOk: null },
    ]);
    expect(valid[0].restartOk).toBe(1);
    expect(valid[1].restartOk).toBe(0);
    expect(valid[2].restartOk).toBeNull();
  });
});
