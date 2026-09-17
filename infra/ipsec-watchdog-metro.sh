#!/bin/bash
# Watchdog do tunel IPsec azure-to-metro (dt-manager).
# Instalado via systemd timer na VM Azure (vm-dt-manager), nao via cron.
#
# Deploy (na VM):
#   sudo cp ipsec-watchdog-metro.sh /usr/local/bin/ipsec-watchdog-metro.sh
#   sudo chmod 755 /usr/local/bin/ipsec-watchdog-metro.sh
#   # criar /etc/systemd/system/ipsec-watchdog-metro.service (Type=oneshot, ExecStart=/usr/local/bin/ipsec-watchdog-metro.sh)
#   # criar /etc/systemd/system/ipsec-watchdog-metro.timer (OnBootSec=2min, OnUnitActiveSec=3min)
#   sudo systemctl daemon-reload && sudo systemctl enable --now ipsec-watchdog-metro.timer
#
# Log: /var/log/ipsec-watchdog.log
#
# Complementa o fix de /etc/ipsec.conf (keyingtries=%forever + closeaction=restart) —
# ver docs/infrastructure/delirio-vpn-chain.md, secao "keyingtries default of 3 causes
# permanent tunnel death". O fix de config evita que o strongSwan desista pra sempre;
# este watchdog e defesa em profundidade caso o retry infinito trave por algum motivo.

LOG=/var/log/ipsec-watchdog.log
STATUS=$(ipsec statusall azure-to-metro 2>&1)

if echo "$STATUS" | grep -q '(0 up'; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) TUNEL CAIDO - forcando ipsec up azure-to-metro" >> "$LOG"
    ipsec up azure-to-metro >> "$LOG" 2>&1
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) resultado: $(ipsec statusall azure-to-metro | grep 'Security Associations')" >> "$LOG"
fi
