'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { generateDanfePdf } = require('../services/danfe');
const { sendDanfeEmail }   = require('../services/nfce-mailer');

// POST /api/aloha/:machineId/index/trigger
// Enfileira comandos aloha-index-nfce-day para todos os dias do mês corrente.
router.post('/:machineId/index/trigger', (req, res) => {
  const machine = db.getMachineById(req.params.machineId);
  if (!machine) return res.status(404).json({ error: 'Maquina nao encontrada' });

  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const today = now.getDate();

  const commandIds = [];
  for (let d = 1; d <= today; d++) {
    const day = String(d).padStart(2, '0');
    const id  = db.createCommand(machine.id, 'aloha-index-nfce-day', { month, day });
    commandIds.push(id);
  }

  res.json({ ok: true, month, days: today, commandIds });
});

// GET /api/aloha/:machineId/index/status
router.get('/:machineId/index/status', (req, res) => {
  try {
    const status = db.getNFCeIndexStatus(req.params.machineId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aloha/search?machineId=&dateFrom=&dateTo=&valueMin=&valueMax=&product=&limit=&offset=
router.get('/search', (req, res) => {
  const { machineId, dateFrom, dateTo, valueMin, valueMax, product, limit, offset } = req.query;
  if (!machineId) return res.status(400).json({ error: 'machineId obrigatorio' });

  try {
    const result = db.searchNFCe({
      machineId,
      dateFrom: dateFrom  || null,
      dateTo:   dateTo    || null,
      valueMin: valueMin != null && valueMin !== '' ? parseFloat(valueMin) : null,
      valueMax: valueMax != null && valueMax !== '' ? parseFloat(valueMax) : null,
      product:  product   || null,
      limit:    Math.min(parseInt(limit)  || 50,  200),
      offset:   parseInt(offset) || 0,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aloha/nfce/:chave?machineId=
router.get('/nfce/:chave', (req, res) => {
  const { machineId } = req.query;
  if (!machineId) return res.status(400).json({ error: 'machineId obrigatorio' });

  const record = db.getNFCeByChave(machineId, req.params.chave);
  if (!record) return res.status(404).json({ error: 'NF-Ce nao encontrada' });
  res.json(record);
});

// GET /api/aloha/nfce/:chave/danfe?machineId=  → retorna PDF
router.get('/nfce/:chave/danfe', async (req, res) => {
  const { machineId } = req.query;
  if (!machineId) return res.status(400).json({ error: 'machineId obrigatorio' });

  const record = db.getNFCeByChave(machineId, req.params.chave);
  if (!record) return res.status(404).json({ error: 'NF-Ce nao encontrada' });

  try {
    const pdf = await generateDanfePdf(record.danfe);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="DANFE-${record.n_nf}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[DANFE] Erro ao gerar PDF:', err.message);
    res.status(500).json({ error: 'Erro ao gerar DANFE' });
  }
});

// POST /api/aloha/nfce/:chave/email
// Body: { machineId, toEmail, extraCCs? }
router.post('/nfce/:chave/email', async (req, res) => {
  const { machineId, toEmail, extraCCs = [] } = req.body;
  if (!machineId || !toEmail) {
    return res.status(400).json({ error: 'machineId e toEmail obrigatorios' });
  }

  const record = db.getNFCeByChave(machineId, req.params.chave);
  if (!record) return res.status(404).json({ error: 'NF-Ce nao encontrada' });

  try {
    const pdf = await generateDanfePdf(record.danfe);
    await sendDanfeEmail({ danfe: record.danfe, pdfBuffer: pdf, toEmail, extraCCs });
    res.json({ ok: true, message: `DANFE enviada para ${toEmail}` });
  } catch (err) {
    console.error('[Email] Erro ao enviar DANFE:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao enviar email' });
  }
});

module.exports = router;
