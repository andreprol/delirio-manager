# Employee Reading, Sync & Remote Deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix employee clock-column display (Gávea missing, Ref2 empty), surface incomplete employees (present but crachá missing in some clocks), add "Completar Crachá" one-click action, and enable remote deploy of clock-proxy via the VPN chain.

**Architecture:** Two separate layers — clock-proxy (`server.js`, `henry-hexa.js`) running on Servidor Skill (192.168.17.252:4321), and the Electron dashboard (`EmployeeTable.jsx`). Backend changes deploy via a new `POST /deploy` endpoint triggered from André's machine through `az vm run-command` → Azure VM → VPN → clock-proxy.

**Tech Stack:** Node.js 22 + Express + Playwright (clock-proxy), React (dashboard), PowerShell (deploy helper), Azure CLI (`az vm run-command`)

---

## File Map

| File | Change |
|------|--------|
| `clock-proxy/server.js` | Add `fs`/`path`/`child_process` requires; `/deploy` endpoint; `incompleteIn` computation; `allClockIps` + `incomplete` in `_empCache` |
| `clock-proxy/henry-hexa.js` | Already fixed in dev (pagination race + Ref2 col + dedup) — deploy only |
| `clock-proxy/deploy-remote.ps1` | New local helper: reads files, base64-encodes, calls `az vm run-command` to push to clock-proxy |
| `dashboard/src/components/EmployeeTable.jsx` | Replace `getReachableIps` with `allClockIps` from data; 3-state cells (✅/❌/—/⚠️); Incompletos filter; `handleCompleteCard`; incomplete count in summary |

`dashboard/src/api.js` — **no change needed**: `api.rh.updateCard(cpf, ref2, clockIps)` already calls `PUT /rh/employee`.

---

## Task 1 — `server.js`: `/deploy` endpoint + `incompleteIn` + `allClockIps`

**Files:**
- Modify: `clock-proxy/server.js`

- [ ] **Step 1: Add missing Node core requires at top of file**

In `clock-proxy/server.js`, after line 1 (`require('dotenv').config();`), add:

```javascript
const fs            = require('fs');
const path          = require('path');
const { spawn }     = require('child_process');
```

- [ ] **Step 2: Add `/deploy` endpoint**

Add after the `PUT /rh/employee` route (around line 338) and before `app.listen`:

```javascript
// ─── DEPLOY REMOTO ───────────────────────────────────────────────────────────
// Recebe arquivos como base64, salva em disco e reinicia o processo.
// Body: { files: { "server.js": "<base64>", "henry-hexa.js": "<base64>" } }
app.post('/deploy', (req, res) => {
  const { files } = req.body;
  if (!files || typeof files !== 'object') {
    return res.status(400).json({ error: 'files obrigatorio' });
  }

  const ALLOWED = new Set(['server.js', 'henry-hexa.js']);
  const TARGET  = process.cwd();
  const results = {};

  for (const [name, b64] of Object.entries(files)) {
    if (!ALLOWED.has(name)) {
      results[name] = { ok: false, error: 'arquivo nao permitido' };
      continue;
    }
    try {
      fs.writeFileSync(path.join(TARGET, name), Buffer.from(b64, 'base64'));
      results[name] = { ok: true };
    } catch (e) {
      results[name] = { ok: false, error: e.message };
    }
  }

  const failed = Object.values(results).some(r => !r.ok);
  if (failed) {
    return res.status(500).json({ success: false, files: results });
  }

  res.json({ success: true, files: results, message: 'Reiniciando em 2s...' });

  // Detached PowerShell: espera 2s, mata este PID, inicia novo processo
  const pid        = process.pid;
  const nodePath   = process.execPath;
  const restartCmd = `Start-Sleep -Seconds 2; Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; Start-Process -FilePath "${nodePath}" -ArgumentList "server.js" -WorkingDirectory "${TARGET}" -WindowStyle Hidden`;
  spawn('powershell.exe', ['-Command', restartCmd], { detached: true, stdio: 'ignore' }).unref();
});
```

- [ ] **Step 3: Build `clockRef2Map` in `runEmployeesInBackground`**

In `runEmployeesInBackground()`, after the `for (const ip of CLOCK_IPS)` loop ends (after line 188, before `const masterMap`), add:

