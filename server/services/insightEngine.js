'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const db     = require('../db');
const { broadcast } = require('./websocket');

function loadConfig() {
  try {
    const cfgPath = path.join(__dirname, '..', 'config.json');
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return { insights: { enabled: false } };
  }
}

let timer;

function start() {
  const cfg = loadConfig().insights || {};
  if (!cfg.enabled || !cfg.claude_api_key) {
    console.log('[InsightEngine] Desabilitado ou sem API key — insights de IA inativos.');
    return;
  }

  const intervalMs = (cfg.interval_hours || 6) * 60 * 60 * 1000;
  timer = setInterval(runNow, intervalMs);
  console.log(`[InsightEngine] Iniciado — intervalo: ${cfg.interval_hours || 6}h`);
}

function stop() {
  if (timer) clearInterval(timer);
}

async function runNow() {
  const cfg = loadConfig().insights || {};
  if (!cfg.claude_api_key) {
    console.log('[InsightEngine] Sem API key configurada.');
    return 0;
  }

  const machines = db.getAllMachines();
  let totalGenerated = 0;

  for (const machine of machines) {
    try {
      const generated = await analyzeMachine(machine, cfg);
      totalGenerated += generated;
    } catch (err) {
      console.error(`[InsightEngine] Erro ao analisar ${machine.id}: ${err.message}`);
    }
  }

  console.log(`[InsightEngine] Ciclo concluído — ${totalGenerated} insights gerados.`);
  return totalGenerated;
}

async function analyzeMachine(machine, cfg) {
  const lookbackDays = cfg.lookback_days || 7;
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  // Fetch Windows events for this machine
  const events = db.getDb().prepare(`
    SELECT event_id, source, level, translation, event_time
    FROM win_events WHERE machine_id = ? AND event_time >= ?
    ORDER BY event_time DESC LIMIT 150
  `).all(machine.id, since);

  // Fetch offline events for this machine
  const offlineEvents = db.getDb().prepare(`
    SELECT ts, type, details FROM events
    WHERE machine_id = ? AND type = 'offline' AND ts >= ?
    ORDER BY ts DESC LIMIT 30
  `).all(machine.id, since);

  if (events.length === 0 && offlineEvents.length === 0) return 0;

  const name    = machine.display_name || machine.hostname;
  const context = buildContext(name, events, offlineEvents);

  const prompt = `Você é um especialista em suporte técnico Windows. Analise os eventos abaixo da máquina "${name}" e identifique padrões problemáticos.

REGRAS CRÍTICAS:
1. Só aponte padrões com evidência clara nos dados (mínimo 2 ocorrências ou 1 evento crítico grave).
2. Para "solution": SOMENTE sugira se tiver alta confiança na solução. Se não souber com certeza, retorne null. Nunca invente soluções.
3. Retorne JSON válido, sem texto extra.

DADOS:
${context}

Responda SOMENTE com JSON neste formato exato:
{
  "insights": [
    {
      "severity": "critical|warning|info",
      "pattern": "Descrição clara do padrão em português (máx 200 chars)",
      "solution": "Solução realista e específica em português (máx 300 chars) ou null"
    }
  ]
}

Se não houver padrões relevantes, retorne: {"insights":[]}`;

  let responseText;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic.default({ apiKey: cfg.claude_api_key });

    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });
    responseText = msg.content[0]?.text || '{"insights":[]}';
  } catch (err) {
    console.error(`[InsightEngine] Claude API error for ${machine.id}: ${err.message}`);
    return 0;
  }

  let parsed;
  try {
    // Claude sometimes wraps JSON in markdown code blocks — strip them
    const cleaned = responseText.replace(/^```json\n?/,'').replace(/\n?```$/,'').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn(`[InsightEngine] Resposta inválida da Claude API para ${machine.id}: ${responseText.slice(0, 100)}`);
    return 0;
  }

  const machineInsights = parsed.insights || [];
  let saved = 0;

  for (const insight of machineInsights) {
    if (!insight.pattern || !insight.severity) continue;

    const hash = crypto
      .createHash('sha256')
      .update(`${machine.id}:${insight.pattern.slice(0, 80)}`)
      .digest('hex');

    db.saveInsight({
      machineId:   machine.id,
      severity:    insight.severity,
      pattern:     insight.pattern,
      solution:    insight.solution || null,
      patternHash: hash,
    });
    saved++;
  }

  if (saved > 0) {
    broadcast('new_insight', { machineId: machine.id, count: saved });
    console.log(`[InsightEngine] ${saved} insights para ${machine.id}`);
  }

  return saved;
}

function buildContext(name, events, offlineEvents) {
  const lines = [];

  if (offlineEvents.length > 0) {
    lines.push(`=== QUEDAS OFFLINE (últimas ${offlineEvents.length}) ===`);
    offlineEvents.forEach(e => lines.push(`${e.ts}: ${e.details}`));
  }

  if (events.length > 0) {
    lines.push(`=== EVENTOS DO WINDOWS (últimos ${events.length}) ===`);
    events.forEach(e =>
      lines.push(`${e.event_time} [${e.level.toUpperCase()}] ID:${e.event_id} ${e.translation}`)
    );
  }

  const full = lines.join('\n');
  return full.length > 8000 ? full.slice(0, 8000) + '\n[... truncado ...]' : full;
}

function restart() {
  stop();
  start();
}

module.exports = { start, stop, runNow, restart };
