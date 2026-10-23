'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { findMatch } = require('../services/watchlistMatcher');
const { agentAuthNoLimit } = require('../middleware/auth');

// POST /api/activity — ingestão do companion (título de janela + processo)
router.post('/activity', agentAuthNoLimit, (req, res) => {
  const { windowTitle, processName } = req.body;

  if (typeof windowTitle !== 'string' || typeof processName !== 'string') {
    return res.status(400).json({ error: 'windowTitle e processName devem ser string' });
  }

  const { id: activityLogId } = db.insertActivityLog(req.machine.id, windowTitle, processName);

  const keywords = db.getActiveWatchlistKeywords();
  const match = findMatch(`${windowTitle} ${processName}`, keywords);
  if (match) {
    db.createCommand(req.machine.id, 'capture-screenshot', { activityLogId });
  }

  res.json({ ok: true, activityLogId, matched: !!match });
});

module.exports = router;
