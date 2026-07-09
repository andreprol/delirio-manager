#!/bin/bash
# safe-restart.sh — restart seguro do dt-manager
# Evita ghost processes de 'pm2 restart' que causam EADDRINUSE loop
# USO: bash /opt/dt-manager/infra/safe-restart.sh

set -e

echo "[safe-restart] Matando ghost 'pm2 restart dt-manager'..."
pkill -f 'pm2 restart dt-manager' 2>/dev/null || true

echo "[safe-restart] Matando server.js residual..."
pkill -f 'node /opt/dt-manager/server.js' 2>/dev/null || true

sleep 2

echo "[safe-restart] Removendo dt-manager do PM2..."
pm2 delete dt-manager 2>/dev/null || true

sleep 1

echo "[safe-restart] Iniciando via ecosystem.config.js..."
cd /opt/dt-manager
pm2 start ecosystem.config.js

pm2 save

sleep 4

echo "[safe-restart] Status final:"
pm2 list

echo "[safe-restart] Health check:"
curl -s http://localhost:3847/health || echo "health check falhou"
