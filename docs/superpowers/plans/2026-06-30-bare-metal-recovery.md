# Bare Metal Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in bare metal recovery to Delirio Manager — Veeam Agent for Windows FREE uploads disk images directly to Azure Blob Storage (`dtmanagerdr`), orchestrated by the existing Go agent infrastructure, with visibility in the Dashboard.

**Architecture:** The DM server queues `dr-setup`, `dr-backup-now`, and `dr-status` commands to individual agents via the existing command pipeline. Each agent downloads and configures Veeam locally; Veeam uploads directly to Azure Blob (bypassing the VM). The server tracks DR state via the heartbeat's new `dr_status` field and exposes a new Dashboard module.

**Tech Stack:** Go 1.26.4 (agent), Node.js 22 + Express + better-sqlite3 (server), React 19 + Vite (dashboard), Veeam Agent for Windows FREE v6.x, Azure Blob Storage (`dtmanagerdr`, brazilsouth, LRS Hot, SAS tokens in `F:\Temp\dr-credentials.txt`).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `agent/dr.go` | CREATE | Veeam install / configure / backup / status logic |
| `agent/dr_test.go` | CREATE | Unit tests for log parsing and status functions |
| `agent/commands.go` | MODIFY | Add 3 DR cases to `executeCommand()` switch |
| `agent/agent.go` | MODIFY | Add `DRStatus` struct + `DrStatus *DRStatus` to `HeartbeatPayload` |
| `server/db.js` | MODIFY | `dr_backups` table + 4 `dr_*` columns + 5 new DB functions |
| `server/routes/dr.js` | CREATE | 4 DR endpoints |
| `server/server.js` | MODIFY | Require + mount DR routes |
| `server/routes/agent.js` | MODIFY | Process `dr_status` from heartbeat |
| `server/services/alertEngine.js` | MODIFY | Add `checkDRBackups()` + overdue email |
| `dashboard/src/api.js` | MODIFY | Add `dr` namespace |
| `dashboard/src/components/DRModule.jsx` | CREATE | Full-screen DR overview |
| `dashboard/src/components/MachineCard.jsx` | MODIFY | DR tab + badge |
| `dashboard/src/App.jsx` | MODIFY | `showDR` state + pill + `<DRModule>` |

---

### Task 1: DB Schema + Functions

**Files:**
- Modify: `server/db.js:188` (end of db.exec block)
- Modify: `server/db.js:193` (migrations array)
- Modify: `server/db.js:749` (before module.exports)

- [ ] **Step 1: Add `dr_backups` table to the `db.exec(\`...\`)` block**

In `server/db.js`, inside the `db.exec(\`...\`)` at line 26, paste the following immediately before the closing backtick (after the `idx_nfce_dh_emi` index at line 189):

```sql
    CREATE TABLE IF NOT EXISTS dr_backups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      backed_at    TEXT NOT NULL,
      status       TEXT NOT NULL,
      storage_gb   REAL,
      duration_min INTEGER,
      error_msg    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dr_backups_machine
      ON dr_backups(machine_id, backed_at DESC);
```

- [ ] **Step 2: Add 4 DR columns to the incremental migrations array**

In `server/db.js`, inside the `const migrations = [...]` array (line 193), add at the end:

```javascript
    `ALTER TABLE machines ADD COLUMN dr_setup TEXT DEFAULT 'not_installed'`,
    `ALTER TABLE machines ADD COLUMN dr_last_ok TEXT`,
    `ALTER TABLE machines ADD COLUMN dr_storage_gb REAL`,
    `ALTER TABLE machines ADD COLUMN dr_version TEXT`,
```

- [ ] **Step 3: Add DR DB functions**

In `server/db.js`, immediately before the `module.exports = {` line, add:

```javascript
// ── DR Backups ────────────────────────────────────────────────────────────────

function updateMachineDRStatus(machineId, { setup, lastOk, storageGb, version } = {}) {
  const d = getDb();
  if (setup     !== undefined) d.prepare('UPDATE machines SET dr_setup=? WHERE id=?').run(setup, machineId);
  if (lastOk    !== undefined) d.prepare('UPDATE machines SET dr_last_ok=? WHERE id=?').run(lastOk, machineId);
  if (storageGb !== undefined) d.prepare('UPDATE machines SET dr_storage_gb=? WHERE id=?').run(storageGb, machineId);
  if (version   !== undefined) d.prepare('UPDATE machines SET dr_version=? WHERE id=?').run(version, machineId);
}

function insertDRBackup(machineId, { backedAt, status, storageGb, durationMin, errorMsg } = {}) {
  getDb().prepare(`
    INSERT INTO dr_backups (machine_id, backed_at, status, storage_gb, duration_min, error_msg)
    VALUES (?,?,?,?,?,?)
  `).run(machineId, backedAt, status, storageGb || null, durationMin || null, errorMsg || null);
}

function getDRHistory(machineId, days = 28) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return getDb().prepare(`
    SELECT * FROM dr_backups WHERE machine_id=? AND backed_at>=?
    ORDER BY backed_at DESC
  `).all(machineId, cutoff);
}

function getDROverview() {
  const d = getDb();
  const threshold24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return {
    total:     d.prepare(`SELECT COUNT(*) as c FROM machines WHERE dr_setup='configured'`).get().c,
    okLast24h: d.prepare(`SELECT COUNT(*) as c FROM machines WHERE dr_setup='configured' AND dr_last_ok>=?`).get(threshold24h).c,
    totalGb:   d.prepare(`SELECT COALESCE(SUM(dr_storage_gb),0) as s FROM machines WHERE dr_setup='configured'`).get().s,
    failing:   d.prepare(`SELECT COUNT(*) as c FROM machines WHERE dr_setup='error'`).get().c,
  };
}

function getMachinesDRDue(olderThanISO) {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE dr_setup = 'configured'
      AND (dr_last_ok IS NULL OR dr_last_ok < ?)
  `).all(olderThanISO);
}
```

- [ ] **Step 4: Export the new functions**

In `server/db.js`, inside `module.exports`, add after `registerRef1, getMaxRef1,`:

```javascript
  // dr backups
  updateMachineDRStatus, insertDRBackup, getDRHistory, getDROverview, getMachinesDRDue,
