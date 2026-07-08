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

// GET /api/zamak/discrepancies/report — gera DOCX de discrepâncias
router.get('/discrepancies/report', async (req, res) => {
  try {
    const rawDb = db.getDb();
    const rows = rawDb.prepare(
      `SELECT type, device_name, store_name, detail FROM zamak_discrepancies ORDER BY type, store_name, device_name`
    ).all();

    const lastSync = rawDb.prepare(`SELECT MAX(cached_at) AS ts FROM zamak_device_cache`).get()?.ts || 'N/A';

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
});

module.exports = router;
