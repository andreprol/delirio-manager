// Gerador de PDFs dos manuais do Delirio Manager
// Uso: node gerar-manuais-pdf.js
// Saída: C:\Temp\manual-instalacao.pdf e C:\Temp\manual-completo.pdf

const PDFDocument = require('../server/node_modules/pdfkit');
const fs = require('fs');
const path = require('path');

const VAULT = 'F:/Cérebro de IA/Cérebro do André/Projetos/Delirio Manager';
const OUTPUT_DIR = 'C:/Temp';

const DOCS = [
  {
    input: path.join(VAULT, 'Manual de Instalação (Simplificado).md'),
    output: path.join(OUTPUT_DIR, 'Delirio Manager — Manual de Instalação.pdf'),
  },
  {
    input: path.join(VAULT, 'Manual Completo do Dashboard.md'),
    output: path.join(OUTPUT_DIR, 'Delirio Manager — Manual Completo.pdf'),
  },
];

// ── Paleta ──────────────────────────────────────────────────────────────────
const C = {
  bg:      '#F8F9FA',
  primary: '#1A1A2E',
  accent:  '#E94560',
  text:    '#2D2D2D',
  subtle:  '#6B7280',
  codebg:  '#1E1E2E',
  codefg:  '#CDD6F4',
  border:  '#E5E7EB',
  th:      '#1A1A2E',
  tralt:   '#F3F4F6',
};

const FONTS = {
  regular: 'Helvetica',
  bold:    'Helvetica-Bold',
  italic:  'Helvetica-Oblique',
  mono:    'Courier',
};

const PAGE = { w: 595, h: 842, ml: 50, mr: 50, mt: 60, mb: 60 };
const TW = PAGE.w - PAGE.ml - PAGE.mr;

// ── Parser de markdown simples ───────────────────────────────────────────────
function parseMarkdown(md) {
  const lines = md.split('\n');
  const tokens = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      tokens.push({ type: 'code', lang, text: codeLines.join('\n') });
      i++;
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      tokens.push({ type: 'heading', level: hMatch[1].length, text: hMatch[2] });
      i++; continue;
    }

    // HR
    if (/^---+$/.test(line.trim())) {
      tokens.push({ type: 'hr' });
      i++; continue;
    }

    // Table header
    if (line.includes('|') && i + 1 < lines.length && /^\|[\s\-|]+\|$/.test(lines[i + 1])) {
      const rows = [];
      const headers = line.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1).map(c => c.trim());
      rows.push(headers);
      i += 2; // skip separator
      while (i < lines.length && lines[i].includes('|')) {
        const cells = lines[i].split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1).map(c => c.trim());
        rows.push(cells);
        i++;
      }
      tokens.push({ type: 'table', rows });
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      tokens.push({ type: 'blockquote', text: line.slice(2) });
      i++; continue;
    }

    // List item
    if (/^(\s*)[-*]\s+/.test(line)) {
      const indent = line.match(/^(\s*)/)[1].length;
      tokens.push({ type: 'listitem', text: line.replace(/^\s*[-*]\s+/, ''), indent });
      i++; continue;
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      tokens.push({ type: 'listitem', text: line.replace(/^\d+\.\s+/, ''), numbered: true });
      i++; continue;
    }

    // Blank line
    if (line.trim() === '') {
      tokens.push({ type: 'blank' });
      i++; continue;
    }

    // Paragraph
    tokens.push({ type: 'paragraph', text: line });
    i++;
  }

  return tokens;
}

// Strip markdown inline syntax for plain rendering
function strip(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1');
}

// Bold/italic inline spans
function inlineSpans(text) {
  const spans = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index), bold: false, mono: false });
    if (m[2]) spans.push({ text: m[2], bold: true, mono: false });
    else if (m[3]) spans.push({ text: m[3], bold: false, italic: true, mono: false });
    else if (m[4]) spans.push({ text: m[4], bold: false, mono: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), bold: false, mono: false });
  return spans;
}

