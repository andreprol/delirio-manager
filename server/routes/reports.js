'use strict';

const express        = require('express');
const router         = express.Router();
const PDFDocument    = require('pdfkit');
const db             = require('../db');
const { getBiosGuide } = require('../services/wolBiosGuide');

// GET /api/reports/bios — JSON com todas as máquinas bios_needed
router.get('/bios', (req, res) => {
  try {
    const machines = db.getMachinesBiosNeeded().map(m => {
      const guide = getBiosGuide(m.motherboard);
      return {
        id:           m.id,
        displayName:  m.display_name || m.hostname,
        location:     m.location || 'Sem localidade',
        motherboard:  m.motherboard || '',
        manufacturer: guide.manufacturer,
        model:        guide.model,
        biosPath:     guide.path,
        biosNote:     guide.note,
        mac:          m.mac || '',
        lastSeen:     m.last_seen,
      };
    });
    res.json({ total: machines.length, generatedAt: new Date().toISOString(), machines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/bios/pdf — PDF para download
router.get('/bios/pdf', (req, res) => {
  try {
    const machines = db.getMachinesBiosNeeded().map(m => {
      const guide = getBiosGuide(m.motherboard);
      // pdfkit + Helvetica nao suporta unicode arrows — substituir por >
      const biosPath = (guide.path || '').replace(/\s*→\s*/g, ' > ');
      const biosNote = (guide.note || '').replace(/\s*→\s*/g, ' > ');
      return {
        displayName:  m.display_name || m.hostname,
        location:     m.location || 'Sem localidade',
        manufacturer: guide.manufacturer,
        model:        guide.model,
        biosPath,
        biosNote,
      };
    });

    const now     = new Date();
    const dateStr = now.toLocaleDateString('pt-BR');
    const timeStr = now.toLocaleTimeString('pt-BR');

    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="relatorio-bios-${now.toISOString().split('T')[0]}.pdf"`);
    doc.pipe(res);

    const L = 40;   // margem esquerda
    const R = 555;  // margem direita
    const W = R - L; // largura útil

    // ── Cabeçalho principal ──
    doc.rect(L, doc.y, W, 56).fill('#1a1d27');
    const hdrY = doc.y;
    doc.fontSize(7).font('Helvetica').fillColor('#f59e0b')
      .text('DELIRIO MANAGER', L + 14, hdrY + 10, { width: W - 28 });
    doc.fontSize(15).font('Helvetica-Bold').fillColor('#ffffff')
      .text('Relatorio BIOS — Wake-on-LAN', L + 14, hdrY + 21, { width: W - 28 });
    doc.y = hdrY + 56 + 6;
    doc.fillColor('#000');

    // Subtítulo e total
    doc.fontSize(9).font('Helvetica').fillColor('#666')
      .text(`Gerado em: ${dateStr} as ${timeStr}`, { align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(0.4);

    if (machines.length === 0) {
      doc.fontSize(12).text('Nenhuma maquina com configuracao de BIOS pendente.', { align: 'center' });
      doc.end();
      return;
    }

    doc.fontSize(10).font('Helvetica').fillColor('#333')
      .text(`Total de maquinas pendentes: ${machines.length}`);
    doc.moveDown(0.6);
    doc.moveTo(L, doc.y).lineTo(R, doc.y).stroke('#ddd');
    doc.moveDown(0.6);

    // ── Uma entrada por máquina ──
    for (const m of machines) {
      // Estimar altura do bloco para decidir nova página
      const blockH = 22 + 14 + 14 + 14 + 30 + (m.biosNote ? 16 : 0) + 20;
      if (doc.y + blockH > 760) doc.addPage();

      // Cabeçalho da máquina — fundo âmbar suave
      const cardY = doc.y;
      doc.rect(L, cardY, W, 22).fill('#fffbeb');
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#92400e')
        .text('  ! Wake-on-LAN — Configuracao de BIOS Necessaria', L + 8, cardY + 6, { width: W - 16 });
      doc.y = cardY + 22 + 6;
      doc.fillColor('#000');

      // Campos com label negrito
      const field = (label, value) => {
        const startX = L;
        const startY = doc.y;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text(label, startX, startY, { continued: true, width: W });
        doc.font('Helvetica').fillColor('#333').text(` ${value}`);
        doc.moveDown(0.15);
      };

      field('Maquina:', `${m.displayName}  —  ${m.location}`);
      field('Placa-mae:', `${m.manufacturer} — ${m.model}`);

      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica').fillColor('#444')
        .text('O driver Windows esta corretamente configurado, mas a maquina nao respondeu ao magic packet.');
      doc.moveDown(0.15);
      doc.text('E necessario habilitar Wake-on-LAN na BIOS:');
      doc.moveDown(0.3);

      // Caixa escura com o caminho BIOS
      const boxY  = doc.y;
      const boxH  = 28;
      doc.rect(L, boxY, W, boxH).fill('#1e1e1e');
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#ffffff')
        .text(m.biosPath, L + 12, boxY + 9, { width: W - 24 });
      doc.y = boxY + boxH + 5;
      doc.fillColor('#000');

      // Obs em itálico
      if (m.biosNote) {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666')
          .text(`Obs: ${m.biosNote}`, L, doc.y, { width: W });
        doc.fillColor('#000');
        doc.moveDown(0.3);
      }

      doc.moveDown(0.5);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).stroke('#e5e7eb');
      doc.moveDown(0.6);
    }

    // ── Rodapé ──
    const footerY = 810;
    doc.moveTo(L, footerY).lineTo(R, footerY).stroke('#ddd');
    doc.fontSize(8).font('Helvetica').fillColor('#999')
      .text('Delirio Manager — Sistema de Monitoramento de Maquinas Windows', L, footerY + 5, { align: 'center', width: W });

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;