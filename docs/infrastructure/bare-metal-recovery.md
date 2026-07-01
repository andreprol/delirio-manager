# Bare Metal Recovery (BMR) — Delirio Manager

> Implemented: 2026-06-30 / 2026-07-01 | Agent v1.5.10 | Dashboard v1.0.40

## Overview

The BMR module extends Delirio Manager to orchestrate **Veeam Agent for Windows FREE** across the ~224-PC fleet, uploading backups directly to **Azure Blob Storage** (`dtmanagerdr`). The Go agent handles install, configuration, and status reporting. The server stores history and fires overdue alerts. The dashboard provides fleet-wide visibility and per-machine controls.

**Recovery scenario**: drive fails at a store → André brings machine home → new drive → boot Veeam Recovery Media USB → restore from Azure Blob → Windows comes up identical.

## Architecture

```
[Store PC — DelirioAgent.exe v1.5.10 + Veeam Agent FREE]
        ↑ heartbeat with dr_status (every 30s)
        ↓ commands: dr-setup / dr-backup-now / dr-status
[Azure VM — DM Server (Node.js + SQLite) — port 3847]
        ↑↓ HTTPS / WebSocket
[Electron Dashboard v1.0.40 — DR Module]

[Veeam Agent] → direct upload → [Azure Blob — dtmanagerdr/{hostname}/]
                                  (does NOT route through DM server)
```

Backups go **directly** from each PC to Azure Blob. The DM server only receives status via heartbeat — no egress cost on the VM.

## Azure Blob Storage

- **Account**: `dtmanagerdr`
- **Resource Group**: `rg-dt-manager`
- **Region**: brazilsouth | **Tier**: LRS Hot
- **Endpoint**: `https://dtmanagerdr.blob.core.windows.net`

### SAS Tokens (expiry: 2028-07-01)

| Token | Permissions | Location | Purpose |
|---|---|---|---|
| Write | rwdlac | `/opt/dt-manager/config.json` → `dr.sas_token` | Veeam uploads backups |
| Read | rl | Recovery USB pendrive | Restore: download backup |

> ⚠️ Tokens in `F:\Temp\dr-credentials.txt` — never commit.

## Files Changed

### Agent (Go)

| File | Purpose |
|---|---|
| `agent/dr.go` | Core DR logic: install, configure, backup, status, cache. Build tag: `windows` |
| `agent/dr_test.go` | Unit tests (TestReadStatusFromLogsEmpty, TestGetCachedDRStatus, TestDRCredsJSON) |
| `agent/commands.go` | +3 cases: `dr-setup`, `dr-backup-now`, `dr-status` |
| `agent/agent.go` | `DrStatus *DRStatus \`json:"dr_status,omitempty"\`` in HeartbeatPayload |
| `agent/main.go` | Version bumped to `1.5.10` |

### Server (Node.js)

| File | Purpose |
|---|---|
| `server/routes/dr.js` | 4 endpoints: POST /:id/setup, POST /:id/backup-now, GET /overview, GET /:id/history |
| `server/routes/agent.js` | DR block after heartbeat: update dr_* columns + insert dr_backups + broadcast `dr_update` |
| `server/db.js` | Table `dr_backups` + 4 ALTER TABLE migrations + 5 functions |
| `server/server.js` | `app.use('/api/dr', drRoutes)` + `/downloads` static path |
| `server/services/alertEngine.js` | `checkDRBackups()` + `sendDROverdueEmail()` + 6h cooldown map |

### Dashboard (React/Electron)

| File | Purpose |
|---|---|
| `dashboard/src/api.js` | `api.dr.{ setup, backupNow, overview, history }` |
| `dashboard/src/components/DRModule.jsx` | Full-screen overview: 4 cards + filter buttons + machines table |
| `dashboard/src/components/MachineCard.jsx` | DR badge + tab + Configurar DR / Forçar Backup buttons |
| `dashboard/src/App.jsx` | `🔒 DR` pill in topbar + `showDR` state + `<DRModule>` overlay |

## Database Schema

### New table: `dr_backups`

```sql
CREATE TABLE dr_backups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id   INTEGER NOT NULL REFERENCES machines(id),
  backed_at    DATETIME NOT NULL,
  status       TEXT NOT NULL,  -- ok | failed | running
  storage_gb   REAL,
  duration_min INTEGER,
  error_msg    TEXT
);
CREATE INDEX idx_dr_backups_machine ON dr_backups(machine_id, backed_at DESC);
```

Server-side retention: 90 days. Azure Blob retention: 7 restore points (configured by Veeam job).

### New columns on `machines`

```sql
ALTER TABLE machines ADD COLUMN dr_setup      TEXT DEFAULT 'not_installed';
ALTER TABLE machines ADD COLUMN dr_last_ok    DATETIME;
ALTER TABLE machines ADD COLUMN dr_storage_gb REAL;
ALTER TABLE machines ADD COLUMN dr_version    TEXT;
```

## Agent Commands

### `dr-setup` (params: `{ azure_account, sas_token, schedule_hour }`)

1. Downloads `VeeamAgentWindows.exe` from DM server (`/downloads/VeeamAgentWindows.exe`, 177 MB)
2. Installs silently: `/silent /norestart`
3. Waits for `VeeamEndpointBackupSvc` to start
4. Creates Azure Blob repository `AzureBlob-DM` → `dtmanagerdr/{hostname}/`
5. Creates backup job `BMR-DM` (full system, daily at `schedule_hour`, 7 restore point retention)
6. Returns: `{ veeam_version, setup_ok, error? }`

