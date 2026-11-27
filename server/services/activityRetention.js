'use strict';

const db     = require('../db-pg');
const logger = require('./logger');
const leaderElection = require('./leaderElection');

const RETENTION_DAYS = 90;
const COMMANDS_RETENTION_DAYS = 30;
const NCR_XML_RETENTION_DAYS = 7;

async function runPurgeOnce() {
  if (!leaderElection.isLeader()) return;

  try {
    const removed = await db.purgeActivityLog(RETENTION_DAYS);
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

// purgeNcrXmlPayloads: xml_b64 (XML completo da NFCe, base64) em
// ncr_monitor_emails é write-only -- grava só pra anexar no e-mail de
// confirmação, nenhuma rota relê depois (ver comentário na própria função
// em db-pg.js). 7 dias dá margem pra debugar e-mail não entregue sem
// acumular pra sempre; a linha em si (order_ref/chave/valor) continua.
async function runNcrXmlPurgeOnce() {
  if (!leaderElection.isLeader()) return;

  try {
    const removed = await db.purgeNcrXmlPayloads(NCR_XML_RETENTION_DAYS);
    if (removed > 0) {
      logger.info(`[ActivityRetention] ${removed} payloads xml_b64 zerados em ncr_monitor_emails (> ${NCR_XML_RETENTION_DAYS}d)`);
    }
    return removed;
  } catch (err) {
    logger.error('[ActivityRetention] erro ao purgar xml_b64 de ncr_monitor_emails', { error: err.message });
    return 0;
  }
}

async function runCommandsPurgeOnce() {
  if (!leaderElection.isLeader()) return;

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
    runNcrXmlPurgeOnce();
    scheduleNext();
  }, delayMs);
}

function scheduleDailyPurge() {
  runPurgeOnce(); // imediato no boot, não espera até a próxima janela
  // Sem await de propósito: runCommandsPurgeOnce roda em batches que cedem o
  // event loop entre lotes (ver db.js), então não precisa (e não deve)
  // bloquear o boot do servidor esperando o backlog inteiro ser limpo.
  runCommandsPurgeOnce();
  runNcrXmlPurgeOnce();
  scheduleNext();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  runPurgeOnce, runCommandsPurgeOnce, runNcrXmlPurgeOnce, scheduleDailyPurge, stop,
  RETENTION_DAYS, COMMANDS_RETENTION_DAYS, NCR_XML_RETENTION_DAYS,
};