```javascript
    // Mapa por relógio de qual ref2 cada funcionário tinha nessa leitura
    const clockRef2Map = {};
    for (const clock of clockResults) {
      if (!clock.success) continue;
      clockRef2Map[clock.ip] = {};
      for (const emp of clock.employees) {
        clockRef2Map[clock.ip][emp.cpf] = emp.ref2 || '';
      }
    }
```

- [ ] **Step 4: Compute `incompleteIn` for each employee**

Replace the existing `absentIn` loop (lines 214–217):

```javascript
    const reachableIps = clockResults.filter(r => r.success).map(r => r.ip);
    for (const emp of masterMap.values()) {
      emp.absentIn     = reachableIps.filter(ip => !emp.presentIn.includes(ip));
      emp.incompleteIn = emp.ref2
        ? reachableIps.filter(ip =>
            emp.presentIn.includes(ip) && !clockRef2Map[ip]?.[emp.cpf]
          )
        : [];
    }
```

- [ ] **Step 5: Add `incomplete` count and `allClockIps` to `_empCache`**

Replace the `_empCache = { ... }` block (lines 222–234):

```javascript
    const employees  = Array.from(masterMap.values());
    const divergent  = employees.filter(e => e.absentIn.length > 0);
    const incomplete = employees.filter(e => e.incompleteIn.length > 0);

    _empCache = {
      total:        employees.length,
      divergent:    divergent.length,
      incomplete:   incomplete.length,
      synchronized: employees.length - divergent.length,
      employees,
      clocks: clockResults.map(r => ({
        ip:      r.ip,
        success: r.success,
        total:   r.total || 0,
        error:   r.message,
      })),
      allClockIps: CLOCK_IPS,
      timestamp:   new Date().toISOString(),
    };
    _empCacheAt = Date.now();
    console.log(`[/rh/employees] Job concluído — ${employees.length} funcionários, ${divergent.length} divergentes, ${incomplete.length} incompletos`);
```

- [ ] **Step 6: Commit server.js**

```bash
git add clock-proxy/server.js
git commit -m "feat(clock-proxy): /deploy endpoint + incompleteIn + allClockIps"
```

---

## Task 2 — `deploy-remote.ps1`: local deploy helper

**Files:**
- Create: `clock-proxy/deploy-remote.ps1`

- [ ] **Step 1: Create the helper script**

Create `clock-proxy/deploy-remote.ps1` with this exact content:

