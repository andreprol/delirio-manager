'use strict';

/**
 * Testes do cursor incremental do InsightEngine — garante que a análise
 * não reprocessa eventos já vistos a cada ciclo (bug real: janela fixa de
 * 7 dias reenviava ~96% de dados repetidos, custou US$107,62 num dia só
 * num projeto irmão — ver feedback_sync_sem_diff_incremental_explode_custo).
 *
 * Fase 4 (cutover): rodava contra SQLite `:memory:` real via `../db`; agora
 * roda contra Postgres real (`../db-pg`, mesmo padrão dos db-pg.*.test.js
 * da Fase 2) — pula sozinho se DATABASE_URL não setada.
 */

const crypto = require('crypto');

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

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[insightEngine.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

function okResponse(insights = []) {
  return { content: [{ text: JSON.stringify({ insights }) }] };
}

describeDb('analyzeMachine — cursor incremental', () => {
  let db, insightEngine;
  const createdMachineIds = [];

  beforeAll(() => {
    db = require('../db-pg');
    insightEngine = require('./insightEngine');
  });

  afterEach(async () => {
    mockCreate.mockReset();
    const pool = db.getPool();
    while (createdMachineIds.length) {
      await pool.query('DELETE FROM machines WHERE id=$1', [createdMachineIds.pop()]); // cascade apaga win_events
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  async function registerMachine() {
    const machineId = crypto.randomUUID();
    createdMachineIds.push(machineId);
    await db.registerMachine({ machineId, hostname: `PC1-${machineId.slice(0, 8)}`, agentVersion: '1.0' });
    return machineId;
  }

  async function insertWinEvent(machineId, eventId, translation, level = 'critical') {
    await db.getPool().query(
      `INSERT INTO win_events (machine_id, event_time, event_id, source, level, translation)
       VALUES ($1, $2, $3, 'System', $4, $5)`,
      [machineId, new Date().toISOString(), eventId, level, translation]
    );
  }

  it('1ª rodada processa o evento existente e avança o cursor', async () => {
    const m1 = await registerMachine();
    await insertWinEvent(m1, 41, 'Reinicio inesperado');

    mockCreate.mockResolvedValue(okResponse());

    const machine = await db.getMachineById(m1);
    const generated = await insightEngine.analyzeMachine(machine, { claude_api_key: 'test-key' });

    expect(generated).toBe(0); // 0 insights relevantes, mas processou
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const after = await db.getMachineById(m1);
    expect(after.last_win_event_id).toBeGreaterThan(0);
  });

  it('2ª rodada sem evento novo NÃO chama a API (0 chamadas)', async () => {
    const m1 = await registerMachine();
    await insertWinEvent(m1, 41, 'Reinicio inesperado');

    mockCreate.mockResolvedValue(okResponse());
    await insightEngine.analyzeMachine(await db.getMachineById(m1), { claude_api_key: 'test-key' });
    mockCreate.mockClear();

    // 2ª rodada: mesmo estado, nenhum evento novo desde o cursor salvo
    const generated = await insightEngine.analyzeMachine(await db.getMachineById(m1), { claude_api_key: 'test-key' });

    expect(generated).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('evento novo após a 1ª rodada é processado isoladamente na 2ª', async () => {
    const m1 = await registerMachine();
    await insertWinEvent(m1, 41, 'Reinicio inesperado');

    mockCreate.mockResolvedValue(okResponse());
    await insightEngine.analyzeMachine(await db.getMachineById(m1), { claude_api_key: 'test-key' });
    mockCreate.mockClear();

    await insertWinEvent(m1, 1001, 'BSOD');

    await insightEngine.analyzeMachine(await db.getMachineById(m1), { claude_api_key: 'test-key' });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('BSOD');
    expect(prompt).not.toContain('Reinicio inesperado'); // não reenvia o já processado
  });

  it('falha na API não avança o cursor — evento é reprocessado no próximo ciclo', async () => {
    const m1 = await registerMachine();
    await insertWinEvent(m1, 41, 'Reinicio inesperado');

    mockCreate.mockRejectedValue(new Error('API indisponivel'));
    await insightEngine.analyzeMachine(await db.getMachineById(m1), { claude_api_key: 'test-key' });

    const after = await db.getMachineById(m1);
    expect(after.last_win_event_id).toBe(0); // cursor NÃO avançou

    mockCreate.mockClear();
    mockCreate.mockResolvedValue(okResponse());
    await insightEngine.analyzeMachine(await db.getMachineById(m1), { claude_api_key: 'test-key' });

    expect(mockCreate).toHaveBeenCalledTimes(1); // reprocessou o mesmo evento
  });

  it('backlog maior que o LIMIT do prompt (150) não fica preso pra sempre', async () => {
    // Regressão do achado do review: avançar o cursor pro MAX(id) da query
    // DESC+LIMIT é idêntico a avançar pro MAX da tabela (o id mais alto
    // sempre entra no topo do DESC) — perderia tudo que ficasse de fora do
    // LIMIT. O fix busca o backlog inteiro pro cálculo do cursor e só
    // trunca pro prompt depois.
    const m1 = await registerMachine();
    for (let i = 1; i <= 160; i++) await insertWinEvent(m1, i, `evento-${i}`, 'info');

    // instância compartilhada: o id (PK identity) não é 1..160 consecutivo --
    // outros workers de teste inserem em paralelo na mesma sequence global.
    // O que importa é o MAX(id) de verdade entre AS LINHAS DESTA máquina,
    // não a contagem de linhas inseridas.
    const { rows: [{ max_id: expectedMaxId }] } = await db.getPool()
      .query('SELECT MAX(id) AS max_id FROM win_events WHERE machine_id=$1', [m1]);

    mockCreate.mockResolvedValue(okResponse());
    await insightEngine.analyzeMachine(await db.getMachineById(m1), { claude_api_key: 'test-key' });

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('evento-160'); // mais recente entra no prompt
    expect(prompt).not.toContain('evento-1\n'); // mais antigo fica de fora do prompt (sinal)

    const after = await db.getMachineById(m1);
    expect(after.last_win_event_id).toBe(expectedMaxId); // cursor cobre TODO o backlog

    // Próxima rodada: nada ficou "esquecido" acima do LIMIT — 0 chamadas.
    mockCreate.mockClear();
    const generated = await insightEngine.analyzeMachine(await db.getMachineById(m1), { claude_api_key: 'test-key' });
    expect(generated).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('máquina sem nenhum evento não chama a API', async () => {
    const m1 = await registerMachine();

    const generated = await insightEngine.analyzeMachine(await db.getMachineById(m1), { claude_api_key: 'test-key' });

    expect(generated).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
