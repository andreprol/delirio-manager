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

    const L = 32;
    const W = doc.page.width - 64;
    const BLUE = '#1a6fc4';

    // ── Header: logo textual + empresa ───────────────────────────────────────
    // Caixa cinza-claro ao redor do header
    doc.rect(L, 28, W, 58).fillColor('#f5f5f5').fill();
    doc.rect(L, 28, W, 58).strokeColor('#cccccc').lineWidth(0.5).stroke();

    // "NFCe" como logo textual (imita o ícone da SEFAZ)
    doc.fontSize(18).font('Helvetica-Bold').fillColor(BLUE)
       .text('NFCe', L + 6, 34, { width: 52, align: 'center' });
    doc.fontSize(7).font('Helvetica').fillColor('#888')
       .text('NFC-e', L + 6, 52, { width: 52, align: 'center' });

    // Empresa à direita do logo
    const eL = L + 62;
    const eW = W - 66;
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#000')
       .text(danfe.emit?.xNome || '', eL, 32, { width: eW, align: 'center' });

    doc.fontSize(8).font('Helvetica').fillColor('#444')
       .text(`CNPJ: ${fmtCNPJ(danfe.emit?.cnpj || '')}`, eL, 46, { width: eW, align: 'center' });

    const addr = [
      danfe.emit?.xLgr,
      danfe.emit?.nro,
      danfe.emit?.xBairro,
      danfe.emit?.xMun && `${danfe.emit.xMun} , ${danfe.emit.UF}`,
    ].filter(Boolean).join(' , ');
    doc.fontSize(7.5).fillColor('#444')
       .text(addr, eL, 57, { width: eW, align: 'center' });

    let y = 94;

    // ── Produtos ─────────────────────────────────────────────────────────────
    const products = danfe.products || [];
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      if (y > doc.page.height - 160) { doc.addPage(); y = 28; }

      const isLast = i === products.length - 1;
      const rowH   = 24;

      // Nome do produto + código (linha 1)
      const nomeLine = `${p.xProd || ''}${p.cProd ? ` (Código: ${p.cProd} )` : ''}`;
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#000')
         .text(nomeLine, L + 2, y + 2, { width: W - 70, lineBreak: false });

      // "Vl. Total" label + valor (linha 1, direita)
      doc.fontSize(7).font('Helvetica').fillColor('#555')
         .text('Vl. Total', L + W - 65, y + 2, { width: 30, align: 'right' });
      doc.fontSize(8).font('Helvetica-Bold').fillColor(BLUE)
         .text(fmtMoeda(p.vProd), L + W - 32, y + 2, { width: 32, align: 'right' });

      // Qtde / UN / Vl. Unit (linha 2)
      const uCom = p.uCom || 'UN';
      const detLine = `Qtde.:${p.qCom ?? 1}   UN: ${uCom}   Vl. Unit.: ${fmtMoeda(p.vUnCom)}`;
      doc.fontSize(7).font('Helvetica').fillColor('#555')
         .text(detLine, L + 2, y + 13, { width: W - 4 });

      y += rowH;
      if (!isLast) dashedLine(doc, y, L, W);
    }

    // ── Totais ───────────────────────────────────────────────────────────────
    y += 6;
    dashedLine(doc, y, L, W);
    y += 5;

    const tot    = danfe.totals || {};
    const vPagar = tot.vNF ?? danfe.vNF ?? 0;
    const tW     = 180;
    const tL     = L + W - tW;

    // Qtd. total de itens
    doc.fontSize(7.5).font('Helvetica').fillColor('#555')
       .text('Qtd. total de itens:', tL, y, { width: tW - 35, align: 'right' });
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#000')
       .text(String(products.length), tL + tW - 32, y, { width: 32, align: 'right' });
    y += 13;

    // Valor a pagar
    doc.fontSize(8).font('Helvetica').fillColor('#555')
       .text('Valor a pagar R$:', tL, y, { width: tW - 55, align: 'right' });
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
       .text(fmtMoeda(vPagar), tL + tW - 52, y - 2, { width: 52, align: 'right' });
    y += 16;

    // Desconto / frete (se houver)
    if (tot.vDesc > 0) {
      doc.fontSize(7).font('Helvetica').fillColor('#555')
         .text('Desconto:', tL, y, { width: tW - 55, align: 'right' });
      doc.fontSize(7).font('Helvetica').fillColor('#c00')
         .text(`- ${fmtMoeda(tot.vDesc)}`, tL + tW - 52, y, { width: 52, align: 'right' });
      y += 11;
    }

    // Cabeçalho formas de pagamento
    dashedLine(doc, y, tL, tW);
    y += 5;
    doc.fontSize(7).font('Helvetica').fillColor('#555')
       .text('Forma de pagamento:', tL, y, { width: tW - 55, align: 'right' });
    doc.fontSize(7).font('Helvetica').fillColor('#555')
       .text('Valor pago R$:', tL + tW - 52, y, { width: 52, align: 'right' });
    y += 11;
    dashedLine(doc, y, tL, tW);
    y += 4;

    for (const p of (danfe.payment || [])) {
      doc.fontSize(7.5).font('Helvetica').fillColor('#000')
         .text(PAG_TYPES[p.tPag] || `Cód. ${p.tPag}`, tL, y, { width: tW - 55, align: 'right' });
      doc.fontSize(7.5).font('Helvetica').fillColor('#000')
         .text(fmtMoeda(p.vPag), tL + tW - 52, y, { width: 52, align: 'right' });
      y += 11;
    }

    dashedLine(doc, y, L, W);
    y += 10;

    // ── Informações gerais da Nota ────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#000')
       .text('Informações gerais da Nota', L, y);
    y += 11;
    dashedLine(doc, y, L, W);
    y += 5;

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#000').text('EMISSÃO NORMAL', L, y);
    y += 11;

    const serie   = danfe.series ? ` Série: ${danfe.series}` : '';
    const emissao = fmtDate(danfe.dhEmi);
    doc.fontSize(7.5).font('Helvetica').fillColor('#000')
       .text(`Número: ${danfe.nNF}${serie}  Emissão: ${emissao} - Via Consumidor`, L, y);
    y += 11;

    dashedLine(doc, y, L, W);
    y += 10;

    // ── Chave de acesso ───────────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#000').text('Chave de acesso', L, y);
    y += 11;
    dashedLine(doc, y, L, W);
    y += 5;

    const urlConsulta = danfe.urlChave || 'http://www.fazenda.rj.gov.br/nfce/consulta';
    doc.fontSize(7).font('Helvetica').fillColor('#555')
       .text(`Consulte pela Chave de Acesso em ${urlConsulta}`, L, y);
    y += 11;

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#000').text('Chave de acesso:', L, y);
    y += 11;
    doc.fontSize(7.5).font('Helvetica').fillColor('#000')
       .text(fmtChave(danfe.chave), L, y);
    y += 14;

    // ── Consumidor ────────────────────────────────────────────────────────────
    dashedLine(doc, y, L, W);
    y += 8;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#000').text('Consumidor', L, y);
    y += 11;
    dashedLine(doc, y, L, W);
    y += 5;

    let consStr = 'Consumidor não identificado';
    if (danfe.dest) {
      const d = danfe.dest;
      consStr = d.xNome || consStr;
      if (d.cpf)  consStr += `  CPF: ${d.cpf}`;
      if (d.cnpj) consStr += `  CNPJ: ${fmtCNPJ(d.cnpj)}`;
    }
    doc.fontSize(7.5).font('Helvetica').fillColor('#000').text(consStr, L, y);

    doc.end();
  });
}

module.exports = { generateDanfePdf };