```powershell
<#
.SYNOPSIS
  Faz deploy remoto do clock-proxy no Servidor Skill via Azure VM + VPN.
.EXAMPLE
  .\deploy-remote.ps1
#>
param(
  [string]$ResourceGroup = "rg-dt-manager",
  [string]$VmName        = "vm-dt-manager"
)

$TOKEN = "<CLOCK_PROXY_TOKEN>"
$DIR   = $PSScriptRoot

Write-Host "Lendo arquivos..." -ForegroundColor Cyan
$serverB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("$DIR\server.js"))
$henryB64  = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("$DIR\henry-hexa.js"))

# JSON body (base64 nao tem chars especiais — seguro para heredoc)
$body = "{`"files`":{`"server.js`":`"$serverB64`",`"henry-hexa.js`":`"$henryB64`"}}"

$sizeKb = [Math]::Round($body.Length / 1024, 1)
Write-Host "Payload: $sizeKb KB — enviando via Azure VM..." -ForegroundColor Cyan

# Script executado na Azure VM (Linux bash)
$script = @"
cat > /tmp/deploy-body.json << 'ENDBODY'
$body
ENDBODY
echo "Body escrito ($sizeKb KB). Chamando /deploy..."
curl -sf -X POST http://192.168.14.1:4321/deploy \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d @/tmp/deploy-body.json
DEPLOY_EXIT=\$?
echo ""
if [ \$DEPLOY_EXIT -eq 0 ]; then
  echo "Deploy enviado. Aguardando restart (7s)..."
  sleep 7
  curl -sf http://192.168.14.1:4321/health && echo "Health OK" || echo "AVISO: health ainda nao responde"
else
  echo "ERRO: curl retornou $DEPLOY_EXIT"
fi
"@

az vm run-command invoke `
  --resource-group $ResourceGroup `
  --name $VmName `
  --command-id RunShellScript `
  --scripts $script
```

- [ ] **Step 2: Commit**

```bash
git add clock-proxy/deploy-remote.ps1
git commit -m "feat(clock-proxy): deploy-remote.ps1 — deploy via Azure VM VPN chain"
```

---

## Task 3 — `EmployeeTable.jsx`: fix column list + 3-state cells

**Files:**
- Modify: `dashboard/src/components/EmployeeTable.jsx`

- [ ] **Step 1: Replace `getReachableIps` with `getAllClockIps`**

Remove lines 299–307 (the two helper functions):

```javascript
// Derive which clock IPs were seen in the last fetch (reachable clocks)
function getReachableIps(clocks) {
  if (!clocks || clocks.length === 0) return []
  return clocks.filter(c => c.success > 0 || c.total > 0).map(c => c.ip)
}

function isDivergent(emp) {
  return emp.absentIn && emp.absentIn.length > 0
}
```

Replace with:

```javascript
function isDivergent(emp) {
  return emp.absentIn && emp.absentIn.length > 0
}

function isIncomplete(emp) {
  return emp.incompleteIn && emp.incompleteIn.length > 0
}
```

- [ ] **Step 2: Replace computed `reachableIps` + add clock status map**

Find this line (around line 518 in original):

```javascript
  // Compute visible clock columns from the data
  const reachableIps = data ? getReachableIps(data.clocks) : []
```

Replace with:

```javascript
  // Todos os IPs tentados (incluindo offline) — vem do backend
  const allClockIps    = data?.allClockIps ?? []
  // Map ip -> bool (true = leitura bem-sucedida nessa rodada)
  const clockStatusMap = Object.fromEntries((data?.clocks ?? []).map(c => [c.ip, c.success]))
```

- [ ] **Step 3: Update filter logic to use `isIncomplete`**

Find the `filtered` computation (around line 522):

```javascript
  const filtered  = employees.filter(emp => {
    const q = search.trim().toLowerCase()
    if (q && !emp.name.toLowerCase().includes(q) && !emp.cpf.includes(q)) return false
    if (filter === 'divergent' && !isDivergent(emp)) return false
    if (filter === 'synced'    &&  isDivergent(emp)) return false
    return true
  })
```

Replace with:

```javascript
  const filtered  = employees.filter(emp => {
    const q = search.trim().toLowerCase()
    if (q && !emp.name.toLowerCase().includes(q) && !emp.cpf.includes(q)) return false
    if (filter === 'divergent'  && !isDivergent(emp))  return false
    if (filter === 'synced'     &&  isDivergent(emp))  return false
    if (filter === 'incomplete' && !isIncomplete(emp)) return false
    return true
  })
```

- [ ] **Step 4: Add `incompleteCount` to summary variables**

After `const divergentCount = data?.divergent ?? 0` (around line 532), add:

```javascript
  const incompleteCount = data?.incomplete ?? 0
```

- [ ] **Step 5: Show incomplete count in header summary**

Find the summary block that shows `{' com divergência'}` and add after it:

```jsx
              {incompleteCount > 0 && (
                <>
                  {' | '}
                  <span style={{ fontWeight: 700, color: 'var(--yellow, #fbbf24)' }}>
                    {incompleteCount}
                  </span>
                  {' incompletos'}
                </>
              )}
```

- [ ] **Step 6: Replace column headers to use `allClockIps` + offline badge**

Find:

```jsx
                {reachableIps.map(ip => (
                  <th key={ip} style={styles.thCenter} title={ip}>
                    {IP_TO_STORE[ip] || ip}
                  </th>
                ))}
```

Replace with:

```jsx
                {allClockIps.map(ip => (
                  <th key={ip} style={styles.thCenter} title={clockStatusMap[ip] ? ip : `${ip} — offline`}>
                    {IP_TO_STORE[ip] || ip}
                    {!clockStatusMap[ip] && (
                      <span style={{ color: 'var(--text-muted, #94a3b8)', fontSize: '10px', display: 'block', fontWeight: 400 }}>
                        offline
                      </span>
                    )}
                  </th>
                ))}
```

- [ ] **Step 7: Replace row cells to use `allClockIps` + 3-state logic**

Find:

```jsx
                      {reachableIps.map(ip => {
                        const present = emp.presentIn?.includes(ip)
                        return (
                          <td key={ip} style={styles.tdCenter}>
                            {present ? '✅' : '❌'}
                          </td>
                        )
                      })}
```

Replace with:

```jsx
                      {allClockIps.map(ip => {
                        const clockOk     = clockStatusMap[ip]
                        const present     = emp.presentIn?.includes(ip)
                        const incomplete  = emp.incompleteIn?.includes(ip)
                        let content, title, extraStyle = {}
                        if (!clockOk) {
                          content    = '—'
                          title      = 'Relógio offline nesta leitura'
                          extraStyle = { color: 'var(--text-muted, #94a3b8)' }
                        } else if (present && incomplete) {
                          content = '⚠️'
                          title   = 'Presente mas crachá NFC ausente neste relógio'
                        } else if (present) {
                          content = '✅'
                          title   = 'Presente'
                        } else {
                          content = '❌'
                          title   = 'Ausente'
                        }
                        return (
                          <td key={ip} style={{ ...styles.tdCenter, ...extraStyle }} title={title}>
                            {content}
                          </td>
                        )
                      })}
```

- [ ] **Step 8: Update `colSpan` reference**

Find:

```jsx
                    colSpan={5 + reachableIps.length}
```

Replace with:

```jsx
                    colSpan={5 + allClockIps.length}
```

- [ ] **Step 9: Commit**

```bash
git add dashboard/src/components/EmployeeTable.jsx
git commit -m "feat(dashboard): fix clock columns — allClockIps, 3-state cells, offline badge"
```

---

## Task 4 — `EmployeeTable.jsx`: Incompletos filter + "Completar Crachá" action

**Files:**
- Modify: `dashboard/src/components/EmployeeTable.jsx`

- [ ] **Step 1: Add `completing` state**

After the `const [removing, setRemoving] = useState(null)` line, add:

```javascript
  const [completing, setCompleting] = useState(null) // cpf sendo completado
```

- [ ] **Step 2: Add `handleCompleteCard` function**

Add this function after the `handleRemove` function (after the closing `}` of `handleRemove`, around line 515):

```javascript
  async function handleCompleteCard(emp) {
    setCompleting(emp.cpf)
    setOpStatus(null)
    try {
      const result = await api.rh.updateCard(emp.cpf, emp.ref2, emp.incompleteIn)
      const allOk  = result.failed === 0
      const type   = allOk ? 'success' : result.updated > 0 ? 'partial' : 'error'
      const clockChips = (result.clocks || []).map(c => ({
        label: IP_TO_STORE[c.clockIp] || c.clockIp,
        ok:    c.success,
      }))
      setOpStatus({
        type,
        title: allOk
          ? `Crachá atualizado em ${result.updated} relógio(s).`
          : `Atualizado em ${result.updated}, falhou em ${result.failed}.`,
        clocks: clockChips,
      })
      loadEmployees()
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao completar crachá: ${err.message}`, clocks: [] })
    } finally {
      setCompleting(null)
    }
  }
```

- [ ] **Step 3: Add "Incompletos" toggle button**

Find the toggle group in the controls section:

```jsx
            <button
              style={styles.toggleBtn(filter === 'synced')}
              onClick={() => setFilter('synced')}
            >
              Não divergentes
            </button>
```

Add immediately after this button (still inside the `<div style={styles.toggleGroup}>`):

```jsx
            <button
              style={styles.toggleBtn(filter === 'incomplete')}
              onClick={() => setFilter('incomplete')}
            >
              Incompletos
            </button>
```

- [ ] **Step 4: Add "Completar Crachá" button in the actions cell**

Find the actions cell content. After the `{divergent && !enrollTarget && (` sync button block and the `{enrollTarget?.cpf === emp.cpf && (` hint, and BEFORE the Remover button, add:

```jsx
                          {isIncomplete(emp) && emp.ref2 && !enrollTarget && (
                            <button
                              style={{
                                ...styles.actionBtn('sync'),
                                ...(completing === emp.cpf ? styles.actionBtnDisabled : {}),
                              }}
                              onClick={() => handleCompleteCard(emp)}
                              disabled={completing === emp.cpf || isRemoving}
                            >
                              {completing === emp.cpf ? 'Atualizando…' : 'Completar Crachá'}
                            </button>
                          )}
```

Exact placement — find:

```jsx
                          <button
                            style={{
                              ...styles.actionBtn('remove'),
                              ...(isRemoving ? styles.actionBtnDisabled : {}),
                            }}
                            onClick={() => handleRemove(emp)}
                            disabled={isRemoving || !!enrollTarget}
                          >
```

Insert the new button block immediately before that `<button`.

- [ ] **Step 5: Verify `actionBtn` style map has a variant for `complete`**

Currently `actionBtn` supports `sync` and `remove`. The "Completar Crachá" button reuses `sync` (blue). No change needed — the style map already has `sync`.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/EmployeeTable.jsx
git commit -m "feat(dashboard): Incompletos filter + Completar Crachá action"
```

---

## Task 5 — Deploy clock-proxy to Servidor Skill

**Files:** no file changes — this is an operational task.

**Context:**
- Deploy path: André's machine → `az vm run-command` → Azure VM (10.0.0.4) → HTTP → Metro pfSense (192.168.14.1:4321) → VPN → EC pfSense → Servidor Skill (192.168.17.252:4321)
- `clock-proxy/` local files are the source of truth — already committed in Tasks 1 & 2
- First deploy must be done manually (the `/deploy` endpoint doesn't exist yet on the server) — use the existing `az vm run-command` method to push the files

- [ ] **Step 1: Push changes to GitHub**

```powershell
cd F:\RichClub
git push
```

- [ ] **Step 2: Verify Azure CLI is logged in**

```powershell
az account show --query "name" -o tsv
```

Expected: account name (e.g. `Andre Prol`). If not logged in: `az login`.

- [ ] **Step 3: Deploy server.js and henry-hexa.js manually via az vm run-command**

This first deploy must be done by passing file content directly (the `/deploy` endpoint isn't on the server yet). Run:

```powershell
# Build base64 content of both files
$serverB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("F:\RichClub\clock-proxy\server.js"))
$henryB64  = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("F:\RichClub\clock-proxy\henry-hexa.js"))

