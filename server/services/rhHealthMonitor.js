// server/services/rhHealthMonitor.js
// Monitor agendado do Módulo RH (relógios Henry Hexa via dt-clock-proxy).
//
// Contexto: incidente de 2026-09-10 — 4 falhas independentes (env var sumida,
// proxy Perl corrompido, dt-clock-proxy parado, módulo Node faltando) derrubaram
// o Módulo RH por completo, sem qualquer alerta — só foi descoberto quando um
// humano abriu o módulo manualmente. Todas as 4 falhas se manifestam do lado da
// VM como erro em GET /api/rh/clocks/status (500 sem token, 502 sem conexão).
// Este monitor consulta esse endpoint periodicamente e alerta via Resend.
'use strict';

const http = require('http');
const { sendAlert } = require('./resendAlert');
const logger = require('./logger');

const POLL_INTERVAL_MS  = 5 * 60 * 1000;  // 5 min — mesma cadência do infra/watchdog.sh
const FAILURE_THRESHOLD = 2;              // falhas 502 consecutivas antes de alertar
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min entre alertas do mesmo tipo

// Relógios com problema de hardware físico conhecido — não contam pro baseline
// de "reachable esperado". Ver project_delirio_manager.md.
const KNOWN_BAD_CLOCK_IPS = ['192.168.13.151', '192.168.20.151']; // Città, Tijuca

const state = {
  consecutiveConnFailures: 0,
  timer: null,
};

function fetchClocksStatus(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path: '/api/rh/clocks/status', method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = { error: data }; }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Timeout apos 15s')));
    req.end();
  });
}

async function handleTokenMissing(body) {
  // erro de configuração — nunca é transitório, alerta imediato
  state.consecutiveConnFailures = 0;
  await sendAlert({
    source:      'Módulo RH',
    stage:       'CLOCK_PROXY_TOKEN ausente',
    detail:      body.error || 'GET /api/rh/clocks/status retornou 500 — variável de ambiente ausente no servidor.',
    cooldownKey: 'rh:token-missing',
    cooldownMs:  ALERT_COOLDOWN_MS,
  });
}

async function handleConnFailed(body) {
  state.consecutiveConnFailures += 1;
  if (state.consecutiveConnFailures < FAILURE_THRESHOLD) return;
  await sendAlert({
    source:      'Módulo RH',
    stage:       'Clock-proxy inacessível',
    detail:      `${body.detail || body.error} (${state.consecutiveConnFailures} falhas consecutivas). ${body.hint || ''}`,
    cooldownKey: 'rh:connection-failed',
    cooldownMs:  ALERT_COOLDOWN_MS,
  });
}

async function handleSuccess(body) {
  // sucesso — reseta contador de falha de conexão
  state.consecutiveConnFailures = 0;

  const clocks = Array.isArray(body.clocks) ? body.clocks : [];
  const expectedTotal = clocks.filter(c => !KNOWN_BAD_CLOCK_IPS.includes(c.ip)).length;
  const reachableOk   = clocks.filter(c => c.reachable && !KNOWN_BAD_CLOCK_IPS.includes(c.ip)).length;

  if (expectedTotal === 0 || reachableOk >= expectedTotal) return;

  await sendAlert({
    source:      'Módulo RH',
    stage:       'Relógios inesperadamente offline',
    detail:      `${reachableOk}/${expectedTotal} relógios (excluindo problemas de hardware conhecidos) respondendo. total=${body.total}, reachable=${body.reachable}, unreachable=${body.unreachable}`,
    cooldownKey: 'rh:reachable-baixo',
    cooldownMs:  ALERT_COOLDOWN_MS,
  });
}

async function checkOnce(port) {
  let result;
  try {
    result = await fetchClocksStatus(port);
  } catch (e) {
    // servidor local não respondeu nem isso — algo mais grave, não é escopo deste monitor
    logger.error(`[RH-HEALTH] Falha ao consultar endpoint local: ${e.message}`);
    return;
  }

  const { statusCode, body } = result;

  if (statusCode === 500) return handleTokenMissing(body);
  if (statusCode === 502) return handleConnFailed(body);
  if (statusCode !== 200) {
    logger.error(`[RH-HEALTH] status inesperado ${statusCode}: ${JSON.stringify(body).slice(0, 200)}`);
    return;
  }
  return handleSuccess(body);
}

function start(port) {
  const targetPort = port || process.env.PORT || 3847;
  checkOnce(targetPort).catch(e => logger.error(`[RH-HEALTH] check inicial erro: ${e.message}`));
  state.timer = setInterval(() => {
    checkOnce(targetPort).catch(e => logger.error(`[RH-HEALTH] check erro: ${e.message}`));
  }, POLL_INTERVAL_MS);
}

function stop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

module.exports = { start, stop };