### `dr-backup-now`

Invokes `VeeamAgent.exe /backup` and returns immediately. Job runs async in Veeam.

### `dr-status`

Returns full `DRStatus` struct by reading Veeam logs from `C:\ProgramData\Veeam\Endpoint\Log\`.

### Heartbeat field `dr_status`

```json
{
  "dr_status": {
    "setup": "configured",
    "last_backup_at": "2026-07-01T23:01:44Z",
    "last_backup_ok": true,
    "is_running": false,
    "storage_gb": 147.3,
    "duration_min": 12,
    "veeam_version": "13.0.3.1220"
  }
}
```

`setup` values: `not_installed` | `installed` | `configured` | `error`

Machines without Veeam omit `dr_status` entirely — server treats absence as `not_installed`. No existing heartbeats break.

## API Routes

All routes registered under `app.use('/api/dr', drRoutes)` in `server.js`.

| Route | Description |
|---|---|
| `POST /api/dr/:id/setup` | Queue `dr-setup`. Azure credentials come from server `config.json` — never exposed to client. Returns 503 if no DR config, 404 if machine not found. |
| `POST /api/dr/:id/backup-now` | Queue `dr-backup-now`. Returns 400 if `dr_setup !== 'configured'`. |
| `GET /api/dr/overview` | Fleet summary: `{ total, okLast24h, totalGb, failing }`. **Must be registered before `/:id/history`** to avoid Express matching "overview" as `:id`. |
| `GET /api/dr/:id/history?days=28` | Backup history for machine. `days` clamped to [1, 90]. |

## server/config.json — DR section

```json
"dr": {
  "azure_account_name": "dtmanagerdr",
  "sas_token": "se=2028-07-01&sp=rwdlac&...",
  "schedule_hour": 23,
  "alert_after_hours": 24,
  "alert_cooldown_hours": 6
}
```

## Alerts

`alertEngine.checkDRBackups()` runs on every `checkAll()` cycle:
- Finds machines where `dr_setup = configured` AND `dr_last_ok < NOW - alert_after_hours`
- Per-machine cooldown: `DR_COOLDOWN_MS = 6h` (in-memory Map, resets on server restart)
- Sends email via nodemailer (same config as existing alerts)

## Veeam Installer on Server

```
/opt/dt-manager/public/downloads/VeeamAgentWindows.exe
→ VeeamAgentWindows_13.0.3.1220.exe — 177 MB
→ Deployed: 2026-07-01
→ Source: veeam.com → Standalone Veeam Agent for Microsoft Windows FREE
```

## Deployment Process

The VM is not a git repo. Files are deployed via **Azure Blob relay**:

```bash
# 1. Upload file to blob (from local)
az storage blob upload --account-name dtmanagerdr --account-key KEY \
  --container-name deploy --file local/file.js --name deploy/file.js --overwrite

# 2. Generate read SAS URL (1-day expiry)
az storage blob generate-sas --account-name dtmanagerdr --account-key KEY \
  --container-name deploy --name deploy/file.js \
  --permissions r --expiry 2026-XX-XX --https-only --full-uri

# 3. Download on VM
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'wget -q -O /opt/dt-manager/routes/file.js "SAS_URL"'

# 4. Restart server (use fork mode — cluster mode has known issues on this VM)
# pm2 restart dt-manager  (if stable process exists)
# kill ORPHAN_PID && pm2 restart dt-manager  (if old orphan process is serving)
```

### Known VM Deploy Issue

This VM has a **long-running orphan Node.js process** (user `delirioadmin`) that started ~Jun 26 and remains even after `pm2 delete`. This orphan handles requests with old code. Always check with `ps aux | grep node` and kill the orphan before testing new routes:

```bash
ps aux | grep node
# Find old process (user: delirioadmin, high uptime)
kill {PID}
pm2 restart dt-manager
```

## Recovery USB Pendrive

Created once, serves all protected machines.

### Creation steps (after first machine is configured)

1. On any machine with Veeam Agent installed:
   ```
   VeeamAgent.exe /create-recovery-media /path:D:\
   ```
2. Write ISO to USB ≥ 2 GB with Rufus
3. Add `azure-credentials.txt` to USB root:
   ```
   Account: dtmanagerdr
   SAS Token (read-only): [rl token from F:\Temp\dr-credentials.txt]
   ```
4. Store USB in a secure location

## Known Issues / Pitfalls

| Issue | Root cause | Fix |
|---|---|---|
| `/api/dr/overview` returns 404 after deploy | Orphan node process (old code) serving requests | `kill PID + pm2 restart` |
| PM2 cluster crash-loop (EADDRINUSE) | Multiple cluster workers competing for socket | Run in fork mode (no `-i N` flag) |
| `dr-setup` takes 10–15 min | 177 MB Veeam download over store's internet | Expected; wait for heartbeat update |
| `updateMachineDRStatus` must use single UPDATE | Multiple separate UPDATEs risk partial writes | Already fixed: single dynamic SET clause |
| `insertDRBackup` null coercion | `0 || null` = null, losing real 0 values | Fixed: use `!= null` guards |
| Route order: /overview before /:id | Express would match "overview" as :id | Fixed: /overview registered first |

## Out of Scope (not implemented)

- Per-machine backup schedule (fixed at 23h for all machines)
- Remote restore orchestrated by DM (always manual with USB)
- Zamak integration (Zamak-covered machines stay on Zamak)
- Teams notifications (email + in-app only, matching existing DM pattern)
- CSV export from DR module
