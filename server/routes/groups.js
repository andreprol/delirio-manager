'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db-pg');
const { broadcast } = require('../services/websocket');
const { asyncHandler } = require('../middleware/asyncHandler');

// GET /api/groups
router.get('/', asyncHandler(async (req, res) => {
  res.json(await db.getGroups());
}));

// POST /api/groups  { name: "Loja Tijuca" }
router.post('/', asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Nome do grupo e obrigatorio' });
  }
  await db.createGroup(name.trim());
  broadcast('groups:updated', await db.getGroups());
  res.status(201).json({ ok: true, name: name.trim() });
}));

// PUT /api/groups/:name  { newName: "Novo Nome" }
router.put('/:name', asyncHandler(async (req, res) => {
  const { newName } = req.body;
  if (!newName || !newName.trim()) {
    return res.status(400).json({ error: 'Novo nome e obrigatorio' });
  }
  await db.renameGroup(req.params.name, newName.trim());
  broadcast('groups:updated', await db.getGroups());
  res.json({ ok: true });
}));

// DELETE /api/groups/:name
router.delete('/:name', asyncHandler(async (req, res) => {
  await db.deleteGroup(req.params.name);
  broadcast('groups:updated', await db.getGroups());
  res.json({ ok: true });
}));

// PUT /api/groups/reorder  { names: ["Grupo A", "Grupo B", ...] }
router.put('/reorder/order', asyncHandler(async (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'names deve ser array' });
  await db.reorderGroups(names);
  broadcast('groups:updated', await db.getGroups());
  res.json({ ok: true });
}));

module.exports = router;