```

- [ ] **Step 5: Smoke-test migrations locally**

```bash
# From F:\RichClub\server:
node -e "
const db = require('./db');
const d = db.getDb();
const tbl = d.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='dr_backups'\").get();
console.log('dr_backups table:', tbl);
const col = d.prepare(\"PRAGMA table_info(machines)\").all().find(c => c.name === 'dr_setup');
console.log('dr_setup column:', col);
"
```

Expected:
```
dr_backups table: { name: 'dr_backups' }
dr_setup column: { cid: ..., name: 'dr_setup', type: 'TEXT', notnull: 0, dflt_value: "'not_installed'", pk: 0 }
```

- [ ] **Step 6: Commit**

```bash
git add server/db.js
git commit -m "feat(dr): add dr_backups table, dr_* columns to machines, DR DB functions"
```

---

### Task 2: Server — DR Routes

**Files:**
- Create: `server/routes/dr.js`
- Modify: `server/server.js:22` (require)
- Modify: `server/server.js:74` (app.use)

- [ ] **Step 1: Create `server/routes/dr.js`**

```javascript
'use strict';

const express      = require('express');
const router       = express.Router();
const path         = require('path');
const fs           = require('fs');
const db           = require('../db');
const { broadcast } = require('../services/websocket');

function loadDRConfig() {
  try {
    const cfgPath = path.join(__dirname, '..', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return cfg.dr || null;
  } catch {
    return null;
  }
}

// POST /api/dr/:id/setup
router.post('/:id/setup', (req, res) => {
  const drCfg = loadDRConfig();
  if (!drCfg || !drCfg.azure_account_name || !drCfg.sas_token) {
    return res.status(503).json({ error: 'DR não configurado no servidor. Adicione o bloco "dr" ao config.json.' });
  }
  const machine = db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada' });

  db.createCommand(machine.id, 'dr-setup', {
    azure_account: drCfg.azure_account_name,
    sas_token:     drCfg.sas_token,
    schedule_hour: drCfg.schedule_hour || 23,
  });
  db.updateMachineDRStatus(machine.id, { setup: 'pending' });
  broadcast('dr_update', { machineId: machine.id, drSetup: 'pending' });
  return res.json({ ok: true, queued: 'dr-setup' });
});

// POST /api/dr/:id/backup-now
router.post('/:id/backup-now', (req, res) => {
  const machine = db.getMachineById(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada' });
  if (machine.dr_setup !== 'configured') {
    return res.status(400).json({ error: 'DR não configurado nesta máquina' });
  }
  db.createCommand(machine.id, 'dr-backup-now', {});
  return res.json({ ok: true, queued: 'dr-backup-now' });
});

// GET /api/dr/overview
router.get('/overview', (req, res) => {
  try {
    return res.json(db.getDROverview());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/dr/:id/history
router.get('/:id/history', (req, res) => {
  const days = parseInt(req.query.days) || 28;
  try {
    return res.json(db.getDRHistory(req.params.id, Math.min(days, 90)));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount in `server/server.js`**

After line 22 (the `alohaRoutes` require), add:

```javascript
const drRoutes       = require('./routes/dr');
```

After line 74 (`app.use('/api/aloha', alohaRoutes);`), add:

```javascript
app.use('/api/dr',       drRoutes);
```

- [ ] **Step 3: Verify `/downloads/` serves static files for Veeam installer**

Check `server/server.js` for how `lhm.zip` is served (agent downloads from `/downloads/lhm.zip`). If no generic `/downloads/` static path exists, add it after the existing `dashboard-updates` static line:

```javascript
const DOWNLOADS_DIR = path.join(PUBLIC_DIR, 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
app.use('/downloads', express.static(DOWNLOADS_DIR));
```

- [ ] **Step 4: Commit**

```bash
git add server/routes/dr.js server/server.js
git commit -m "feat(dr): add DR routes (setup, backup-now, overview, history) + mount"
```

---

### Task 3: Heartbeat — DR Status Processing

**Files:**
- Modify: `server/routes/agent.js:95` (after the `broadcast('machine:update')` call)

- [ ] **Step 1: Add DR heartbeat processing**

In `server/routes/agent.js`, in the `POST /api/heartbeat` handler, immediately after the `broadcast('machine:update', { ... });` block (around line 98), add:

```javascript
    // DR status — update machines table and insert backup records
    const drStatus = req.body.dr_status;
    if (drStatus) {
      const setup = drStatus.setup || 'not_installed';
      const drUpdate = { setup };
      if (drStatus.veeam_version) drUpdate.version = drStatus.veeam_version;
      if (drStatus.storage_gb != null) drUpdate.storageGb = drStatus.storage_gb;

      if (drStatus.last_backup_at && drStatus.last_backup_at !== machine.dr_last_ok) {
        if (drStatus.last_backup_ok) {
          drUpdate.lastOk = drStatus.last_backup_at;
          db.insertDRBackup(machine.id, {
            backedAt:    drStatus.last_backup_at,
            status:      'ok',
            storageGb:   drStatus.storage_gb,
            durationMin: drStatus.duration_min,
          });
        } else {
          db.insertDRBackup(machine.id, {
            backedAt: drStatus.last_backup_at,
            status:   'failed',
            errorMsg: drStatus.error_msg,
          });
        }
      }

      db.updateMachineDRStatus(machine.id, drUpdate);
      broadcast('dr_update', { machineId: machine.id, drStatus });
    }
```

- [ ] **Step 2: Commit**

```bash
git add server/routes/agent.js
git commit -m "feat(dr): process dr_status from agent heartbeat"
```

---

### Task 4: Alert Engine — DR Overdue Checks

**Files:**
- Modify: `server/services/alertEngine.js`

- [ ] **Step 1: Add DR cooldown map** — After the `offlineAlertCooldown` declaration (line 13), add:

```javascript
const drAlertCooldown   = new Map();
const DR_COOLDOWN_MS    = 6 * 60 * 60 * 1000; // 6h between overdue alerts per machine
```

- [ ] **Step 2: Add `checkDRBackups()` and `sendDROverdueEmail()`** — Immediately before the `function fireAlert(...)` definition, add:

```javascript
function checkDRBackups() {
  const cfg = loadConfig();
  const alertAfterHours = cfg.dr?.alert_after_hours || 24;
  const threshold = new Date(Date.now() - alertAfterHours * 60 * 60 * 1000).toISOString();
  const due = db.getMachinesDRDue(threshold);

  for (const machine of due) {
    const now       = Date.now();
    const lastAlert = drAlertCooldown.get(machine.id) || 0;
    if ((now - lastAlert) < DR_COOLDOWN_MS) continue;

    drAlertCooldown.set(machine.id, now);
    const displayName = machine.display_name || machine.hostname;
    const location    = machine.location || 'Sem localidade';
    const hoursAgo    = machine.dr_last_ok
      ? Math.round((now - new Date(machine.dr_last_ok).getTime()) / 3600000)
      : null;
    const msg = hoursAgo
      ? `${displayName}: backup DR atrasado (último há ${hoursAgo}h)`
      : `${displayName}: backup DR nunca realizado`;

    fireAlert(machine.id, 'dr_overdue', msg);
    sendDROverdueEmail(displayName, location, hoursAgo, machine.dr_last_ok);
    console.log(`[AlertEngine] DR overdue: ${machine.id}`);
  }
}

async function sendDROverdueEmail(displayName, location, hoursAgo, lastOkISO) {
  const cfg = loadConfig().alerts?.email;
  if (!cfg?.enabled || !cfg.to?.length) return;

  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host, port: cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  const when = lastOkISO
    ? `há ${hoursAgo}h (${new Date(lastOkISO).toLocaleString('pt-BR')})`
    : 'nunca';

  try {
    await transporter.sendMail({
      from:    `"Delirio Manager" <${cfg.user}>`,
      to:      cfg.to.join(', '),
      subject: `⚠️ Backup DR Atrasado: ${displayName}`,
      html: `
        <h2 style="color:#f59e0b">⚠️ Backup DR Atrasado</h2>
        <p><strong>Máquina:</strong> ${displayName}</p>
        <p><strong>Localidade:</strong> ${location}</p>
        <p><strong>Último backup OK:</strong> ${when}</p>
        <p>Verifique o status do Veeam Agent nesta máquina no Dashboard.</p>
        <hr><p style="color:#888;font-size:12px">Delirio Manager — Bare Metal Recovery</p>
      `,
    });
    console.log(`[AlertEngine] Email DR overdue enviado: ${displayName}`);
  } catch (err) {
    console.error('[AlertEngine] Falha email DR overdue:', err.message);
  }
}
```

- [ ] **Step 3: Call `checkDRBackups()` in `checkAll()`** — In the `checkAll()` function body, add:

```javascript
  checkDRBackups();
```

- [ ] **Step 4: Commit**

```bash
git add server/services/alertEngine.js
git commit -m "feat(dr): add DR overdue alert check (6h cooldown)"
```

---

### Task 5: VM Config Update

Add the `"dr"` block to `/opt/dt-manager/server/config.json` on the Azure VM so the DR routes can read the SAS credentials.

- [ ] **Step 1: Read current config from VM**

```powershell
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts "cat /opt/dt-manager/server/config.json"
```

Copy the output — you need it to verify the current structure before patching.

- [ ] **Step 2: Patch config.json on the VM**

```powershell
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts @'
node -e "
const fs = require('fs');
const p = '/opt/dt-manager/server/config.json';
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
if (cfg.dr) { console.log('dr block already present'); process.exit(0); }
cfg.dr = {
  azure_account_name: 'dtmanagerdr',
  sas_token: 'se=2028-07-01&sp=rwdlac&spr=https&sv=2026-04-06&ss=b&srt=sco&sig=RFPnwStRGbkamwWOaG1%2BSKPUFGwws6nRcWdSKv9okmU%3D',
  schedule_hour: 23,
  alert_after_hours: 24,
  alert_cooldown_hours: 6
};
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
console.log('DR config saved OK');
"
'@
```

- [ ] **Step 3: Verify**

```powershell
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts "node -e \"const c=require('/opt/dt-manager/server/config.json'); console.log(JSON.stringify(c.dr,null,2))\""
```

Expected output: JSON object with `azure_account_name`, `sas_token`, `schedule_hour`.

- [ ] **Step 4: Restart server on VM**

```powershell
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts "cd /opt/dt-manager && pm2 restart server && pm2 status"
```

---

### Task 6: Host Veeam Installer on Server

The agent downloads `VeeamAgentWindows.exe` from the DM server at `/downloads/VeeamAgentWindows.exe`. This is the same pattern as `lhm.zip` (served from `server/public/downloads/`).

- [ ] **Step 1: Download Veeam Agent for Windows FREE**

Go to `veeam.com/windows-endpoint-server-backup-free.html`, download the free installer. Save as `VeeamAgentWindows.exe` to `F:\Temp\`. This file is ~200 MB.

- [ ] **Step 2: Upload to VM via SCP**

```bash
scp "F:\Temp\VeeamAgentWindows.exe" delirioadmin@20.226.33.21:/opt/dt-manager/server/public/downloads/VeeamAgentWindows.exe
```

If SCP is not available, use the Azure Portal → vm-dt-manager → Run command to wget it directly from a direct download URL if Veeam provides one, or use a temporary Azure Storage upload.

- [ ] **Step 3: Verify accessibility**

```powershell
$r = Invoke-WebRequest -Method Head -Uri 'https://dt-manager.brazilsouth.cloudapp.azure.com/downloads/VeeamAgentWindows.exe'
Write-Output "Status: $($r.StatusCode) | Size: $($r.Headers.'Content-Length') bytes"
```

Expected: `Status: 200 | Size: ~200000000 bytes`

---

### Task 7: Agent — `agent/dr.go`

**Files:**
- Create: `agent/dr.go`
- Create: `agent/dr_test.go`

> **⚠️ Veeam PowerShell Note:** The exact cmdlet names in `configureJob()` depend on the Veeam Agent for Windows version installed. After `installVeeam()` succeeds on a test machine, run: `Import-Module 'C:\Program Files\Veeam\Endpoint Backup\Veeam.Endpoint.Backup.PowerShell.dll'; Get-Command -Module *Veeam* | Select-Object Name` to get the actual cmdlet list and adjust the script in `configureJob()` if needed.

- [ ] **Step 1: Create `agent/dr.go`**

```go
//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	veeamInstallerName = "VeeamAgentWindows.exe"
	veeamSvcName       = "VeeamEndpointBackupSvc"
	veeamPSModulePath  = `C:\Program Files\Veeam\Endpoint Backup\Veeam.Endpoint.Backup.PowerShell.dll`
	veeamLogDir        = `C:\ProgramData\Veeam\Endpoint\Log`
	drJobName          = "BMR-DM"
	drRepoName         = "AzureBlob-DM"
)

// DrCreds holds Azure Blob credentials received in the dr-setup command params.
type DrCreds struct {
	AzureAccount string `json:"azure_account"`
	SASToken     string `json:"sas_token"`
	ScheduleHour int    `json:"schedule_hour"`
}

// DRStatus is the dr_status field sent inside every heartbeat.
type DRStatus struct {
	Setup        string  `json:"setup"`
	LastBackupAt string  `json:"last_backup_at,omitempty"`
	LastBackupOk bool    `json:"last_backup_ok"`
	IsRunning    bool    `json:"is_running"`
	StorageGB    float64 `json:"storage_gb,omitempty"`
	DurationMin  int     `json:"duration_min,omitempty"`
	ErrorMsg     string  `json:"error_msg,omitempty"`
	VeeamVersion string  `json:"veeam_version,omitempty"`
}

var drStatusCache *DRStatus

func runPS(script string) (string, error) {
	var out, errOut bytes.Buffer
	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%w — stderr: %s", err, strings.TrimSpace(errOut.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

func isVeeamInstalled() bool {
	out, err := runPS(fmt.Sprintf(
		`(Get-Service -Name "%s" -ErrorAction SilentlyContinue) -ne $null`, veeamSvcName,
	))
	return err == nil && out == "True"
}

func getVeeamVersion() string {
	out, err := runPS(`(Get-ItemProperty "HKLM:\SOFTWARE\Veeam\Veeam Endpoint Backup" -ErrorAction SilentlyContinue).ProductVersion`)
	if err != nil {
		return ""
	}
	return out
}

// installVeeam downloads VeeamAgentWindows.exe from the DM server and installs it silently.
func installVeeam(serverURL string) error {
	if isVeeamInstalled() {
		logInfo("DR: Veeam já instalado, pulando download.")
		return nil
	}

	logInfo("DR: baixando instalador Veeam do servidor...")
	resp, err := http.Get(serverURL + "/downloads/" + veeamInstallerName)
	if err != nil {
		return fmt.Errorf("download VeeamAgentWindows.exe: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download VeeamAgentWindows.exe: HTTP %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("ler instalador Veeam: %w", err)
	}

	tmpPath := filepath.Join(os.TempDir(), veeamInstallerName)
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("salvar instalador Veeam: %w", err)
	}
	defer os.Remove(tmpPath)

	logInfo("DR: instalando Veeam Agent (modo silencioso)...")
	cmd := exec.Command(tmpPath, "/silent", "/norestart")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("instalação Veeam falhou: %w — output: %s", err, string(out))
	}

	// Aguarda serviço subir (até 3 minutos)
	for i := 0; i < 36; i++ {
		time.Sleep(5 * time.Second)
		if isVeeamInstalled() {
			logInfo(fmt.Sprintf("DR: Veeam instalado com sucesso. Versão: %s", getVeeamVersion()))
			return nil
		}
	}
	return fmt.Errorf("serviço Veeam não subiu em 3 minutos após instalação")
}

// configureJob creates an Azure Blob repo and backup job in Veeam via PowerShell.
// NOTE: cmdlet names (Add-VBRComputerBackupJob, etc.) must be verified against
// the installed Veeam version. Run `Get-Command -Module *Veeam* | Select Name`
// on a test machine after installation to confirm the exact names.
func configureJob(creds DrCreds) error {
	hostname, _ := os.Hostname()
	container := strings.ToLower(hostname)
	endpoint := fmt.Sprintf("https://%s.blob.core.windows.net", creds.AzureAccount)
	scheduleHour := creds.ScheduleHour
	if scheduleHour < 0 || scheduleHour > 23 {
		scheduleHour = 23
	}

	script := fmt.Sprintf(`
$ErrorActionPreference = 'Stop'

$modulePath = '%s'
if (-not (Test-Path $modulePath)) {
    throw "Módulo Veeam PS não encontrado em: $modulePath"
}
Import-Module $modulePath -Force

# Remove repo e job anteriores (idempotente)
try { Get-VBRBackupRepository -Name '%s' -ErrorAction SilentlyContinue | Remove-VBRBackupRepository -Confirm:$false } catch {}
try { Get-VBRJob -Name '%s' -ErrorAction SilentlyContinue | Remove-VBRJob -Confirm:$false } catch {}

# Cria credencial Azure Blob via SAS
$connStr = "BlobEndpoint=%s;SharedAccessSignature=%s"
$azAccount = New-VBRAzureStorageAccount -ConnectionString $connStr -Name '%s'

# Cria repositório no container nomeado pelo hostname
$repo = Add-VBRAzureObjectStorageRepository `
    -Name '%s' `
    -AzureStorageAccount $azAccount `
    -Container '%s'

# Cria job de backup bare metal
$job = Add-VBRComputerBackupJob `
    -Name '%s' `
    -BackupType EntireComputer `
    -StorageType ObjectStorage `
    -Repository $repo `
    -RestorePointsToKeep 7

# Agenda para às 23h (ou horário configurado)
$schedOpts = New-VBRJobScheduleOptions
$schedOpts.Type = 'Daily'
$schedOpts.DailyOptions.TimeLocal = [datetime]::Today.AddHours(%d)
$schedOpts.DailyOptions.Type = 'Everyday'
Set-VBRJobScheduleOptions -Job $job -Options $schedOpts
Enable-VBRJobSchedule -Job $job

Write-Output "configured"
`,
		veeamPSModulePath,
		drRepoName, drJobName,
		endpoint, creds.SASToken, creds.AzureAccount,
		drRepoName,
		container,
		drJobName,
		scheduleHour,
	)

	out, err := runPS(script)
	if err != nil {
		return fmt.Errorf("configureJob PS falhou: %w", err)
	}
	if !strings.Contains(out, "configured") {
		return fmt.Errorf("configureJob saída inesperada: %s", out)
	}
	logInfo(fmt.Sprintf("DR: job '%s' configurado → azure://%s/%s", drJobName, creds.AzureAccount, container))
	return nil
}

// triggerBackupNow starts the DR backup job immediately (Veeam runs async).
func triggerBackupNow() error {
	script := fmt.Sprintf(`
$ErrorActionPreference = 'Stop'
Import-Module '%s' -Force
$job = Get-VBRJob -Name '%s' -ErrorAction SilentlyContinue
if (-not $job) { throw "Job '%s' não encontrado" }
Start-VBRJob -Job $job -RunAsync
Write-Output "started"
`, veeamPSModulePath, drJobName, drJobName)

	out, err := runPS(script)
	if err != nil {
		return fmt.Errorf("triggerBackupNow falhou: %w", err)
	}
	if !strings.Contains(out, "started") {
		return fmt.Errorf("triggerBackupNow saída inesperada: %s", out)
	}
	return nil
}

// readStatus builds a DRStatus by querying Veeam via PowerShell (or log files as fallback).
func readStatus() DRStatus {
	s := DRStatus{
		Setup:        "not_installed",
		VeeamVersion: getVeeamVersion(),
	}
	if !isVeeamInstalled() {
		return s
	}
	s.Setup = "installed"

	// Try PowerShell session query first
	script := fmt.Sprintf(`
Import-Module '%s' -Force -ErrorAction SilentlyContinue
$sess = Get-VBRSession -ErrorAction SilentlyContinue |
    Where-Object { $_.JobName -eq '%s' } |
    Sort-Object CreationTime -Descending |
    Select-Object -First 1
if ($sess) {
    @{
        Result       = [string]$sess.Result
        CreationTime = $sess.CreationTime.ToUniversalTime().ToString('o')
        EndTime      = if ($sess.EndTime) { $sess.EndTime.ToUniversalTime().ToString('o') } else { '' }
        IsRunning    = ($sess.State -eq 'Working')
    } | ConvertTo-Json -Compress
}
`, veeamPSModulePath, drJobName)

	if out, err := runPS(script); err == nil && len(out) > 0 && out != "" {
		var sess struct {
			Result       string `json:"Result"`
			CreationTime string `json:"CreationTime"`
			EndTime      string `json:"EndTime"`
			IsRunning    bool   `json:"IsRunning"`
		}
		if json.Unmarshal([]byte(out), &sess) == nil {
			s.Setup = "configured"
			s.IsRunning = sess.IsRunning
			s.LastBackupAt = sess.CreationTime
			s.LastBackupOk = sess.Result == "Success"
			if !s.LastBackupOk && sess.Result != "" {
				s.ErrorMsg = "Veeam result: " + sess.Result
			}
			if !sess.IsRunning && sess.EndTime != "" {
				t1, e1 := time.Parse(time.RFC3339, sess.CreationTime)
				t2, e2 := time.Parse(time.RFC3339, sess.EndTime)
				if e1 == nil && e2 == nil {
					s.DurationMin = int(t2.Sub(t1).Minutes())
				}
			}
			return s
		}
	}

	// Fallback: parse log files
	return readStatusFromLogs(s)
}

var (
	rexOK   = regexp.MustCompile(`(?i)backup.*success|job.*finished.*success`)
	rexFail = regexp.MustCompile(`(?i)backup.*fail|job.*fail`)
	rexGB   = regexp.MustCompile(`(?i)transferred[^0-9]*([\d.]+)\s*gb`)
)

func readStatusFromLogs(base DRStatus) DRStatus {
	entries, err := os.ReadDir(veeamLogDir)
	if err != nil {
		return base
	}
	sort.Slice(entries, func(i, j int) bool {
		ii, _ := entries[i].Info()
		jj, _ := entries[j].Info()
		return ii.ModTime().After(jj.ModTime())
	})
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".log") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(veeamLogDir, e.Name()))
		if err != nil {
			continue
		}
		content := string(data)
		info, _ := e.Info()
		if rexOK.MatchString(content) {
			base.Setup = "configured"
			base.LastBackupAt = info.ModTime().UTC().Format(time.RFC3339)
			base.LastBackupOk = true
			if m := rexGB.FindStringSubmatch(strings.ToLower(content)); len(m) > 1 {
				if gb, err := strconv.ParseFloat(m[1], 64); err == nil {
					base.StorageGB = gb
				}
			}
			return base
		}
		if rexFail.MatchString(content) {
			base.Setup = "error"
			base.LastBackupOk = false
			base.ErrorMsg = "Veeam backup falhou (ver logs em C:\\ProgramData\\Veeam\\Endpoint\\Log)"
			return base
		}
	}
	return base
}

func getCachedDRStatus() *DRStatus {
	if drStatusCache == nil {
		s := readStatus()
		drStatusCache = &s
	}
	return drStatusCache
}

func invalidateDRCache() {
	drStatusCache = nil
}
```

- [ ] **Step 2: Create `agent/dr_test.go`**

```go
//go:build windows

package main

import (
	"testing"
)

func TestReadStatusFromLogsEmpty(t *testing.T) {
	// Should not panic when log dir doesn't exist or is empty
	base := DRStatus{Setup: "installed"}
	result := readStatusFromLogs(base)
	if result.Setup != "installed" {
		t.Errorf("expected setup=installed for empty/missing log dir, got %s", result.Setup)
	}
}

func TestGetCachedDRStatusReturnsSomething(t *testing.T) {
	invalidateDRCache()
	s := getCachedDRStatus()
	if s == nil {
		t.Fatal("getCachedDRStatus returned nil")
	}
	valid := map[string]bool{
		"not_installed": true, "installed": true,
		"configured": true, "pending": true, "error": true,
	}
	if !valid[s.Setup] {
		t.Errorf("unexpected setup value: %q", s.Setup)
	}
}

func TestDRCredsJSON(t *testing.T) {
	raw := `{"azure_account":"dtmanagerdr","sas_token":"abc","schedule_hour":23}`
	var c DrCreds
	if err := jsonUnmarshal([]byte(raw), &c); err != nil {
		t.Fatal(err)
	}
	if c.AzureAccount != "dtmanagerdr" {
		t.Errorf("expected dtmanagerdr, got %s", c.AzureAccount)
	}
	if c.ScheduleHour != 23 {
		t.Errorf("expected 23, got %d", c.ScheduleHour)
	}
}
```

Add the helper (needed because `encoding/json` is imported as `json` in commands.go but we need it in the test too):

```go
// jsonUnmarshal is a test helper that calls encoding/json.Unmarshal.
func jsonUnmarshal(data []byte, v any) error {
	return json.Unmarshal(data, v)
}
```

- [ ] **Step 3: Build to verify it compiles**

```bash
cd agent
GOOS=windows GOARCH=amd64 go build -o /tmp/dr-check.exe .
```

Expected: compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add agent/dr.go agent/dr_test.go
git commit -m "feat(dr): agent/dr.go — Veeam install / configure / backup / status"
```

---

### Task 8: Agent — Integration

**Files:**
- Modify: `agent/commands.go:139` (before `default:` case)
- Modify: `agent/agent.go:25` (HeartbeatPayload struct)
- Modify: `agent/agent.go:192` (sendHeartbeat function)

- [ ] **Step 1: Add 3 DR cases to `executeCommand()` in `agent/commands.go`**

Immediately before the `default:` case (line 139):

```go
	case "dr-setup":
		var creds DrCreds
		if err := json.Unmarshal(cmd.Params, &creds); err != nil {
			return "", fmt.Errorf("params dr-setup inválidos: %w", err)
		}
		if creds.AzureAccount == "" || creds.SASToken == "" {
			return "", fmt.Errorf("dr-setup: azure_account e sas_token obrigatórios")
		}
		logInfo(fmt.Sprintf("DR-SETUP recebido (cmd %s). Instalando Veeam...", cmd.ID))
		if err := installVeeam(a.cfg.ServerURL); err != nil {
			invalidateDRCache()
			return "", fmt.Errorf("installVeeam: %w", err)
		}
		logInfo("DR-SETUP: Veeam instalado. Configurando job...")
		if err := configureJob(creds); err != nil {
			invalidateDRCache()
			return "", fmt.Errorf("configureJob: %w", err)
		}
		invalidateDRCache()
		s := readStatus()
		drStatusCache = &s
		result, _ := json.Marshal(map[string]interface{}{
			"veeam_version": s.VeeamVersion,
			"setup_ok":      true,
		})
		return string(result), nil

	case "dr-backup-now":
		logInfo(fmt.Sprintf("DR-BACKUP-NOW recebido (cmd %s)", cmd.ID))
		if err := triggerBackupNow(); err != nil {
			return "", fmt.Errorf("triggerBackupNow: %w", err)
		}
		invalidateDRCache()
		return `{"job_started":true}`, nil

	case "dr-status":
		logInfo(fmt.Sprintf("DR-STATUS recebido (cmd %s)", cmd.ID))
		invalidateDRCache()
		s := readStatus()
		drStatusCache = &s
		data, err := json.Marshal(s)
		if err != nil {
			return "", err
		}
		return string(data), nil
```

- [ ] **Step 2: Add `DRStatus` to `HeartbeatPayload` in `agent/agent.go`**

Replace the existing `HeartbeatPayload` struct (lines 25-33) with:

```go
type HeartbeatPayload struct {
	MachineID   string    `json:"machineId"`
	Token       string    `json:"token"`
	Hostname    string    `json:"hostname"`
	Version     string    `json:"agentVersion"`
	Metrics     *Metrics  `json:"metrics"`
	WolEnabled  *bool     `json:"wolEnabled,omitempty"`
	Motherboard string    `json:"motherboard,omitempty"`
	DrStatus    *DRStatus `json:"dr_status,omitempty"`
}
```

- [ ] **Step 3: Populate `DrStatus` in `sendHeartbeat()`**

In `agent/agent.go`, in `sendHeartbeat()`, immediately after the `payload := HeartbeatPayload{...}` struct literal (around line 192), add:

```go
	// Attach DR status if Veeam is present on this machine
	if isVeeamInstalled() {
		s := getCachedDRStatus()
		payload.DrStatus = s
	}
```

- [ ] **Step 4: Run tests**

```bash
cd agent && go test ./... -v 2>&1 | head -60
```

Expected: Existing `wol_test.go` and `config_test.go` pass. New `dr_test.go` smoke tests pass (setup will be `not_installed` on a dev machine without Veeam).

- [ ] **Step 5: Build agent binary**

```bash
cd agent && GOOS=windows GOARCH=amd64 go build -o ../delirio-agent.exe .
```

Expected: `delirio-agent.exe` created.

- [ ] **Step 6: Commit**

```bash
git add agent/commands.go agent/agent.go
git commit -m "feat(dr): wire dr-setup/backup-now/status into agent commands + heartbeat"
```

---

### Task 9: Deploy Agent + Server

- [ ] **Step 1: Compute SHA256 of new agent binary**

```powershell
$hash = (Get-FileHash ".\delirio-agent.exe" -Algorithm SHA256).Hash.ToLower()
Write-Output $hash
```

- [ ] **Step 2: Upload agent binary to VM**

```bash
scp delirio-agent.exe delirioadmin@20.226.33.21:/opt/dt-manager/server/public/downloads/delirio-agent.exe
```

- [ ] **Step 3: Update agent version on VM** — Update the version JSON file that `routes/update.js` reads. Increment the version number to the next patch (e.g., `1.5.10`) and set the SHA256 hash from Step 1.

```powershell
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts "cat /opt/dt-manager/server/public/downloads/version.json"
```

Then update:

```powershell
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts @"
node -e `"
const fs = require('fs');
const p = '/opt/dt-manager/server/public/downloads/version.json';
const v = JSON.parse(fs.readFileSync(p,'utf8'));
v.version = '1.5.10';
v.sha256 = 'PASTE_HASH_HERE';
fs.writeFileSync(p, JSON.stringify(v,null,2));
console.log('version.json updated:', v.version);
`"
"@
```

- [ ] **Step 4: Deploy server code to VM**

```powershell
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts "cd /opt/dt-manager && git pull && pm2 restart server && pm2 status"
```

- [ ] **Step 5: Verify server health**

```powershell
Invoke-RestMethod -Uri 'https://dt-manager.brazilsouth.cloudapp.azure.com/health'
```

Expected: `{ status: 'ok', ... }`

- [ ] **Step 6: Broadcast agent update from Dashboard** — Open Dashboard → Settings → Update → Broadcast Update. Wait for online agents to self-update (heartbeat response triggers the update check within 30s).

---

### Task 10: Dashboard — API Client

**Files:**
- Modify: `dashboard/src/api.js:142` (after `rh:` block)

- [ ] **Step 1: Add `dr` namespace in `dashboard/src/api.js`**

After the closing `},` of the `rh:` block (after line 142), add:

```javascript
  // DR — Bare Metal Recovery
  dr: {
    setup:     (id)           => request('POST', `/api/dr/${id}/setup`),
    backupNow: (id)           => request('POST', `/api/dr/${id}/backup-now`),
    overview:  ()             => request('GET',  '/api/dr/overview'),
    history:   (id, days=28)  => request('GET',  `/api/dr/${id}/history?days=${days}`),
  },
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/api.js
git commit -m "feat(dr): add dr namespace to api.js"
```

---

### Task 11: MachineCard — DR Tab

**Files:**
- Modify: `dashboard/src/components/MachineCard.jsx`

- [ ] **Step 1: Add DR badge constants** — After the `WOL_BADGE` constant definition, add:

```javascript
const DR_BADGE = {
  not_installed: null,
  pending:    { color: '#f59e0b', label: 'DR ⏳', title: 'Configuração DR em andamento...' },
  configured: { color: '#22c55e', label: 'DR ✓',  title: 'Bare metal recovery ativo' },
  error:      { color: '#ef4444', label: 'DR ✗',  title: 'Erro no backup — verificar logs' },
}
```

- [ ] **Step 2: Add DR state variables** — After the `insightsUnread` state declaration, add:

```javascript
  const [drLoading, setDrLoading] = useState(false)
  const [drMsg,     setDrMsg]     = useState(null)
```

- [ ] **Step 3: Add DR action handlers** — After the `handleCommand` function definition, add:

```javascript
  async function handleDRSetup() {
    setDrLoading(true); setDrMsg(null)
    try {
      await api.dr.setup(machine.id)
      setDrMsg('Configurando DR... aguarde o próximo heartbeat (~30s).')
    } catch (e) {
      setDrMsg('Erro: ' + (e.message || 'falhou'))
    } finally { setDrLoading(false) }
  }

  async function handleBackupNow() {
    setDrLoading(true); setDrMsg(null)
    try {
      await api.dr.backupNow(machine.id)
      setDrMsg('Backup iniciado. Acompanhe o status no próximo heartbeat.')
    } catch (e) {
      setDrMsg('Erro: ' + (e.message || 'falhou'))
    } finally { setDrLoading(false) }
  }
```

- [ ] **Step 4: Add DR badge in machine card header** — Find where the WoL badge is rendered (the block with `WOL_BADGE[machine.wolStatus]`). Immediately after it, add:

```javascript
              {DR_BADGE[machine.dr_setup] && (
                <span
                  title={DR_BADGE[machine.dr_setup].title}
                  style={{
                    fontSize: '0.7em', padding: '1px 6px', borderRadius: 4, cursor: 'default',
                    background: DR_BADGE[machine.dr_setup].color + '22',
                    color: DR_BADGE[machine.dr_setup].color,
                    border: `1px solid ${DR_BADGE[machine.dr_setup].color}44`,
                  }}
                >{DR_BADGE[machine.dr_setup].label}</span>
              )}
```

- [ ] **Step 5: Add DR tab button** — Find the tab buttons row (where `setActiveTab('metrics')` etc. are called). Add:

```javascript
              <button onClick={() => setActiveTab('dr')}
                style={{ background: activeTab === 'dr' ? '#6366f120' : 'transparent', color: activeTab === 'dr' ? '#818cf8' : '#888', border: 'none', padding: '4px 10px', cursor: 'pointer', borderRadius: 4, fontSize: '0.8em' }}>
                🔒 DR
              </button>
```

- [ ] **Step 6: Add DR tab content panel** — In the tab content area (where `activeTab === 'metrics'` etc. render content), add:

```javascript
              {activeTab === 'dr' && (
                <div style={{ padding: '10px 0' }}>
                  <div style={{ marginBottom: 6, fontSize: '0.82em', color: '#aaa' }}>
                    <strong>Status:</strong>{' '}
                    <span style={{ color: DR_BADGE[machine.dr_setup]?.color || '#888' }}>
                      {machine.dr_setup || 'not_installed'}
                    </span>
                    {machine.dr_version && (
                      <span style={{ marginLeft: 8, color: '#555', fontSize: '0.9em' }}>
                        Veeam {machine.dr_version}
                      </span>
                    )}
                  </div>
                  {machine.dr_last_ok && (
                    <div style={{ marginBottom: 6, fontSize: '0.82em', color: '#aaa' }}>
                      <strong>Último backup OK:</strong>{' '}
                      {new Date(machine.dr_last_ok).toLocaleString('pt-BR')}
                      {machine.dr_storage_gb && (
                        <span style={{ marginLeft: 8, color: '#6ee7b7' }}>
                          {machine.dr_storage_gb.toFixed(1)} GB
                        </span>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    {(!machine.dr_setup || machine.dr_setup === 'not_installed') && (
                      <button onClick={handleDRSetup} disabled={drLoading}
                        style={{ background: '#6366f115', color: '#818cf8', border: '1px solid #6366f133', padding: '4px 14px', borderRadius: 6, cursor: 'pointer', fontSize: '0.8em' }}>
                        {drLoading ? '⏳ Aguarde...' : '⚙️ Configurar DR'}
                      </button>
                    )}
                    {machine.dr_setup === 'configured' && (
                      <button onClick={handleBackupNow} disabled={drLoading}
                        style={{ background: '#16a34a15', color: '#22c55e', border: '1px solid #16a34a33', padding: '4px 14px', borderRadius: 6, cursor: 'pointer', fontSize: '0.8em' }}>
                        {drLoading ? '⏳...' : '▶ Forçar Backup'}
                      </button>
                    )}
                  </div>
                  {drMsg && (
                    <div style={{ marginTop: 8, fontSize: '0.78em', color: '#f59e0b' }}>{drMsg}</div>
                  )}
                </div>
              )}
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/components/MachineCard.jsx
git commit -m "feat(dr): DR tab + badge in MachineCard"
```

---

### Task 12: DRModule — Overview Screen

**Files:**
- Create: `dashboard/src/components/DRModule.jsx`

- [ ] **Step 1: Create `dashboard/src/components/DRModule.jsx`**

```jsx
import { useState, useEffect } from 'react'
import { api } from '../api'

const STATUS_COLOR = {
  configured:   '#22c55e',
  pending:      '#f59e0b',
  error:        '#ef4444',
  not_installed:'#4b5563',
}
const STATUS_LABEL = {
  configured:   '✅ Protegida',
  pending:      '⏳ Configurando',
  error:        '❌ Erro',
  not_installed:'— Sem DR',
}

export function DRModule({ onClose }) {
  const [overview, setOverview] = useState(null)
  const [machines, setMachines] = useState([])
  const [filter,   setFilter]   = useState('all')
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  async function load() {
    setLoading(true); setError(null)
    try {
      const [ov, ms] = await Promise.all([api.dr.overview(), api.getMachines()])
      setOverview(ov)
      setMachines(ms)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const filtered = machines.filter(m => {
    if (filter === 'configured') return m.dr_setup === 'configured'
    if (filter === 'none')       return !m.dr_setup || m.dr_setup === 'not_installed'
    if (filter === 'error')      return m.dr_setup === 'error'
    return true
  })

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f0f19f0', zIndex: 9999, display: 'flex', flexDirection: 'column', fontFamily: 'monospace' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #1e1e30' }}>
        <div>
          <h2 style={{ margin: 0, color: '#a5b4fc', fontSize: '1.1em' }}>🔒 Bare Metal Recovery</h2>
          <p style={{ margin: '2px 0 0', fontSize: '0.78em', color: '#555' }}>Veeam Agent for Windows FREE + Azure Blob (dtmanagerdr)</p>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.3em', cursor: 'pointer' }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {loading && <p style={{ color: '#888' }}>Carregando...</p>}
        {error   && <p style={{ color: '#ef4444' }}>Erro: {error}</p>}

        {/* Overview cards */}
        {overview && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Protegidas',    value: overview.total,                             color: '#22c55e' },
              { label: 'Backup < 24h', value: `${overview.okLast24h} / ${overview.total}`, color: '#3b82f6' },
              { label: 'Total Azure',   value: `${(overview.totalGb || 0).toFixed(0)} GB`, color: '#8b5cf6' },
              { label: 'Com falha',     value: overview.failing,                           color: '#ef4444' },
            ].map(card => (
              <div key={card.label} style={{ background: '#1a1a2a', borderRadius: 8, padding: '12px 16px', border: `1px solid ${card.color}33` }}>
                <div style={{ fontSize: '1.5em', fontWeight: 700, color: card.color }}>{card.value}</div>
                <div style={{ fontSize: '0.75em', color: '#888', marginTop: 2 }}>{card.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {[['all', 'Todas'], ['configured', 'Protegidas'], ['none', 'Sem DR'], ['error', 'Com falha']].map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)}
              style={{ background: filter === k ? '#6366f133' : 'transparent', color: filter === k ? '#818cf8' : '#666', border: `1px solid ${filter === k ? '#6366f144' : '#333'}`, padding: '3px 12px', borderRadius: 4, cursor: 'pointer', fontSize: '0.8em' }}>
              {label}
            </button>
          ))}
          <button onClick={load} style={{ marginLeft: 'auto', background: 'none', border: '1px solid #333', color: '#666', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: '0.8em' }}>
            ↻ Atualizar
          </button>
        </div>

        {/* Table */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8em' }}>
          <thead>
            <tr style={{ color: '#555', borderBottom: '1px solid #222' }}>
              {['Máquina', 'Localidade', 'Status DR', 'Último Backup OK', 'Storage', 'Veeam'].map(h => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(m => (
              <tr key={m.id} style={{ borderBottom: '1px solid #1a1a2a' }}>
                <td style={{ padding: '7px 8px', color: '#e2e8f0' }}>{m.display_name || m.hostname}</td>
                <td style={{ padding: '7px 8px', color: '#888' }}>{m.location || '—'}</td>
                <td style={{ padding: '7px 8px' }}>
                  <span style={{ color: STATUS_COLOR[m.dr_setup] || '#4b5563', fontWeight: 600 }}>
                    {STATUS_LABEL[m.dr_setup] || '— Sem DR'}
                  </span>
                </td>
                <td style={{ padding: '7px 8px', color: '#888' }}>
                  {m.dr_last_ok ? new Date(m.dr_last_ok).toLocaleString('pt-BR') : '—'}
                </td>
                <td style={{ padding: '7px 8px', color: '#6ee7b7' }}>
                  {m.dr_storage_gb ? `${m.dr_storage_gb.toFixed(1)} GB` : '—'}
                </td>
                <td style={{ padding: '7px 8px', color: '#555' }}>{m.dr_version || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && filtered.length === 0 && (
          <p style={{ color: '#555', marginTop: 16 }}>Nenhuma máquina neste filtro.</p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/DRModule.jsx
git commit -m "feat(dr): DRModule full-screen overview with fleet stats"
```

---

### Task 13: App.jsx Wiring

**Files:**
- Modify: `dashboard/src/App.jsx`

- [ ] **Step 1: Import DRModule** — After the `AlohaModule` import line, add:

```javascript
import { DRModule } from './components/DRModule'
```

- [ ] **Step 2: Add `showDR` state** — After `const [showAloha, setShowAloha] = useState(false)`, add:

```javascript
  const [showDR, setShowDR] = useState(false)
```

- [ ] **Step 3: Add DR pill in topbar** — Find the topbar area where the RH and Aloha pills/buttons are rendered. After the Aloha pill, add:

```javascript
              <button
                onClick={() => setShowDR(true)}
                title="Bare Metal Recovery"
                style={{ background: '#6366f111', border: '1px solid #6366f133', borderRadius: 6, padding: '3px 10px', color: '#818cf8', fontSize: '0.8em', cursor: 'pointer' }}
              >
                🔒 DR
              </button>
```

- [ ] **Step 4: Render DRModule** — After the `{showAloha && <AlohaModule ... />}` rendering, add:

```javascript
      {showDR && <DRModule onClose={() => setShowDR(false)} />}
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/App.jsx
git commit -m "feat(dr): wire DRModule + pill into App"
```

---

### Task 14: Build, Package, Deploy Dashboard

- [ ] **Step 1: Build dashboard**

```bash
cd dashboard && npm run build
```

Expected: no build errors, `dist/` updated.

- [ ] **Step 2: Package Electron installer**

```bash
cd dashboard && npm run dist
```

Expected: new `.exe` installer in `dist/`.

- [ ] **Step 3: Upload installer to VM and update dashboard version** — Follow the same flow used in previous dashboard releases: upload to `/opt/dt-manager/server/public/dashboard-updates/` and update the version so `electron-updater` picks it up.

---

### Task 15: Pilot Test

- [ ] **Step 1: Pick a test machine** — Choose one non-critical machine from the Dashboard (ideally one you can physically observe). Open its detail card → DR tab.

- [ ] **Step 2: Trigger Configurar DR** — Click "⚙️ Configurar DR". Verify:
  - `POST /api/dr/:id/setup` returns `{ ok: true, queued: 'dr-setup' }`
  - Machine `dr_setup` badge changes to `⏳ DR` within a few seconds (WebSocket broadcast)

- [ ] **Step 3: Wait for agent to pick up the command** — The agent polls commands every 10s. Within 10s it should receive `dr-setup`. The `dr-setup` flow takes ~5–10 minutes (Veeam download + install).

- [ ] **Step 4: Verify successful setup** — Within 10 minutes, the machine's `dr_setup` badge should change to `✅ DR ✓`. If it changes to `❌ DR ✗`, check the agent log on the machine at `C:\ProgramData\DelirioAgent\agent.log` for the PowerShell error.

- [ ] **Step 5: If configureJob fails — verify Veeam cmdlets** — On the test machine, run:

```powershell
Import-Module 'C:\Program Files\Veeam\Endpoint Backup\Veeam.Endpoint.Backup.PowerShell.dll' -Force
Get-Command -Module *Veeam* | Select-Object Name | Sort-Object Name
```

Adjust the cmdlet names in `agent/dr.go`'s `configureJob()` function to match what's actually available, rebuild, redeploy.

- [ ] **Step 6: Trigger manual backup** — After setup succeeds, click "▶ Forçar Backup". Within 30s the next heartbeat should show `is_running: true`. Check Azure Portal → Storage account `dtmanagerdr` → Containers → verify a container named after the machine's hostname appeared.

---

## Self-Review

**Spec coverage:**
- ✅ Azure Blob `dtmanagerdr` — Task 5 adds credentials to config.json
- ✅ `dr-setup` command (install + configure Veeam) — Tasks 7 + 8
- ✅ `dr-backup-now` command — Tasks 7 + 8
- ✅ `dr-status` command — Tasks 7 + 8
- ✅ `dr_status` field in heartbeat — Task 8 (agent.go)
- ✅ Server processes heartbeat DR status — Task 3
- ✅ `dr_backups` table + `dr_*` columns — Task 1
- ✅ 4 DR routes — Task 2
- ✅ DR overdue alert (email, 6h cooldown) — Task 4
- ✅ MachineCard DR tab (Configurar DR / Forçar Backup buttons) — Task 11
- ✅ Opt-in per machine — "Configurar DR" only shown when `dr_setup = not_installed` (Task 11 Step 6)
- ✅ DRModule overview — Task 12
- ✅ DR pill in topbar — Task 13
- ✅ Veeam installer hosted on DM server — Task 6

**Type consistency:**
- `DRStatus` Go struct → JSON key `dr_status` in heartbeat
- Server reads `req.body.dr_status` ✅
- DB columns: `dr_setup`, `dr_last_ok`, `dr_storage_gb`, `dr_version` ✅
- `getAllMachines()` does `SELECT m.*` → new columns included automatically ✅
- Dashboard reads `machine.dr_setup`, `machine.dr_last_ok`, `machine.dr_storage_gb`, `machine.dr_version` ✅

**⚠️ Known gap — Veeam cmdlet names:** The `configureJob()` function uses cmdlet names (`Add-VBRComputerBackupJob`, `Add-VBRAzureObjectStorageRepository`, etc.) that must be verified against the actual installed Veeam Agent for Windows version. Task 15 Step 5 covers the diagnostic procedure. If the cmdlets differ, update `configureJob()` in `agent/dr.go`, rebuild, and redeploy the agent.
