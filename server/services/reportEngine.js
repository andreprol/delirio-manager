// server/services/reportEngine.js
'use strict';

const path = require('path');
const db   = require('../db');

function loadConfig() {
  try { return require('../config.json').relatorio || {}; }
  catch { return {}; }
}

// Detecta padrões recorrentes no histórico de tópicos resolvidos
function detectRecurrences(history) {
  const counts = {};
  for (const h of history) {
    const key = h.description.toLowerCase().slice(0, 40);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, c]) => c >= 2)
    .map(([desc, count]) => `"${desc}..." (${count}x nos últimos 6 meses)`);
}

function buildStoreContext(storeName, month) {
  // Tópicos abertos — pesam no score
  const openTopics = db.getTopics(storeName);

  // Histórico de resolvidos — apenas insights
  const history = db.getTopicsHistory(storeName, 6);
  const recurrences = detectRecurrences(history);

  // Chamados Freshdesk
  const fdActive = db.getFreshdeskActive(storeName, month);
  const fdClosed = db.getFreshdeskClosed(storeName, month);

  // Métricas DM — últimos 30 dias
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const machines = db.getAllMachines().filter(m => m.location === storeName);
  const metricsStmt = db.getDb().prepare(
    `SELECT AVG(cpu_pct) as avg_cpu, AVG((ram_total_mb - ram_free_mb)*100.0/ram_total_mb) as avg_ram,
     AVG(disk_free_gb) as avg_disk_free, AVG(cpu_temp_c) as avg_temp
     FROM metrics WHERE machine_id = ? AND ts >= ?`
  );
  const machineData = machines.map(m => {
    const recent = metricsStmt.get(m.id, since.toISOString());
    return {
      name:       m.hostname,
      isCritical: /^(TERM|BOH)/i.test(m.hostname),
      os:         m.agent_version || 'unknown',
      status:     m.status,
      avg_cpu:    recent?.avg_cpu    ? Math.round(recent.avg_cpu)    : null,
      avg_ram:    recent?.avg_ram    ? Math.round(recent.avg_ram)    : null,
      avg_temp:   recent?.avg_temp   ? Math.round(recent.avg_temp)   : null,
      disk_free:  recent?.avg_disk_free ? Math.round(recent.avg_disk_free) : null,
    };
  });

  // Alertas de OS — Windows 10 (build < 19045 indica Win10)
  const win10Machines = db.getDb().prepare(
    `SELECT hostname FROM machines WHERE location = ? AND (agent_version LIKE '%Win 10%' OR agent_version LIKE '%10.0.%')`
  ).all(storeName).map(m => m.hostname);

  // Feedback histórico para calibração da IA
  const recentFeedback = db.getRecentFeedback(storeName, 5);

  return {
    storeName, month, openTopics, history: history.slice(0, 20),
    recurrences, fdActive, fdClosed, machineData, win10Machines, recentFeedback,
  };
}

