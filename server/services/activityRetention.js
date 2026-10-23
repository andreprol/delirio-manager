'use strict';

const db     = require('../db');
const logger = require('./logger');

const RETENTION_DAYS = 90;

function runPurgeOnce() {
  const removed = db.purgeActivityLog(RETENTION_DAYS);
  if (removed > 0) {
    logger.info(`[ActivityRetention] ${removed} linhas de activity_log removidas (> ${RETENTION_DAYS}d)`);
  }
  return removed;
}

function scheduleDailyPurge() {
  runPurgeOnce();
  setInterval(runPurgeOnce, 24 * 60 * 60 * 1000);
}

module.exports = { runPurgeOnce, scheduleDailyPurge, RETENTION_DAYS };
