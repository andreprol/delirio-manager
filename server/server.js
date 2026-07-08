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
const relatorioRoutes = require('./routes/relatorio');
const zamakRoutes     = require('./routes/zamak');

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

// ── Status integrações ────────────────────────────────────────────────────────
app.get('/api/status/integrations', (req, res) => {
  const { getIntegrationsStatus } = require('./db');
  res.json(getIntegrationsStatus());
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
app.use('/api/relatorio', relatorioRoutes);
app.use('/api/zamak',    zamakRoutes);

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

// Relatórios TI gerados (downloads/relatorios/)
const RELATORIOS_DIR = path.join(__dirname, '..', 'downloads', 'relatorios');
fs.mkdirSync(RELATORIOS_DIR, { recursive: true });
try { fs.chmodSync(path.join(__dirname, '..', 'downloads'), 0o777); } catch (_) {}
try { fs.chmodSync(RELATORIOS_DIR, 0o777); } catch (_) {}
app.use('/downloads/relatorios', express.static(RELATORIOS_DIR));

// Fotos de tópicos do Módulo Relatório
const RELATORIO_PHOTOS_DIR = path.join(PUBLIC_DIR, 'relatorio-photos');
fs.mkdirSync(RELATORIO_PHOTOS_DIR, { recursive: true });
try { fs.chmodSync(RELATORIO_PHOTOS_DIR, 0o777); } catch (_) {}
app.use('/relatorio-photos', express.static(RELATORIO_PHOTOS_DIR));

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

// GET /install.ps1 — script de instalação completo, baixado e executado diretamente na máquina remota
app.get('/install.ps1', (req, res) => {
  const serverUrl = `https://${req.hostname}`;
  const script = `
$Servidor    = "${serverUrl}"
$InstallDir  = "C:\\Program Files\\DelirioAgent"
$ExePath     = "$InstallDir\\delirio-agent.exe"
$DownloadUrl = "$Servidor/downloads/delirio-agent.exe"
$ServiceName = "DelirioAgent"

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step([int]$n, [int]$total, [string]$msg) { Write-Host "[$n/$total] $msg" -ForegroundColor Yellow }
function Write-Detail([string]$msg) { Write-Host "      $msg" -ForegroundColor Gray }
function Write-OK([string]$msg)     { Write-Host "      OK: $msg" -ForegroundColor Green }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERRO: Execute como Administrador (clique direito -> Executar como administrador)." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       DELIRIO MANAGER AGENT — Instalação             ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Servidor   : $Servidor"
Write-Host "  Diretório  : $InstallDir"
Write-Host "  Computador : $env:COMPUTERNAME"
Write-Host ""

Write-Step 1 5 "Verificando conectividade com o servidor..."
try {
    $h = Invoke-WebRequest -Uri "$Servidor/health" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    Write-OK "Servidor acessível (HTTP $($h.StatusCode))"
} catch {
    Write-Host "ERRO: Servidor inacessível: $Servidor/health" -ForegroundColor Red
    exit 1
}

Write-Step 2 5 "Verificando serviço existente..."
$svcExistente = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svcExistente) {
    Write-Detail "Parando serviço (status: $($svcExistente.Status))..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Name "delirio-agent" -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    Stop-Process -Name "delirio-agent" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Write-OK "Serviço parado"
} else {
    Write-OK "Instalação nova (sem serviço anterior)"
}

Write-Step 3 5 "Baixando delirio-agent.exe..."
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ExePath -UseBasicParsing -TimeoutSec 120
    $mb = [math]::Round((Get-Item $ExePath).Length / 1MB, 1)
    Write-OK "Download concluido ($mb MB)"
} catch {
    Write-Host "ERRO: Falha ao baixar o agente: $_" -ForegroundColor Red
    exit 1
}

Write-Step 4 5 "Configurando e instalando serviço..."
& $ExePath -server $Servidor
& $ExePath -install
Write-OK "Serviço instalado e iniciado"

Write-Step 5 5 "Verificando instalação..."
Start-Sleep -Seconds 4
$svcFinal = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if ($svcFinal -and $svcFinal.Status -eq "Running") {
    $proc = Get-Process -Name "delirio-agent" -ErrorAction SilentlyContinue
    $ram  = if ($proc) { "$([math]::Round($proc.WorkingSet64/1MB,1))MB" } else { "N/D" }
    $ver  = (& $ExePath -version 2>&1) -replace "DelirioAgent v",""
    Write-Host ""
    Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "║   INSTALACAO CONCLUIDA COM SUCESSO                   ║" -ForegroundColor Green
    Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Versão     : $ver"
    Write-Host "  Computador : $env:COMPUTERNAME"
    Write-Host "  Serviço    : $ServiceName (RUNNING)"
    Write-Host "  RAM atual  : $ram"
    Write-Host "  Log        : $InstallDir\\logs\\agent.log"
    Write-Host ""
    Write-Host "  O agente aparecera online no dashboard em < 60 segundos." -ForegroundColor Cyan
    Write-Host "  Dashboard  : $Servidor" -ForegroundColor Cyan
    Write-Host ""
} else {
    $status = if ($svcFinal) { $svcFinal.Status } else { "NAO ENCONTRADO" }
    Write-Host "ERRO: Servico nao subiu (status: $status)" -ForegroundColor Red
    Write-Host "Log: Get-Content '$InstallDir\\logs\\agent.log' -Tail 30"
    exit 1
}
`.trimStart();

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
