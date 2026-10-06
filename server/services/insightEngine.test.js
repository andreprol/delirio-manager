'use strict';

/**
 * Testes do cursor incremental do InsightEngine — garante que a análise
 * não reprocessa eventos já vistos a cada ciclo (bug real: janela fixa de
 * 7 dias reenviava ~96% de dados repetidos, custou US$107,62 num dia só
 * num projeto irmão — ver feedback_sync_sem_diff_incremental_explode_custo).
 */

const mockCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  class MockAPIError extends Error {}
  return {
    default: jest.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    APIError: MockAPIError,
  };
});

function makeEnv() {
  jest.resetModules();
  process.env.DB_PATH = ':memory:';
  const db = require('../db');
  const insightEngine = require('./insightEngine');
  return { db, insightEngine };
}

afterEach(() => {
  delete process.env.DB_PATH;
  mockCreate.mockReset();
});

function okResponse(insights = []) {
  return { content: [{ text: JSON.stringify({ insights }) }] };
}

describe('analyzeMachine — cursor incremental', () => {
  it('1ª rodada processa o evento existente e avança o cursor', async () => {
    const { db, insightEngine } = makeEnv();
    db.registerMachine({ machineId: 'm1', hostname: 'PC1', agentVersion: '1.0' });
    db.getDb().prepare(`
      INSERT INTO win_events (machine_id, event_time, event_id, source, level, translation)
      VALUES ('m1', datetime('now'), 41, 'System', 'critical', 'Reinicio inesperado')
    `).run();

    mockCreate.mockResolvedValue(okResponse());

    const machine = db.getMachineById('m1');
    const generated = await insightEngine.analyzeMachine(machine, { claude_api_key: 'test-key' });

    expect(generated).toBe(0); // 0 insights relevantes, mas processou
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const after = db.getMachineById('m1');
    expect(after.last_win_event_id).toBeGreaterThan(0);
  });

  it('2ª rodada sem evento novo NÃO chama a API (0 chamadas)', async () => {
    const { db, insightEngine } = makeEnv();
    db.registerMachine({ machineId: 'm1', hostname: 'PC1', agentVersion: '1.0' });
    db.getDb().prepare(`
      INSERT INTO win_events (machine_id, event_time, event_id, source, level, translation)
      VALUES ('m1', datetime('now'), 41, 'System', 'critical', 'Reinicio inesperado')
    `).run();

    mockCreate.mockResolvedValue(okResponse());
    await insightEngine.analyzeMachine(db.getMachineById('m1'), { claude_api_key: 'test-key' });
    mockCreate.mockClear();

    // 2ª rodada: mesmo estado, nenhum evento novo desde o cursor salvo
    const generated = await insightEngine.analyzeMachine(db.getMachineById('m1'), { claude_api_key: 'test-key' });

    expect(generated).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('evento novo após a 1ª rodada é processado isoladamente na 2ª', async () => {
    const { db, insightEngine } = makeEnv();
    db.registerMachine({ machineId: 'm1', hostname: 'PC1', agentVersion: '1.0' });
    db.getDb().prepare(`
      INSERT INTO win_events (machine_id, event_time, event_id, source, level, translation)
      VALUES ('m1', datetime('now'), 41, 'System', 'critical', 'Reinicio inesperado')
    `).run();

    mockCreate.mockResolvedValue(okResponse());
    await insightEngine.analyzeMachine(db.getMachineById('m1'), { claude_api_key: 'test-key' });
    mockCreate.mockClear();

    db.getDb().prepare(`
      INSERT INTO win_events (machine_id, event_time, event_id, source, level, translation)
      VALUES ('m1', datetime('now'), 1001, 'System', 'critical', 'BSOD')
    `).run();

    await insightEngine.analyzeMachine(db.getMachineById('m1'), { claude_api_key: 'test-key' });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('BSOD');
    expect(prompt).not.toContain('Reinicio inesperado'); // não reenvia o já processado
  });

  it('falha na API não avança o cursor — evento é reprocessado no próximo ciclo', async () => {
    const { db, insightEngine } = makeEnv();
    db.registerMachine({ machineId: 'm1', hostname: 'PC1', agentVersion: '1.0' });
    db.getDb().prepare(`
      INSERT INTO win_events (machine_id, event_time, event_id, source, level, translation)
      VALUES ('m1', datetime('now'), 41, 'System', 'critical', 'Reinicio inesperado')
    `).run();

    mockCreate.mockRejectedValue(new Error('API indisponivel'));
    await insightEngine.analyzeMachine(db.getMachineById('m1'), { claude_api_key: 'test-key' });

    const after = db.getMachineById('m1');
    expect(after.last_win_event_id).toBe(0); // cursor NÃO avançou

    mockCreate.mockClear();
    mockCreate.mockResolvedValue(okResponse());
    await insightEngine.analyzeMachine(db.getMachineById('m1'), { claude_api_key: 'test-key' });

    expect(mockCreate).toHaveBeenCalledTimes(1); // reprocessou o mesmo evento
  });

  it('backlog maior que o LIMIT do prompt (150) não fica preso pra sempre', async () => {
    // Regressão do achado do review: avançar o cursor pro MAX(id) da query
    // DESC+LIMIT é idêntico a avançar pro MAX da tabela (o id mais alto
    // sempre entra no topo do DESC) — perderia tudo que ficasse de fora do
    // LIMIT. O fix busca o backlog inteiro pro cálculo do cursor e só
    // trunca pro prompt depois.
    const { db, insightEngine } = makeEnv();
    db.registerMachine({ machineId: 'm1', hostname: 'PC1', agentVersion: '1.0' });
    const insert = db.getDb().prepare(`
      INSERT INTO win_events (machine_id, event_time, event_id, source, level, translation)
      VALUES ('m1', datetime('now'), ?, 'System', 'info', ?)
    `);
    for (let i = 1; i <= 160; i++) insert.run(i, `evento-${i}`);

    mockCreate.mockResolvedValue(okResponse());
    await insightEngine.analyzeMachine(db.getMachineById('m1'), { claude_api_key: 'test-key' });

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('evento-160'); // mais recente entra no prompt
    expect(prompt).not.toContain('evento-1\n'); // mais antigo fica de fora do prompt (sinal)

    const after = db.getMachineById('m1');
    expect(after.last_win_event_id).toBe(160); // mas o cursor cobre TODO o backlog

    // Próxima rodada: nada ficou "esquecido" acima do LIMIT — 0 chamadas.
    mockCreate.mockClear();
    const generated = await insightEngine.analyzeMachine(db.getMachineById('m1'), { claude_api_key: 'test-key' });
    expect(generated).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('máquina sem nenhum evento não chama a API', async () => {
    const { db, insightEngine } = makeEnv();
    db.registerMachine({ machineId: 'm1', hostname: 'PC1', agentVersion: '1.0' });

    const generated = await insightEngine.analyzeMachine(db.getMachineById('m1'), { claude_api_key: 'test-key' });

    expect(generated).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