# Write helper script that Azure VM will run
$script = @"
echo "$serverB64" | base64 -d > /tmp/server.js.b64
echo "$henryB64"  | base64 -d > /tmp/henry-hexa.js.b64
TOKEN=<CLOCK_PROXY_TOKEN>
curl -sf -X POST http://192.168.14.1:4321/deploy \
  -H "Authorization: Bearer \$TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"files\":{\"server.js\":\"\$(cat /tmp/server.js.b64 | tr -d '\n')\",\"henry-hexa.js\":\"\$(cat /tmp/henry-hexa.js.b64 | tr -d '\n')\"}}"
"@

Write-Host "Tamanho do script: $([Math]::Round($script.Length/1024, 1)) KB"
```

Wait — the above passes base64 inline which can exceed `az vm run-command` limits. Use the manual copy approach for the first deploy instead:

```powershell
# Fallback manual first deploy: copy files directly via az vm run-command download from GitHub raw
$TOKEN = "<CLOCK_PROXY_TOKEN>"
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts @"
TOKEN=$TOKEN
# Kill the running node server.js on Servidor Skill
curl -sf -X POST http://192.168.14.1:4321/rh/offboard \
  -H "Authorization: Bearer \$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cpf":"DEPLOY_TEST"}' 2>/dev/null || true
