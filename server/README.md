# Delirio Manager — Server

Node.js + Express backend for the Delirio Manager fleet management system.

## Stack

- **Runtime**: Node.js
- **Framework**: Express
- **Database**: SQLite via `better-sqlite3`
- **Real-time**: WebSocket via `ws`
- **PDF generation**: `pdfkit`
- **AI**: `@anthropic-ai/sdk` (Claude Haiku)
- **Process manager**: PM2

## Project Structure

```
server/
├── server.js              # Express app entry point
├── db.js                  # SQLite schema, migrations, all query functions
├── config.json            # Runtime config (gitignored — copy from config.example.json)
├── config.example.json    # Config template
├── ecosystem.config.js    # PM2 configuration
├── routes/
│   ├── agent.js           # Agent registration, heartbeat, metrics ingestion
│   ├── machines.js        # Machine CRUD, command dispatch
│   ├── insights.js        # AI insights endpoints
│   ├── alerts.js          # Alert rules CRUD
│   ├── groups.js          # Location groups management
│   ├── winEvents.js       # Windows Event Log endpoints
│   ├── reports.js         # PDF report generation
│   ├── settings.js        # Server settings (autoWake, insights config)
│   └── update.js          # Agent update broadcast
├── services/
│   ├── insightEngine.js   # AI log analysis engine (Claude Haiku)
│   ├── alertEngine.js     # Alert monitoring and notification engine
│   ├── websocket.js       # WebSocket server and broadcast helper
│   └── wolBiosGuide.js    # WoL BIOS configuration guide generator
├── data/                  # SQLite database (gitignored)
├── public/                # Static files: agent binary, installer (gitignored)
└── logs/                  # PM2 logs (gitignored)
```

## Setup

```bash
npm install --production
cp config.example.json config.json
# Edit config.json
node server.js
```

## Configuration

See [`config.example.json`](config.example.json) for all options.

| Key | Default | Description |
|-----|---------|-------------|
| `insights.enabled` | `false` | Enable AI log analysis |
| `insights.claude_api_key` | `""` | Anthropic API key |
| `insights.interval_hours` | `6` | Analysis interval in hours |
| `insights.lookback_days` | `7` | Days of logs to analyze |
| `autoWake.enabled` | `false` | Auto wake-on-LAN for offline machines |

## API

### Agent Endpoints

```
POST   /api/register              Agent registration
POST   /api/heartbeat             Metrics + command poll (authenticated by token)
POST   /api/machines/:id/events   Windows Event Log batch upload
```

### Dashboard Endpoints

```
GET    /health                    Health check
GET    /api/machines              List machines with latest metrics
GET    /api/machines/:id          Single machine details
PUT    /api/machines/:id          Update display name, location, critical flag
POST   /api/machines/:id/commands Send command (reboot, shutdown, wol, uninstall)
GET    /api/machines/:id/metrics  Metrics history (up to 168h)
GET    /api/machines/:id/events   Internal events log
GET    /api/machines/:id/win-events   Windows Event Log
GET    /api/groups                List location groups
POST   /api/groups                Create group
PUT    /api/groups/:name          Rename group
DELETE /api/groups/:name          Delete group (moves machines to ungrouped)
GET    /api/insights              AI insights (optional ?machine_id=X)
PUT    /api/insights/:id/read     Mark insight as read
POST   /api/insights/generate     Trigger immediate AI analysis
GET    /api/settings              Server settings (API key masked)
PUT    /api/settings              Update settings
GET    /api/reports/bios/pdf      Download BIOS configuration PDF report
POST   /api/update/broadcast      Broadcast agent update to all machines
```

## AI Insight Engine

The `InsightEngine` (`services/insightEngine.js`) periodically analyzes machine logs using Claude Haiku:

1. Fetches Windows Event Log + offline events for each machine
2. Builds a text context (truncated to 8,000 characters)
3. Calls Claude Haiku with a structured prompt in Brazilian Portuguese
4. Parses the JSON response and saves insights with deduplication
5. Broadcasts `new_insight` via WebSocket to connected dashboards

**Deduplication**: Each insight is hashed as `SHA256(machine_id + pattern[:80])` — duplicate patterns for the same machine are silently ignored.

**Calling `restart()` after config changes**: The engine reads config at startup. After updating the API key via settings, `restart()` is automatically called to reload the config without restarting the whole server process.

## Deployment on Azure

The server runs on an Azure VM behind Nginx (HTTPS termination). Use the provided deploy script at `infra/upload-servidor.ps1` to push file updates via `az vm run-command` without requiring SSH access.

```powershell
# From the project root on Windows
.\infra\upload-servidor.ps1
```
