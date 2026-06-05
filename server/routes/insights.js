'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/insights?machine_id=X&limit=50
router.get('/', (req, res) => {
  const { machine_id, limit } = req.query;
  try {
    const insights = db.getInsights({
      machineId: machine_id || null,
      limit:     parseInt(limit) || 50,
    });
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/insights/:id/read
router.put('/:id/read', (req, res) => {
  db.markInsightRead(parseInt(req.params.id));
  res.json({ ok: true });
});

// POST /api/insights/generate  — manual trigger (debug/test)
router.post('/generate', async (req, res) => {
  try {
    const insightEngine = require('../services/insightEngine');
    const result = await insightEngine.runNow();
    res.json({ generated: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