function buildPrompt(ctx) {
  const { storeName, month, openTopics, history, recurrences, fdActive, fdClosed, machineData, win10Machines, recentFeedback } = ctx;

  const fmtTopic = t =>
    `  [ID:${t.id}][${t.severity.toUpperCase()}${t.is_critical_machine ? ' 🔴BOH/TERM' : ''}] ${t.description}`;

  const fmtTicket = t =>
    `  [${t.status}] ${t.title}${t.resolved_at ? ` (resolvido: ${t.resolved_at.slice(0,10)})` : ''}`;

  const fmtMachine = m =>
    `  ${m.name}${m.isCritical ? ' [CRÍTICA]' : ''} — CPU ${m.avg_cpu ?? '?'}% RAM ${m.avg_ram ?? '?'}% Temp ${m.avg_temp ?? '?'}°C DiskFree ${m.disk_free ?? '?'}GB status:${m.status}`;

  const fmtFeedback = f =>
    `  [${f.month}] "${f.feedback_text}"`;

  return `Você é um analista de TI da Delírio Tropical. Avalie o risco da loja abaixo e retorne SOMENTE um objeto JSON válido, sem texto adicional.

LOJA: ${storeName} | MÊS: ${month}

REGRA CRÍTICA: Qualquer problema em máquina TERM* (terminal Aloha) ou BOH* (servidor Aloha) = severidade máxima. Essas máquinas geram o faturamento da loja.

REGRA NOTA 30: Se não houver dados relevantes para uma dimensão (hardware, software, conectividade, segurança, incidentes ou operacional), atribua nota 30. Isso representa risco baixo e gerenciável — não ausência de informação.

TÓPICOS ABERTOS — PROBLEMAS ATIVOS (pesam no score de todas as dimensões e na dimensão Operacional):
${openTopics.length ? openTopics.map(fmtTopic).join('\n') : '  Nenhum'}

CHAMADOS FRESHDESK ATIVOS (abertos/pendentes — pesam no score):
${fdActive.length ? fdActive.map(fmtTicket).join('\n') : '  Nenhum'}

TÓPICOS RESOLVIDOS NO MÊS (histórico — NÃO pesam no score):
${history.filter(h => h.resolved_at?.slice(0,7) === month).slice(0,10).map(t => `  [resolvido] ${t.description}`).join('\n') || '  Nenhum'}

CHAMADOS FRESHDESK FECHADOS NO MÊS (histórico — NÃO pesam no score):
${fdClosed.length ? fdClosed.map(fmtTicket).join('\n') : '  Nenhum'}

PROBLEMAS RECORRENTES DETECTADOS (contribuem para score de incidentes):
${recurrences.length ? recurrences.map(r => '  ' + r).join('\n') : '  Nenhum padrão recorrente'}

SAÚDE DAS MÁQUINAS:
${machineData.length ? machineData.map(fmtMachine).join('\n') : '  Sem dados de máquinas'}

MÁQUINAS WINDOWS 10 (sem suporte — risco de segurança):
${win10Machines.length ? win10Machines.join(', ') : '  Nenhuma'}

FEEDBACK HISTÓRICO DO GESTOR (calibre seu julgamento com base nisto):
${recentFeedback.length ? recentFeedback.map(fmtFeedback).join('\n') : '  Nenhum feedback anterior'}

DIMENSÃO OPERACIONAL: Avalie exclusivamente os tópicos abertos inseridos pela equipe (listados acima com ID:). Esta dimensão mede o impacto operacional percebido pela equipe local. Se um tópico não fornecer informação suficiente para qualquer avaliação (ex.: texto de teste, imagem irrelevante, descrição vazia ou sem contexto), inclua o ID desse tópico no campo "inconclusivos". Tópicos inconclusivos não contribuem para o score operacional.

Retorne JSON com este formato exato:
{
  "score": <0-100>,
  "hardware": <0-100>,
  "software": <0-100>,
  "conectividade": <0-100>,
  "seguranca": <0-100>,
  "incidentes": <0-100>,
  "operacional": <0-100>,
  "narrativa": "<2-3 parágrafos explicando o risco>",
  "recomendacoes": ["<ação 1>", "<ação 2>", "<ação 3>"],
  "inconclusivos": [<id1>, <id2>]
}`;
}

