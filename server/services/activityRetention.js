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
    logger.error('[ActivityRetention] erro ao purgar activity_log', { message: err.message });
    return 0;
  }
}

function scheduleDailyPurge() {
  runPurgeOnce();
  setInterval(runPurgeOnce, 24 * 60 * 60 * 1000);
}

module.exports = { runPurgeOnce, scheduleDailyPurge, RETENTION_DAYS };
