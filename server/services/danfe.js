'use strict';

const PDFDocument = require('pdfkit');
const QRCode      = require('qrcode');

const PAG_TYPES = {
  '01': 'Dinheiro',
  '02': 'Cheque',
  '03': 'Cartão de Crédito',
  '04': 'Cartão de Débito',
  '05': 'Crédito Loja',
  '10': 'Vale Alimentação',
  '11': 'Vale Refeição',
  '12': 'Vale Presente',
  '13': 'Vale Combustível',
  '15': 'Boleto Bancário',
  '17': 'Pagamento Instantâneo (Pix)',
  '99': 'Outros',
};

function fmtCNPJ(v) {
  if (!v || v.length !== 14) return v || '';
  return `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8,12)}-${v.slice(12)}`;
}

function fmtMoeda(v) {
  return `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    });
  } catch { return iso; }
}

function fmtChave(chave) {
  if (!chave) return '';
  return chave.match(/.{1,4}/g)?.join(' ') || chave;
}

function hLine(doc, y, left, width, color = '#cccccc') {
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor(color).stroke();
}

/**
 * Generates a DANFE NFC-e PDF buffer.
 * @param {object} danfe — NFCeDanfe payload from nfce_index.danfe_json
 * @returns {Promise<Buffer>}
 */
async function generateDanfePdf(danfe) {
  // Gera QR code como PNG antes de abrir o documento (operação assíncrona)
  const qrUrl = danfe.qrCode || danfe.urlChave || '';
  let qrBuffer = null;
  if (qrUrl) {
    try {
      qrBuffer = await QRCode.toBuffer(qrUrl, {
        type:   'png',
        width:  130,
        margin: 1,
        color:  { dark: '#000000', light: '#ffffff' },
      });
    } catch (_) { /* QR code opcional — prossegue sem ele se falhar */ }
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 30, left: 30, right: 30, bottom: 30 },
    });

    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 30;                              // left margin
    const W = doc.page.width - 60;            // content width

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(7).fillColor('#666')
       .text('DANFE NFC-e', L, 30, { align: 'center', width: W });

    doc.fontSize(9).fillColor('#000').font('Helvetica-Bold')
       .text('NOTA FISCAL DE CONSUMIDOR ELETRÔNICA', L, 42, { align: 'center', width: W });

    // ── Emitter ──────────────────────────────────────────────────────────────
    doc.fontSize(11).font('Helvetica-Bold')
       .text(danfe.emit?.xNome || '', L, 60, { align: 'center', width: W });

    const addr = [
      danfe.emit?.xLgr, danfe.emit?.nro && `nº ${danfe.emit.nro}`,
      danfe.emit?.xBairro, danfe.emit?.xMun && `${danfe.emit.xMun}/${danfe.emit.UF}`,
    ].filter(Boolean).join(', ');

    doc.fontSize(8).font('Helvetica')
       .text(addr, L, 74, { align: 'center', width: W })
       .text(
         `CNPJ: ${fmtCNPJ(danfe.emit?.cnpj || '')}  |  IE: ${danfe.emit?.ie || ''}`,
         L, 84, { align: 'center', width: W }
       );

    let y = 95;
    hLine(doc, y, L, W);
    y += 5;

    // ── NF meta ──────────────────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica')
       .text(
         `NF-e Nº ${danfe.nNF}   Série: ${danfe.series || ''}   Emissão: ${fmtDate(danfe.dhEmi)}`,
         L, y, { align: 'center', width: W }
       );
    y += 14;
    hLine(doc, y, L, W);
    y += 6;

    // ── Products ─────────────────────────────────────────────────────────────
    const COL = { item: L, desc: L + 18, qty: L + W - 135, unit: L + W - 94, tot: L + W - 48 };

    doc.fontSize(7).font('Helvetica-Bold').fillColor('#444')
       .text('#',      COL.item, y, { width: 16 })
       .text('Produto', COL.desc, y, { width: W - 160 })
       .text('Qtd',    COL.qty,  y, { width: 39, align: 'right' })
       .text('Unit.',  COL.unit, y, { width: 44, align: 'right' })
       .text('Total',  COL.tot,  y, { width: 48, align: 'right' });
    y += 10;
    hLine(doc, y, L, W, '#e0e0e0');
    y += 4;

    doc.font('Helvetica').fillColor('#000');
    for (const p of (danfe.products || [])) {
      if (y > doc.page.height - 130) {
        doc.addPage();
        y = 30;
      }
      doc.fontSize(7)
         .text(p.nItem || '', COL.item, y, { width: 16 })
         .text(p.xProd || '', COL.desc, y, { width: W - 164, lineBreak: false })
         .text(String(p.qCom || 0), COL.qty, y, { width: 39, align: 'right' })
         .text(fmtMoeda(p.vUnCom), COL.unit, y, { width: 44, align: 'right' })
         .text(fmtMoeda(p.vProd),  COL.tot,  y, { width: 48, align: 'right' });
      y += 13;
    }

    hLine(doc, y, L, W);
    y += 6;

    // ── Totals ───────────────────────────────────────────────────────────────
    const tot = danfe.totals || {};
    const totRows = [
      ['Subtotal', fmtMoeda(tot.vProd)],
      tot.vDesc  > 0 ? ['Desconto', `- ${fmtMoeda(tot.vDesc)}`]  : null,
      tot.vFrete > 0 ? ['Frete',    fmtMoeda(tot.vFrete)]        : null,
      ['TOTAL NF-e', fmtMoeda(tot.vNF || danfe.vNF)],
    ].filter(Boolean);

    for (const [label, value] of totRows) {
      const isTotal = label === 'TOTAL NF-e';
      doc.fontSize(isTotal ? 9 : 7)
         .font(isTotal ? 'Helvetica-Bold' : 'Helvetica')
         .text(label, L + W - 150, y, { width: 100, align: 'right' })
         .text(value, L + W - 48,  y, { width: 48,  align: 'right' });
      y += isTotal ? 14 : 11;
    }

    hLine(doc, y, L, W);
    y += 6;

    // ── Payment ──────────────────────────────────────────────────────────────
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#444').text('FORMAS DE PAGAMENTO', L, y);
    y += 11;

    for (const p of (danfe.payment || [])) {
      doc.fontSize(7).font('Helvetica').fillColor('#000')
         .text(PAG_TYPES[p.tPag] || `Cód. ${p.tPag}`, L + 4, y)
         .text(fmtMoeda(p.vPag), L + W - 48, y, { width: 48, align: 'right' });
      y += 11;
    }

    hLine(doc, y, L, W);
    y += 8;

    // ── Chave de acesso ──────────────────────────────────────────────────────
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#444').text('CHAVE DE ACESSO', L, y);
    y += 10;
    doc.fontSize(6.5).font('Helvetica').fillColor('#000')
       .text(fmtChave(danfe.chave), L, y, { align: 'center', width: W });
    y += 14;

    // ── QR Code ──────────────────────────────────────────────────────────────
    const QR_SIZE = 110;
    if (qrBuffer) {
      const qrX = L + (W - QR_SIZE) / 2;
      doc.image(qrBuffer, qrX, y, { width: QR_SIZE, height: QR_SIZE });
      y += QR_SIZE + 6;
    }

    // ── Consulta ─────────────────────────────────────────────────────────────
    doc.fontSize(7).fillColor('#666')
       .text('Consulte esta NFC-e em:', L, y, { align: 'center', width: W });
    y += 9;
    doc.fontSize(7).fillColor('#1a6fc4')
       .text(
         danfe.urlChave || 'http://www.fazenda.rj.gov.br/nfce/consulta',
         L, y, { align: 'center', width: W }
       );

    doc.end();
  });
}

module.exports = { generateDanfePdf };
