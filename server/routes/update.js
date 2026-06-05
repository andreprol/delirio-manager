'use strict';

// routes/update.js — gerencia versao do agente e atualizacoes em massa

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const db       = require('../db');
const { broadcast } = require('../services/websocket');

const PUBLIC_DIR    = path.join(__dirname, '..', 'public');
const VERSION_FILE  = path.join(PUBLIC_DIR, 'version.json');
const AGENT_EXE     = path.join(PUBLIC_DIR, 'delirio-agent.exe');

function readVersionInfo() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  } catch {
    return { version: '1.0.0', sha256: '', publishedAt: null };
  }
}

// GET /api/update/version — retorna versao atual publicada
router.get('/version', (req, res) => {
  res.json(readVersionInfo());
});

// POST /api/update/publish — faz upload do novo agente.exe
// Body: multipart form com campo "binary" (o .exe)
// OU JSON com { base64: "...", version: "1.1.0" } para upload via API
router.post('/publish', express.raw({ type: 'application/octet-stream', limit: '50mb' }), (req, res) => {
  const version = req.headers['x-agent-version'];
  if (!version) {
    return res.status(400).json({ error: 'Header X-Agent-Version obrigatorio' });
  }

  if (!req.body || req.body.length < 1000) {
    return res.status(400).json({ error: 'Binario muito pequeno ou vazio' });
  }

  // Calcula SHA256 do binario recebido
  const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');

  // Salva o binario
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(AGENT_EXE, req.body);

  // Salva version.json
  const info = {
    version,
    sha256,
    publishedAt: new Date().toISOString(),
    sizeBytes: req.body.length,
  };
  fs.writeFileSync(VERSION_FILE, JSON.stringify(info, null, 2));

  console.log(`[Update] Nova versao publicada: v${version} (${Math.round(req.body.length / 1024)}KB, sha256: ${sha256.slice(0, 16)}...)`);

  // Notifica dashboards em tempo real
  broadcast('agent:version', { version, sha256, publishedAt: info.publishedAt });

  res.json({ ok: true, version, sha256, sizeBytes: req.body.length });
});

// POST /api/update/broadcast — envia comando de update para todas as maquinas online
// Body: { targetVersion: "1.1.0" } (opcional, usa versao atual se omitido)
router.post('/broadcast', (req, res) => {
  const info = readVersionInfo();
  const version = req.body?.targetVersion || info.version;

  if (!fs.existsSync(AGENT_EXE)) {
    return res.status(404).json({ error: 'Nenhum binario publicado ainda. Publique primeiro.' });
  }

  const machines = db.getAllMachines().filter(m => m.status === 'online');
  if (machines.length === 0) {
    return res.json({ ok: true, sent: 0, message: 'Nenhuma maquina online no momento.' });
  }

  let sent = 0;
  for (const m of machines) {
    try {
      db.createCommand(m.id, 'update', {
        version,
        sha256: info.sha256,
      });
      sent++;
    } catch {}
  }

  console.log(`[Update] Broadcast de atualizacao v${version} enviado para ${sent} maquinas.`);
  broadcast('update:broadcast', { version, sent, total: machines.length });

  res.json({ ok: true, sent, total: machines.length, version });
});

// POST /api/update/machine/:id — envia update para maquina especifica
router.post('/machine/:id', (req, res) => {
  const machine = db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Maquina nao encontrada' });

  const info = readVersionInfo();
  db.createCommand(machine.id, 'update', {
    version: info.version,
    sha256:  info.sha256,
  });

  res.json({ ok: true, machineId: machine.id, version: info.version });
});

// ── Upload do installer do dashboard ──────────────────────────────────────

const multer = require('multer');

const dashboardUpdatesDir = path.join(PUBLIC_DIR, 'dashboard-updates');
require('fs').mkdirSync(dashboardUpdatesDir, { recursive: true });

const dashboardStorage = multer.diskStorage({
  destination: dashboardUpdatesDir,
  filename:    (_req, file, cb) => cb(null, file.originalname),
});
const uploadDashboard = multer({
  storage: dashboardStorage,
  limits:  { fileSize: 500 * 1024 * 1024 },
});

function loadServerConfig() {
  try {
    return JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

// POST /api/update/upload-dashboard
// Header: X-Upload-Secret com o valor de config.json.uploadSecret
router.post('/upload-dashboard', (req, res, next) => {
  const cfg    = loadServerConfig();
  const secret = cfg.uploadSecret;
  if (!secret || req.headers['x-upload-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized — configure uploadSecret em config.json' });
  }
  next();
}, uploadDashboard.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  console.log(`[Update] Dashboard file uploaded: ${req.file.originalname} (${Math.round(req.file.size / 1024)}KB)`);
  res.json({ ok: true, filename: req.file.originalname, size: req.file.size });
});

module.exports = router;
module.exports.readVersionInfo = readVersionInfo;
