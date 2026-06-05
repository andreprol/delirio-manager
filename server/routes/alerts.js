'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/alerts
router.get('/', (req, res) => {
  res.json(db.getAlerts(req.query.machineId || null).map(parseAlert));
});

// POST /api/alerts
router.post('/', (req, res) => {
  const { machineId, type, threshold, durationMins, channels } = req.body;

  const validTypes = ['offline', 'cpu_high', 'temp_high', 'disk_low', 'reboot', 'shutdown'];
  if (!type || !validTypes.includes(type)) {
    return res.status(400).json({ error: `Tipo invalido. Validos: ${validTypes.join(', ')}` });
  }

  const id = db.createAlert({ machineId, type, threshold, durationMins, channels });
  res.status(201).json({ id });
});

// DELETE /api/alerts/:id
router.delete('/:id', (req, res) => {
  db.deleteAlert(parseInt(req.params.id));
  res.json({ ok: true });
});

function parseAlert(a) {
  return {
    id:           a.id,
    machineId:    a.machine_id,
    type:         a.type,
    threshold:    a.threshold,
    durationMins: a.duration_mins,
    channels:     JSON.parse(a.channels || '["push"]'),
    enabled:      a.enabled === 1,
    createdAt:    a.created_at,
  };
}

module.exports = router;
