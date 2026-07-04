// server/routes/relatorio.js
'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const router   = express.Router();
const db       = require('../db');
const freshdesk = require('../services/freshdesk');
const { buildStoreContext, callClaude, parseClaudeScore, generateDocx, generatePdf } = require('../services/reportEngine');

// GET /api/relatorio/stores
// Retorna todas as lojas com score mais recente e contagem de tópicos abertos
router.get('/stores', (req, res) => {
  try {
    const { countMap, scoreMap } = db.getStoresOverview();
    // Pegar lista de lojas únicas de machines + topics
    const storeSet = new Set();
    db.getAllMachines().forEach(m => { if (m.location) storeSet.add(m.location); });
    db.getDb().prepare('SELECT DISTINCT store_name FROM report_topics').all()
      .forEach(r => storeSet.add(r.store_name));
    db.getDb().prepare('SELECT DISTINCT store_name FROM freshdesk_cache WHERE store_name IS NOT NULL').all()
      .forEach(r => storeSet.add(r.store_name));

    const stores = [...storeSet].sort().map(name => ({
      name,
      openTopics: countMap[name] || 0,
      score: scoreMap[name]?.score ?? null,
      lastReport: scoreMap[name]?.generatedAt ?? null,
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
    res.json(topics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/relatorio/topics
router.post('/topics', (req, res) => {
  try {
    const { store_name, description, severity, machine_mention, photo_path, created_by } = req.body;
    if (!store_name || !description || !severity) {
      return res.status(400).json({ error: 'store_name, description e severity são obrigatórios' });
    }
    const topic = db.createTopic({ store_name, description, severity, machine_mention, photo_path, created_by });
    res.status(201).json(topic);
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

    // 6. Responder com URLs de download
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

// GET /api/relatorio/history/:store
router.get('/history/:store', (req, res) => {
  try {
    const history = db.getReportHistory(decodeURIComponent(req.params.store));
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