// ── Render ──────────────────────────────────────────────────────────────────
function renderInline(doc, text, x, y, width, opts = {}) {
  const spans = inlineSpans(text);
  let cx = x;
  const lineH = opts.lineH || 14;

  for (const span of spans) {
    const font = span.mono ? FONTS.mono : span.bold ? FONTS.bold : span.italic ? FONTS.italic : FONTS.regular;
    const size = span.mono ? (opts.size || 10) - 1 : opts.size || 10;
    const color = span.mono ? C.accent : opts.color || C.text;
    doc.font(font).fontSize(size).fillColor(color);
    const w = doc.widthOfString(span.text);
    if (cx + w > x + width) {
      y += lineH;
      cx = x;
    }
    doc.text(span.text, cx, y, { lineBreak: false });
    cx += w;
  }
  return y;
}

function generatePDF(inputPath, outputPath) {
  const md = fs.readFileSync(inputPath, 'utf8');
  const tokens = parseMarkdown(md);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE.mt, bottom: PAGE.mb, left: PAGE.ml, right: PAGE.mr },
    info: { Title: path.basename(outputPath, '.pdf'), Author: 'André Dias Moreira Prol' },
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  let y = PAGE.mt;
  let listCounter = 0;
  let prevType = null;

  const newPage = () => {
    doc.addPage();
    y = PAGE.mt;
  };

  const ensureSpace = (needed) => {
    if (y + needed > PAGE.h - PAGE.mb) newPage();
  };

  // ── Cover ──────────────────────────────────────────────────────────────────
  // Header bar
  doc.rect(0, 0, PAGE.w, 8).fill(C.accent);
  doc.rect(0, 8, PAGE.w, 52).fill(C.primary);
  doc.font(FONTS.bold).fontSize(16).fillColor('#FFFFFF')
     .text('DELIRIO MANAGER', PAGE.ml, 22, { width: TW });
  doc.rect(0, 60, PAGE.w, 2).fill(C.accent);
  y = 80;

  // ── Render tokens ──────────────────────────────────────────────────────────
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];

    if (tok.type === 'blank') {
      if (prevType && prevType !== 'blank') y += 4;
      prevType = 'blank';
      continue;
    }

    if (tok.type === 'hr') {
      ensureSpace(16);
      doc.moveTo(PAGE.ml, y + 6).lineTo(PAGE.ml + TW, y + 6).strokeColor(C.border).lineWidth(0.5).stroke();
      y += 16;
      prevType = 'hr';
      continue;
    }

    if (tok.type === 'heading') {
      const sizes   = [22, 16, 13, 12, 11, 10];
      const sizes_h = [36, 28, 20, 16, 14, 14];
      const sz = sizes[tok.level - 1] || 10;
      const spaceNeeded = sizes_h[tok.level - 1] || 18;
      ensureSpace(spaceNeeded);

      if (tok.level === 1) {
        y += 8;
        doc.rect(PAGE.ml - 4, y, TW + 8, sz + 10).fill(C.primary);
        doc.font(FONTS.bold).fontSize(sz).fillColor('#FFFFFF')
           .text(strip(tok.text), PAGE.ml + 4, y + 5, { width: TW });
        y += sz + 18;
      } else if (tok.level === 2) {
        y += 12;
        doc.rect(PAGE.ml, y + sz + 2, TW, 2).fill(C.accent);
        doc.font(FONTS.bold).fontSize(sz).fillColor(C.primary)
           .text(strip(tok.text), PAGE.ml, y, { width: TW });
        y += sz + 10;
      } else if (tok.level === 3) {
        y += 8;
        doc.rect(PAGE.ml, y, 3, sz + 2).fill(C.accent);
        doc.font(FONTS.bold).fontSize(sz).fillColor(C.primary)
           .text(strip(tok.text), PAGE.ml + 8, y, { width: TW - 8 });
        y += sz + 8;
      } else {
        y += 6;
        doc.font(FONTS.bold).fontSize(sz).fillColor(C.subtle)
           .text(strip(tok.text), PAGE.ml, y, { width: TW });
        y += sz + 6;
      }
      prevType = 'heading';
      continue;
    }

    if (tok.type === 'code') {
      const codeLines = tok.text.split('\n');
      const lineH = 12;
      const padV = 8;
      const padH = 10;
      const blockH = codeLines.length * lineH + padV * 2 + (tok.lang ? 14 : 0);
      ensureSpace(blockH + 8);

      const bx = PAGE.ml;
      const bw = TW;

      // Code block background
      doc.roundedRect(bx, y, bw, blockH, 4).fill(C.codebg);

      // Language label
      let cy = y + padV;
      if (tok.lang) {
        doc.font(FONTS.bold).fontSize(7).fillColor('#89B4FA')
           .text(tok.lang.toUpperCase(), bx + padH, cy);
        cy += 14;
      }

      doc.font(FONTS.mono).fontSize(8).fillColor(C.codefg);
      for (const cl of codeLines) {
        if (cy + lineH > y + blockH - padV) break;
        doc.text(cl, bx + padH, cy, { width: bw - padH * 2, lineBreak: false });
        cy += lineH;
      }

      y += blockH + 10;
      prevType = 'code';
      continue;
    }

    if (tok.type === 'blockquote') {
      ensureSpace(24);
      const text = strip(tok.text);
      doc.font(FONTS.italic).fontSize(9);
      const h = doc.heightOfString(text, { width: TW - 20 }) + 12;
      doc.roundedRect(PAGE.ml, y, TW, h, 3).fill('#FFF8E1');
      doc.rect(PAGE.ml, y, 3, h).fill('#F59E0B');
      doc.font(FONTS.italic).fontSize(9).fillColor('#92400E')
         .text(text, PAGE.ml + 12, y + 6, { width: TW - 20 });
      y += h + 8;
      prevType = 'blockquote';
      continue;
    }

    if (tok.type === 'listitem') {
      ensureSpace(16);
      const indent = (tok.indent || 0) * 10;
      const text = strip(tok.text);
      doc.font(FONTS.regular).fontSize(9);
      const h = doc.heightOfString(text, { width: TW - 16 - indent });
      const bullet = tok.numbered ? '•' : '–';
      doc.font(FONTS.bold).fontSize(9).fillColor(C.accent)
         .text(bullet, PAGE.ml + indent, y, { width: 10, lineBreak: false });
      doc.font(FONTS.regular).fontSize(9).fillColor(C.text)
         .text(text, PAGE.ml + indent + 12, y, { width: TW - 14 - indent });
      y += h + 3;
      prevType = 'listitem';
      continue;
    }

    if (tok.type === 'table') {
      const { rows } = tok;
      if (rows.length < 2) continue;

      const headers = rows[0];
      const dataRows = rows.slice(1);
      const colW = Math.floor(TW / headers.length);
      const rowH = 18;
      const tableH = rowH * (dataRows.length + 1) + 4;

      ensureSpace(tableH + 8);

      // Header row
      doc.rect(PAGE.ml, y, TW, rowH).fill(C.th);
      headers.forEach((h, ci) => {
        doc.font(FONTS.bold).fontSize(8).fillColor('#FFFFFF')
           .text(h, PAGE.ml + ci * colW + 4, y + 5, { width: colW - 8, lineBreak: false });
      });
      y += rowH;

      // Data rows
      dataRows.forEach((row, ri) => {
        const bg = ri % 2 === 0 ? '#FFFFFF' : C.tralt;
        doc.rect(PAGE.ml, y, TW, rowH).fill(bg);
        row.forEach((cell, ci) => {
          doc.font(FONTS.regular).fontSize(8).fillColor(C.text)
             .text(strip(cell), PAGE.ml + ci * colW + 4, y + 5, { width: colW - 8, lineBreak: false });
        });
        // border bottom
        doc.moveTo(PAGE.ml, y + rowH).lineTo(PAGE.ml + TW, y + rowH)
           .strokeColor(C.border).lineWidth(0.3).stroke();
        y += rowH;
      });

      y += 10;
      prevType = 'table';
      continue;
    }

    if (tok.type === 'paragraph') {
      const text = strip(tok.text);
      if (!text) continue;
      doc.font(FONTS.regular).fontSize(10);
      const h = doc.heightOfString(text, { width: TW }) + 2;
      ensureSpace(h + 4);
      doc.font(FONTS.regular).fontSize(10).fillColor(C.text)
         .text(text, PAGE.ml, y, { width: TW });
      y += h + 4;
      prevType = 'paragraph';
      continue;
    }
  }

  // ── Footer on every page ───────────────────────────────────────────────────
  const totalPages = doc.bufferedPageRange ? doc.bufferedPageRange().count : 1;
  const range = doc.bufferedPageRange ? doc.bufferedPageRange() : { start: 0, count: 1 };

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

(async () => {
  for (const d of DOCS) {
    process.stdout.write(`Gerando: ${path.basename(d.output)} ... `);
    await generatePDF(d.input, d.output);
    console.log('OK');
  }
  console.log('\nPDFs salvos em C:/Temp/');
})();
