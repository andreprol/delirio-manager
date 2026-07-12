'use strict';

const http   = require('http');
const app    = require('./app');
const logger = require('./services/logger');

const { initWebSocket } = require('./services/websocket');
const alertEngine       = require('./services/alertEngine');
const insightEngine     = require('./services/insightEngine');
const zamakService      = require('./services/zamak');
const metricsEmail      = require('./services/metricsEmailReport');
const ncrMonitor        = require('./services/ncrMonitor');

const PORT = process.env.PORT || 3847;

const server = http.createServer(app);
initWebSocket(server);

server.listen(PORT, () => {
  logger.info('Delirio Manager Server iniciado', {
    version: '1.0.0',
    port:    PORT,
    db:      process.env.DB_PATH || 'data/dt-manager.db',
    health:  `http://localhost:${PORT}/health`,
  });
  alertEngine.start();
  insightEngine.start();
  zamakService.scheduleDailySync();
  metricsEmail.scheduleDailyMetricsEmail();
  ncrMonitor.start();
  logger.info('NCR monitor iniciado', { interval: '2min' });
  _scheduleHourlyMetricsMonitor();
});

// ── Monitor de métricas horárias — loga máquinas sem snapshot há >2h ─────────
function _scheduleHourlyMetricsMonitor() {
  const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 min
  const ALERT_THRESHOLD_H = 2;

  function check() {
    try {
      const { getHourlyMetricsDiag } = require('./db');
      const now = Math.floor(Date.now() / 1000);
      const threshold = now - ALERT_THRESHOLD_H * 3600;
      const rows = getHourlyMetricsDiag();

      const missing = rows.filter(r => {
        if (r.status !== 'online') return false; // offline é esperado
        return !r.last_snapshot_ts || r.last_snapshot_ts < threshold;
      });

      if (missing.length === 0) {
        logger.info('[HourlyMonitor] Todas as máquinas online enviando snapshots');
        return;
      }

      logger.warn(`[HourlyMonitor] ${missing.length} máquina(s) online sem snapshot há >${ALERT_THRESHOLD_H}h`, {
        machines: missing.map(r => ({
          hostname:     r.hostname,
          location:     r.location,
          agentVersion: r.agent_version || '?',
          readings24h:  r.readings_24h,
          lastHourlyAt: r.last_hourly_at || 'nunca',
          agoMin:       r.last_snapshot_ts
            ? Math.round((now - r.last_snapshot_ts) / 60)
            : null,
          motivo: !r.agent_version || r.agent_version < '1.5.13'
            ? `agente ${r.agent_version || '?'} (sem hourlySnapshot — atualizar)`
            : r.readings_24h === 0
              ? 'agente novo mas sem nenhuma leitura hoje (verificar logs do agente)'
              : 'baixa cobertura',
        })),
      });
    } catch (err) {
      logger.error('[HourlyMonitor] Erro ao verificar snapshots', { error: err.message });
    }
  }

  // Primeira verificação após 5 min (aguarda agentes conectarem)
  setTimeout(() => {
    check();
    setInterval(check, CHECK_INTERVAL_MS);
  }, 5 * 60 * 1000);
}

// ── NF-Ce indexer — dispara diariamente às 23:00 para servidores BOH ─────────
let _nfceLastIndexDay = null;
setInterval(() => {
  const now  = new Date();
  const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const today = now.toISOString().slice(0, 10);
  if (hhmm === '23:00' && _nfceLastIndexDay !== today) {
    _nfceLastIndexDay = today;
    _triggerNFCeIndexing(now).catch(e => logger.error('[NFCe] Erro no scheduler', { error: e.message }));
  }
}, 60000);

async function _triggerNFCeIndexing(now) {
  const { getAllMachines, createCommand } = require('./db');
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const today = now.getDate();

  const boh = getAllMachines().filter(m =>
    m.hostname?.toUpperCase().endsWith('BOH') && m.status === 'online'
  );
  if (!boh.length) return;

  logger.info('NFCe indexação noturna', { boh: boh.length, month, diasAte: String(today).padStart(2, '0') });
  for (const machine of boh) {
    for (let d = 1; d <= today; d++) {
      createCommand(machine.id, 'aloha-index-nfce-day', { month, day: String(d).padStart(2, '0') });
    }
  }
}

// ── Shutdown gracioso ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM recebido — encerrando graciosamente');
  alertEngine.stop();
  insightEngine.stop();
  server.close(() => process.exit(0));
});