async function callClaude(ctx) {
  const cfg = loadConfig();
  // Fallback: usa insights.claude_api_key se relatorio.claude_api_key não estiver configurado
  let apiKey = cfg.claude_api_key;
  if (!apiKey) {
    try { apiKey = require('../config.json').insights?.claude_api_key; } catch {}
  }
  if (!apiKey) throw new Error('Claude API key não configurada em config.json (relatorio.claude_api_key)');

  const { Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const prompt = buildPrompt(ctx);

  const msg = await client.messages.create({
    model:      cfg.model || 'claude-haiku-4-5-20251001',
    max_tokens: cfg.max_tokens || 1500,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = msg.content[0].text.trim();
  // Extrair JSON mesmo se vier com texto extra
  const jsonMatch = text.match(/\{[\s\S]+\}/);
  if (!jsonMatch) throw new Error('Claude retornou resposta sem JSON válido');
  return JSON.parse(jsonMatch[0]);
}

const clamp = (v, def = 30) => Math.min(100, Math.max(0, Math.round(v != null ? v : def)));

function parseClaudeScore(aiResult) {
  return {
    score_total:        clamp(aiResult.score,          0),
    score_hardware:     clamp(aiResult.hardware),
    score_software:     clamp(aiResult.software),
    score_connectivity: clamp(aiResult.conectividade),
    score_security:     clamp(aiResult.seguranca),
    score_incidents:    clamp(aiResult.incidentes),
    score_operational:  clamp(aiResult.operacional),
    ai_narrative:       aiResult.narrativa || '',
    ai_recommendations: Array.isArray(aiResult.recomendacoes) ? aiResult.recomendacoes : [],
    inconclusivos:      Array.isArray(aiResult.inconclusivos)  ? aiResult.inconclusivos  : [],
  };
}

async function generateDocx(ctx, scores, month) {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
          ImageRun, HeadingLevel, AlignmentType, WidthType } = require('docx');
  const fs   = require('fs');
  const path = require('path');

  const LOGO_PATH = path.join(__dirname, '..', 'templates', 'logo-delirio.png');
  const logoData  = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;

  const SCORE_COLOR = scores.score_total >= 60 ? 'DC2626' : scores.score_total >= 30 ? 'EA580C' : '16A34A';
  const SCORE_LABEL = scores.score_total >= 60 ? 'RISCO ALTO' : scores.score_total >= 30 ? 'RISCO MÉDIO' : 'RISCO BAIXO';

  const dim = (label, val) => new TableRow({ children: [
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 18 })] })], width: { size: 50, type: WidthType.PERCENTAGE } }),
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(val), size: 18 })] })], width: { size: 50, type: WidthType.PERCENTAGE } }),
  ]});

  const topicRow = (t) => new TableRow({ children: [
    new TableCell({ children: [new Paragraph(t.severity.toUpperCase())] }),
    new TableCell({ children: [new Paragraph(t.is_critical_machine ? '🔴 BOH/TERM' : '—')] }),
    new TableCell({ children: [new Paragraph(t.description)] }),
    new TableCell({ children: [new Paragraph(t.created_at.slice(0,10))] }),
  ]});

  const fdRow = (t) => new TableRow({ children: [
    new TableCell({ children: [new Paragraph(t.title)] }),
    new TableCell({ children: [new Paragraph(t.status)] }),
    new TableCell({ children: [new Paragraph(t.created_at?.slice(0,10) || '—')] }),
    new TableCell({ children: [new Paragraph(t.resolved_at?.slice(0,10) || '—')] }),
  ]});

  const sections = [];

  // Capa
  if (logoData) {
    sections.push(new Paragraph({
      children: [new ImageRun({ data: logoData, type: 'png', transformation: { width: 180, height: 60 } })],
      alignment: AlignmentType.CENTER,
    }));
  }
  sections.push(new Paragraph({ text: `Relatório Mensal de TI`, heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }));
  sections.push(new Paragraph({ children: [new TextRun({ text: `${ctx.storeName} — ${month}`, size: 28 })] , alignment: AlignmentType.CENTER}));
  sections.push(new Paragraph({ children: [new TextRun({ text: `Score de Risco: ${scores.score_total}/100 — ${SCORE_LABEL}`, bold: true, color: SCORE_COLOR, size: 28 })], alignment: AlignmentType.CENTER }));
  sections.push(new Paragraph(''));

  // Score detalhado
  sections.push(new Paragraph({ text: '2. Score de Risco', heading: HeadingLevel.HEADING_2 }));
  sections.push(new Table({ rows: [
    dim('Hardware',        scores.score_hardware),
    dim('Software / OS',   scores.score_software),
    dim('Conectividade',   scores.score_connectivity),
    dim('Segurança',       scores.score_security),
    dim('Incidentes',      scores.score_incidents),
    dim('Operacional',     scores.score_operational),
    dim('TOTAL',           scores.score_total),
  ], width: { size: 60, type: WidthType.PERCENTAGE } }));
  sections.push(new Paragraph(''));
  sections.push(new Paragraph(scores.ai_narrative || ''));
  sections.push(new Paragraph(''));

  // Tópicos abertos
  sections.push(new Paragraph({ text: '3. Tópicos Abertos', heading: HeadingLevel.HEADING_2 }));
  if (ctx.openTopics.length) {
    sections.push(new Table({ rows: [
      new TableRow({ children: ['Severidade','Máquina Crítica','Descrição','Abertura'].map(h =>
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })
      )}),
      ...ctx.openTopics.map(topicRow),
    ]}));
  } else {
    sections.push(new Paragraph('Nenhum tópico aberto neste mês.'));
  }
  sections.push(new Paragraph(''));

  // Chamados Freshdesk
  sections.push(new Paragraph({ text: '5. Chamados TI — Freshdesk', heading: HeadingLevel.HEADING_2 }));
  const allFd = [...ctx.fdActive, ...ctx.fdClosed];
  if (allFd.length) {
    sections.push(new Table({ rows: [
      new TableRow({ children: ['Título','Status','Abertura','Resolução'].map(h =>
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })
      )}),
      ...allFd.map(fdRow),
    ]}));
  } else {
    sections.push(new Paragraph('Nenhum chamado TI registrado.'));
  }
  sections.push(new Paragraph(''));

  // Máquinas
  sections.push(new Paragraph({ text: '6. Saúde das Máquinas', heading: HeadingLevel.HEADING_2 }));
  if (ctx.machineData.length) {
    sections.push(new Table({ rows: [
      new TableRow({ children: ['Máquina','CPU%','RAM%','Temp°C','Disco Livre GB','Status'].map(h =>
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })
      )}),
      ...ctx.machineData.map(m => new TableRow({ children: [
        new TableCell({ children: [new Paragraph(`${m.name}${m.isCritical ? ' 🔴' : ''}`)] }),
        new TableCell({ children: [new Paragraph(String(m.avg_cpu ?? '—'))] }),
        new TableCell({ children: [new Paragraph(String(m.avg_ram ?? '—'))] }),
        new TableCell({ children: [new Paragraph(String(m.avg_temp ?? '—'))] }),
        new TableCell({ children: [new Paragraph(String(m.disk_free ?? '—'))] }),
        new TableCell({ children: [new Paragraph(m.status || '—')] }),
      ]})),
    ]}));
  } else {
    sections.push(new Paragraph('Sem dados de máquinas para este período.'));
  }
  sections.push(new Paragraph(''));

  // Windows 10
  sections.push(new Paragraph({ text: '7. Alertas de Sistema Operacional', heading: HeadingLevel.HEADING_2 }));
  if (ctx.win10Machines.length) {
    sections.push(new Paragraph(`As seguintes máquinas estão com Windows 10 (sem suporte de segurança): ${ctx.win10Machines.join(', ')}`));
    sections.push(new Paragraph('Recomendação: agendar upgrade para Windows 11 com urgência.'));
  } else {
    sections.push(new Paragraph('Nenhuma máquina com OS fora de suporte detectada.'));
  }
  sections.push(new Paragraph(''));

  // Zamak placeholder
  sections.push(new Paragraph({ text: '8. Segurança — Zamak', heading: HeadingLevel.HEADING_2 }));
  sections.push(new Paragraph('[Pendente — integração Zamak em andamento. Incluir relatório de tentativas de invasão quando disponível.]'));
  sections.push(new Paragraph(''));

  // Recomendações
  sections.push(new Paragraph({ text: '9. Recomendações e Próximos Passos', heading: HeadingLevel.HEADING_2 }));
  for (const rec of (scores.ai_recommendations || [])) {
    sections.push(new Paragraph({ text: `• ${rec}`, bullet: { level: 0 } }));
  }

  const doc = new Document({ sections: [{ children: sections }] });
  const DOWNLOADS = path.join(__dirname, '..', '..', 'downloads', 'relatorios');
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const safeName  = ctx.storeName.replace(/[^a-zA-Z0-9À-ÿ _-]/g, '').replace(/\s+/g, '_').slice(0, 60);
  const safeMonth = month.replace(/[^0-9-]/g, '').slice(0, 7);
  const filename  = `relatorio_${safeName}_${safeMonth}.docx`;
  const filepath  = path.join(DOWNLOADS, filename);
  if (!filepath.startsWith(DOWNLOADS)) throw new Error('invalid report path');
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

async function generatePdf(docxPath) {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const dir  = path.dirname(docxPath);
  try {
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, docxPath], { timeout: 30000 });
    return docxPath.replace(/\.docx$/, '.pdf');
  } catch (err) {
    console.error('[reportEngine] PDF conversion failed:', err.message);
    return null;
  }
}

module.exports = { buildStoreContext, callClaude, parseClaudeScore, detectRecurrences, buildPrompt, generateDocx, generatePdf };