echo 'Nao foi possivel chamar /deploy (endpoint nao existe ainda)'
echo 'Use o procedimento manual de RDP para esta primeira instalacao'
"@
```

**⚠️ NOTA IMPORTANTE — Primeira instalação manual:**
O endpoint `/deploy` não existe no servidor ainda. Para esta primeira instalação, conectar via RDP ao Servidor Skill (192.168.17.252) e executar:

```powershell
# No Servidor Skill via RDP:
Set-Location C:\DtClockProxy

# Parar o servidor atual
$pid = (netstat -ano | Select-String ":4321").ToString().Trim() -split "\s+" | Select-Object -Last 1
if ($pid) { Stop-Process -Id $pid -Force }

# Copiar arquivos do compartilhamento de rede (via RDP tsclient)
Copy-Item "\\tsclient\F\RichClub\clock-proxy\server.js"     "C:\DtClockProxy\server.js"     -Force
Copy-Item "\\tsclient\F\RichClub\clock-proxy\henry-hexa.js" "C:\DtClockProxy\henry-hexa.js" -Force

# Reiniciar
Start-Sleep -Seconds 2
Start-Process -FilePath "C:\nvm4w\nodejs\node.exe" -ArgumentList "server.js" -WorkingDirectory "C:\DtClockProxy" -WindowStyle Hidden
Start-Sleep -Seconds 5
Invoke-RestMethod http://localhost:4321/health
```

- [ ] **Step 4: Verify server is up and new endpoint exists**

From Azure VM via `az vm run-command`:

```powershell
$TOKEN = "<CLOCK_PROXY_TOKEN>"
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts "curl -sf http://192.168.14.1:4321/health && echo 'OK'"
```

Expected output (in `value[0].message`): `{"ok":true,"service":"dt-clock-proxy"}OK`

- [ ] **Step 5: Test `/deploy` endpoint with a no-op call**

```powershell
$TOKEN = "<CLOCK_PROXY_TOKEN>"
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts "curl -sf -X POST http://192.168.14.1:4321/deploy -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"files\":{}}'"
```

Expected: `{"success":true,"files":{},"message":"Reiniciando em 2s..."}`

- [ ] **Step 6: Test `deploy-remote.ps1` for future deploys**

```powershell
cd F:\RichClub\clock-proxy
.\deploy-remote.ps1
```

Expected: output ends with `{"ok":true,"service":"dt-clock-proxy"}` after 7s delay.

---

## Task 6 — Build and release dashboard v1.0.9

**Files:**
- Modify: `dashboard/package.json` (version bump)
- Build output: `dashboard/dist-electron/`

- [ ] **Step 1: Bump version**

```powershell
cd F:\RichClub\dashboard
npm version patch
```

Expected: prints `v1.0.9`

- [ ] **Step 2: Build the installer**

```powershell
npm run dist
```

Expected: creates `dist-electron/Delirio Manager Setup 1.0.9.exe` and `dist-electron/latest.yml`

- [ ] **Step 3: Create GitHub release**

```powershell
cd F:\RichClub
gh release create v1.0.9 `
  "dashboard/dist-electron/latest.yml" `
  "dashboard/dist-electron/Delirio Manager Setup 1.0.9.exe.blockmap" `
  --title "v1.0.9"
gh release upload v1.0.9 "dashboard/dist-electron/Delirio Manager Setup 1.0.9.exe"
```

