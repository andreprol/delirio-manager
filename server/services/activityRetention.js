'use strict';

const db     = require('../db');
const logger = require('./logger');

const RETENTION_DAYS = 90;
const COMMANDS_RETENTION_DAYS = 30;

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

async function runCommandsPurgeOnce() {
  try {
    const orphans = await db.purgeOrphanCommands();
    const old     = await db.purgeOldTerminalCommands(COMMANDS_RETENTION_DAYS);
    if (orphans > 0 || old > 0) {
      logger.info(`[ActivityRetention] commands: ${orphans} órfãos + ${old} terminais > ${COMMANDS_RETENTION_DAYS}d removidos`);
    }
    return { orphans, old };
  } catch (err) {
    // Mesma lição do incidente 15/11/2026: um erro de purge não pode virar
    // outage do servidor inteiro.
    logger.error('[ActivityRetention] erro ao purgar commands', { error: err.message });
    return { orphans: 0, old: 0 };
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
    runCommandsPurgeOnce(); // fire-and-forget — ver comentário em scheduleDailyPurge
    scheduleNext();
  }, delayMs);
}

function scheduleDailyPurge() {
  runPurgeOnce(); // imediato no boot, não espera até a próxima janela
  // Sem await de propósito: runCommandsPurgeOnce roda em batches que cedem o
  // event loop entre lotes (ver db.js), então não precisa (e não deve)
  // bloquear o boot do servidor esperando o backlog inteiro ser limpo.
  runCommandsPurgeOnce();
  scheduleNext();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  runPurgeOnce, runCommandsPurgeOnce, scheduleDailyPurge, stop,
  RETENTION_DAYS, COMMANDS_RETENTION_DAYS,
};
