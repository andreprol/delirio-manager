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

// ── Monitor autônomo de leituras horárias ────────────────────────────────────
// Roda a cada minuto; dispara a verificação completa nos :05 de cada hora.
// Para cada máquina online sem leitura no último 65 min:
//   • offline  → registra reading_miss_event (causa: offline)
//   • online   → registra + diagnostica automaticamente + dispara alerta
function _scheduleHourlyMetricsMonitor() {
  let lastCheckedHour = -1;

  function _diagnoseHeartbeat(ver, heartbeatAgoMin, readings24h) {
    if (heartbeatAgoMin !== null && heartbeatAgoMin < 3) {
      if (readings24h === 0) return `agente ${ver} vivo (heartbeat há ${heartbeatAgoMin}min) — goroutine nunca iniciou (verificar logs: token ausente no boot?)`;
      return `agente ${ver} vivo (heartbeat há ${heartbeatAgoMin}min) — goroutine morreu após ${readings24h} leitura(s) — provável panic silencioso ou crash do rate-limiter`;
    }
    if (heartbeatAgoMin !== null && heartbeatAgoMin < 10) {
      return `agente ${ver} com heartbeat recente (${heartbeatAgoMin}min) — goroutine interrompida`;
    }
    return `agente ${ver} sem heartbeat há ${heartbeatAgoMin ?? '?'}min — agente pode ter crashado completamente`;
  }

  function _diagnose(machine, nowTs) {
    const ver = machine.agent_version;
    if (!ver || ver < '1.5.20') {
      return `agente ${ver || 'desconhecido'} não suporta hourlySnapshot — atualizar para v1.5.23+`;
    }
    const heartbeatAgoMin = machine.last_seen
      ? Math.round((nowTs * 1000 - new Date(machine.last_seen).getTime()) / 60000)
      : null;
    return _diagnoseHeartbeat(ver, heartbeatAgoMin, machine.readings_24h ?? 0);
  }

  async function _checkHour() {
    try {
      const {
        getMachinesOnlineMissingReading,
        getHourlyMetricsDiag,
        insertReadingMiss,
        createCommand,
      } = require('./db');
      const { checkAll: alertCheckAll } = require('./services/alertEngine');

      const nowTs    = Math.floor(Date.now() / 1000);
      // Janela: leitura esperada na hora anterior (65 min para dar folga à rede)
      const window   = 65 * 60;
      const threshold = nowTs - window;

      // Máquinas online sem leitura nos últimos 65 min
      const onlineMissing = getMachinesOnlineMissingReading(threshold);

      // Todas as máquinas para capturar offline sem leitura também
      const allDiag = getHourlyMetricsDiag();
      const offlineMissing = allDiag.filter(r =>
        r.status === 'offline' &&
        (!r.last_snapshot_ts || r.last_snapshot_ts < threshold)
      );

      const hourTs = Math.floor(nowTs / 3600) * 3600; // início da hora atual

      // Registra leituras perdidas — offline (causa esperada)
      for (const m of offlineMissing) {
        insertReadingMiss(m.id, {
          expectedHour:  hourTs,
          machineStatus: 'offline',
          agentVersion:  m.agent_version,
          lastHeartbeat: m.last_snapshot_ts,
          diagnosis:     'máquina offline',
        });
      }

      if (onlineMissing.length === 0) {
        logger.info('[HourlyMonitor] Todas as máquinas online enviando snapshots corretamente');
        return;
      }

      // Registra + diagnostica leituras perdidas — online (problema real)
      const { broadcast } = require('./services/websocket');
      const { addEvent }  = require('./db');

      for (const m of onlineMissing) {
        const diagnosis = _diagnose(m, nowTs);
        const name      = m.display_name || m.hostname;

        insertReadingMiss(m.id, {
          expectedHour:  hourTs,
          machineStatus: 'online',
          agentVersion:  m.agent_version,
          lastHeartbeat: m.last_snapshot_ts,
          diagnosis,
        });

        // Solicita log do agente para diagnóstico — processado no ACK de get_agent_log
        createCommand(m.id, 'get_agent_log', { lines: 100 });

        addEvent(m.id, 'reading_miss',
          `Leitura horária perdida — ${name} online mas sem snapshot. ${diagnosis}`);

        broadcast('alert', {
          machineId: m.id,
          type:      'reading_miss',
          message:   `${name} (${m.location}): leitura horária perdida. ${diagnosis}`,
          ts:        new Date().toISOString(),
        });

        logger.warn('[HourlyMonitor] Leitura perdida — máquina ONLINE', {
          hostname:    m.hostname,
          location:    m.location,
          readings24h: m.readings_24h,
          diagnosis,
        });
      }

      logger.warn(`[HourlyMonitor] ${onlineMissing.length} máquina(s) ONLINE sem leitura na última hora`, {
        locations: [...new Set(onlineMissing.map(m => m.location))],
      });
    } catch (err) {
      logger.error('[HourlyMonitor] Erro no check horário', { error: err.message });
    }
  }

  // Tick a cada minuto — dispara nos :05 de cada hora (após agentes terem tempo de enviar)
  setInterval(() => {
    const now  = new Date();
    const min  = now.getUTCMinutes();
    const hour = now.getUTCHours();
    if (min === 5 && hour !== lastCheckedHour) {
      lastCheckedHour = hour;
      _checkHour();
    }
  }, 60 * 1000);

  // Primeira verificação: 5 min após o boot (aguarda agentes registrarem)
  setTimeout(_checkHour, 5 * 60 * 1000);
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
