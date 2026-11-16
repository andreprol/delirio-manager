'use strict';

/**
 * Testes do Grupo 9 (Ref1 Registry + Módulo Relatório: report_topics*,
 * freshdesk_cache, report_runs, report_feedback) de server/db-pg.js
 * contra um Postgres real (instância dev). Nenhuma dessas tabelas tem FK
 * pra machines -- limpeza manual por store/id únicos em afterEach.
 */

const crypto = require('crypto');

const hasDb = !!process.env.DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;

if (!hasDb) {
  console.warn('[db-pg.relatorio.test] DATABASE_URL não setada -- suite pulada (ver .env.postgres.example)');
}

describeDb('db-pg (Grupo 9: Ref1 Registry + Módulo Relatório)', () => {
  let db;
  const createdStores = [];
  const createdRef1s = [];

  beforeAll(() => {
    db = require('./db-pg');
  });

  afterEach(async () => {
    const pool = db.getPool();
    while (createdRef1s.length) {
      await pool.query('DELETE FROM ref1_registry WHERE ref1=$1', [createdRef1s.pop()]);
    }
    while (createdStores.length) {
      const store = createdStores.pop();
      await pool.query('DELETE FROM report_topics WHERE store_name=$1', [store]);
      await pool.query('DELETE FROM report_topics_history WHERE store_name=$1', [store]);
      await pool.query('DELETE FROM freshdesk_cache WHERE store_name=$1', [store]);
      await pool.query('DELETE FROM report_runs WHERE store_name=$1', [store]);
      await pool.query('DELETE FROM report_feedback WHERE store_name=$1', [store]);
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  function trackStore() {
    const store = `TEST-LOJA-${crypto.randomUUID().slice(0, 8)}`;
    createdStores.push(store);
    return store;
  }

  describe('registerRef1 / getMaxRef1', () => {
    it('registra e ON CONFLICT ignora duplicata; getMaxRef1 reflete o maior', async () => {
      const n1 = 900001 + Math.floor(Math.random() * 1000);
      createdRef1s.push(n1);
      await db.registerRef1({ ref1: n1, cpf: '11111111111', name: 'Fulano' });
      await db.registerRef1({ ref1: n1, cpf: '22222222222', name: 'Outro' }); // duplicata, ignorada

      const { rows } = await db.getPool().query('SELECT cpf FROM ref1_registry WHERE ref1=$1', [n1]);
      expect(rows[0].cpf).toBe('11111111111'); // não sobrescreveu

      const max = await db.getMaxRef1();
      expect(max).toBeGreaterThanOrEqual(n1);
      expect(typeof max).toBe('number');
    });

    it('ref1 inválido (0, negativo, não numérico) é noop', async () => {
      await expect(db.registerRef1({ ref1: 0, cpf: 'x', name: 'y' })).resolves.toBeUndefined();
      await expect(db.registerRef1({ ref1: -5, cpf: 'x', name: 'y' })).resolves.toBeUndefined();
      await expect(db.registerRef1({ ref1: 'abc', cpf: 'x', name: 'y' })).resolves.toBeUndefined();
    });
  });

  describe('isCriticalMachine', () => {
    it('TERM/BOH (case-insensitive) é crítico, outros não', () => {
      expect(db.isCriticalMachine('TERM-01')).toBe(true);
      expect(db.isCriticalMachine('boh-caixa')).toBe(true);
      expect(db.isCriticalMachine('  term-02  ')).toBe(true); // trim
      expect(db.isCriticalMachine('PDV-01')).toBe(false);
      expect(db.isCriticalMachine(null)).toBe(false);
      expect(db.isCriticalMachine('')).toBe(false);
    });
  });

  describe('createTopic / getTopics / updateTopic / moveTopic / resolveTopic / replicateTopic / getTopicsHistory', () => {
    it('createTopic (RETURNING *) marca is_critical_machine via machine_mention', async () => {
      const store = trackStore();
      const topic = await db.createTopic({
        store_name: store, description: 'Impressora falhando', severity: 'alta', machine_mention: 'BOH-02',
      });
      expect(topic.is_critical_machine).toBe(1);
      expect(topic.created_by).toBe('TI'); // default
    });

    it('getTopics ordena por severidade (critica > alta > media > baixa) e created_at DESC', async () => {
      const store = trackStore();
      await db.createTopic({ store_name: store, description: 'baixa', severity: 'baixa' });
      await db.createTopic({ store_name: store, description: 'critica', severity: 'critica' });
      await db.createTopic({ store_name: store, description: 'alta', severity: 'alta' });

      const topics = await db.getTopics(store);
      expect(topics.map(t => t.severity)).toEqual(['critica', 'alta', 'baixa']);
    });

    it('updateTopic: photo_path undefined preserva, null limpa, string troca', async () => {
      const store = trackStore();
      const created = await db.createTopic({
        store_name: store, description: 'original', severity: 'media', photo_path: 'foto1.jpg',
      });

      const unchanged = await db.updateTopic(created.id, { description: 'editado', severity: 'media' });
      expect(unchanged.photo_path).toBe('foto1.jpg'); // undefined -- preservou

      const cleared = await db.updateTopic(created.id, { description: 'editado2', severity: 'media', photo_path: null });
      expect(cleared.photo_path).toBeNull();

      const replaced = await db.updateTopic(created.id, { description: 'editado3', severity: 'media', photo_path: 'foto2.jpg' });
      expect(replaced.photo_path).toBe('foto2.jpg');
    });

    it('moveTopic muda store_name e devolve null se id não existir', async () => {
      const storeA = trackStore();
      const storeB = trackStore();
      const topic = await db.createTopic({ store_name: storeA, description: 'x', severity: 'media' });

      const moved = await db.moveTopic(topic.id, storeB);
      expect(moved.store_name).toBe(storeB);

      expect(await db.moveTopic(999999999, storeB)).toBeNull();
    });

    it('resolveTopic migra pra report_topics_history e remove de report_topics', async () => {
      const store = trackStore();
      const topic = await db.createTopic({ store_name: store, description: 'resolver', severity: 'alta' });

      const result = await db.resolveTopic(topic.id);
      expect(result).toEqual({ resolved: true });
      expect(await db.getTopics(store)).toHaveLength(0);

      const history = await db.getTopicsHistory(store, 6);
      expect(history).toHaveLength(1);
      expect(history[0].description).toBe('resolver');
      expect(history[0].original_topic_id).toBe(topic.id);
    });

    it('resolveTopic com id inexistente devolve null sem criar histórico', async () => {
      expect(await db.resolveTopic(999999999)).toBeNull();
    });

    it('replicateTopic cria uma cópia por loja destino, devolve null se original não existe', async () => {
      const storeOrigin = trackStore();
      const storeB = trackStore();
      const storeC = trackStore();
      const topic = await db.createTopic({ store_name: storeOrigin, description: 'replicar', severity: 'media' });

      const created = await db.replicateTopic(topic.id, [storeB, storeC]);
      expect(created).toHaveLength(2);
      expect(await db.getTopics(storeB)).toHaveLength(1);
      expect(await db.getTopics(storeC)).toHaveLength(1);

      expect(await db.replicateTopic(999999999, [storeB])).toBeNull();
    });
  });

  describe('getAllStoresTopicCount', () => {
    it('agrupa por loja com count Number (não bigint-string)', async () => {
      const store = trackStore();
      await db.createTopic({ store_name: store, description: 'a', severity: 'media' });
      await db.createTopic({ store_name: store, description: 'b', severity: 'media' });

      const counts = await db.getAllStoresTopicCount();
      const mine = counts.find(c => c.store_name === store);
      expect(mine.count).toBe(2);
      expect(typeof mine.count).toBe('number');
    });
  });

  describe('Freshdesk cache', () => {
    it('getFreshdeskCacheAge Infinity quando nunca cacheado, número de horas quando tem', async () => {
      const store = trackStore();
      expect(await db.getFreshdeskCacheAge(store)).toBe(Infinity);

      await db.upsertFreshdeskTickets([{
        ticket_id: 900000 + Math.floor(Math.random() * 10000),
        store_name: store, title: 'T1', status: 'open', priority: 'high',
        created_at: '2026-03-01', resolved_at: null,
      }]);

      const age = await db.getFreshdeskCacheAge(store);
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(1);
    });

    it('upsertFreshdeskTickets com ON CONFLICT atualiza em vez de duplicar', async () => {
      const store = trackStore();
      const ticketId = 910000 + Math.floor(Math.random() * 10000);
      await db.upsertFreshdeskTickets([{
        ticket_id: ticketId, store_name: store, title: 'Original', status: 'open', priority: 'low',
        created_at: '2026-01-01', resolved_at: null,
      }]);
      await db.upsertFreshdeskTickets([{
        ticket_id: ticketId, store_name: store, title: 'Atualizado', status: 'closed', priority: 'low',
        created_at: '2026-01-01', resolved_at: '2026-01-02',
      }]);

      const { rows } = await db.getPool().query('SELECT title, status FROM freshdesk_cache WHERE ticket_id=$1', [ticketId]);
      expect(rows).toHaveLength(1); // não duplicou
      expect(rows[0].title).toBe('Atualizado');
      expect(rows[0].status).toBe('closed');
    });

    it('getFreshdeskActive/getFreshdeskClosed filtram por status e mês (substr)', async () => {
      const store = trackStore();
      await db.upsertFreshdeskTickets([
        {
          ticket_id: 920001 + Math.floor(Math.random() * 1000), store_name: store, title: 'Aberto',
          status: 'open', priority: 'low', created_at: '2026-05-10', resolved_at: null,
        },
        {
          ticket_id: 930001 + Math.floor(Math.random() * 1000), store_name: store, title: 'Fechado',
          status: 'closed', priority: 'low', created_at: '2026-04-01', resolved_at: '2026-05-20',
        },
      ]);

      const active = await db.getFreshdeskActive(store, '2026-05');
      expect(active.map(t => t.title)).toEqual(['Aberto']);

      const closed = await db.getFreshdeskClosed(store, '2026-05');
      expect(closed.map(t => t.title)).toEqual(['Fechado']);
    });
  });

  describe('Report runs', () => {
    it('saveReportRun (RETURNING id) + getReportHistory + getRecentReportRun (dedup)', async () => {
      const store = trackStore();
      const id = await db.saveReportRun({
        store_name: store, month: '2026-06', score_total: 85, score_hardware: 90,
        score_software: 80, score_connectivity: 95, score_security: 70, score_incidents: 100,
        score_operational: 88, ai_narrative: 'tudo bem', ai_recommendations: ['trocar HD'],
        docx_path: 'a.docx', pdf_path: 'a.pdf',
      });
      expect(typeof id).toBe('number');

      const history = await db.getReportHistory(store);
      expect(history).toHaveLength(1);
      expect(JSON.parse(history[0].ai_recommendations)).toEqual(['trocar HD']);

      const recent = await db.getRecentReportRun(store, '2026-06', 60);
      expect(recent.id).toBe(id);

      expect(await db.getRecentReportRun(store, '2026-07', 60)).toBeUndefined(); // mês diferente
    });
  });

  describe('Feedback', () => {
    it('saveFeedback + getRecentFeedback respeitando limit', async () => {
      const store = trackStore();
      await db.saveFeedback({ store_name: store, month: '2026-06', feedback_text: 'ótimo', report_run_id: null });
      await db.saveFeedback({ store_name: store, month: '2026-06', feedback_text: 'podia melhorar', report_run_id: null });

      const feedback = await db.getRecentFeedback(store, 1);
      expect(feedback).toHaveLength(1);
      expect(feedback[0].feedback_text).toBe('podia melhorar'); // mais recente
    });
  });

  describe('getStoresOverview', () => {
    it('combina contagem de topics com o score do report_run mais recente por loja', async () => {
      const store = trackStore();
      await db.createTopic({ store_name: store, description: 'x', severity: 'media' });
      await db.saveReportRun({ store_name: store, month: '2026-06', score_total: 77 });

      const overview = await db.getStoresOverview();
      expect(overview.countMap[store]).toBe(1);
      expect(overview.scoreMap[store].score).toBe(77);
    });
  });
});
