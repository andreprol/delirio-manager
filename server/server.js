'use strict';

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const express = require('express');

const { initWebSocket } = require('./services/websocket');
const alertEngine       = require('./services/alertEngine');
const insightEngine     = require('./services/insightEngine');

const agentRoutes    = require('./routes/agent');
const machineRoutes  = require('./routes/machines');
const alertRoutes    = require('./routes/alerts');
const updateRoutes   = require('./routes/update');
const groupRoutes    = require('./routes/groups');
const winEventsRoutes = require('./routes/winEvents');
const insightRoutes  = require('./routes/insights');
const reportRoutes   = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
const rhRoutes       = require('./routes/rh');
const alohaRoutes    = require('./routes/aloha');
const drRoutes       = require('./routes/dr');

const PORT    = process.env.PORT    || 3847;
const VERSION = '1.0.0';

// ── App Express ───────────────────────────────────────────────────────────────
const app = express();

app.use(express.json({ limit: '5mb' }));

// CORS simples para o dashboard Electron (origem local)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Agent-Version');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Logging basico
app.use((req, res, next) => {
  if (req.path !== '/health') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const { getDb } = require('./db');
  const machineCount = getDb()
    .prepare('SELECT COUNT(*) as c FROM machines').get().c;

  res.json({
    status:  'ok',
    version: VERSION,
    uptime:  Math.round(process.uptime()),
    machines: machineCount,
  });
});

// ── Rotas ─────────────────────────────────────────────────────────────────────
app.use('/api', agentRoutes);
app.use('/api', winEventsRoutes);
app.use('/api/machines', machineRoutes);
app.use('/api/alerts',   alertRoutes);
app.use('/api/update',   updateRoutes);
app.use('/api/groups',   groupRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/reports',  reportRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/rh',       rhRoutes);
app.use('/api/aloha',    alohaRoutes);
app.use('/api/dr',       drRoutes);

// ── Servir o instalador e o binario do agente ─────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');

// Dashboard updates — servidos estaticamente para o electron-updater
const DASHBOARD_UPDATES_DIR = path.join(PUBLIC_DIR, 'dashboard-updates');
fs.mkdirSync(DASHBOARD_UPDATES_DIR, { recursive: true });
app.use('/dashboard-updates', express.static(DASHBOARD_UPDATES_DIR));

// Downloads gerais (VeeamAgentWindows.exe, etc.)
const DOWNLOADS_DIR = path.join(PUBLIC_DIR, 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
app.use('/downloads', express.static(DOWNLOADS_DIR));

// GET /downloads/dashboard — download do installer mais recente do dashboard
app.get('/downloads/dashboard', (req, res) => {
  try {
    const installer = fs.readdirSync(DASHBOARD_UPDATES_DIR).find(f => f.endsWith('.exe'));
    if (!installer) return res.status(404).json({ error: 'Installer nao encontrado' });
    res.download(path.join(DASHBOARD_UPDATES_DIR, installer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /install.ps1
app.get('/install.ps1', (req, res) => {
  const serverUrl = `https://${req.hostname}`;
  const script = [
    '# Delirio Manager - Instalador do Agente',
    '# Execute como Administrador no PowerShell',
    '$ErrorActionPreference = "Stop"',
    `$SERVER = "${serverUrl}"`,
    '$DIR    = "C:\\Program Files\\DelirioAgent"',
    '',
    'Write-Host "Instalando Delirio Agent..." -ForegroundColor Cyan',
    'New-Item -ItemType Directory -Force -Path $DIR | Out-Null',
    '',
    '# Baixa o agente',
    'Invoke-WebRequest -Uri "$SERVER/downloads/delirio-agent.exe" -OutFile "$DIR\\delirio-agent.exe" -UseBasicParsing',
    '',
    '# Configura servidor e instala servico',
    '& "$DIR\\delirio-agent.exe" -server $SERVER',
    '& "$DIR\\delirio-agent.exe" -install',
    '',
    'Write-Host "Delirio Agent instalado com sucesso!" -ForegroundColor Green',
    'Write-Host "Servico: DelirioAgent"',
    'Get-Service DelirioAgent | Select-Object Status, DisplayName',
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="install.ps1"');
  res.send(script);
});

// GET /downloads/delirio-agent.exe
app.get('/downloads/delirio-agent.exe', (req, res) => {
  const exePath = path.join(PUBLIC_DIR, 'delirio-agent.exe');
  if (!fs.existsSync(exePath)) {
    return res.status(404).json({
      error: 'Binario nao encontrado. Copie delirio-agent.exe para a pasta public/ da VM.'
    });
  }
  res.download(exePath, 'delirio-agent.exe');
});

// GET /downloads/lhm.zip
app.get('/downloads/lhm.zip', (req, res) => {
  const zipPath = path.join(PUBLIC_DIR, 'lhm.zip');
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'lhm.zip nao encontrado na pasta public/' });
  }
  res.download(zipPath, 'lhm.zip');
});

// ── 404 para rotas desconhecidas ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Rota nao encontrada' });
});

// ── Erro global ───────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// ── Inicia servidor ───────────────────────────────────────────────────────────
const server = http.createServer(app);
initWebSocket(server);

server.listen(PORT, () => {
  console.log('==============================================');
  console.log(`  Delirio Manager Server v${VERSION}`);
  console.log(`  Porta   : ${PORT}`);
  console.log(`  DB      : ${process.env.DB_PATH || 'data/dt-manager.db'}`);
  console.log(`  Health  : http://localhost:${PORT}/health`);
  console.log('==============================================');
  alertEngine.start();
  insightEngine.start();
});

// ── NF-Ce indexer — dispara diariamente às 23:00 para servidores BOH ─────────
let _nfceLastIndexDay = null;
setInterval(() => {
  const now  = new Date();
  const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const today = now.toISOString().slice(0, 10);
  if (hhmm === '23:00' && _nfceLastIndexDay !== today) {
    _nfceLastIndexDay = today;
    _triggerNFCeIndexing(now).catch(e => console.error('[NFCe] Erro no scheduler:', e.message));
  }
}, 60000); // verifica a cada minuto

async function _triggerNFCeIndexing(now) {
  const { getAllMachines, createCommand } = require('./db');
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const today = now.getDate();

  const boh = getAllMachines().filter(m =>
    m.hostname?.toUpperCase().endsWith('BOH') && m.status === 'online'
  );
  if (!boh.length) return;

  console.log(`[NFCe] Indexação noturna: ${boh.length} BOH, ${month}, dias 01–${String(today).padStart(2,'0')}`);
  for (const machine of boh) {
    for (let d = 1; d <= today; d++) {
      createCommand(machine.id, 'aloha-index-nfce-day', { month, day: String(d).padStart(2, '0') });
    }
  }
}

// Shutdown gracioso
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido. Encerrando...');
  alertEngine.stop();
  insightEngine.stop();
  server.close(() => process.exit(0));
});
