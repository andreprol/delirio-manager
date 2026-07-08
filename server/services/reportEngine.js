// server/services/reportEngine.js
'use strict';

const path = require('path');
const fs   = require('fs');
const db   = require('../db');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
  try { return require('../config.json').relatorio || {}; }
  catch { return {}; }
}

function scoreColor(s) {
  if (s > 50) return 'E53E3E';
  if (s > 30) return 'ED8936';
  return '48BB78';
}

function scoreLabel(s) {
  if (s > 50) return 'RISCO ALTO';
  if (s > 30) return 'RISCO MÉDIO';
  return 'RISCO BAIXO';
}

const clamp = (v, def = 30) => Math.min(100, Math.max(0, Math.round(v != null ? v : def)));

const WEIGHTS = {
  score_hardware:     0.20,
  score_software:     0.15,
  score_connectivity: 0.15,
  score_security:     0.20,
  score_incidents:    0.20,
  score_operational:  0.10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Context builder
// ─────────────────────────────────────────────────────────────────────────────

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
  const openTopics  = db.getTopics(storeName);
  const history     = db.getTopicsHistory(storeName, 6);
  const recurrences = detectRecurrences(history);

  // Freshdesk — ALL tickets (sem filtro de mês para o relatório)
  const rawDb = db.getDb();
  const fdActive = rawDb.prepare(
    `SELECT ticket_id, title, status, priority, created_at
     FROM freshdesk_cache WHERE store_name = ? AND status IN ('open','pending')
     ORDER BY created_at DESC`
  ).all(storeName);

  const fdClosed = rawDb.prepare(
    `SELECT ticket_id, title, status, priority, created_at, resolved_at
     FROM freshdesk_cache WHERE store_name = ? AND status IN ('resolved','closed')
     ORDER BY resolved_at DESC LIMIT 50`
  ).all(storeName);

  const fdTotal = rawDb.prepare(
    `SELECT COUNT(*) as n FROM freshdesk_cache WHERE store_name = ?`
  ).get(storeName)?.n || 0;

  // Métricas DM — últimos 30 dias
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const machines = db.getAllMachines().filter(m => m.location === storeName);
  const metricsStmt = rawDb.prepare(
    `SELECT AVG(cpu_pct) as avg_cpu,
            AVG((ram_total_mb - ram_free_mb)*100.0/ram_total_mb) as avg_ram,
            AVG(disk_free_gb) as avg_disk_free,
            AVG(cpu_temp_c) as avg_temp
     FROM metrics WHERE machine_id = ? AND ts >= ?`
  );
  const machineData = machines.map(m => {
    const r = metricsStmt.get(m.id, since.toISOString());
    return {
      name:       m.hostname,
      isCritical: /^(TERM|BOH)/i.test(m.hostname),
      status:     m.status,
      avg_cpu:    r?.avg_cpu    ? Math.round(r.avg_cpu)    : null,
      avg_ram:    r?.avg_ram    ? Math.round(r.avg_ram)    : null,
      avg_temp:   r?.avg_temp   ? Math.round(r.avg_temp)   : null,
      disk_free:  r?.avg_disk_free ? Math.round(r.avg_disk_free) : null,
    };
  });

  // SO fora de suporte
  const win10Machines = rawDb.prepare(
    `SELECT hostname FROM machines
     WHERE location = ? AND (agent_version LIKE '%Win 10%' OR agent_version LIKE '%10.0.%')`
  ).all(storeName).map(m => m.hostname);

  const recentFeedback = db.getRecentFeedback(storeName, 5);

  return {
    storeName, month,
    openTopics, history: history.slice(0, 20), recurrences,
    fdActive, fdClosed, fdTotal,
    machineData, win10Machines, recentFeedback,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildPrompt(ctx) {
  const { storeName, month, openTopics, history, recurrences,
          fdActive, machineData, win10Machines, recentFeedback } = ctx;

  const fmtTopic    = t => `  [ID:${t.id}][${t.severity.toUpperCase()}${t.is_critical_machine ? ' BOH/TERM' : ''}] ${t.description}`;
  const fmtTicket   = t => `  [${t.status}] ${t.title}`;
  const fmtMachine  = m => `  ${m.name}${m.isCritical ? ' [CRITICA]' : ''} — CPU ${m.avg_cpu ?? '?'}% RAM ${m.avg_ram ?? '?'}% Temp ${m.avg_temp ?? '?'}C DiskFree ${m.disk_free ?? '?'}GB status:${m.status}`;
  const fmtFeedback = f => `  [${f.month}] "${f.feedback_text}"`;

  return `Voce e um analista de TI da Delirio Tropical. Avalie o risco da loja e retorne SOMENTE um objeto JSON valido, sem texto adicional.

LOJA: ${storeName} | MES: ${month}

REGRA CRITICA: Qualquer problema em maquina TERM* ou BOH* = severidade maxima (terminais de faturamento).
REGRA NOTA 30: Sem dados relevantes para uma dimensao → atribua exatamente 30.
DIMENSAO OPERACIONAL: Avalie apenas topicos abertos inseridos pela equipe. Topico sem contexto tecnico real (texto de teste, generico, sem descricao de problema) = inconclusivo. Se todos inconclusivos ou nenhum topico → campo "operacional" = exatamente 30.

TOPICOS ABERTOS (pesam em TODAS as dimensoes + operacional):
${openTopics.length ? openTopics.map(fmtTopic).join('\n') : '  Nenhum'}

CHAMADOS FRESHDESK ATIVOS (${fdActive.length} abertos/pendentes — pesam no score):
${fdActive.slice(0, 20).map(fmtTicket).join('\n') || '  Nenhum'}

TOPICOS RESOLVIDOS NO MES (historico — nao pesam):
${history.filter(h => h.resolved_at?.slice(0,7) === month).slice(0,10).map(t => `  [resolvido] ${t.description}`).join('\n') || '  Nenhum'}

PROBLEMAS RECORRENTES:
${recurrences.length ? recurrences.map(r => '  ' + r).join('\n') : '  Nenhum'}

SAUDE DAS MAQUINAS (media 30 dias):
${machineData.length ? machineData.map(fmtMachine).join('\n') : '  Sem dados'}

MAQUINAS WINDOWS 10 (risco de seguranca):
${win10Machines.length ? win10Machines.join(', ') : '  Nenhuma'}

FEEDBACK HISTORICO DO GESTOR:
${recentFeedback.length ? recentFeedback.map(fmtFeedback).join('\n') : '  Nenhum'}

Retorne JSON exato com este formato (sem campos extras, sem explicacoes fora do JSON):
{
  "hardware": <0-100>,
  "software": <0-100>,
  "conectividade": <0-100>,
  "seguranca": <0-100>,
  "incidentes": <0-100>,
  "operacional": <0-100>,
  "resumo": "<1 paragrafo de resumo executivo geral da situacao da loja>",
  "narrativa_hardware": "<2-3 frases sobre hardware, temperatura, CPU, RAM e disco das maquinas>",
  "narrativa_software": "<2-3 frases sobre software, sistema operacional e atualizacoes>",
  "narrativa_conectividade": "<2-3 frases sobre conectividade e rede>",
  "narrativa_seguranca": "<2-3 frases sobre seguranca, vulnerabilidades e acesso>",
  "narrativa_incidentes": "<2-3 frases sobre incidentes, chamados Freshdesk e recorrencias>",
  "narrativa_operacional": "<2-3 frases sobre os topicos abertos pela equipe e impacto operacional>",
  "recomendacoes": ["<acao prioritaria 1>", "<acao prioritaria 2>", "<acao prioritaria 3>"],
  "inconclusivos": [<id_numerico_do_topico>, ...]
}

IMPORTANTE sobre "inconclusivos": liste o ID de CADA topico sem contexto tecnico real. Array vazio [] se TODOS foram avaliáveis.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude API
// ─────────────────────────────────────────────────────────────────────────────

async function callClaude(ctx) {
  const cfg = loadConfig();
  let apiKey = cfg.claude_api_key;
  if (!apiKey) {
    try { apiKey = require('../config.json').insights?.claude_api_key; } catch {}
  }
  if (!apiKey) throw new Error('Claude API key não configurada em config.json');

  const { Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt(ctx);

  const msg = await client.messages.create({
    model:      cfg.model || 'claude-haiku-4-5-20251001',
    max_tokens: cfg.max_tokens || 3000,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = msg.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]+\}/);
  if (!jsonMatch) throw new Error('Claude retornou resposta sem JSON válido');
  return JSON.parse(jsonMatch[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Score parser
// ─────────────────────────────────────────────────────────────────────────────

function parseClaudeScore(aiResult) {
  const score_hardware     = clamp(aiResult.hardware);
  const score_software     = clamp(aiResult.software);
  const score_connectivity = clamp(aiResult.conectividade);
  const score_security     = clamp(aiResult.seguranca);
  const score_incidents    = clamp(aiResult.incidentes);
  const score_operational  = clamp(aiResult.operacional);

  const score_total = Math.round(
    score_hardware     * WEIGHTS.score_hardware     +
    score_software     * WEIGHTS.score_software     +
    score_connectivity * WEIGHTS.score_connectivity +
    score_security     * WEIGHTS.score_security     +
    score_incidents    * WEIGHTS.score_incidents    +
    score_operational  * WEIGHTS.score_operational
  );

  return {
    // DB fields (used by saveReportRun via explicit columns)
    score_total, score_hardware, score_software, score_connectivity,
    score_security, score_incidents, score_operational,
    ai_narrative:       aiResult.resumo || aiResult.narrativa || '',
    ai_recommendations: Array.isArray(aiResult.recomendacoes) ? aiResult.recomendacoes : [],
    inconclusivos:      Array.isArray(aiResult.inconclusivos)  ? aiResult.inconclusivos  : [],
    // Per-dimension narratives for docx (not persisted to DB — saveReportRun uses explicit cols)
    dim_resumo:        aiResult.resumo            || '',
    dim_hardware:      aiResult.narrativa_hardware      || '',
    dim_software:      aiResult.narrativa_software      || '',
    dim_conectividade: aiResult.narrativa_conectividade || '',
    dim_seguranca:     aiResult.narrativa_seguranca     || '',
    dim_incidentes:    aiResult.narrativa_incidentes    || '',
    dim_operacional:   aiResult.narrativa_operacional   || '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCX generation
// ─────────────────────────────────────────────────────────────────────────────

function parsePhotoPaths(raw) {
  if (!raw) return [];
  if (raw.startsWith('[')) { try { return JSON.parse(raw); } catch { return []; } }
  return [raw];
}

async function generateDocx(ctx, scores, month) {
  const {
    Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
    ImageRun, HeadingLevel, AlignmentType, WidthType, ShadingType, BorderStyle,
  } = require('docx');

  const LOGO_PATH  = path.join(__dirname, '..', 'templates', 'logo-delirio.png');
  const PHOTOS_DIR = path.join(__dirname, '..', 'public', 'relatorio-photos');
  const logoData   = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;

  // ── Cell/border helpers ───────────────────────────────────────────────────

  function noBorderSide() {
    return { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  }
  const cellNoBorders = {
    top: noBorderSide(), bottom: noBorderSide(),
    left: noBorderSide(), right: noBorderSide(),
  };
  const tableNoBorders = {
    top: noBorderSide(), bottom: noBorderSide(),
    left: noBorderSide(), right: noBorderSide(),
    insideHorizontal: noBorderSide(), insideVertical: noBorderSide(),
  };

  function shading(fill) {
    return { type: ShadingType.CLEAR, color: 'auto', fill };
  }

  // ── Score bar row ─────────────────────────────────────────────────────────
  // Total row width: 2000 (label) + 6500 (bar area) + 500 (value) = 9000 DXA

  function scoreBarRow(label, val) {
    const color  = scoreColor(val);
    const barMax = 6500;
    const filled = Math.max(50, Math.min(barMax - 50, Math.round(val * 65)));
    const empty  = barMax - filled;
    return new TableRow({ children: [
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: label, size: 19, bold: true })] })],
        width: { size: 2000, type: WidthType.DXA },
        borders: cellNoBorders,
        margins: { right: 120 },
      }),
      new TableCell({
        children: [new Paragraph('')],
        width: { size: filled, type: WidthType.DXA },
        shading: shading(color),
        borders: cellNoBorders,
      }),
      new TableCell({
        children: [new Paragraph('')],
        width: { size: empty, type: WidthType.DXA },
        shading: shading('E0E0E0'),
        borders: cellNoBorders,
      }),
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: String(val), size: 19, bold: true, color })] })],
        width: { size: 500, type: WidthType.DXA },
        borders: cellNoBorders,
        margins: { left: 80 },
      }),
    ]});
  }

  // ── Score badge (colored block with number) ───────────────────────────────

  function scoreBadge(val) {
    const color = scoreColor(val);
    const label = scoreLabel(val);
    return new Table({
      rows: [new TableRow({ children: [
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text: String(val), size: 52, bold: true, color: 'FFFFFF' })],
              alignment: AlignmentType.CENTER,
            }),
            new Paragraph({
              children: [new TextRun({ text: label, size: 20, bold: true, color: 'FFFFFF' })],
              alignment: AlignmentType.CENTER,
            }),
          ],
          shading: shading(color),
          borders: cellNoBorders,
          margins: { top: 120, bottom: 120, left: 240, right: 240 },
          width: { size: 2200, type: WidthType.DXA },
        }),
      ]})],
      width: { size: 2200, type: WidthType.DXA },
      borders: tableNoBorders,
    });
  }

  // ── Score bars table (all dimensions) ────────────────────────────────────

  function scoreBarsTable(scores) {
    return new Table({
      rows: [
        scoreBarRow('Hardware',      scores.score_hardware),
        scoreBarRow('Software / OS', scores.score_software),
        scoreBarRow('Conectividade', scores.score_connectivity),
        scoreBarRow('Segurança',     scores.score_security),
        scoreBarRow('Incidentes',    scores.score_incidents),
        scoreBarRow('Operacional',   scores.score_operational),
      ],
      width: { size: 9000, type: WidthType.DXA },
      borders: tableNoBorders,
    });
  }

  // ── Dimension section header ──────────────────────────────────────────────

  function dimHeader(num, title, val) {
    return [
      new Paragraph({ text: `${num}. ${title}`, heading: HeadingLevel.HEADING_2 }),
      scoreBadge(val),
      new Paragraph(''),
    ];
  }

  function dimNarrative(text) {
    if (!text) return [];
    return [
      new Paragraph({ children: [new TextRun({ text, size: 20 })] }),
      new Paragraph(''),
    ];
  }

  // ── Machines table ────────────────────────────────────────────────────────

  function machinesSection(machineData) {
    if (!machineData.length) return [new Paragraph({ children: [new TextRun({ text: 'Sem dados de máquinas para este período.', size: 20 })] })];
    return [new Table({ rows: [
      new TableRow({ children: ['Máquina','CPU%','RAM%','Temp°C','Disco Livre GB','Status'].map(h =>
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 18 })] })] })
      )}),
      ...machineData.map(m => new TableRow({ children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: `${m.name}${m.isCritical ? ' 🔴' : ''}`, size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(m.avg_cpu ?? '—'), size: 18, color: m.avg_cpu > 80 ? 'E53E3E' : '000000' })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(m.avg_ram ?? '—'), size: 18, color: m.avg_ram > 80 ? 'E53E3E' : '000000' })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(m.avg_temp ?? '—'), size: 18, color: m.avg_temp > 70 ? 'E53E3E' : '000000' })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(m.disk_free ?? '—'), size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: m.status || '—', size: 18 })] })] }),
      ]})),
    ]})];
  }

  // ── Freshdesk section ─────────────────────────────────────────────────────

  function freshdeskSection(fdActive, fdClosed, fdTotal) {
    const items = [];
    items.push(new Paragraph({ children: [
      new TextRun({ text: `Histórico total: ${fdTotal} chamados`, size: 20, bold: true }),
      new TextRun({ text: `   |   Abertos/Pendentes: ${fdActive.length}`, size: 20, color: fdActive.length > 0 ? 'E53E3E' : '48BB78' }),
      new TextRun({ text: `   |   Resolvidos (últimos 50): ${fdClosed.length}`, size: 20 }),
    ]}));
    items.push(new Paragraph(''));

    if (fdActive.length) {
      items.push(new Paragraph({ children: [new TextRun({ text: 'Chamados Abertos / Pendentes', bold: true, size: 20 })] }));
      items.push(new Table({ rows: [
        new TableRow({ children: ['Título', 'Status', 'Prioridade', 'Abertura'].map(h =>
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 18 })] })] })
        )}),
        ...fdActive.map(t => new TableRow({ children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.title || '—', size: 18 })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.status || '—', size: 18 })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.priority || '—', size: 18 })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.created_at?.slice(0,10) || '—', size: 18 })] })] }),
        ]})),
      ]}));
      items.push(new Paragraph(''));
    }

    if (fdClosed.length) {
      items.push(new Paragraph({ children: [new TextRun({ text: 'Chamados Recentemente Resolvidos', bold: true, size: 20 })] }));
      items.push(new Table({ rows: [
        new TableRow({ children: ['Título', 'Abertura', 'Resolução'].map(h =>
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 18 })] })] })
        )}),
        ...fdClosed.slice(0, 25).map(t => new TableRow({ children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.title || '—', size: 18 })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.created_at?.slice(0,10) || '—', size: 18 })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.resolved_at?.slice(0,10) || '—', size: 18 })] })] }),
        ]})),
      ]}));
    }

    if (!fdActive.length && !fdClosed.length) {
      items.push(new Paragraph({ children: [new TextRun({ text: 'Nenhum chamado TI registrado.', size: 20 })] }));
    }
    return items;
  }

  // ── Operational topics (with photos) ─────────────────────────────────────

  function operationalSection(openTopics) {
    if (!openTopics.length) {
      return [new Paragraph({ children: [new TextRun({ text: 'Nenhum tópico aberto neste período.', size: 20 })] })];
    }

    const items = [];

    // Summary table
    items.push(new Table({ rows: [
      new TableRow({ children: ['ID', 'Severidade', 'Máq. Crítica', 'Descrição', 'Abertura'].map(h =>
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 18 })] })] })
      )}),
      ...openTopics.map(t => new TableRow({ children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(t.id), size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.severity.toUpperCase(), size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.is_critical_machine ? '🔴 BOH/TERM' : '—', size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.description || '—', size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.created_at?.slice(0,10) || '—', size: 18 })] })] }),
      ]})),
    ]}));
    items.push(new Paragraph(''));

    // Topic details with photos
    for (const t of openTopics) {
      const photos = parsePhotoPaths(t.photo_path);
      if (!photos.length) continue;
      items.push(new Paragraph({
        children: [new TextRun({ text: `Fotos — Tópico ID ${t.id} (${t.severity.toUpperCase()}):`, bold: true, size: 18 })],
      }));
      for (const urlPath of photos) {
        const filename = path.basename(urlPath);
        const filepath = path.join(PHOTOS_DIR, filename);
        if (!fs.existsSync(filepath)) continue;
        try {
          const data = fs.readFileSync(filepath);
          const ext  = path.extname(filename).slice(1).toLowerCase();
          items.push(new Paragraph({
            children: [new ImageRun({
              data,
              type: (ext === 'jpg' || ext === 'jpeg') ? 'jpg' : 'png',
              transformation: { width: 460, height: 300 },
            })],
          }));
        } catch (_) { /* skip unreadable photo */ }
      }
      items.push(new Paragraph(''));
    }
    return items;
  }

  // ── Build document ────────────────────────────────────────────────────────

  const children = [];

  // Cover
  if (logoData) {
    children.push(new Paragraph({
      children: [new ImageRun({ data: logoData, type: 'png', transformation: { width: 180, height: 60 } })],
      alignment: AlignmentType.CENTER,
    }));
  }
  children.push(new Paragraph({ text: 'Relatório Mensal de TI', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `${ctx.storeName} — ${month}`, size: 28 })],
    alignment: AlignmentType.CENTER,
  }));
  children.push(new Paragraph(''));

  // Score widget visual
  children.push(new Paragraph({ text: 'Score de Risco TI', heading: HeadingLevel.HEADING_2 }));
  children.push(scoreBadge(scores.score_total));
  children.push(new Paragraph(''));
  children.push(scoreBarsTable(scores));
  children.push(new Paragraph(''));

  // Resumo Executivo
  if (scores.dim_resumo) {
    children.push(new Paragraph({ text: 'Resumo Executivo', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ children: [new TextRun({ text: scores.dim_resumo, size: 20 })] }));
    children.push(new Paragraph(''));
  }

  // ── 1. Hardware ───────────────────────────────────────────────────────────
  children.push(...dimHeader(1, 'Hardware', scores.score_hardware));
  children.push(...dimNarrative(scores.dim_hardware));
  children.push(...machinesSection(ctx.machineData));
  children.push(new Paragraph(''));

  // ── 2. Software / OS ─────────────────────────────────────────────────────
  children.push(...dimHeader(2, 'Software / OS', scores.score_software));
  children.push(...dimNarrative(scores.dim_software));
  if (ctx.win10Machines.length) {
    children.push(new Paragraph({
      children: [new TextRun({
        text: `⚠️ Máquinas com Windows 10 (sem suporte de segurança): ${ctx.win10Machines.join(', ')}`,
        color: 'E53E3E', bold: true, size: 20,
      })],
    }));
    children.push(new Paragraph({ children: [new TextRun({ text: 'Recomendação: agendar upgrade para Windows 11 com urgência.', size: 20 })] }));
  } else {
    children.push(new Paragraph({ children: [new TextRun({ text: 'Nenhuma máquina com OS fora de suporte detectada.', size: 20 })] }));
  }
  children.push(new Paragraph(''));

  // ── 3. Conectividade ─────────────────────────────────────────────────────
  children.push(...dimHeader(3, 'Conectividade', scores.score_connectivity));
  children.push(...dimNarrative(scores.dim_conectividade));
  children.push(new Paragraph(''));

  // ── 4. Segurança ─────────────────────────────────────────────────────────
  children.push(...dimHeader(4, 'Segurança', scores.score_security));
  children.push(...dimNarrative(scores.dim_seguranca));
  children.push(new Paragraph({
    children: [new TextRun({
      text: '[Zamak RMM — integração em andamento. Relatório de endpoints e tentativas de acesso não autorizado será incluído em breve.]',
      color: '888888', size: 18,
    })],
  }));
  children.push(new Paragraph(''));

  // ── 5. Incidentes ────────────────────────────────────────────────────────
  children.push(...dimHeader(5, 'Incidentes', scores.score_incidents));
  children.push(...dimNarrative(scores.dim_incidentes));
  children.push(...freshdeskSection(ctx.fdActive, ctx.fdClosed, ctx.fdTotal));
  children.push(new Paragraph(''));

  // ── 6. Operacional ───────────────────────────────────────────────────────
  children.push(...dimHeader(6, 'Operacional', scores.score_operational));
  children.push(...dimNarrative(scores.dim_operacional));
  children.push(...operationalSection(ctx.openTopics));
  children.push(new Paragraph(''));

  // ── 7. Recomendações ─────────────────────────────────────────────────────
  children.push(new Paragraph({ text: '7. Recomendações e Próximos Passos', heading: HeadingLevel.HEADING_2 }));
  for (const rec of (scores.ai_recommendations || [])) {
    children.push(new Paragraph({ children: [new TextRun({ text: `• ${rec}`, size: 20 })] }));
  }

  // ── Write file ────────────────────────────────────────────────────────────

  const doc = new Document({ sections: [{ children }] });
  const DOWNLOADS = path.join(__dirname, '..', '..', 'downloads', 'relatorios');
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const safeName  = ctx.storeName.replace(/[^a-zA-Z0-9À-ž _-]/g, '').replace(/\s+/g, '_').slice(0, 60);
  const safeMonth = month.replace(/[^0-9-]/g, '').slice(0, 7);
  const filename  = `relatorio_${safeName}_${safeMonth}.docx`;
  const filepath  = path.join(DOWNLOADS, filename);
  if (!filepath.startsWith(DOWNLOADS)) throw new Error('invalid report path');
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF conversion
// ─────────────────────────────────────────────────────────────────────────────

async function generatePdf(docxPath) {
  const { execFileSync } = require('child_process');
  const dir = path.dirname(docxPath);
  try {
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, docxPath], { timeout: 30000 });
    return docxPath.replace(/\.docx$/, '.pdf');
  } catch (err) {
    console.error('[reportEngine] PDF conversion failed:', err.message);
    return null;
  }
}

module.exports = {
  buildStoreContext, callClaude, parseClaudeScore,
  detectRecurrences, buildPrompt, generateDocx, generatePdf,
};
