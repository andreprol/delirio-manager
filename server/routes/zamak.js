// server/routes/zamak.js
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const zamak   = require('../services/zamak');

// GET /api/zamak/status — resumo do cache por loja
router.get('/status', (req, res) => {
  try {
    const age  = db.getZamakCacheAge();
    const rawDb = db.getDb();

    const byStore = rawDb.prepare(`
      SELECT
        store_name,
        COUNT(*) AS total_devices,
        SUM(patch_critical) AS patch_critical,
        SUM(patch_high)     AS patch_high,
        SUM(patch_total)    AS patch_total,
        SUM(threats_active) AS threats_active,
        SUM(failing_checks) AS failing_checks,
        SUM(CASE WHEN status IN ('offline','overdue','Error') THEN 1 ELSE 0 END) AS devices_offline,
        MAX(cached_at)      AS last_sync
      FROM zamak_device_cache
      GROUP BY store_name
      ORDER BY store_name
    `).all();

    const discrepancies = rawDb.prepare(
      `SELECT type, device_name, store_name, detail, detected_at
       FROM zamak_discrepancies ORDER BY type, store_name`
    ).all();

    const unmapped = rawDb.prepare(
      `SELECT DISTINCT site_name FROM zamak_device_cache WHERE store_name IS NULL`
    ).all().map(r => r.site_name);

    res.json({
      cacheAgeHours:  age === Infinity ? null : Math.round(age * 10) / 10,
      synced:         age < 48,
      byStore,
      discrepancies,
      unmappedSites:  unmapped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zamak/sync — dispara sync manual
router.post('/sync', async (req, res) => {
  try {
    const result = await zamak.syncAll();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/zamak/discrepancies
router.get('/discrepancies', (req, res) => {
  try {
    const rows = db.getDb().prepare(
      `SELECT * FROM zamak_discrepancies ORDER BY type, store_name, device_name`
    ).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
