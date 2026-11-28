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

const { Pool } = require('pg');
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

// Trunca a query de novo aqui (defesa em profundidade) -- db-pg.js já trunca
// a 200 chars em getLongRunningTransactions, mas se alguém remover aquele
// .slice() no futuro o alerta ainda não pode vazar a query inteira (pode
// conter literais de dados reais de cliente). Achado do code-reviewer
// (revisão independente, 27/11/2026): sem isso, nenhum teste cobria o corte,
// porque todo mock de teste já devolvia query curta.
const MAX_QUERY_CHARS_IN_ALERT = 200;

// Pool ISOLADO deste monitor -- nunca o pool compartilhado do app (db-pg.js).
// Achado 🟠 ALTO do code-reviewer (revisão independente, 27/11/2026): se este
// monitor usasse o pool compartilhado e esse pool estivesse esgotado
// (exatamente o cenário que o monitor existe pra detectar), a própria query
// de monitoramento ficaria pendurada pra sempre esperando uma conexão livre
// e o monitor nunca chegaria a alertar sobre nada. max:1 porque é uma query
// leve, isolada, a cada 2min -- não precisa de mais. connectionTimeoutMillis
// garante que, se nem essa conexão isolada conseguir conectar a tempo
// (Postgres down/sobrecarregado), o monitor desiste rápido e alerta sobre
// ISSO (ver o catch em checkOnce) em vez de pendurar pra sempre.
// statement_timeout é cinto de segurança pra a query em si (view leve,
// nunca deveria se aproximar disso).
const MONITOR_POOL_MAX = 1;
const MONITOR_CONNECTION_TIMEOUT_MS = 10 * 1000; // 10s
const MONITOR_STATEMENT_TIMEOUT_MS = 15 * 1000; // 15s

let monitorPool = null;
function getMonitorPool() {
  if (!monitorPool) {
    monitorPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: MONITOR_POOL_MAX,
      connectionTimeoutMillis: MONITOR_CONNECTION_TIMEOUT_MS,
      statement_timeout: MONITOR_STATEMENT_TIMEOUT_MS,
    });
    // Mesma lição de db-pg.js (getPool): sem isso, um erro num client idle
    // deste pool emite 'error' não tratado e derruba o processo Node inteiro.
    monitorPool.on('error', err => logger.error('[LongTxnMonitor] erro assíncrono no pool isolado', { error: err.message }));
  }
  return monitorPool;
}

function buildAlertDetail(rows) {
  const lines = rows.slice(0, MAX_DETAILED_IN_ALERT).map(r => {
    const rawQuery = r.query ? r.query.replace(/\s+/g, ' ').trim() : '(sem query ativa)';
    const query = rawQuery.slice(0, MAX_QUERY_CHARS_IN_ALERT);
    return `pid=${r.pid} usename=${r.usename || '?'} app=${r.applicationName || '?'} `
      + `xact=${r.xactDurationSeconds}s query=${r.queryDurationSeconds}s -- ${query}`;
  });
  const omitted = rows.length - lines.length;
  const suffix = omitted > 0 ? `\n(+${omitted} outra(s) transação(ões) longa(s) não detalhada(s))` : '';
  return `${rows.length} transação(ões) Postgres aberta(s) há mais de ${THRESHOLD_MINUTES}min:\n`
    + lines.join('\n') + suffix;
}

async function alertMonitorSemConexao(err) {
  // Achado 🟠 ALTO do code-reviewer: este É o cenário mais crítico que este
  // monitor existe pra cobrir (pool/Postgres esgotado ou inacessível) --
  // nunca pode só logar e ficar em silêncio, isso recriaria exatamente o
  // incidente original (ninguém soube até notar o sintoma). cooldownKey
  // própria, nunca mistura com o alerta de transação longa real.
  logger.error('[LongTxnMonitor] erro ao consultar pg_stat_activity', { error: err.message });
  await sendAlert({
    source:      'Postgres',
    stage:       'Monitor de transação longa sem conexão',
    detail:      `longTransactionMonitor não conseguiu consultar pg_stat_activity (possível pool/Postgres esgotado): ${err.message}`,
    cooldownKey: 'pg:monitor-sem-conexao',
    cooldownMs:  ALERT_COOLDOWN_MS,
  });
}

async function checkOnce() {
  if (!leaderElection.isLeader()) return;

  let rows;
  try {
    rows = await db.getLongRunningTransactions(THRESHOLD_MINUTES, getMonitorPool());
  } catch (err) {
    await alertMonitorSemConexao(err);
    return { checked: 0, alerted: false };
  }

  if (rows.length === 0) {
    // debug, não info -- roda a cada 2min (~720x/dia); no caminho feliz isso
    // é só ruído em log de produção (achado do code-reviewer).
    logger.debug('[LongTxnMonitor] nenhuma transação longa encontrada');
    return { checked: 0, alerted: false };
  }

  logger.info(`[LongTxnMonitor] ${rows.length} transação(ões) longa(s) encontrada(s)`, {
    pids: rows.map(r => r.pid),
  });
  const res = await sendAlert({
    source:      'Postgres',
    stage:       'Transação longa',
    detail:      buildAlertDetail(rows),
    cooldownKey: 'pg:long-transaction',
    cooldownMs:  ALERT_COOLDOWN_MS,
  });
  // alerted reflete se o e-mail saiu de verdade, não só se tentamos mandar --
  // sendAlert pode devolver sent:false por cooldown/alertas desligados/sem
  // api key (achado do code-reviewer).
  return { checked: rows.length, alerted: res.sent === true };
}

// state.stopped funciona como guarda de corrida -- mesmo padrão de
// rhHealthMonitor.js scheduleNext(): se stop() for chamado enquanto um
// checkOnce anterior ainda está em voo, o .finally() desse checkOnce chamaria
// scheduleNext() de novo e recriaria o timer que stop() acabou de cancelar;
// o guard `if (state.stopped) return` no início de scheduleNext() impede isso.
// stopped também serve de guarda de idempotência em start() (achado do
// code-reviewer: uma 2a chamada não pode criar um 2o ciclo e vazar o timer
// do 1o).
const state = {
  timer: null,
  stopped: true,
};

function scheduleNext() {
  if (state.stopped) return;
  state.timer = setTimeout(() => {
    checkOnce()
      .catch(err => logger.error('[LongTxnMonitor] check erro', { error: err.message }))
      .finally(scheduleNext);
  }, POLL_INTERVAL_MS);
  state.timer.unref(); // nunca prende o processo vivo só por isso (mesmo padrão de rhHealthMonitor/dbSizeMonitor)
}

function start() {
  if (!state.stopped) return; // idempotente -- 2a chamada não cria um 2o ciclo (achado do code-reviewer)
  state.stopped = false;
  checkOnce()
    .catch(err => logger.error('[LongTxnMonitor] check inicial erro', { error: err.message }))
    .finally(scheduleNext);
}

function stop() {
  state.stopped = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

module.exports = {
  start, stop, checkOnce,
  POLL_INTERVAL_MS, THRESHOLD_MINUTES, ALERT_COOLDOWN_MS,
};
