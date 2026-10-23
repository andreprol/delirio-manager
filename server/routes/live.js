'use strict';

// routes/live.js — start/stop de sessão ao vivo (ver/assumir tela em tempo
// real). Esta rota é quem gera os dois segredos (companionToken, dashboardToken)
// de que o WebSocketServer em /live (services/liveSessionRelay.js) depende pra
// autenticar cada lado da sessão. Cada token só pode chegar ao lado certo:
// companionToken vai pro agente (via comando enfileirado), dashboardToken volta
// na resposta HTTP pra quem chamou /start (o dashboard) — nunca o contrário, e
// nunca os dois juntos do mesmo lado. Mesmo padrão X-Admin-Secret de
// routes/machines.js (endpoint /:id/run).

const express   = require('express');
const router    = express.Router();
const crypto    = require('crypto');
const db        = require('../db');
const relay     = require('../services/liveSessionRelay');
const { adminAuth } = require('../middleware/adminAuth');

// POST /api/live/:machineId/start  { mode: 'normal'|'shadow' }
router.post('/:machineId/start', adminAuth, (req, res) => {
  const { mode } = req.body || {};
  if (mode !== 'normal' && mode !== 'shadow') {
    return res.status(400).json({ error: "mode deve ser 'normal' ou 'shadow'" });
  }

  const machine = db.getMachineById(req.params.machineId);
  if (!machine) {
    return res.status(404).json({ error: 'Máquina não encontrada' });
  }

  const sessionId      = db.createLiveSession(machine.id, mode);
  const companionToken = crypto.randomBytes(32).toString('hex');
  const dashboardToken = crypto.randomBytes(32).toString('hex');

  // registra os dois tokens no relay (ambos obrigatórios — ver liveSessionRelay.js)
  relay.registerSession(sessionId, { machineId: machine.id, mode, companionToken, dashboardToken });

  // só o companionToken vai pro agente, via comando enfileirado
  db.createCommand(machine.id, 'start-live-session', { sessionId, mode, companionToken });

  // só o dashboardToken volta na resposta — companionToken nunca aparece aqui
  res.json({ ok: true, sessionId, mode, dashboardToken });
});

// POST /api/live/:sessionId/stop  { recorded?: boolean }
router.post('/:sessionId/stop', adminAuth, (req, res) => {
  const session = db.getLiveSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }

  if (req.body && req.body.recorded) {
    db.setLiveSessionRecorded(session.id);
  }
  db.endLiveSession(session.id);
  relay.unregisterSession(session.id);
  db.createCommand(session.machine_id, 'stop-live-session', { sessionId: session.id });

  res.json({ ok: true });
});

module.exports = router;
