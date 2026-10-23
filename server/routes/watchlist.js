'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { broadcast } = require('../services/websocket');

// GET /api/watchlist
router.get('/', (req, res) => {
  res.json(db.getWatchlistKeywords());
});

// POST /api/watchlist  { keyword: "vaga de emprego" }
router.post('/', (req, res) => {
  const { keyword } = req.body;
  if (typeof keyword !== 'string' || !keyword.trim()) {
    return res.status(400).json({ error: 'keyword e obrigatoria' });
  }
  const id = db.createWatchlistKeyword(keyword.trim());
  broadcast('watchlist:updated', db.getWatchlistKeywords());
  res.status(201).json({ ok: true, id, keyword: keyword.trim() });
});

// PUT /api/watchlist/:id  { active: true|false }
router.put('/:id', (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active deve ser boolean' });
  }
  db.setWatchlistKeywordActive(req.params.id, active);
  broadcast('watchlist:updated', db.getWatchlistKeywords());
  res.json({ ok: true });
});

// DELETE /api/watchlist/:id
router.delete('/:id', (req, res) => {
  db.deleteWatchlistKeyword(req.params.id);
  broadcast('watchlist:updated', db.getWatchlistKeywords());
  res.json({ ok: true });
});

module.exports = router;
