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
  // Mesmo ruling de routes/agent.js -- aceita o new_id pendente de re-key
  // (Task 4, machineRekeyWorker.js) enquanto a Fase B não comitou
  // machines.id, só pra fins de AUTORIZAÇÃO.
  if (!machine || (machine.id !== machineId && machine.pending_rekey_new_id !== machineId)) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  if (events.length === 0) {
    return res.json({ saved: 0 });
  }

  // 🔴 Achado do revisor (fix-wave pós-revisão da Task 4): grava sempre com
  // `machine.id` (o id que de fato existe em `machines` nesse momento --
  // `oldId` durante a janela pendente, `newId` depois que a Fase B
  // comitou), NUNCA com `machineId` do payload. `win_events` tem FK ativa
  // pra `machines(id)` -- gravar com o `newId` do payload enquanto ele só
  // existe como `pending_rekey_new_id` (ainda não comitado) virava violação
  // de FK (500) no desenho antigo; no desenho clone-and-swap atual, `newId`
  // chega a existir mais cedo (desde o clone da Fase B), mas ainda não é
  // garantia -- `machine.id` é sempre a fonte da verdade.
  try {
    await db.saveWinEvents(machine.id, events);

    const unread = await db.countUnreadWinEvents(machine.id);
    broadcast('new_win_events', {
      machineId: machine.id,
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
