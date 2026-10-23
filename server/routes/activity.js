'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { findMatch } = require('../services/watchlistMatcher');

// POST /api/activity — ingestão do companion (título de janela + processo)
router.post('/activity', (req, res) => {
  const { machineId, token, windowTitle, processName } = req.body;

  if (!machineId || !token) {
    return res.status(400).json({ error: 'machineId e token são obrigatórios' });
  }

  const machine = db.getMachineByToken(token);
  if (!machine || machine.id !== machineId) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const { id: activityLogId } = db.insertActivityLog(machineId, windowTitle || '', processName || '');

  const keywords = db.getActiveWatchlistKeywords();
  const match = findMatch(`${windowTitle || ''} ${processName || ''}`, keywords);
  if (match) {
    db.createCommand(machineId, 'capture-screenshot', { activityLogId });
  }

  res.json({ ok: true, activityLogId, matched: !!match });
});

module.exports = router;
