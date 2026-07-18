'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// GET /api/settings — retorna configurações públicas (sem credenciais)
router.get('/', (req, res) => {
  try {
    const cfg = loadConfig();
    res.json({
      autoWake: {
        enabled: cfg.autoWake?.enabled === true,
      },
      alerts: {
        offlineEnabled: cfg.alerts?.offlineEnabled !== false,
      },
      insights: {
        enabled:   cfg.insights?.enabled === true,
        hasApiKey: !!(cfg.insights?.claude_api_key),
        interval_hours: cfg.insights?.interval_hours || 6,
        lookback_days:  cfg.insights?.lookback_days  || 7,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function applyInsightsSettings(cfg, ins) {
  cfg.insights = {
    ...(cfg.insights || {}),
    enabled: ins.enabled === true,
  };
  if (ins.interval_hours) cfg.insights.interval_hours = ins.interval_hours;
  if (ins.lookback_days)  cfg.insights.lookback_days  = ins.lookback_days;
  if (typeof ins.claude_api_key === 'string') cfg.insights.claude_api_key = ins.claude_api_key;
}

// PUT /api/settings — atualiza configurações
router.put('/', (req, res) => {
  try {
    const cfg = loadConfig();

    if (req.body.autoWake !== undefined) {
      if (typeof req.body.autoWake !== 'object' || req.body.autoWake === null) {
        return res.status(400).json({ error: 'autoWake deve ser um objeto' });
      }
      cfg.autoWake = {
        ...(cfg.autoWake || {}),
        enabled: req.body.autoWake.enabled === true,
      };
    }

    if (req.body.alerts !== undefined) {
      cfg.alerts = {
        ...(cfg.alerts || {}),
        offlineEnabled: req.body.alerts.offlineEnabled !== false,
      };
    }

    if (req.body.insights !== undefined) {
      applyInsightsSettings(cfg, req.body.insights);
      saveConfig(cfg);
      const insightEngine = require('../services/insightEngine');
      insightEngine.restart();
    } else {
      saveConfig(cfg);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
