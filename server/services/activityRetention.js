'use strict';

const db     = require('../db');
const logger = require('./logger');

const RETENTION_DAYS = 90;

function runPurgeOnce() {
  try {
    const removed = db.purgeActivityLog(RETENTION_DAYS);
    if (removed > 0) {
      logger.info(`[ActivityRetention] ${removed} linhas de activity_log removidas (> ${RETENTION_DAYS}d)`);
    }
    return removed;
  } catch (err) {
    // Nunca derruba o processo por isso — um erro de purge não pode virar
    // outage do servidor inteiro (mesma lição do incidente WAL 275GB).
    logger.error('[ActivityRetention] erro ao purgar activity_log', { error: err.message });
    return 0;
  }
}

let timer = null;

// Mesmo padrão de scheduleDailySync (services/zamak.js): agenda pra hora fixa
// de baixo tráfego em vez de setInterval a partir do boot — um deploy de dia
// faria o purge recorrer todo dia em horário de pico, igual outros serviços
// deste projeto já corrigiram antes.
function scheduleNext() {
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(4, 0, 0, 0); // 01:00 BRT = 04:00 UTC
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delayMs = next - now;
  timer = setTimeout(() => {
    runPurgeOnce();
    scheduleNext();
  }, delayMs);
}

function scheduleDailyPurge() {
  runPurgeOnce(); // imediato no boot, não espera até a próxima janela
  scheduleNext();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { runPurgeOnce, scheduleDailyPurge, stop, RETENTION_DAYS };
