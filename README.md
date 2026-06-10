# Delirio Manager

A self-hosted Windows PC fleet management system for multi-location businesses. Monitor, control, and analyze up to 150+ Windows machines across multiple sites from a single Electron dashboard — with real-time updates, Wake-on-LAN, and AI-powered log analysis.

![Electron](https://img.shields.io/badge/Electron-34-blue?logo=electron)
![Node.js](https://img.shields.io/badge/Node.js-Express-green?logo=node.js)
![React](https://img.shields.io/badge/React-Vite-61DAFB?logo=react)
![Go](https://img.shields.io/badge/Agent-Go-00ADD8?logo=go)

---

## Features

### Fleet Management
- **Real-time monitoring** via WebSocket with 30s HTTP fallback
- **Split-view dashboard** — sidebar with locations + machine cards with live metrics
- **Machine cards** — CPU, RAM, disk usage, temperatures, uptime, IP, MAC
- **Location groups** — organize machines by store/site, drag-free via context menu

### Remote Control
- **Remote commands** — reboot, shutdown, cancel-shutdown, uninstall agent
- **Wake-on-LAN** — wake offline machines via a relay (another machine on the same network)
- **Auto-Wake** — automatically wakes WoL-confirmed machines that go offline
- **Critical machine protection** — requires typing the machine name to confirm destructive commands

### Monitoring & Alerts
- **Windows Event Log** viewer per machine (focused mode + full mode)
- **Offline alerts** — real-time toast + alerts panel with history
- **BIOS report** — PDF export listing machines that need BIOS configuration for WoL

### AI Insights (Claude Haiku)
- Automatically analyzes Windows Event Logs every 6 hours
- Detects patterns: crashes, service failures, update loops, offline patterns, suspicious installs
- Suggests solutions with high-confidence evidence requirement
- Real-time push to dashboard via WebSocket
- Configurable via the settings UI (no manual config file editing needed)

---

## Architecture

```
delirio-manager/
├── agent/          # Go agent installed as a Windows service on managed PCs
├── server/         # Node.js + Express backend (runs on Azure VM)
├── dashboard/      # Electron + React + Vite frontend
├── deploy/         # PowerShell scripts for pilot testing and rollout
├── infra/          # Azure VM provisioning and server deployment scripts
└── docs/           # Design specs and implementation logs
```

### Stack

| Layer | Tech |
|-------|------|
| Agent | Go, runs as Windows Service |
| Server | Node.js, Express, SQLite (better-sqlite3), PM2 |
| Dashboard | Electron 34, React, Vite |
| Real-time | WebSocket (ws library) |
| AI Analysis | Anthropic Claude Haiku API |
| Infrastructure | Azure VM, Nginx (HTTPS termination) |

---

## How It Works

1. **Agent** runs on each managed PC as a Windows service (`DelirioAgent`)
2. Every 30 seconds, the agent sends a heartbeat with metrics (CPU, RAM, disk, temperatures) to the server
3. The agent collects Windows Event Logs and sends them to the server
4. The **server** stores everything in SQLite and pushes live updates to connected dashboards via WebSocket
5. The **dashboard** (Electron app) runs on the manager's machine and shows all locations and their machines
6. Every 6 hours, the **InsightEngine** calls Claude Haiku to analyze logs and detect anomalies

---

## Getting Started

### Prerequisites
- Node.js 18+
- Go 1.21+ (to build the agent)
- Azure VM or any Linux server with PM2 and Nginx
- Anthropic API key (optional, for AI insights)

### Server Setup

```bash
cd server
cp config.example.json config.json
# Edit config.json with your settings
npm install --production
npm start
# Or with PM2:
pm2 start ecosystem.config.js
```

### Dashboard Setup

```bash
cd dashboard
npm install
npm run dist        # Builds the Electron installer
# Run the installer from dist-electron/
```

> **Important:** Always use `npm run dist` to rebuild the Electron app. Running `npm run build` alone only updates the Vite bundle — the Electron packager embeds assets into an `.asar` file that requires a full rebuild.

### Agent Installation (on managed PCs)

Run as Administrator in PowerShell:
```powershell
irm https://your-server/install.ps1 | iex
```

This downloads and installs `delirio-agent.exe` as a Windows service.

### Building the Agent

```powershell
cd agent
.\build.ps1
# Output: delirio-agent.exe
# Copy to server/public/ for distribution
```

---

## Configuration

Copy `server/config.example.json` to `server/config.json` and edit:

```json
{
  "insights": {
    "enabled": true,
    "interval_hours": 6,
    "claude_api_key": "sk-ant-api03-...",
    "lookback_days": 7
  },
  "autoWake": {
    "enabled": false
  },
  "alerts": {
    "email": { "enabled": false },
    "teams": { "enabled": false }
  }
}
```

The AI insights key can also be configured through the dashboard UI: **⚙ Config → Insights de IA**.

---

## Deployment (Azure)

Use the provided script to deploy server updates without SSH:

```powershell
# Deploys all server files via Azure CLI run-command
.\infra\upload-servidor.ps1
```

This uses `az vm run-command invoke` to transfer files encoded in base64 and restart PM2.

### Production: Server Resilience

Two-layer protection keeps the server running in production.

**Layer 1 — PM2 + systemd (VM reboots and PM2 daemon crashes):**

```bash
pm2 start server.js --name dt-manager
pm2 save
pm2 startup systemd -u root --hp /root
# Then run the printed command to register the systemd unit
```

This makes systemd restart PM2 automatically whenever the VM boots or the PM2 daemon itself crashes.

**Layer 2 — Watchdog cron (process alive but server unresponsive):**

```bash
# Copy watchdog to VM
# (run from local machine via az vm run-command invoke)

# Install cron entry on the VM:
(crontab -l 2>/dev/null | grep -v watchdog; echo "*/5 * * * * /opt/dt-manager/watchdog.sh") | crontab -
chmod +x /opt/dt-manager/watchdog.sh
```

`infra/watchdog.sh` polls `GET /health` every 5 minutes and runs `pm2 restart dt-manager` if it doesn't receive HTTP 200. Log: `/var/log/dt-manager-watchdog.log`.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Server health check |
| GET | `/api/machines` | List all machines with latest metrics |
| POST | `/api/machines/:id/commands` | Send command (reboot, shutdown, wol, uninstall) |
| GET | `/api/insights` | Get AI-generated insights (all or per machine) |
| POST | `/api/insights/generate` | Trigger immediate AI analysis |
| GET | `/api/settings` | Get server settings (API key masked) |
| PUT | `/api/settings` | Update settings (autoWake, insights config) |
| GET | `/api/reports/bios/pdf` | Download BIOS configuration report PDF |

Full agent API (heartbeat, events, commands): see [`server/routes/agent.js`](server/routes/agent.js)

---

## Database Schema

SQLite database at `server/data/dt-manager.db`:

- **machines** — registered PCs with status, location, WoL state
- **metrics** — 24h rolling metrics history per machine
- **commands** — command queue (pending → sent → acked/failed)
- **events** — internal events (online, offline, agent_installed)
- **win_events** — Windows Event Log entries per machine (30-day retention)
- **alerts** — alert rules configuration
- **groups** — location groups with display order
- **insights** — AI-generated patterns with deduplication hash

---

## WebSocket Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `machine:update` | Server → Client | Live metrics update |
| `machine:offline` | Server → Client | Machine went offline |
| `groups:updated` | Server → Client | Group list changed |
| `new_insight` | Server → Client | New AI insights generated |
| `alert` | Server → Client | Alert triggered |
| `command:acked` | Server → Client | Command completed |

---

## Created By

**André Dias Moreira Prol** — Developer & IT Manager

Delirio Manager was designed and built by [André Dias Moreira Prol](https://github.com/andreprol), a software developer and IT manager specializing in Windows fleet management, AI-powered monitoring systems, and enterprise automation tools.

- GitHub: [github.com/andreprol](https://github.com/andreprol)
- Other projects: [Revivio](https://revivio.com.br) — AI-powered photo restoration platform

---

## License

MIT
