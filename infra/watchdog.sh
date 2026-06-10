#!/bin/bash
# Watchdog do servidor dt-manager
# Instalado via cron: */5 * * * * /opt/dt-manager/watchdog.sh
# Log: /var/log/dt-manager-watchdog.log
#
# Para instalar na VM:
#   (crontab -l 2>/dev/null | grep -v watchdog; echo "*/5 * * * * /opt/dt-manager/watchdog.sh") | crontab -

LOG=/var/log/dt-manager-watchdog.log

STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://localhost:3847/health)

if [ "$STATUS" != "200" ]; then
  echo "[$(date)] Watchdog: servidor nao respondeu (HTTP $STATUS) — reiniciando PM2" >> "$LOG"
  pm2 restart dt-manager >> "$LOG" 2>&1
else
  echo "[$(date)] Watchdog: OK (HTTP $STATUS)" >> "$LOG"
fi
