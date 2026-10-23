#!/bin/bash
# safe-restart.sh — restart seguro do dt-manager
# Evita ghost processes de 'pm2 restart' que causam EADDRINUSE loop
# USO: bash /opt/dt-manager/infra/safe-restart.sh

set -e

# Guardrail — incidente 2026-09-10: um restart anterior sobrescreveu o ecosystem.config.js
# sem CLOCK_PROXY_TOKEN/CLOCK_PROXY_URL, derrubando o Módulo RH em silêncio.
# Aborta ANTES de mexer em qualquer processo se as vars não estiverem no arquivo que será usado.
ECOSYSTEM_FILE="/opt/dt-manager/ecosystem.config.js"
if [ -f "$ECOSYSTEM_FILE" ]; then
  if ! grep -qE "CLOCK_PROXY_TOKEN:\s*['\"]" "$ECOSYSTEM_FILE"; then
    echo "[safe-restart] ABORTADO: CLOCK_PROXY_TOKEN ausente em $ECOSYSTEM_FILE — Módulo RH ficaria fora do ar." >&2
    echo "[safe-restart] Corrija o ecosystem.config.js antes de reiniciar (ver project_delirio_manager.md)." >&2
    exit 1
  fi
  if ! grep -qE "CLOCK_PROXY_URL:\s*['\"]" "$ECOSYSTEM_FILE"; then
    echo "[safe-restart] ABORTADO: CLOCK_PROXY_URL ausente em $ECOSYSTEM_FILE — Módulo RH ficaria fora do ar." >&2
    exit 1
  fi
  if ! grep -qE "exec_mode:\s*['\"]fork['\"]" "$ECOSYSTEM_FILE"; then
    echo "[safe-restart] ABORTADO: exec_mode:'fork' ausente em $ECOSYSTEM_FILE — PM2 assume cluster quando 'instances' está presente sem exec_mode explícito, e SQLite single-writer + WebSocket com clients em memória quebram com múltiplos workers (EADDRINUSE crash loop, incidente 23/10/2026)." >&2
    exit 1
  fi
fi

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

sleep 2

echo "[safe-restart] Verificando exec_mode real..."
REAL_MODE=$(pm2 jlist | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const p=d.find(x=>x.name==='dt-manager'); console.log(p&&p.pm2_env&&p.pm2_env.exec_mode||'none')")
if [ "$REAL_MODE" != "fork_mode" ]; then
  echo "[safe-restart] ABORTADO: dt-manager subiu em '$REAL_MODE', esperado 'fork_mode'. Nao salvando este estado no pm2 save — investigar antes de tentar de novo." >&2
  exit 1
fi
echo "[safe-restart] exec_mode confirmado: fork_mode"

pm2 save

sleep 4

echo "[safe-restart] Status final:"
pm2 list

echo "[safe-restart] Health check:"
curl -s http://localhost:3847/health || echo "health check falhou"
