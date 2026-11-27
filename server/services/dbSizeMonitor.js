// server/services/dbSizeMonitor.js
// Monitora o crescimento do banco Postgres de produção -- motivação real:
// ncr_monitor_emails.xml_b64 (ver services/activityRetention.js) cresceu
// write-only por meses sem nenhum alerta, só achado numa investigação manual
// (17/11/2026). Snapshot diário do tamanho de cada tabela + alerta por
// e-mail quando alguma cresce rápido demais ou já está grande o bastante
// pra merecer atenção, mesmo sem ter sido o motivo original de nenhum
// incidente ainda.
'use strict';

const path   = require('path');
const fs     = require('fs');
const db     = require('../db-pg');
const logger = require('./logger');
const leaderElection = require('./leaderElection');

const SNAPSHOT_RETENTION_DAYS = 180;
const GROWTH_CHECK_WINDOW_DAYS = 7;
// ALERT_COOLDOWN_DAYS: achado do code-reviewer (17/11/2026) -- sem isto,
// uma tabela que cruza o threshold e não encolhe (caso comum, era
// exatamente o cenário do xml_b64 que motivou esta feature) manda o MESMO
// e-mail todo dia pra sempre, inclusive a cada boot/deploy -- treina a
// ignorar o alerta, o mesmo mecanismo de falha que motivou construir isto.
// 7 dias: reenvia no máximo 1x/semana por tabela enquanto ela continuar
// alertável.
const ALERT_COOLDOWN_DAYS = 7;

// Crescimento só vira alerta se as DUAS condições baterem -- só percentual
// alertaria sobre tabelas minúsculas que dobram de 10KB pra 20KB (ruído);
// só bytes absolutos alertaria sobre toda tabela grande que cresce normal
// (ex: activity_log, que tem retenção própria de 90 dias e é esperado
// flutuar). Tabela GRANDE o bastante (LARGE_TABLE_BYTES_THRESHOLD) sempre
// aparece no relatório, mesmo sem crescimento rápido -- é o caso que teria
// pego o xml_b64 antes de alguém reparar manualmente.
const GROWTH_PCT_THRESHOLD = 50;
const GROWTH_BYTES_THRESHOLD = 50 * 1024 * 1024; // 50MB
const LARGE_TABLE_BYTES_THRESHOLD = 500 * 1024 * 1024; // 500MB

const RECIPIENTS = ['andre@delirio.com.br'];

function loadGraphConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).msGraph || {};
  } catch {
    return {};
  }
}

async function getAccessToken(cfg) {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    scope:         'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send',
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
  );
  if (!res.ok) throw new Error(`Falha ao obter token Graph: ${res.status}`);
  const { access_token, refresh_token: newRt } = await res.json();

  if (newRt && newRt !== cfg.refreshToken) {
    try {
      const confPath = path.join(__dirname, '..', 'config.json');
      const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
      conf.msGraph.refreshToken = newRt;
      fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));
    } catch {}
  }
  return access_token;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

// isAlertable decide quais linhas de getDbSizeGrowth merecem relatório --
// ver comentário dos thresholds no topo do arquivo.
function isAlertable(row) {
  const fastGrowth = row.growthPct !== null
    && row.growthPct >= GROWTH_PCT_THRESHOLD
    && row.growthBytes >= GROWTH_BYTES_THRESHOLD;
  const alreadyLarge = row.bytesNow >= LARGE_TABLE_BYTES_THRESHOLD;
  return fastGrowth || alreadyLarge;
}

