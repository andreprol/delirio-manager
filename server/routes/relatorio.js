// server/routes/relatorio.js
'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const router   = express.Router();
const db       = require('../db');
const freshdesk = require('../services/freshdesk');
const { buildStoreContext, callClaude, parseClaudeScore, generateDocx, generatePdf } = require('../services/reportEngine');
const { sendSimpleEmail } = require('../services/nfce-mailer');

// Multer: salva fotos em public/relatorio-photos/ com nome único
const PHOTOS_DIR = path.join(__dirname, '..', 'public', 'relatorio-photos');
fs.mkdirSync(PHOTOS_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PHOTOS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `photo_${Date.now()}_${Math.random().toString(36).slice(2,7)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB

// Parseia o campo photo_path (legado: null | URL única | JSON array)
function parsePhotoPaths(raw) {
  if (!raw) return [];
  if (raw.startsWith('[')) { try { return JSON.parse(raw); } catch { return []; } }
  return [raw]; // URL única legada
}

// POST /api/relatorio/photos — upload de uma foto, retorna URL pública
router.post('/photos', (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      console.error('[relatorio/photos] multer error:', err.message);
      return res.status(400).json({ error: err.message || 'Erro no upload' });
    }
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    res.json({ url: `/relatorio-photos/${req.file.filename}` });
  });
});

// GET /api/relatorio/stores
// Retorna todas as lojas com score mais recente e contagem de tópicos abertos
// ?force=true → força sync Freshdesk antes de retornar
router.get('/stores', async (req, res) => {
  try {
    if (req.query.force === 'true') {
      await freshdesk.syncAll().catch(e => console.warn('[stores] Freshdesk sync failed:', e.message));
    }
    const { countMap, scoreMap } = db.getStoresOverview();
    // Pegar lista de lojas únicas de machines + topics
    // Mapa canônico: normalizado (sem acento, minúsculo) → nome de exibição
    // Prioridade: freshdesk_cache > report_topics > machines
    // Assim "Assembleia" (freshdesk) prevalece sobre "Assembléia" (machines)
    const stripAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const canonical = new Map();
    db.getAllMachines().forEach(m => {
      if (m.location) {
        const k = stripAccents(m.location);
        if (!canonical.has(k)) canonical.set(k, m.location);
      }
    });
    db.getDb().prepare('SELECT DISTINCT store_name FROM report_topics').all()
      .forEach(r => {
        const k = stripAccents(r.store_name);
        if (!canonical.has(k)) canonical.set(k, r.store_name);
      });
    db.getDb().prepare('SELECT DISTINCT store_name FROM freshdesk_cache WHERE store_name IS NOT NULL').all()
      .forEach(r => { canonical.set(stripAccents(r.store_name), r.store_name); }); // freshdesk tem prioridade

    const storeSet = new Set(canonical.values());
    storeSet.delete('Temporário');
    storeSet.delete('Temporario');
    storeSet.delete('Manutenção');
    storeSet.delete('Manutencao');

    const freshdeskRows = db.getDb().prepare(
      `SELECT store_name, COUNT(*) as n FROM freshdesk_cache WHERE store_name IS NOT NULL GROUP BY store_name`
    ).all();
    const freshdeskMap = {};
    freshdeskRows.forEach(r => { freshdeskMap[stripAccents(r.store_name)] = r.n; });

    const stores = [...storeSet].sort().map(name => ({
      name,
      openTopics:     countMap[name] || 0,
      score:          scoreMap[name]?.score ?? null,
      lastReport:     scoreMap[name]?.generatedAt ?? null,
      freshdeskCount: freshdeskMap[stripAccents(name)] ?? 0,
    }));
    res.json(stores);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/relatorio/topics/:store
router.get('/topics/:store', (req, res) => {
  try {
    const topics = db.getTopics(decodeURIComponent(req.params.store));
    // Parsear photo_path como JSON array (pode ser null, string URL única ou JSON array)
    const parsed = topics.map(t => ({ ...t, photo_paths: parsePhotoPaths(t.photo_path) }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/relatorio/topics
router.post('/topics', (req, res) => {
  try {
    const { store_name, description, severity, machine_mention, photo_paths, created_by } = req.body;
    if (!store_name || !description || !severity) {
      return res.status(400).json({ error: 'store_name, description e severity são obrigatórios' });
    }
    // Guardar array de URLs como JSON string no campo photo_path
    const photo_path = photo_paths && photo_paths.length ? JSON.stringify(photo_paths) : null;
    const topic = db.createTopic({ store_name, description, severity, machine_mention, photo_path, created_by });
    res.status(201).json({ ...topic, photo_paths: photo_paths || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/relatorio/topics/:id — editar tópico existente
router.put('/topics/:id', (req, res) => {
  try {
    const { description, severity, machine_mention } = req.body;
    if (!description || !severity) {
      return res.status(400).json({ error: 'description e severity são obrigatórios' });
    }
    // photo_path só é calculado se photo_paths vier no body; undefined = preserva DB
    let photo_path;
    if ('photo_paths' in req.body) {
      const pp = req.body.photo_paths;
      photo_path = pp && pp.length ? JSON.stringify(pp) : null;
    }
    const topic = db.updateTopic(Number(req.params.id), { description, severity, machine_mention, photo_path });
    if (!topic) return res.status(404).json({ error: 'Tópico não encontrado' });
    res.json({ ...topic, photo_paths: parsePhotoPaths(topic.photo_path) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/relatorio/topics/:id  — soft delete → history
router.delete('/topics/:id', (req, res) => {
  try {
    const result = db.resolveTopic(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Tópico não encontrado' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/relatorio/generate
router.post('/generate', async (req, res) => {
  try {
    const { store, month } = req.body;
    if (!store || !month) return res.status(400).json({ error: 'store e month são obrigatórios' });

    // 1. Sync Freshdesk se cache vencido
    await freshdesk.syncIfStale(store).catch(e => console.warn('[relatorio] Freshdesk sync failed:', e.message));

    // 2. Montar contexto
    const ctx = buildStoreContext(store, month);

    // 3. Chamar Claude
    const aiRaw   = await callClaude(ctx);
    const scores  = parseClaudeScore(aiRaw);

    // 4. Gerar documentos
    const docxPath = await generateDocx(ctx, scores, month);
    const pdfPath  = await generatePdf(docxPath).catch(() => null);

    // 5. Salvar run
    const runId = db.saveReportRun({
      store_name:        store,
      month,
      ...scores,
      docx_path: docxPath,
      pdf_path:  pdfPath,
    });

    // 6. Alertar sobre tópicos inconclusivos
    if (scores.inconclusivos && scores.inconclusivos.length > 0) {
      const topicById = {};
      ctx.openTopics.forEach(t => { topicById[t.id] = t; });
      for (const topicId of scores.inconclusivos) {
        const topic = topicById[topicId];
        const descricao = topic ? topic.description : `ID ${topicId}`;
        const html = `<p>O tópico abaixo inserido para a loja <strong>${store}</strong> foi considerado <strong>inconclusivo</strong> pela análise de IA e não pôde contribuir para nenhuma dimensão do relatório.</p>
<table border="1" cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif">
  <tr><td><strong>Loja</strong></td><td>${store}</td></tr>
  <tr><td><strong>Mês</strong></td><td>${month}</td></tr>
  <tr><td><strong>Tópico ID</strong></td><td>${topicId}</td></tr>
  <tr><td><strong>Descrição</strong></td><td>${descricao}</td></tr>
</table>
<p>Por favor, edite o tópico no Delirio Manager com mais detalhes para que possa ser avaliado corretamente no próximo relatório.</p>`;
        sendSimpleEmail(
          'suporteti@delirio.com.br',
          `[Delirio Manager] Tópico inconclusivo — ${store}`,
          html
        ).catch(e => console.warn('[relatorio] falha ao enviar alerta inconclusivo:', e.message));
      }
    }

    // 7. Responder com URLs de download
    const base = '/downloads/relatorios';
    res.json({
      runId,
      score:   scores.score_total,
      docxUrl: `${base}/${path.basename(docxPath)}`,
      pdfUrl:  pdfPath ? `${base}/${path.basename(pdfPath)}` : null,
      scores,
      narrative:       scores.ai_narrative,
      recommendations: scores.ai_recommendations,
    });
  } catch (err) {
    console.error('[relatorio/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/relatorio/feedback
router.post('/feedback', (req, res) => {
  try {
    const { store_name, month, feedback_text, report_run_id } = req.body;
    if (!store_name || !month || !feedback_text) {
      return res.status(400).json({ error: 'store_name, month e feedback_text são obrigatórios' });
    }
    db.saveFeedback({ store_name, month, feedback_text, report_run_id });
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/relatorio/freshdesk/:store — tickets visíveis na UI
router.get('/freshdesk/:store', async (req, res) => {
  try {
    const store = decodeURIComponent(req.params.store);
    await freshdesk.syncIfStale(store).catch(() => {});
    const active = db.getDb().prepare(
      `SELECT ticket_id, title, status, priority, created_at
       FROM freshdesk_cache
       WHERE store_name = ? AND status IN ('open','pending')
       ORDER BY created_at DESC`
    ).all(store);
    const closed = db.getDb().prepare(
      `SELECT ticket_id, title, status, priority, created_at, resolved_at
       FROM freshdesk_cache
       WHERE store_name = ? AND status IN ('resolved','closed')
       ORDER BY resolved_at DESC LIMIT 20`
    ).all(store);
    res.json({ active, closed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/relatorio/history/:store
router.get('/history/:store', (req, res) => {
  try {
    const history = db.getReportHistory(decodeURIComponent(req.params.store));
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/relatorio/freshdesk-debug
// Diagnóstico: mostra config, cache atual e tenta sync forçado
router.get('/freshdesk-debug', async (req, res) => {
  try {
    let cfg = {};
    try { cfg = require('../config.json').freshdesk || {}; } catch {}

    // Cache atual
    const cached = db.getDb().prepare('SELECT COUNT(*) as total FROM freshdesk_cache').get();
    const sample = db.getDb().prepare('SELECT * FROM freshdesk_cache LIMIT 5').all();

    // Tentar sync forçado e capturar resultado bruto
    let syncResult = null;
    let syncError  = null;
    try {
      syncResult = await freshdesk.syncAll();
    } catch (e) {
      syncError = e.message;
    }

    // Após sync, ver o que ficou no cache
    const afterSync = db.getDb().prepare('SELECT COUNT(*) as total FROM freshdesk_cache').get();
    const afterSample = db.getDb().prepare('SELECT store_name, status, title FROM freshdesk_cache LIMIT 10').all();

    res.json({
      config: { domain: cfg.domain, api_key_set: !!cfg.api_key, api_key_length: (cfg.api_key || '').length },
      cache_before: { total: cached.total, sample },
      sync: syncResult !== null ? { count: syncResult } : { error: syncError },
      cache_after: { total: afterSync.total, sample: afterSample },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
