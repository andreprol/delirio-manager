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
});

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
