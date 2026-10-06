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

async function fetchClaudeResponse(cfg, prompt) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic.default({ apiKey: cfg.claude_api_key });
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.text || '{"insights":[]}';
  } catch (err) {
    console.error(`[InsightEngine] Claude API error: ${err.message}`);
    return null;
  }
}

function persistInsights(machine, machineInsights) {
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

// Busca TODO o backlog novo desde o cursor salvo (sem LIMIT aqui) — é o que
// garante que o cursor devolvido nunca pule evento sem ele ter sido
// realmente visto. Um LIMIT nesta query faria o DESC sempre trazer
// justamente o id mais alto (= o próprio MAX da tabela), então "avançar o
// cursor até o maior id buscado" viraria idêntico a "avançar até o MAX da
// tabela" — perda silenciosa do restante do backlog sempre que ele exceder
// o LIMIT (achado de review). O recorte pro prompt (mais recente = sinal
// mais relevante) acontece depois, em JS, sem afetar o cursor.
function fetchNewEvents(machine) {
  const lastWinId     = machine.last_win_event_id || 0;
  const lastOfflineId = machine.last_offline_event_id || 0;

  const events = db.getDb().prepare(`
    SELECT id, event_id, source, level, translation, event_time
    FROM win_events WHERE machine_id = ? AND id > ?
    ORDER BY id DESC
  `).all(machine.id, lastWinId);

  const offlineEvents = db.getDb().prepare(`
    SELECT id, ts, type, details FROM events
    WHERE machine_id = ? AND type = 'offline' AND id > ?
    ORDER BY id DESC
  `).all(machine.id, lastOfflineId);

  // Cursor cobre o backlog inteiro buscado acima — nunca fica maior que o
  // que de fato foi visto, então nenhum evento pode ser marcado "já
  // analisado" sem ter sido.
  return {
    events, offlineEvents,
    maxWinId:     events.length        ? events[0].id        : lastWinId,
    maxOfflineId: offlineEvents.length ? offlineEvents[0].id : lastOfflineId,
  };
}

// Claude às vezes embrulha o JSON em code fence markdown — remove antes de parsear.
function parseInsightsResponse(responseText, machineId) {
  try {
    const cleaned = responseText.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    console.warn(`[InsightEngine] Resposta inválida da Claude API para ${machineId}: ${responseText.slice(0, 100)}`);
    return null;
  }
}

async function analyzeMachine(machine, cfg) {
  // Cursor incremental: só processa evento com id MAIOR que o já visto na
  // última rodada (evita reenviar ~96% de dados repetidos a cada ciclo —
  // bug real que custou US$107,62 num dia só no projeto JARVIS, mesmo padrão).
  const { events, offlineEvents, maxWinId, maxOfflineId } = fetchNewEvents(machine);

  if (events.length === 0 && offlineEvents.length === 0) return 0;

  const name    = machine.display_name || machine.hostname;
  // Só os mais recentes entram no prompt — sinal mais relevante pro Claude.
  // O cursor já cobre o backlog inteiro (acima), então nada fica
  // permanentemente sem ser analisado mesmo se o volume exceder isso.
  const context = buildContext(name, events.slice(0, 150), offlineEvents.slice(0, 30));

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

  const responseText = await fetchClaudeResponse(cfg, prompt);
  if (!responseText) return 0; // falha na API — não avança cursor, tenta de novo no próximo ciclo

  const parsed = parseInsightsResponse(responseText, machine.id);
  if (!parsed) return 0; // resposta inválida — não avança cursor, tenta de novo no próximo ciclo

  // Só avança o cursor depois de uma análise bem-sucedida (mesmo que 0 insights
  // relevantes tenham sido encontrados — isso é um resultado válido).
  db.updateMachineInsightCursor(machine.id, { lastWinEventId: maxWinId, lastOfflineEventId: maxOfflineId });

  return persistInsights(machine, parsed.insights || []);
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

module.exports = { start, stop, runNow, restart, analyzeMachine };
