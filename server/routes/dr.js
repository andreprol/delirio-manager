'use strict';

const express      = require('express');
const router       = express.Router();
const path         = require('path');
const fs           = require('fs');
const db           = require('../db');
const { broadcast } = require('../services/websocket');

function loadDRConfig() {
  try {
    const cfgPath = path.join(__dirname, '..', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return cfg.dr || null;
  } catch {
    return null;
  }
}

// POST /api/dr/:id/setup
router.post('/:id/setup', (req, res) => {
  const drCfg = loadDRConfig();
  if (!drCfg || !drCfg.azure_account_name || !drCfg.sas_token) {
    return res.status(503).json({ error: 'DR não configurado no servidor. Adicione o bloco "dr" ao config.json.' });
  }
  const machine = db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada' });

  try {
    db.createCommand(machine.id, 'dr-setup', {
      azure_account: drCfg.azure_account_name,
      sas_token:     drCfg.sas_token,
      schedule_hour: drCfg.schedule_hour || 23,
    });
    db.updateMachineDRStatus(machine.id, { setup: 'pending' });
    broadcast('dr_update', { machineId: machine.id, drSetup: 'pending' });
    return res.json({ ok: true, queued: 'dr-setup' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/dr/:id/backup-now
router.post('/:id/backup-now', (req, res) => {
  const machine = db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada' });
  if (machine.dr_setup !== 'configured') {
    return res.status(400).json({ error: 'DR não configurado nesta máquina' });
  }
  try {
    db.createCommand(machine.id, 'dr-backup-now', {});
    return res.json({ ok: true, queued: 'dr-backup-now' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/dr/overview — MUST be before /:id/history to avoid Express treating "overview" as an ID
router.get('/overview', (req, res) => {
  try {
    return res.json(db.getDROverview());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/dr/:id/history
router.get('/:id/history', (req, res) => {
  const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 28, 90));
  try {
    return res.json(db.getDRHistory(req.params.id, days));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
