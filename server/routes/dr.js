'use strict';

const express      = require('express');
const router       = express.Router();
const path         = require('path');
const fs           = require('fs');
const db           = require('../db-pg');
const { broadcast } = require('../services/websocket');
const { asyncHandler } = require('../middleware/asyncHandler');

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
router.post('/:id/setup', asyncHandler(async (req, res) => {
  const drCfg = loadDRConfig();
  if (!drCfg || !drCfg.azure_account_name || !drCfg.sas_token) {
    return res.status(503).json({ error: 'DR não configurado no servidor. Adicione o bloco "dr" ao config.json.' });
  }
  const machine = await db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada' });

  try {
    await db.createCommand(machine.id, 'dr-setup', {
      azure_account: drCfg.azure_account_name,
      sas_token:     drCfg.sas_token,
      schedule_hour: drCfg.schedule_hour || 23,
    });
    await db.updateMachineDRStatus(machine.id, { setup: 'pending' });
    broadcast('dr_update', { machineId: machine.id, drSetup: 'pending' });
    return res.json({ ok: true, queued: 'dr-setup' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}));

// POST /api/dr/:id/backup-now
router.post('/:id/backup-now', asyncHandler(async (req, res) => {
  const machine = await db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada' });
  if (machine.dr_setup !== 'configured') {
    return res.status(400).json({ error: 'DR não configurado nesta máquina' });
  }
  try {
    await db.createCommand(machine.id, 'dr-backup-now', {});
    return res.json({ ok: true, queued: 'dr-backup-now' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}));

// GET /api/dr/overview — MUST be before /:id/history to avoid Express treating "overview" as an ID
router.get('/overview', asyncHandler(async (req, res) => {
  try {
    return res.json(await db.getDROverview());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}));

// GET /api/dr/:id/history
router.get('/:id/history', asyncHandler(async (req, res) => {
  const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 28, 90));
  try {
    return res.json(await db.getDRHistory(req.params.id, days));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}));

module.exports = router;
