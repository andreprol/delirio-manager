'use strict';

const PDFDocument = require('pdfkit');

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
  return Number(v || 0).toFixed(2).replace('.', ',');
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
  } catch { return iso; }
}

function fmtChave(chave) {
  if (!chave) return '';
  return chave.match(/.{1,4}/g)?.join(' ') || chave;
}

// Linha sólida
function hLine(doc, y, left, width, color = '#cccccc') {
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor(color).lineWidth(0.5).stroke();
}

// Linha tracejada (imita o estilo SEFAZ entre produtos)
function dashedLine(doc, y, left, width) {
  doc.save();
  doc.moveTo(left, y).lineTo(left + width, y)
     .dash(3, { space: 3 }).strokeColor('#aaaaaa').lineWidth(0.4).stroke();
  doc.restore();
}

function drawHeader(doc, danfe, L, W, BLUE) {
  doc.rect(L, 28, W, 58).fillColor('#f5f5f5').fill();
  doc.rect(L, 28, W, 58).strokeColor('#cccccc').lineWidth(0.5).stroke();
  doc.fontSize(18).font('Helvetica-Bold').fillColor(BLUE)
     .text('NFCe', L + 6, 34, { width: 52, align: 'center' });
  doc.fontSize(7).font('Helvetica').fillColor('#888')
     .text('NFC-e', L + 6, 52, { width: 52, align: 'center' });

  const eL   = L + 62;
  const eW   = W - 66;
  const emit = danfe.emit || {};
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#000')
     .text(emit.xNome || '', eL, 32, { width: eW, align: 'center' });
  doc.fontSize(8).font('Helvetica').fillColor('#444')
     .text(`CNPJ: ${fmtCNPJ(emit.cnpj || '')}`, eL, 46, { width: eW, align: 'center' });

  const addr = [
    emit.xLgr,
    emit.nro,
    emit.xBairro,
    emit.xMun && `${emit.xMun} , ${emit.UF}`,
  ].filter(Boolean).join(' , ');
  doc.fontSize(7.5).fillColor('#444').text(addr, eL, 57, { width: eW, align: 'center' });
  return 94;
}

function drawProducts(doc, products, L, W, BLUE, y) {
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (y > doc.page.height - 160) { doc.addPage(); y = 28; }
    const isLast  = i === products.length - 1;
    const nomeLine = `${p.xProd || ''}${p.cProd ? ` (Código: ${p.cProd} )` : ''}`;
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#000')
       .text(nomeLine, L + 2, y + 2, { width: W - 70, lineBreak: false });
    doc.fontSize(7).font('Helvetica').fillColor('#555')
       .text('Vl. Total', L + W - 65, y + 2, { width: 30, align: 'right' });
    doc.fontSize(8).font('Helvetica-Bold').fillColor(BLUE)
       .text(fmtMoeda(p.vProd), L + W - 32, y + 2, { width: 32, align: 'right' });
    const uCom    = p.uCom || 'UN';
    const detLine = `Qtde.:${p.qCom ?? 1}   UN: ${uCom}   Vl. Unit.: ${fmtMoeda(p.vUnCom)}`;
    doc.fontSize(7).font('Helvetica').fillColor('#555')
       .text(detLine, L + 2, y + 13, { width: W - 4 });
    y += 24;
    if (!isLast) dashedLine(doc, y, L, W);
  }
  return y;
}

function drawTotals(doc, danfe, L, W, y) {
  y += 6; dashedLine(doc, y, L, W); y += 5;
  const tot    = danfe.totals || {};
  const vPagar = tot.vNF ?? danfe.vNF ?? 0;
  const tW     = 180;
  const tL     = L + W - tW;

  doc.fontSize(7.5).font('Helvetica').fillColor('#555')
     .text('Qtd. total de itens:', tL, y, { width: tW - 35, align: 'right' });
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#000')
     .text(String((danfe.products || []).length), tL + tW - 32, y, { width: 32, align: 'right' });
  y += 13;
  doc.fontSize(8).font('Helvetica').fillColor('#555')
     .text('Valor a pagar R$:', tL, y, { width: tW - 55, align: 'right' });
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
     .text(fmtMoeda(vPagar), tL + tW - 52, y - 2, { width: 52, align: 'right' });
  y += 16;
  if (tot.vDesc > 0) {
    doc.fontSize(7).font('Helvetica').fillColor('#555')
       .text('Desconto:', tL, y, { width: tW - 55, align: 'right' });
    doc.fontSize(7).font('Helvetica').fillColor('#c00')
       .text(`- ${fmtMoeda(tot.vDesc)}`, tL + tW - 52, y, { width: 52, align: 'right' });
    y += 11;
  }
  return { y, tot, tL, tW };
}