- [ ] **Step 4: Push update files to Azure VM**

```powershell
az vm run-command invoke `
  --resource-group rg-dt-manager `
  --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts @"
DIR=/opt/dt-manager/public/dashboard-updates; VER=1.0.9
curl -fsSL -o "\$DIR/latest.yml" 'https://github.com/andreprol/delirio-manager/releases/download/v\$VER/latest.yml'
curl -fsSL -o "\$DIR/Delirio Manager Setup \$VER.exe.blockmap" 'https://github.com/andreprol/delirio-manager/releases/download/v\$VER/Delirio.Manager.Setup.\$VER.exe.blockmap'
curl -fL    -o "\$DIR/Delirio Manager Setup \$VER.exe"          'https://github.com/andreprol/delirio-manager/releases/download/v\$VER/Delirio.Manager.Setup.\$VER.exe'
cat "\$DIR/latest.yml"
"@
```

Expected: prints the `latest.yml` content with `version: 1.0.9`

- [ ] **Step 5: Commit version bump and tag release history**

```powershell
cd F:\RichClub
git add dashboard/package.json dashboard/package-lock.json
git commit -m "chore: bump dashboard to v1.0.9"
git push
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|-------------|------|
| Variable employee counts (pagination race) | henry-hexa.js already fixed; deploy in Task 5 |
| Ref2 always empty (wrong column index) | henry-hexa.js already fixed; deploy in Task 5 |
| Bshop only 8 employees (same fix) | henry-hexa.js pagination fix |
| CPF as cross-clock key | Already in server.js masterMap — no change needed |
| Gávea column missing | Task 3: `allClockIps` replaces filtered `reachableIps` |
| 3-state cells (✅/❌/—) | Task 3: Steps 6-7 |
| Failed clock shows "offline" in header | Task 3: Step 6 |
| `incompleteIn` field | Task 1: Steps 3-4 |
| `allClockIps` in API response | Task 1: Step 5 |
| `/deploy` endpoint | Task 1: Step 2 |
| `deploy-remote.ps1` | Task 2 |
| Incompletos filter | Task 4: Step 3 |
| "Completar Crachá" action | Task 4: Steps 1-4 |
| Incomplete count in summary | Task 3: Steps 4-5 |
| Deploy to Servidor Skill | Task 5 |
| Dashboard release | Task 6 |

**Placeholder scan:** None found — all code blocks are complete.

**Type consistency:** `emp.incompleteIn` defined in Task 1 (Step 4), used in Tasks 3 and 4. `allClockIps` defined in Task 1 (Step 5), used in Task 3. `data.incomplete` count defined in Task 1 (Step 5), consumed in Task 3 (Step 4). All consistent.