// table_name vem de pg_stat_user_tables (nunca input de usuário), mas
// escapar é hábito defensivo barato -- achado do code-reviewer.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildGrowthEmailHtml(rows) {
  const tableRows = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.table_name)}</td>
      <td>${formatBytes(r.bytesNow)}</td>
      <td>${formatBytes(r.bytesBefore)}</td>
      <td>${r.growthPct === null ? '—' : r.growthPct.toFixed(0) + '%'}</td>
      <td>${r.rowsNow.toLocaleString('pt-BR')}</td>
    </tr>
  `).join('');
  return `
    <p>Tabelas que cresceram rápido ou já estão grandes no Postgres (janela de ${GROWTH_CHECK_WINDOW_DAYS} dias):</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse">
      <tr><th>Tabela</th><th>Tamanho agora</th><th>Há ${GROWTH_CHECK_WINDOW_DAYS}d</th><th>Crescimento</th><th>Linhas</th></tr>
      ${tableRows}
    </table>
  `;
}

async function sendGrowthAlertEmail(rows) {
  const cfg = loadGraphConfig();
  if (!cfg.tenantId) throw new Error('msGraph não configurado');
  const token = await getAccessToken(cfg);
  const message = {
    subject: `⚠️ Delirio Manager — ${rows.length} tabela(s) do banco merecendo atenção`,
    body: { contentType: 'HTML', content: buildGrowthEmailHtml(rows) },
    toRecipients: RECIPIENTS.map(address => ({ emailAddress: { address } })),
  };
  const r = await fetch('https://graph.microsoft.com/v1.0/users/andre@delirio.com.br/sendMail', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`sendMail falhou (${r.status}): ${txt}`);
  }
}

async function runSnapshotOnce() {
  if (!leaderElection.isLeader()) return;

  try {
    const count = await db.recordDbSizeSnapshot();
    logger.info(`[DbSizeMonitor] snapshot gravado: ${count} tabela(s)`);
    return count;
  } catch (err) {
    // Mesma lição de activityRetention.js: um erro de monitoramento não
    // pode virar outage do servidor inteiro.
    logger.error('[DbSizeMonitor] erro ao gravar snapshot', { error: err.message });
    return 0;
  }
}

async function runGrowthCheckOnce() {
  if (!leaderElection.isLeader()) return;

  try {
    const growth = await db.getDbSizeGrowth(GROWTH_CHECK_WINDOW_DAYS);
    const alertable = growth.filter(isAlertable);
    if (alertable.length === 0) {
      logger.info('[DbSizeMonitor] nenhuma tabela cruzou o threshold de crescimento');
      return { checked: growth.length, alerted: 0, skippedCooldown: 0 };
    }
    // Cooldown: pula tabela já alertada nos últimos ALERT_COOLDOWN_DAYS --
    // ver comentário da constante. Loga sempre (mesmo as puladas), só não
    // manda e-mail de novo.
    const recentlyAlerted = new Set(await db.getTablesAlertedWithinDays(ALERT_COOLDOWN_DAYS));
    const toAlert = alertable.filter(r => !recentlyAlerted.has(r.table_name));
    const skipped = alertable.length - toAlert.length;
    if (skipped > 0) {
      logger.info(`[DbSizeMonitor] ${skipped} tabela(s) alertável(is) puladas (dentro do cooldown de ${ALERT_COOLDOWN_DAYS}d)`, {
        tables: alertable.filter(r => recentlyAlerted.has(r.table_name)).map(r => r.table_name),
      });
    }
    if (toAlert.length === 0) {
      return { checked: growth.length, alerted: 0, skippedCooldown: skipped };
    }
    logger.info(`[DbSizeMonitor] ${toAlert.length} tabela(s) cruzaram o threshold`, {
      tables: toAlert.map(r => r.table_name),
    });
    await sendGrowthAlertEmail(toAlert);
    await db.recordAlertsSent(toAlert);
    return { checked: growth.length, alerted: toAlert.length, skippedCooldown: skipped };
  } catch (err) {
    logger.error('[DbSizeMonitor] erro ao checar/alertar crescimento', { error: err.message });
    return { checked: 0, alerted: 0, skippedCooldown: 0 };
  }
}

async function runPurgeSnapshotsOnce() {
  if (!leaderElection.isLeader()) return;

  try {
    const removed = await db.purgeDbSizeSnapshots(SNAPSHOT_RETENTION_DAYS);
    if (removed > 0) {
      logger.info(`[DbSizeMonitor] ${removed} snapshots antigos removidos (> ${SNAPSHOT_RETENTION_DAYS}d)`);
    }
    return removed;
  } catch (err) {
    logger.error('[DbSizeMonitor] erro ao purgar snapshots antigos', { error: err.message });
    return 0;
  }
}

let timer = null;

// Mesmo padrão de activityRetention.js: hora fixa de baixo tráfego, não
// setInterval a partir do boot.
function scheduleNext() {
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(4, 30, 0, 0); // 01:30 BRT -- 30min depois de activityRetention
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delayMs = next - now;
  timer = setTimeout(async () => {
    await runSnapshotOnce();
    await runGrowthCheckOnce();
    runPurgeSnapshotsOnce(); // fire-and-forget, batches próprios
    scheduleNext();
  }, delayMs);
}

function scheduleDailyMonitor() {
  // Imediato no boot, não espera até a próxima janela -- mas sequencial
  // (await), diferente de activityRetention: precisa do snapshot gravado
  // ANTES de rodar o growth check, senão compara contra dado inexistente.
  (async () => {
    await runSnapshotOnce();
    await runGrowthCheckOnce();
    runPurgeSnapshotsOnce();
  })();
  scheduleNext();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  runSnapshotOnce, runGrowthCheckOnce, runPurgeSnapshotsOnce, scheduleDailyMonitor, stop,
  isAlertable, formatBytes,
  SNAPSHOT_RETENTION_DAYS, GROWTH_CHECK_WINDOW_DAYS, ALERT_COOLDOWN_DAYS,
  GROWTH_PCT_THRESHOLD, GROWTH_BYTES_THRESHOLD, LARGE_TABLE_BYTES_THRESHOLD,
};
