// server/routes/zamak.js
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db-pg');
const zamak   = require('../services/zamak');
const { asyncHandler } = require('../middleware/asyncHandler');

// COUNT/SUM sobre INTEGER vem como bigint-string via driver pg -- sempre
// Number() (mesma lição de sempre, ver db-pg.js countQuery).
function numifyByStoreRow(r) {
  return {
    ...r,
    total_devices:   Number(r.total_devices),
    patch_critical:  Number(r.patch_critical),
    patch_high:      Number(r.patch_high),
    patch_total:     Number(r.patch_total),
    threats_active:  Number(r.threats_active),
    failing_checks:  Number(r.failing_checks),
    devices_offline: Number(r.devices_offline),
  };
}

// GET /api/zamak/status — resumo do cache por loja
router.get('/status', asyncHandler(async (req, res) => {
  try {
    const age  = await db.getZamakCacheAge();
    const pool = db.getPool();

    const { rows: byStoreRaw } = await pool.query(`
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
    `);
    const byStore = byStoreRaw.map(numifyByStoreRow);

    const { rows: discrepancies } = await pool.query(
      `SELECT type, device_name, store_name, detail, detected_at
       FROM zamak_discrepancies ORDER BY type, store_name`
    );

    const { rows: unmappedRows } = await pool.query(
      `SELECT DISTINCT site_name FROM zamak_device_cache WHERE store_name IS NULL`
    );
    const unmapped = unmappedRows.map(r => r.site_name);

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
}));

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
router.get('/discrepancies', asyncHandler(async (req, res) => {
  try {
    const { rows } = await db.getPool().query(
      `SELECT * FROM zamak_discrepancies ORDER BY type, store_name, device_name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// GET /api/zamak/threats?store=X — lista ameaças MAV individuais
router.get('/threats', asyncHandler(async (req, res) => {
  try {
    const rows = await db.getZamakThreats(req.query.store || null);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// GET /api/zamak/performance?store=X
router.get('/performance', asyncHandler(async (req, res) => {
  try {
    const rows = await db.getZamakPerformance(req.query.store || null);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// GET /api/zamak/outages?store=X
router.get('/outages', asyncHandler(async (req, res) => {
  try {
    const rows = await db.getZamakOutages(req.query.store || null);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// GET /api/zamak/discrepancies/report — gera DOCX de discrepâncias
router.get('/discrepancies/report', asyncHandler(async (req, res) => {
  try {
    const pool = db.getPool();
    const { rows } = await pool.query(
      `SELECT type, device_name, store_name, detail FROM zamak_discrepancies ORDER BY type, store_name, device_name`
    );

    const { rows: [lastSyncRow] } = await pool.query(`SELECT MAX(cached_at) AS ts FROM zamak_device_cache`);
    const lastSync = lastSyncRow?.ts || 'N/A';

    const zamakOnly = rows.filter(r => r.type === 'zamak_only');
    const dmOnly    = rows.filter(r => r.type === 'dm_only');

    // Group by store
    function groupByStore(list) {
      const map = {};
      for (const r of list) {
        const s = r.store_name || 'Sem loja';
        if (!map[s]) map[s] = [];
        map[s].push(r.device_name);
      }
      return map;
    }

    const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, AlignmentType, WidthType } = require('docx');

    function headerRow(cols) {
      return new TableRow({
        tableHeader: true,
        children: cols.map(c => new TableCell({
          shading: { fill: '667EEA' },
          children: [new Paragraph({ children: [new TextRun({ text: c, bold: true, color: 'FFFFFF', size: 18 })] })],
        })),
      });
    }

    function dataRow(cells) {
      return new TableRow({
        children: cells.map(c => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: c || '—', size: 18 })] })],
        })),
      });
    }

    function sectionTable(title, grouped) {
      const storeNames = Object.keys(grouped).sort();
      const dataRows = storeNames.flatMap(store =>
        grouped[store].map((dev, i) => dataRow([i === 0 ? store : '', dev]))
      );

      return [
        new Paragraph({ text: title, heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 100 } }),
        new Paragraph({ children: [new TextRun({ text: `${rows.filter(r => (title.includes('Zamak') ? r.type === 'zamak_only' : r.type === 'dm_only')).length} máquinas`, size: 18, color: '667EEA' })], spacing: { after: 120 } }),
        storeNames.length
          ? new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: [headerRow(['Loja', 'Hostname']), ...dataRows],
            })
          : new Paragraph({ children: [new TextRun({ text: 'Nenhuma discrepância nesta categoria.', size: 18, color: '48BB78' })] }),
        new Paragraph(''),
      ];
    }

    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({
            text: 'Relatório de Discrepâncias Zamak ↔ Delirio Manager',
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 120 },
          }),
          new Paragraph({ children: [new TextRun({ text: `Gerado em: ${new Date().toLocaleString('pt-BR')}`, size: 18, color: '888888' })], spacing: { after: 80 } }),
          new Paragraph({ children: [new TextRun({ text: `Último sync Zamak: ${lastSync}`, size: 18, color: '888888' })], spacing: { after: 240 } }),

          // Resumo
          new Paragraph({ text: 'Resumo', heading: HeadingLevel.HEADING_2, spacing: { after: 100 } }),
          new Table({
            width: { size: 60, type: WidthType.PERCENTAGE },
            rows: [
              headerRow(['Tipo', 'Quantidade']),
              dataRow(['Na Zamak, sem agente DM', String(zamakOnly.length)]),
              dataRow(['No DM, sem cobertura Zamak', String(dmOnly.length)]),
              dataRow(['Total', String(rows.length)]),
            ],
          }),
          new Paragraph(''),

          ...sectionTable('Máquinas na Zamak sem agente Delirio Manager', groupByStore(zamakOnly)),
          ...sectionTable('Máquinas no Delirio Manager sem cobertura Zamak', groupByStore(dmOnly)),
        ],
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="discrepancias-zamak-${date}.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

module.exports = router;
