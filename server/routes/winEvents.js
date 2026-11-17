'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db-pg');
const { broadcast } = require('../services/websocket');
const { asyncHandler } = require('../middleware/asyncHandler');

// POST /api/win-events  — receives events from agent
router.post('/win-events', asyncHandler(async (req, res) => {
  const { machineId, token, events } = req.body;

  if (!machineId || !token || !Array.isArray(events)) {
    return res.status(400).json({ error: 'machineId, token e events são obrigatórios' });
  }

  const machine = await db.getMachineByToken(token);
  if (!machine || machine.id !== machineId) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  if (events.length === 0) {
    return res.json({ saved: 0 });
  }

  try {
    await db.saveWinEvents(machineId, events);

    const unread = await db.countUnreadWinEvents(machineId);
    broadcast('new_win_events', {
      machineId,
      count: unread,
    });

    res.json({ saved: events.length });
  } catch (err) {
    console.error('[WinEvents] Erro ao salvar:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
}));

// GET /api/machines/:id/win-events?scope=focused|broad
router.get('/machines/:id/win-events', asyncHandler(async (req, res) => {
  const { id }    = req.params;
  const { scope } = req.query;
  try {
    const events = await db.getWinEvents(id, scope || 'focused');
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// PUT /api/machines/:id/win-events/read
router.put('/machines/:id/win-events/read', asyncHandler(async (req, res) => {
  await db.markWinEventsRead(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