function drawPayments(doc, danfe, tL, tW, L, W, y) {
  dashedLine(doc, y, tL, tW); y += 5;
  doc.fontSize(7).font('Helvetica').fillColor('#555')
     .text('Forma de pagamento:', tL, y, { width: tW - 55, align: 'right' });
  doc.fontSize(7).font('Helvetica').fillColor('#555')
     .text('Valor pago R$:', tL + tW - 52, y, { width: 52, align: 'right' });
  y += 11; dashedLine(doc, y, tL, tW); y += 4;
  for (const p of (danfe.payment || [])) {
    doc.fontSize(7.5).font('Helvetica').fillColor('#000')
       .text(PAG_TYPES[p.tPag] || `Cód. ${p.tPag}`, tL, y, { width: tW - 55, align: 'right' });
    doc.fontSize(7.5).font('Helvetica').fillColor('#000')
       .text(fmtMoeda(p.vPag), tL + tW - 52, y, { width: 52, align: 'right' });
    y += 11;
  }
  dashedLine(doc, y, L, W); y += 10;
  return y;
}

function drawNoteInfo(doc, danfe, L, W, y) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#000')
     .text('Informações gerais da Nota', L, y);
  y += 11; dashedLine(doc, y, L, W); y += 5;
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#000').text('EMISSÃO NORMAL', L, y);
  y += 11;
  const serie = danfe.series ? ` Série: ${danfe.series}` : '';
  doc.fontSize(7.5).font('Helvetica').fillColor('#000')
     .text(`Número: ${danfe.nNF}${serie}  Emissão: ${fmtDate(danfe.dhEmi)} - Via Consumidor`, L, y);
  y += 11; dashedLine(doc, y, L, W); y += 10;

  doc.fontSize(8).font('Helvetica-Bold').fillColor('#000').text('Chave de acesso', L, y);
  y += 11; dashedLine(doc, y, L, W); y += 5;
  const urlConsulta = danfe.urlChave || 'http://www.fazenda.rj.gov.br/nfce/consulta';
  doc.fontSize(7).font('Helvetica').fillColor('#555')
     .text(`Consulte pela Chave de Acesso em ${urlConsulta}`, L, y);
  y += 11;
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#000').text('Chave de acesso:', L, y);
  y += 11;
  doc.fontSize(7.5).font('Helvetica').fillColor('#000').text(fmtChave(danfe.chave), L, y);
  y += 14;
  return y;
}

function drawConsumer(doc, danfe, L, W, y) {
  dashedLine(doc, y, L, W); y += 8;
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#000').text('Consumidor', L, y);
  y += 11; dashedLine(doc, y, L, W); y += 5;
  let consStr = 'Consumidor não identificado';
  if (danfe.dest) {
    const d = danfe.dest;
    consStr = d.xNome || consStr;
    if (d.cpf)  consStr += `  CPF: ${d.cpf}`;
    if (d.cnpj) consStr += `  CNPJ: ${fmtCNPJ(d.cnpj)}`;
  }
  doc.fontSize(7.5).font('Helvetica').fillColor('#000').text(consStr, L, y);
}

/**
 * Generates a DANFE NFC-e PDF buffer — layout baseado na consulta SEFAZ RJ.
 * @param {object} danfe — NFCeDanfe payload from nfce_index.danfe_json
 * @returns {Promise<Buffer>}
 */
function generateDanfePdf(danfe) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 28, left: 32, right: 32, bottom: 28 },
    });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L    = 32;
    const W    = doc.page.width - 64;
    const BLUE = '#1a6fc4';

    let y                     = drawHeader(doc, danfe, L, W, BLUE);
    const products            = danfe.products || [];
    y                         = drawProducts(doc, products, L, W, BLUE, y);
    const { y: y2, tot, tL, tW } = drawTotals(doc, danfe, L, W, y);
    const y3                  = drawPayments(doc, danfe, tL, tW, L, W, y2);
    const y4                  = drawNoteInfo(doc, danfe, L, W, y3);
    drawConsumer(doc, danfe, L, W, y4);
    doc.end();
  });
}

module.exports = { generateDanfePdf };
