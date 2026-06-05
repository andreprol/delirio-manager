'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { broadcast } = require('../services/websocket');

// GET /api/groups
router.get('/', (req, res) => {
  res.json(db.getGroups());
});

// POST /api/groups  { name: "Loja Tijuca" }
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Nome do grupo e obrigatorio' });
  }
  db.createGroup(name.trim());
  broadcast('groups:updated', db.getGroups());
  res.status(201).json({ ok: true, name: name.trim() });
});

// PUT /api/groups/:name  { newName: "Novo Nome" }
router.put('/:name', (req, res) => {
  const { newName } = req.body;
  if (!newName || !newName.trim()) {
    return res.status(400).json({ error: 'Novo nome e obrigatorio' });
  }
  db.renameGroup(req.params.name, newName.trim());
  broadcast('groups:updated', db.getGroups());
  res.json({ ok: true });
});

// DELETE /api/groups/:name
router.delete('/:name', (req, res) => {
  db.deleteGroup(req.params.name);
  broadcast('groups:updated', db.getGroups());
  res.json({ ok: true });
});

// PUT /api/groups/reorder  { names: ["Grupo A", "Grupo B", ...] }
router.put('/reorder/order', (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'names deve ser array' });
  db.reorderGroups(names);
  broadcast('groups:updated', db.getGroups());
  res.json({ ok: true });
});

module.exports = router;
