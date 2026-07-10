'use strict';

// routes/admin.js — operações administrativas autenticadas
// Evita o lock de 90min do Azure run-command para operações rotineiras

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');

function loadAdminSecret() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return cfg.adminSecret || null;
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const secret = loadAdminSecret();
  if (!secret) {
    return res.status(503).json({ error: 'adminSecret nao configurado em config.json' });
  }
  if (req.headers['x-admin-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /api/admin/restart
// Dispara o safe-restart.sh em background e responde imediatamente.
// O servidor reinicia ~2s depois, encerrando a conexão normalmente.
router.post('/restart', authMiddleware, (req, res) => {
  const SAFE_RESTART = '/opt/dt-manager/infra/safe-restart.sh';

  if (!fs.existsSync(SAFE_RESTART)) {
    return res.status(500).json({ error: `Script nao encontrado: ${SAFE_RESTART}` });
  }

  console.log(`[Admin] Restart solicitado por ${req.ip} em ${new Date().toISOString()}`);

  res.json({ ok: true, message: 'Restart iniciado. Servidor volta em ~15s.' });

  // Dispara em background APÓS enviar a resposta
  setImmediate(() => {
    const child = spawn('bash', [SAFE_RESTART], {
      detached: true,
      stdio:    'ignore',
    });
    child.unref();
  });
});

// GET /api/admin/status
// Retorna info básica do processo para diagnóstico sem precisar de run-command.
router.get('/status', authMiddleware, (req, res) => {
  const { execSync } = require('child_process');

  let pm2Info = null;
  try {
    pm2Info = execSync('pm2 jlist 2>/dev/null', { timeout: 5000 }).toString();
    pm2Info = JSON.parse(pm2Info).map(p => ({
      name:    p.name,
      status:  p.pm2_env?.status,
      pid:     p.pid,
      restarts: p.pm2_env?.restart_time,
      uptime:  p.pm2_env?.pm_uptime,
    }));
  } catch {
    pm2Info = 'indisponivel';
  }

  let diskFree = null;
  try {
    diskFree = execSync("df -h /opt 2>/dev/null | tail -1 | awk '{print $4}'", { timeout: 3000 }).toString().trim();
  } catch { /* ignore */ }

  res.json({
    nodeUptime:  Math.round(process.uptime()),
    nodeMemMB:   Math.round(process.memoryUsage().rss / 1024 / 1024),
    pid:         process.pid,
    pm2:         pm2Info,
    diskFreeOpt: diskFree,
    ts:          new Date().toISOString(),
  });
});

module.exports = router;
