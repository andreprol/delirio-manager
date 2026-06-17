# Design: Employee Reading, Sync & Remote Deploy

**Date:** 2026-06-17  
**Project:** Delirio Manager — dt-clock-proxy + dashboard  
**Status:** Approved

---

## Section 1 — Remote Deploy (via Azure VM)

### Problem

`henry-hexa.js` and `server.js` changes on André's dev machine need to reach **Servidor Skill** (`192.168.17.252:4321`, Escritório Central). André's home machine is on a different network — no direct route to `192.168.17.252`.

### Network Topology

```
André (home)
  ↓  az vm run-command (Azure CLI)
Azure VM  10.0.0.4
  ↓  IPsec VPN
Metro pfSense  192.168.14.1
  ↓  IPsec VPN
EC pfSense  192.168.17.1
  ↓  LAN
Servidor Skill  192.168.17.252:4321
```

The Metro pfSense already proxies HTTP from the outside on port 4321 (confirmed in prior session — reachable via `192.168.14.1:4321` from Azure VM).

### Solution

Add `POST /deploy` endpoint to **dt-clock-proxy** (`server.js`). It:
1. Accepts `{ targetDir?: string }` (defaults to `C:\DtClockProxy`)
2. Runs `git pull` in the target dir
3. Restarts the service via PowerShell `Restart-Service` or `node server.js` kill+start
4. Returns `{ success, stdout, stderr }`

**Protected by the same `API_TOKEN` Bearer auth** already on all routes.

**Deploy flow from Claude Code:**

```
az vm run-command invoke \
  --resource-group <rg> --name <vm> \
  --command-id RunPowerShellScript \
  --scripts "Invoke-RestMethod -Uri http://192.168.14.1:4321/deploy -Method POST -Headers @{Authorization='Bearer $TOKEN'} -ContentType 'application/json' -Body '{\"targetDir\":\"C:\\\\DtClockProxy\"}'"
```

The Azure VM is already authenticated and reachable. Metro pfSense forwards `:4321` inbound to Servidor Skill transparently.

### Service restart strategy

Servidor Skill runs `node server.js` as a Windows service (confirmed: **not PM2**). The `/deploy` endpoint will:
1. Pull latest code
2. Restart the Windows service by name (e.g. `Restart-Service dt-clock-proxy`)
3. If service name unknown, kill the node process by port and let the service manager respawn

---

## Section 2 — Gávea Column & 3-State Clock Cells

### Problem

`getReachableIps()` in `EmployeeTable.jsx` filters by `c.success > 0 || c.total > 0`, excluding clocks that were attempted but returned errors. This means:
- Failed clock columns disappear entirely from the table header
- Gávea (`192.168.15.151`) is missing even when it was attempted

### Solution

Change `getReachableIps()` to return **all clock IPs that appear in `data.clocks`**, regardless of success status.

Per-cell logic (3 states):

| State | Condition | Display |
|-------|-----------|---------|
| ✅ Present | `emp.presentIn.includes(ip)` | ✅ |
| ❌ Absent (confirmed) | clock succeeded + emp not present | ❌ |
| `—` | clock failed | `—` (grayed) |

Column header shows clock name + `(offline)` when failed.

### Backend change

`server.js` `runEmployeesInBackground()` must include `allClockIps` in the response:

```js
allClockIps: CLOCK_IPS,   // full list regardless of success
```

This lets the frontend always render all 9 columns.

---

## Section 3 — Incomplete Employees (ref2 missing)

### Problem

An employee can be present in all clocks but have `ref2` (NFC crachá UID) empty in one or more of them. Currently this isn't flagged — `isDivergent()` only checks `absentIn.length > 0`.

### Backend: `incompleteIn[]`

In `runEmployeesInBackground()`, after building masterMap:

```js
for (const emp of masterMap.values()) {
  emp.absentIn    = reachableIps.filter(ip => !emp.presentIn.includes(ip));
  emp.incompleteIn = emp.ref2
    ? reachableIps.filter(ip =>
        emp.presentIn.includes(ip) &&
        !clockEmployeeRef2Map[ip]?.[emp.cpf]   // ref2 empty at that clock
      )
    : [];
}
```

Requires keeping a per-clock ref2 map during the merge phase.

### Frontend: 3 new behaviors

1. **Cell decoration**: ⚠️ in the clock column cell when `emp.incompleteIn.includes(ip)` — employee present but ref2 missing there.

2. **Filter**: New tab/toggle "Incompletos" showing employees where `incompleteIn.length > 0` (regardless of `absentIn`).

3. **Action "Completar Crachá"**: Appears when employee has `ref2` in master AND `incompleteIn.length > 0`. Calls `PUT /rh/employee` with `{ cpf, ref2, clockIps: emp.incompleteIn }`.

---

## Data Flow Summary

```
runEmployeesInBackground()
  ↓ per-clock: henry.listEmployees()          [fixed: pagination, ref2 col, dedup]
  ↓ build masterMap (best ref1+ref2)          [fixed]
  ↓ compute absentIn[], incompleteIn[]        [new]
  ↓ return { employees, clocks, allClockIps } [allClockIps new]

GET /rh/employees → EmployeeTable.jsx
  ↓ columns = allClockIps (always 9)          [fixed]
  ↓ cells: ✅ / ❌ / — / ⚠️                  [fixed+new]
  ↓ filter: Divergentes | Incompletos | Todos  [new]
  ↓ action: Sincronizar | Completar Crachá | Remover [Completar Crachá new]

POST /deploy (from az vm run-command)
  ↓ git pull + service restart                [new]
```

---

## Files to Change

| File | Change |
|------|--------|
| `clock-proxy/server.js` | Add `/deploy` endpoint; add `incompleteIn` + per-clock ref2 map; add `allClockIps` to response |
| `clock-proxy/henry-hexa.js` | Already fixed locally (pagination race + ref2 col + dedup) |
| `dashboard/src/components/EmployeeTable.jsx` | Fix `getReachableIps()`; 3-state cells; incomplete filter; Completar Crachá action |
| `dashboard/src/api.js` | Verify `updateCard` calls `PUT /rh/employee` |
