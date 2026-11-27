'use strict';

const http   = require('http');
const app    = require('./app');
const logger = require('./services/logger');

const { initWebSocket } = require('./services/websocket');
const alertEngine       = require('./services/alertEngine');
const insightEngine     = require('./services/insightEngine');
const zamakService      = require('./services/zamak');
const metricsEmail       = require('./services/metricsEmailReport');
const ncrMonitor         = require('./services/ncrMonitor');
const serviceStatusEmail = require('./services/serviceStatusEmail');
const rhHealthMonitor    = require('./services/rhHealthMonitor');
const { sendAlert }      = require('./services/resendAlert');
const { initLiveRelay }  = require('./services/liveSessionRelay');
const { createUpgradeRouter } = require('./services/upgradeRouter');
const activityRetention  = require('./services/activityRetention');
const dbSizeMonitor       = require('./services/dbSizeMonitor');
const leaderElection      = require('./services/leaderElection');

const PORT = process.env.PORT || 3847;

const server = http.createServer(app);
const wsServer = initWebSocket();
// Sempre montado, mesmo sem FEATURE_LIVE_ACCESS — inofensivo: sem a flag,
// nenhuma rota consegue criar sessão (registerSession), então toda conexão
// em /live recebe 4000 (sessão inexistente) na hora, mesmo custo de a rota
// não existir. Gatear aqui também só adicionaria uma segunda flag redundante.
const liveWss = initLiveRelay();
// Roteador único de 'upgrade' pra /ws e /live — ver services/upgradeRouter.js
// pro porquê de não usar {server, path} em cada WebSocketServer (achado real
// em produção: o 1º registrado abortava com 400 qualquer upgrade de path
// diferente do seu, antes do WebSocketServer certo ter a chance de atender).
server.on('upgrade', createUpgradeRouter({ wsServer, liveWss }));

// Checagem de boot — pega o cenário do incidente de 2026-09-10 no exato momento
// em que um deploy/restart apaga a env var, em vez de esperar o próximo tick do monitor.
if (!process.env.CLOCK_PROXY_TOKEN) {
  logger.error('CLOCK_PROXY_TOKEN ausente no ambiente — Módulo RH vai falhar em todas as rotas');
  sendAlert({
    source:      'Módulo RH',
    stage:       'Boot sem CLOCK_PROXY_TOKEN',
    detail:      'Servidor subiu sem CLOCK_PROXY_TOKEN no ambiente — todas as rotas /api/rh/* vão retornar 500. Verifique o ecosystem.config.js da VM.',
    cooldownKey: 'rh:token-missing', // mesma chave do rhHealthMonitor — evita alerta duplicado
  }).catch(e => logger.error('[Boot] Falha ao enviar alerta de CLOCK_PROXY_TOKEN ausente', { error: e.message }));
}

