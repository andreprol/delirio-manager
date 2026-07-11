// server/services/reportEngine.js
'use strict';

const path   = require('path');
const fs     = require('fs');
const db     = require('../db');
const logger = require('./logger');

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

  // SO fora de suporte — usa os_version real (coletado desde agente v1.5.11)
  const win10Rows = rawDb.prepare(
    `SELECT hostname FROM machines WHERE location = ? AND os_version LIKE '%Windows 10%'`
  ).all(storeName);
  const win10Machines         = win10Rows.map(m => m.hostname);
  const win10CriticalMachines = win10Machines.filter(h => /^(TERM|BOH)/i.test(h));
  const win10NormalMachines   = win10Machines.filter(h => !/^(TERM|BOH)/i.test(h));

  const recentFeedback = db.getRecentFeedback(storeName, 5);

  // Métricas horárias ponderadas do mês do relatório
  const weightedMetrics  = db.getWeightedMetricsForStore(storeName, month);
  // Eventos offline do mês do relatório
  const offlineEventCount = db.getOfflineEventsForStore(storeName, month);
  // Máquinas sem nenhuma medição horária no mês (offline total ou agente v1.5.12)
  const machinesWithoutMetrics = db.getMachinesWithoutMetrics(storeName, month);

  // Dados Zamak / N-able (cache, pode estar vazio se nunca sincronizado)
  const zamak = db.getZamakSummaryForStore(storeName);
  const zamakAge = db.getZamakCacheAge();
  const zamakSynced = zamakAge < Infinity && zamakAge < 48; // considera válido se < 48h

  return {
    storeName, month,
    openTopics, history: history.slice(0, 20), recurrences,
    fdActive, fdClosed, fdTotal,
    machineData, win10Machines, win10CriticalMachines, win10NormalMachines, recentFeedback,
    weightedMetrics, offlineEventCount, machinesWithoutMetrics,
    zamak, zamakSynced,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt — parte estática (cacheável) + parte dinâmica (por loja/mês)
// ─────────────────────────────────────────────────────────────────────────────

// Nunca muda entre chamadas — elegível para prompt caching da Anthropic (TTL 5min).
const STATIC_SYSTEM_PROMPT = `Voce e um analista de TI senior da Delirio Tropical, empresa de food service com lojas no Rio de Janeiro. Seu relatorio sera lido pelo gerente de TI e pela diretoria. Avalie o risco da loja e retorne SOMENTE um objeto JSON valido, sem texto adicional.

═══════════════════════════════════════
REGRAS CRITICAS — LEIA ANTES DE AVALIAR
═══════════════════════════════════════

REGRA MAQUINAS CRITICAS: Qualquer problema em maquina cujo hostname comeca com TERM* ou BOH* = severidade maxima automatica. Sao os terminais de faturamento (PDV) e servidores Aloha — se caem, a loja para de vender.

REGRA ESPECIFICIDADE OBRIGATORIA: Cada narrativa DEVE citar os nomes reais das maquinas afetadas, os valores numericos exatos (ex: "TERMCIT1 operando com CPU media de 84%"), os IDs dos chamados Freshdesk (ex: "Chamado #3847 — impressora de cozinha offline ha 3 dias") e os IDs dos topicos (ex: "Topico #12 — nobreak apitando"). Proibido escrever de forma generica como "alguns equipamentos" ou "varios chamados". Se nao ha dados especificos → dizer isso claramente.

REGRA HUMANIZACAO: O texto deve soar como escrito por um analista experiente, nao por um bot. Use frases naturais, conecte os problemas a impactos reais na operacao da loja, demonstre raciocinio tecnico. Evite listas secas; prefira paragrafos fluidos com dados embutidos.

REGRA NOTA 30: Sem dados relevantes para uma dimensao → atribua exatamente 30.

REGRA OPERACIONAL: Avalie apenas topicos abertos inseridos pela equipe. Topico sem contexto tecnico real (texto de teste, generico, sem descricao de problema) = inconclusivo. Se todos inconclusivos ou nenhum topico → campo "operacional" = exatamente 30.

═══════════════════════════════════
FORMATO DE SAIDA (JSON puro, sem texto fora do JSON)
═══════════════════════════════════

{
  "hardware": <0-100>,
  "software": <0-100>,
  "conectividade": <0-100>,
  "seguranca": <0-100>,
  "incidentes": <0-100>,
  "operacional": <0-100>,
  "resumo": "<Paragrafo de resumo executivo da situacao geral da loja — mencione as maquinas mais criticas pelo nome, o problema mais grave e o impacto operacional real. Tom direto, como um briefing para o diretor.>",
  "narrativa_hardware": "<2-4 frases sobre hardware fisico e saude das maquinas. Inclui: CPU/RAM/temperatura/disco de cada maquina pelo nome (ex: TERMCITTA1 operando com CPU 72%), equipamentos fisicos com problema como nobreaks, terminais, impressoras, quando citados em topicos ou chamados. Conecte leituras altas a riscos reais (ex: CPU 84% no TERMBSHOP2 causa lentidao no fechamento de vendas).>",
  "narrativa_software": "<2-3 frases sobre sistemas operacionais, versoes de software, atualizacoes pendentes. Cite maquinas Windows 10 pelo nome se houver. Mencione risco de EOL.>",
  "narrativa_conectividade": "<2-3 frases sobre rede, internet, VPN, quedas de conectividade. Cite topicos ou chamados de rede especificos se houver.>",
  "narrativa_seguranca": "<2-4 frases sobre seguranca: patches pendentes (cite quantos criticos), ameacas MAV, maquinas sem antivirus atualizado, acessos nao autorizados. Se dados Zamak disponiveis, mencione numeros exatos.>",
  "narrativa_incidentes": "<2-4 frases sobre chamados Freshdesk ativos (cite titulos ou IDs dos mais criticos), topicos recorrentes (cite o padrao), tempo medio de abertura dos chamados ativos. Demonstre pattern recognition.>",
  "narrativa_operacional": "<2-3 frases sobre os topicos abertos pela equipe (cite IDs e descricoes), seu impacto na operacao diaria da loja, quais estao pendentes ha mais tempo.>",
  "recomendacoes": ["<acao especifica e prioritaria 1 — cite maquina ou sistema alvo>", "<acao especifica 2>", "<acao especifica 3>"],
  "inconclusivos": [<id_numerico_do_topico_sem_contexto_real>, ...]
}

LEMBRETE FINAL: Cada narrativa deve ter dados especificos. Um relatorio que diz "alguns equipamentos apresentam problemas" e reprovado. Um relatorio que diz "TERMCITTA1 e TERMCITTA3 operam com CPU acima de 75% nas ultimas 3 semanas, elevando o risco de lentidao no PDV durante o pico de vendas do almoco" e aprovado.`;

function buildUserPrompt(ctx) {
  const { storeName, month, openTopics, history, recurrences,
          fdActive, machineData, win10CriticalMachines,
          win10NormalMachines, recentFeedback, zamak, zamakSynced,
          machinesWithoutMetrics } = ctx;

  const fmtTopic    = t => `  [ID:${t.id}][${t.severity.toUpperCase()}${t.is_critical_machine ? ' BOH/TERM' : ''}] ${t.description}`;
  const fmtTicket   = t => `  [${t.status}] ${t.title}`;
  const fmtMachine  = m => `  ${m.name}${m.isCritical ? '*' : ''} ${m.avg_cpu ?? '?'}/${m.avg_ram ?? '?'}/${m.avg_temp ?? '?'}/${m.disk_free ?? '?'} ${m.status}`;
  const fmtFeedback = f => `  [${f.month}] "${f.feedback_text}"`;

  return `LOJA: ${storeName} | MES: ${month}

═══════════════════════════════════
DADOS DA LOJA
═══════════════════════════════════

TOPICOS ABERTOS (pesam em TODAS as dimensoes + operacional):
${openTopics.length ? openTopics.map(fmtTopic).join('\n') : '  Nenhum topico aberto'}

CHAMADOS FRESHDESK ATIVOS (${fdActive.length} abertos/pendentes):
${fdActive.slice(0, 20).map(fmtTicket).join('\n') || '  Nenhum chamado ativo'}

TOPICOS RESOLVIDOS NO MES (historico):
${history.filter(h => h.resolved_at?.slice(0,7) === month).slice(0,10).map(t => `  [resolvido] ${t.description}`).join('\n') || '  Nenhum'}

PROBLEMAS RECORRENTES:
${recurrences.length ? recurrences.map(r => '  ' + r).join('\n') : '  Nenhum recorrente identificado'}

SAUDE DAS MAQUINAS — CPU%/RAM%/Temp°C/DiskLivreGB/status (* = TERM/BOH critica):
${machineData.length ? machineData.map(fmtMachine).join('\n') : '  Sem dados de saude de maquinas para este periodo'}

MAQUINAS SEM MEDICAO HORARIA NO MES (offline ou agente desatualizado):
${machinesWithoutMetrics && machinesWithoutMetrics.length
  ? machinesWithoutMetrics.map(m => `  ${m.hostname} (${m.status})`).join('\n')
  : '  Nenhuma'}

MAQUINAS WINDOWS 10 (EOL out/2025):
  TERM/BOH criticas: ${win10CriticalMachines.length ? win10CriticalMachines.join(', ') : 'Nenhuma'}
  Normais: ${win10NormalMachines.length ? win10NormalMachines.join(', ') : 'Nenhuma'}

ZAMAK RMM (${zamakSynced ? 'dados validos' : 'SEM DADOS'}):
${zamakSynced && zamak.total_devices > 0
  ? `  devices:${zamak.total_devices} patches_criticos:${zamak.patch_critical} patches_high:${zamak.patch_high} patches_total:${zamak.patch_total} ameacas:${zamak.threats_active} checks_falha:${zamak.failing_checks} offline:${zamak.devices_offline}`
  : '  Sem dados Zamak'}

FEEDBACK HISTORICO DO GESTOR:
${recentFeedback.length ? recentFeedback.map(fmtFeedback).join('\n') : '  Nenhum feedback anterior'}`;
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
  const client    = new Anthropic({ apiKey });
  const maxTokens = Math.max(cfg.max_tokens || 6000, 6000);
  const model     = cfg.model || 'claude-haiku-4-5-20251001';
  const t0        = Date.now();

  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    // Parte estática vai no system com cache_control — Anthropic cacheia por 5min,
    // reduz ~60% do custo de input em chamadas consecutivas para lojas diferentes.
    system: [
      {
        type:          'text',
        text:          STATIC_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: buildUserPrompt(ctx) }],
  });

  const u = msg.usage ?? {};
  logger.info('claude:relatorio', {
    store:        ctx.storeName,
    month:        ctx.month,
    model,
    input:        u.input_tokens             ?? 0,
    output:       u.output_tokens            ?? 0,
    cache_write:  u.cache_creation_input_tokens ?? 0,
    cache_read:   u.cache_read_input_tokens  ?? 0,
    stop_reason:  msg.stop_reason,
    latency_ms:   Date.now() - t0,
  });

  if (msg.stop_reason === 'max_tokens') {
    throw new Error(`Claude atingiu limite de tokens (${maxTokens}) — resposta truncada. Aumente max_tokens em config.json.`);
  }

  const text = msg.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]+\}/);
  if (!jsonMatch) {
    const preview = text.slice(0, 200).replace(/\n/g, ' ');
    throw new Error(`Claude retornou resposta sem JSON válido. Prévia: "${preview}"`);
  }
  return JSON.parse(jsonMatch[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Score parser
// ─────────────────────────────────────────────────────────────────────────────

function parseClaudeScore(aiResult, ctx) {
  let   score_hardware     = clamp(aiResult.hardware);
  let   score_software     = clamp(aiResult.software);
  const score_connectivity = clamp(aiResult.conectividade);
  let   score_security     = clamp(aiResult.seguranca);
  const score_incidents    = clamp(aiResult.incidentes);
  let   score_operational  = clamp(aiResult.operacional);

  // ── Penalidade Win10 (programática — não depende do julgamento da IA) ──────
  const hasCriticalWin10 = (ctx?.win10CriticalMachines?.length ?? 0) > 0;
  const hasNormalWin10   = (ctx?.win10NormalMachines?.length   ?? 0) > 0;
  let   win10Adendo      = '';

  if (hasCriticalWin10) {
    score_software = Math.min(100, score_software + 40);
    score_security = Math.min(100, score_security + 35);
    const lista = ctx.win10CriticalMachines.join(', ');
    win10Adendo = `⚠️ RISCO CRÍTICO: máquinas TERM/BOH com Windows 10 detectadas (${lista}). ` +
                  `Windows 10 encerrou suporte em outubro/2025 — vulnerabilidades sem patch em terminais de faturamento representam risco máximo de invasão e violação de dados.`;
  } else if (hasNormalWin10) {
    score_software = Math.min(100, score_software + 25);
    score_security = Math.min(100, score_security + 20);
    const lista = ctx.win10NormalMachines.join(', ');
    win10Adendo = `⚠️ Máquinas com Windows 10 detectadas (${lista}). ` +
                  `Windows 10 encerrou suporte em outubro/2025 — atualização para Windows 11 necessária para manter cobertura de segurança.`;
  }

  // ── Penalidades de Hardware (métricas horárias ponderadas — mês do relatório) ─
  const wm = ctx?.weightedMetrics;
  const hwAdendos = [];
  if (wm && wm.total_readings > 0) {
    const cpu  = wm.avg_cpu_pct  ?? 0;
    const ram  = wm.avg_ram_pct  ?? 0;
    const disk = wm.avg_disk_pct ?? 0;
    const temp = wm.avg_cpu_temp ?? 0;

    // CPU% — média ponderada (horas comerciais peso 2, fora peso 1)
    if (cpu > 60) {
      const pen = cpu > 80 ? { hw: 18, op: 15 } : { hw: 10, op: 8 };
      score_hardware    = Math.min(100, score_hardware    + pen.hw);
      score_operational = Math.min(100, score_operational + pen.op);
      hwAdendos.push(`CPU média ponderada ${Math.round(cpu)}% (${cpu > 80 ? 'CRÍTICO' : 'ALERTA'} — threshold: >60%)`);
    }
    // RAM% — média ponderada
    if (ram > 60) {
      const pen = ram > 80 ? { hw: 18, op: 15 } : { hw: 10, op: 8 };
      score_hardware    = Math.min(100, score_hardware    + pen.hw);
      score_operational = Math.min(100, score_operational + pen.op);
      hwAdendos.push(`RAM média ponderada ${Math.round(ram)}% (${ram > 80 ? 'CRÍTICO' : 'ALERTA'} — threshold: >60%)`);
    }
    // Disco% — média ponderada
    if (disk > 60) {
      const pen = disk > 80 ? { hw: 12, op: 8 } : { hw: 6, op: 4 };
      score_hardware    = Math.min(100, score_hardware    + pen.hw);
      score_operational = Math.min(100, score_operational + pen.op);
      hwAdendos.push(`Disco médio ponderado ${Math.round(disk)}% (${disk > 80 ? 'CRÍTICO — risco de falha' : 'ALERTA'} — threshold: >60%)`);
    }
    // Temperatura CPU — média ponderada
    if (temp > 60) {
      const pen = temp > 70 ? { hw: 15, op: 10 } : { hw: 8, op: 5 };
      score_hardware    = Math.min(100, score_hardware    + pen.hw);
      score_operational = Math.min(100, score_operational + pen.op);
      hwAdendos.push(`Temperatura CPU média ponderada ${Math.round(temp)}°C (${temp > 70 ? 'CRÍTICO — risco de queima' : 'ALERTA'} — threshold: >60°C)`);
    } else if (temp >= 50 && temp <= 60) {
      score_hardware    = Math.min(100, score_hardware    + 4);
      score_operational = Math.min(100, score_operational + 2);
      hwAdendos.push(`Temperatura CPU média ponderada ${Math.round(temp)}°C (atenção — threshold: >=50°C)`);
    }
  }

  // ── Penalidade de quedas offline (eventos do mês) ────────────────────────
  const offlineCount = ctx?.offlineEventCount ?? 0;
  let offlineAdendo = '';
  if (offlineCount > 0) {
    let pen;
    if (offlineCount > 15)     pen = { op: 28, sec: 20, nivel: 'CRÍTICO' };
    else if (offlineCount > 5) pen = { op: 18, sec: 12, nivel: 'ALTO' };
    else                       pen = { op: 10, sec: 6,  nivel: 'MÉDIO' };

    score_operational = Math.min(100, score_operational + pen.op);
    score_security    = Math.min(100, score_security    + pen.sec);
    offlineAdendo = `${offlineCount} queda(s) offline registrada(s) no mês [${pen.nivel}]: ` +
      `máquinas offline não executam aplicações, patches de SO ou atualizações de segurança.`;
  }

  // ── Penalidade por máquinas sem medição horária (offline total / agente v1.5.12) ─
  const noMetricsMachines = ctx?.machinesWithoutMetrics ?? [];
  const noMetricsCount    = noMetricsMachines.length;
  let   noMetricsAdendo   = '';
  if (noMetricsCount > 0) {
    let pen;
    if (noMetricsCount >= 6)      pen = { hw: 25, sw: 30, nivel: 'CRÍTICO' };
    else if (noMetricsCount >= 3) pen = { hw: 18, sw: 22, nivel: 'ALTO' };
    else                          pen = { hw: 10, sw: 12, nivel: 'MÉDIO' };

    score_hardware = Math.min(100, score_hardware + pen.hw);
    score_software = Math.min(100, score_software + pen.sw);

    const lista = noMetricsMachines.map(m => m.hostname).join(', ');
    noMetricsAdendo = `${noMetricsCount} máquina(s) sem medição horária no mês [${pen.nivel}]: ${lista}. ` +
      `Estado de hardware desconhecido e entrega de patches não monitorada.`;
  }

  const score_total = Math.round(
    score_hardware     * WEIGHTS.score_hardware     +
    score_software     * WEIGHTS.score_software     +
    score_connectivity * WEIGHTS.score_connectivity +
    score_security     * WEIGHTS.score_security     +
    score_incidents    * WEIGHTS.score_incidents    +
    score_operational  * WEIGHTS.score_operational
  );

  // Injeta adendos nas narrativas
  const hwAdendoText = hwAdendos.length
    ? `MÉTRICAS DE HARDWARE (média ponderada mensal): ${hwAdendos.join('; ')}.`
    : '';
  const narrativaSoftware  = [aiResult.narrativa_software  || '', win10Adendo, noMetricsAdendo].filter(Boolean).join(' ');
  const narrativaSeguranca = [aiResult.narrativa_seguranca || '', win10Adendo, offlineAdendo].filter(Boolean).join(' ');

  // Adiciona recomendação explícita de upgrade se Win10 crítico
  const recomendacoes = Array.isArray(aiResult.recomendacoes) ? [...aiResult.recomendacoes] : [];
  if (hasCriticalWin10) {
    recomendacoes.unshift(`URGENTE: atualizar para Windows 11 as máquinas críticas com Windows 10 (${ctx.win10CriticalMachines.join(', ')})`);
  } else if (hasNormalWin10) {
    recomendacoes.push(`Atualizar para Windows 11 as máquinas com Windows 10 (${ctx.win10NormalMachines.join(', ')})`);
  }

  // Recomendações automáticas de hardware
  if (wm && wm.total_readings > 0) {
    const cpu  = wm.avg_cpu_pct  ?? 0;
    const ram  = wm.avg_ram_pct  ?? 0;
    const disk = wm.avg_disk_pct ?? 0;
    const temp = wm.avg_cpu_temp ?? 0;
    if (cpu > 80)  recomendacoes.push(`URGENTE: CPU média mensal ${Math.round(cpu)}% — avaliar upgrade de processador ou redistribuição de carga`);
    else if (cpu > 60) recomendacoes.push(`CPU média mensal ${Math.round(cpu)}% — monitorar e planejar upgrade`);
    if (ram > 80)  recomendacoes.push(`URGENTE: RAM média mensal ${Math.round(ram)}% — expandir memória nas máquinas da loja`);
    else if (ram > 60) recomendacoes.push(`RAM média mensal ${Math.round(ram)}% — considerar expansão de memória`);
    if (disk > 80) recomendacoes.push(`URGENTE: Disco médio mensal ${Math.round(disk)}% — limpeza imediata e avaliação de upgrade de armazenamento`);
    else if (disk > 60) recomendacoes.push(`Disco médio mensal ${Math.round(disk)}% — iniciar limpeza de arquivos desnecessários`);
    if (temp > 70) recomendacoes.unshift(`URGENTE: temperatura CPU média ${Math.round(temp)}°C — limpeza de cooler e troca de pasta térmica imediata`);
    else if (temp > 60) recomendacoes.push(`Temperatura CPU média ${Math.round(temp)}°C — agendar manutenção preventiva (limpeza de cooler)`);
  }
  if (offlineCount > 5)  recomendacoes.unshift(`URGENTE: ${offlineCount} quedas offline no mês — investigar estabilidade da rede e nobreaks`);
  else if (offlineCount > 0) recomendacoes.push(`${offlineCount} queda(s) offline registrada(s) — verificar estabilidade de rede e nobreaks`);

  if (noMetricsCount >= 3) {
    recomendacoes.unshift(`URGENTE: ${noMetricsCount} máquinas sem medição horária (${noMetricsMachines.map(m => m.hostname).join(', ')}) — atualizar agente para v1.5.13 ou verificar conectividade`);
  } else if (noMetricsCount > 0) {
    recomendacoes.push(`Atualizar agente para v1.5.13 nas máquinas sem medição: ${noMetricsMachines.map(m => m.hostname).join(', ')}`);
  }

  return {
    // DB fields (used by saveReportRun via explicit columns)
    score_total, score_hardware, score_software, score_connectivity,
    score_security, score_incidents, score_operational,
    ai_narrative:       aiResult.resumo || aiResult.narrativa || '',
    ai_recommendations: recomendacoes,
    inconclusivos:      Array.isArray(aiResult.inconclusivos) ? aiResult.inconclusivos : [],
    // Per-dimension narratives for docx (not persisted to DB — saveReportRun uses explicit cols)
    dim_resumo:        aiResult.resumo       || '',
    dim_hardware:      [aiResult.narrativa_hardware || '', hwAdendoText, noMetricsAdendo].filter(Boolean).join(' '),
    dim_software:      narrativaSoftware,
    dim_conectividade: aiResult.narrativa_conectividade || '',
    dim_seguranca:     narrativaSeguranca,
    dim_incidentes:    aiResult.narrativa_incidentes    || '',
    dim_operacional:   [aiResult.narrativa_operacional || '', offlineAdendo].filter(Boolean).join(' '),
    win10Adendo,
    hwAdendoText,
    offlineAdendo,
    noMetricsAdendo,
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
      new Paragraph({ children: [new TextRun({ text, size: 20 })], alignment: AlignmentType.JUSTIFIED }),
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
    children.push(new Paragraph({ children: [new TextRun({ text: scores.dim_resumo, size: 20 })], alignment: AlignmentType.JUSTIFIED }));
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
      alignment: AlignmentType.JUSTIFIED,
    }));
    children.push(new Paragraph({ children: [new TextRun({ text: 'Recomendação: agendar upgrade para Windows 11 com urgência.', size: 20 })], alignment: AlignmentType.JUSTIFIED }));
  } else {
    children.push(new Paragraph({ children: [new TextRun({ text: 'Nenhuma máquina com OS fora de suporte detectada.', size: 20 })], alignment: AlignmentType.JUSTIFIED }));
  }
  children.push(new Paragraph(''));

  // ── 3. Conectividade ─────────────────────────────────────────────────────
  children.push(...dimHeader(3, 'Conectividade', scores.score_connectivity));
  children.push(...dimNarrative(scores.dim_conectividade));
  children.push(new Paragraph(''));

  // ── 4. Segurança ─────────────────────────────────────────────────────────
  children.push(...dimHeader(4, 'Segurança', scores.score_security));
  children.push(...dimNarrative(scores.dim_seguranca));
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
    children.push(new Paragraph({ children: [new TextRun({ text: `• ${rec}`, size: 20 })], alignment: AlignmentType.JUSTIFIED }));
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
  detectRecurrences, buildUserPrompt, generateDocx, generatePdf,
};
