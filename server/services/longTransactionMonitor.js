// server/services/longTransactionMonitor.js
// Monitora transações Postgres anormalmente longas (pg_stat_activity) --
// motivação real do incidente: `UPDATE machines SET id=$1 WHERE id=$2` (antes
// da Task 4 deste mesmo plano) segurava o lock da linha `machines` durante o
// cascade de FK em activity_log/nfce_index, travando de 1 a 71+ minutos,
// derrubando /api/healthz e o pool de conexões -- só foi descoberto quando
// alguém notou o sintoma, sem nenhum alerta próprio. Este monitor detecta
// qualquer transação anormalmente longa (não só esse caso específico, já
// corrigido na Task 4) ANTES que ela vire outage.
'use strict';

const db     = require('../db-pg');
const { sendAlert } = require('./resendAlert');
const logger = require('./logger');
const leaderElection = require('./leaderElection');

// POLL_INTERVAL_MS: mais frequente que o rhHealthMonitor (5min) porque uma
// transação travada pode escalar rápido, como no incidente original.
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 min

// THRESHOLD_MINUTES: bem acima de qualquer query/transação normal do sistema
// (que leva segundos) -- alerta cedo, antes de virar outage. O incidente
// original levou de 1 a 71+ minutos até alguém notar.
const THRESHOLD_MINUTES = 5;

// ALERT_COOLDOWN_MS: mesma janela do rhHealthMonitor -- evita espamar um
// e-mail a cada 2 minutos enquanto a mesma transação continuar travada.
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

// Quantas transações detalhar no corpo do alerta -- o resto só entra na
// contagem total (evita um e-mail gigante se muita coisa travar de uma vez).
const MAX_DETAILED_IN_ALERT = 5;

function buildAlertDetail(rows) {
  const lines = rows.slice(0, MAX_DETAILED_IN_ALERT).map(r => {
    const query = r.query ? r.query.replace(/\s+/g, ' ').trim() : '(sem query ativa)';
    return `pid=${r.pid} usename=${r.usename || '?'} app=${r.applicationName || '?'} `
      + `xact=${r.xactDurationSeconds}s query=${r.queryDurationSeconds}s -- ${query}`;
  });
  const omitted = rows.length - lines.length;
  const suffix = omitted > 0 ? `\n(+${omitted} outra(s) transação(ões) longa(s) não detalhada(s))` : '';
  return `${rows.length} transação(ões) Postgres aberta(s) há mais de ${THRESHOLD_MINUTES}min:\n`
    + lines.join('\n') + suffix;
}

async function checkOnce() {
  if (!leaderElection.isLeader()) return;

  let rows;
  try {
    rows = await db.getLongRunningTransactions(THRESHOLD_MINUTES);
  } catch (err) {
    // Mesma lição de dbSizeMonitor.js: um erro de monitoramento não pode
    // virar outage do servidor inteiro.
    logger.error('[LongTxnMonitor] erro ao consultar pg_stat_activity', { error: err.message });
    return { checked: 0, alerted: false };
  }

  if (rows.length === 0) {
    logger.info('[LongTxnMonitor] nenhuma transação longa encontrada');
    return { checked: 0, alerted: false };
  }

  logger.info(`[LongTxnMonitor] ${rows.length} transação(ões) longa(s) encontrada(s)`, {
    pids: rows.map(r => r.pid),
  });
  await sendAlert({
    source:      'Postgres',
    stage:       'Transação longa',
    detail:      buildAlertDetail(rows),
    cooldownKey: 'pg:long-transaction',
    cooldownMs:  ALERT_COOLDOWN_MS,
  });
  return { checked: rows.length, alerted: true };
}

let timer = null;

function start() {
  checkOnce().catch(err => logger.error('[LongTxnMonitor] check inicial erro', { error: err.message }));
  timer = setInterval(() => {
    checkOnce().catch(err => logger.error('[LongTxnMonitor] check erro', { error: err.message }));
  }, POLL_INTERVAL_MS);
  timer.unref(); // nunca prende o processo vivo só por isso (mesmo padrão de rhHealthMonitor/dbSizeMonitor)
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start, stop, checkOnce,
  POLL_INTERVAL_MS, THRESHOLD_MINUTES, ALERT_COOLDOWN_MS,
};