server.listen(PORT, async () => {
  logger.info('Delirio Manager Server iniciado', {
    version: '1.0.0',
    port:    PORT,
    db:      process.env.DATABASE_URL ? 'postgres' : '(DATABASE_URL ausente)',
    health:  `http://localhost:${PORT}/health`,
  });
  // leaderElection.start() tem que ser a PRIMEIRA chamada de serviço aqui.
  leaderElection.start();
  alertEngine.start();
  insightEngine.start();
  metricsEmail.scheduleDailyMetricsEmail();
  if (process.env.NCR_MONITOR_ENABLED === 'false') {
    logger.info('NCR monitor desabilitado via NCR_MONITOR_ENABLED=false');
  } else {
    ncrMonitor.start();
    logger.info('NCR monitor iniciado', { interval: '2min' });
  }
  serviceStatusEmail.scheduleServiceStatusEmails();
  _scheduleHourlyMetricsMonitor();
  rhHealthMonitor.start(PORT);
  logger.info('RH health monitor iniciado', { interval: '5min' });

  // zamakService, activityRetention e dbSizeMonitor disparam um "catch up se
  // atrasado" IMEDIATO e síncrono ao serem agendados, que checa isLeader().
  // isLeader() é false até a 1ª tentativa de lock voltar do Postgres (pelo
  // menos 1 round-trip) — sem esperar, esse catch-up seria SEMPRE pulado no
  // boot (ex.: cache Zamak ficava até ~48h velho após restart). Por isso só
  // esses três esperam; os serviços acima não têm catch-up imediato e sobem
  // sem atraso. whenFirstAttemptSettled() nunca rejeita.
  await leaderElection.whenFirstAttemptSettled();
  zamakService.scheduleDailySync();
  if (process.env.FEATURE_LIVE_ACCESS === 'true') {
    activityRetention.scheduleDailyPurge();
  }
  // FEATURE_DB_SIZE_MONITOR: achado do code-reviewer (17/11/2026) -- feature
  // nova que manda e-mail de produção automaticamente sem nenhum kill switch,
  // violando a convenção do projeto (CLAUDE.md "Feature Flags"). Default
  // false (zero value) -- ligar manualmente no ecosystem.config.js da VM
  // depois de confirmar que o snapshot/alerta rodam como esperado.
  if (process.env.FEATURE_DB_SIZE_MONITOR === 'true') {
    dbSizeMonitor.scheduleDailyMonitor();
  }
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
    if (!leaderElection.isLeader()) return;

    try {
      const {
        getMachinesOnlineMissingReading,
        getHourlyMetricsDiag,
        insertReadingMiss,
        createCommand,
      } = require('./db-pg');
      const { checkAll: alertCheckAll } = require('./services/alertEngine');

      const nowTs    = Math.floor(Date.now() / 1000);
      // Janela: leitura esperada na hora anterior (65 min para dar folga à rede)
      const window   = 65 * 60;
      const threshold = nowTs - window;

      // Máquinas online sem leitura nos últimos 65 min
      const onlineMissing = await getMachinesOnlineMissingReading(threshold);

      // Todas as máquinas para capturar offline sem leitura também
      const allDiag = await getHourlyMetricsDiag();
      const offlineMissing = allDiag.filter(r =>
        r.status === 'offline' &&
        (!r.last_snapshot_ts || r.last_snapshot_ts < threshold)
      );

      const hourTs = Math.floor(nowTs / 3600) * 3600; // início da hora atual

      // Registra leituras perdidas — offline (causa esperada)
      for (const m of offlineMissing) {
        await insertReadingMiss(m.id, {
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
      const { addEvent }  = require('./db-pg');

      for (const m of onlineMissing) {
        const diagnosis = _diagnose(m, nowTs);
        const name      = m.display_name || m.hostname;

        await insertReadingMiss(m.id, {
          expectedHour:  hourTs,
          machineStatus: 'online',
          agentVersion:  m.agent_version,
          lastHeartbeat: m.last_snapshot_ts,
          diagnosis,
        });

        // Solicita log do agente para diagnóstico — processado no ACK de get_agent_log
        await createCommand(m.id, 'get_agent_log', { lines: 100 });

        await addEvent(m.id, 'reading_miss',
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

// ── NF-Ce indexer — a cada 15min para servidores BOH ─────────────────────────
// Era 1x/dia às 23:00; passou a rodar a cada 15min (09/11/2026) pra feature
// de auto-envio de DANFE por e-mail (encomendas) detectar notas novas rápido.
// Barato de verdade: indexação é incremental (nfce_indexed_days), dias
// passados são sempre pulados — só "hoje" é reprocessado a cada rodada.
const NFCE_INDEX_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  _triggerNFCeIndexing(new Date()).catch(e => logger.error('[NFCe] Erro no scheduler', { error: e.message }));
}, NFCE_INDEX_INTERVAL_MS);
// Primeira rodada 2min após boot — não espera 15min pra primeira indexação do dia.
setTimeout(() => {
  _triggerNFCeIndexing(new Date()).catch(e => logger.error('[NFCe] Erro no scheduler', { error: e.message }));
}, 2 * 60 * 1000);

async function _triggerNFCeIndexing(now) {
  if (!leaderElection.isLeader()) return;

  const { getAllMachines, createCommand, getIndexedDayKeysSet, todayDayKey } = require('./db-pg');
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const today = now.getDate();
  const todayKey = todayDayKey();

  const allMachines = await getAllMachines();
  const boh = allMachines.filter(m =>
    m.hostname?.toUpperCase().endsWith('BOH') && m.status === 'online'
  );
  if (!boh.length) return;

  let totalSent = 0, totalSkipped = 0;
  for (const machine of boh) {
    const indexedDays = await getIndexedDayKeysSet(machine.id);
    for (let d = 1; d <= today; d++) {
      const day    = String(d).padStart(2, '0');
      const dayKey = `${month}-${day}`;
      if (indexedDays.has(dayKey) && dayKey !== todayKey) { totalSkipped++; continue; }
      await createCommand(machine.id, 'aloha-index-nfce-day', { month, day });
      totalSent++;
    }
  }
  logger.info('NFCe indexação noturna', { boh: boh.length, month, enviados: totalSent, puladosJaIndexados: totalSkipped });
}

// ── Aloha scan — mantém o card "verificado" do dashboard sempre fresco ───────
// Sem isso o scan só rodava 1x (ao expandir a loja pela 1a vez no dashboard) e
// nunca mais se atualizava sozinho — card ficava com dado de meses atrás.
function _scheduleAlohaScanRefresh() {
  const { getAllMachines, createCommand } = require('./db-pg');
  const INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h — scan é leve (só lista pastas, não abre XML)

  async function _refresh() {
    if (!leaderElection.isLeader()) return;

    const allMachines = await getAllMachines();
    const boh = allMachines.filter(m =>
      m.hostname?.toUpperCase().endsWith('BOH') && m.status === 'online'
    );
    for (const machine of boh) {
      await createCommand(machine.id, 'aloha-scan', {});
    }
    if (boh.length) logger.info('[AlohaScan] Refresh automático disparado', { lojas: boh.length });
  }

  setTimeout(() => { _refresh().catch(e => logger.error('[AlohaScan] Erro no refresh', { error: e.message })); }, 5 * 60 * 1000);
  setInterval(() => { _refresh().catch(e => logger.error('[AlohaScan] Erro no refresh', { error: e.message })); }, INTERVAL_MS);
}
_scheduleAlohaScanRefresh();

// ── Shutdown gracioso ─────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM recebido — encerrando graciosamente');
  alertEngine.stop();
  insightEngine.stop();
  rhHealthMonitor.stop();
  activityRetention.stop();
  dbSizeMonitor.stop();
  await leaderElection.stop();
  server.close(() => process.exit(0));
});
