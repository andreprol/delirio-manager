'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db-pg');
const { internalAuth } = require('../middleware/internalAuth');
const { asyncHandler } = require('../middleware/asyncHandler');

// GET /api/insights?machine_id=X&limit=50
router.get('/', asyncHandler(async (req, res) => {
  const { machine_id, limit } = req.query;
  try {
    const insights = await db.getInsights({
      machineId: machine_id || null,
      limit:     parseInt(limit) || 50,
    });
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// PUT /api/insights/:id/read
router.put('/:id/read', asyncHandler(async (req, res) => {
  await db.markInsightRead(parseInt(req.params.id));
  res.json({ ok: true });
}));

// POST /api/insights/generate  — manual trigger (debug/test)
// Protegido: dispara chamada paga à API da Anthropic pra todas as máquinas.
router.post('/generate', internalAuth, async (req, res) => {
  try {
    const insightEngine = require('../services/insightEngine');
    const result = await insightEngine.runNow();
    res.json({ generated: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
