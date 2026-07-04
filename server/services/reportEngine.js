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
  const machines = db.getMachines().filter(m => m.location === storeName);
  const machineData = machines.map(m => {
    const recent = db.getDb().prepare(
      `SELECT AVG(cpu_pct) as avg_cpu, AVG((ram_total_mb - ram_free_mb)*100.0/ram_total_mb) as avg_ram,
       AVG(disk_free_gb) as avg_disk_free, AVG(cpu_temp_c) as avg_temp
       FROM metrics WHERE machine_id = ? AND ts >= ?`
    ).get(m.id, since.toISOString());
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
    `  [${t.severity.toUpperCase()}${t.is_critical_machine ? ' 🔴BOH/TERM' : ''}] ${t.description}`;

  const fmtTicket = t =>
    `  [${t.status}] ${t.title}${t.resolved_at ? ` (resolvido: ${t.resolved_at.slice(0,10)})` : ''}`;

  const fmtMachine = m =>
    `  ${m.name}${m.isCritical ? ' [CRÍTICA]' : ''} — CPU ${m.avg_cpu ?? '?'}% RAM ${m.avg_ram ?? '?'}% Temp ${m.avg_temp ?? '?'}°C DiskFree ${m.disk_free ?? '?'}GB status:${m.status}`;

  const fmtFeedback = f =>
    `  [${f.month}] "${f.feedback_text}"`;

  return `Você é um analista de TI da Delírio Tropical. Avalie o risco da loja abaixo e retorne SOMENTE um objeto JSON válido, sem texto adicional.

LOJA: ${storeName} | MÊS: ${month}

REGRA CRÍTICA: Qualquer problema em máquina TERM* (terminal Aloha) ou BOH* (servidor Aloha) = severidade máxima. Essas máquinas geram o faturamento da loja.

TÓPICOS ABERTOS (problemas ativos — pesam no score):
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

Retorne JSON com este formato exato:
{
  "score": <0-100>,
  "hardware": <0-100>,
  "software": <0-100>,
  "conectividade": <0-100>,
  "seguranca": <0-100>,
  "incidentes": <0-100>,
  "narrativa": "<2-3 parágrafos explicando o risco>",
  "recomendacoes": ["<ação 1>", "<ação 2>", "<ação 3>"]
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

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey });

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

function parseClaudeScore(aiResult) {
  return {
    score_total:       Math.min(100, Math.max(0, Math.round(aiResult.score        || 0))),
    score_hardware:    Math.min(100, Math.max(0, Math.round(aiResult.hardware     || 0))),
    score_software:    Math.min(100, Math.max(0, Math.round(aiResult.software     || 0))),
    score_connectivity:Math.min(100, Math.max(0, Math.round(aiResult.conectividade|| 0))),
    score_security:    Math.min(100, Math.max(0, Math.round(aiResult.seguranca    || 0))),
    score_incidents:   Math.min(100, Math.max(0, Math.round(aiResult.incidentes   || 0))),
    ai_narrative:      aiResult.narrativa || '',
    ai_recommendations: Array.isArray(aiResult.recomendacoes) ? aiResult.recomendacoes : [],
  };
}

module.exports = { buildStoreContext, callClaude, parseClaudeScore, detectRecurrences, buildPrompt };
