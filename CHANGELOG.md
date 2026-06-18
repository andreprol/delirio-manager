# Changelog

All notable changes to Delirio Manager are documented here.

---

## [1.0.20] — 2026-06-18

### Added
- **NF-Ce search + DANFE**: new "Buscar DANFE" tab in the Aloha module
  - Filter by BOH server, date range, value range, and product text
  - Download DANFE as PDF directly from the dashboard
  - Send DANFE by email with PDF attachment — mandatory CC to bruno@delirio.com.br and suporteti@delirio.com.br
- **Agent v1.5.3**: new `aloha-index-nfce-day` command — parses all NF-Ce XMLs from `C:\Bootdrv\AlohaFiscal\ServerData\XML\{DD}\NFCe\`, extracts chave, date, value, products, payment, QR code
- **Server**: `nfce_index` SQLite table with full-text product search and date/value filters
- **Server**: `routes/aloha.js` — six new endpoints: trigger indexing, index status, NF-Ce search, get by chave, download DANFE PDF, send email
- **Server**: `services/danfe.js` — DANFE NFC-e PDF generation with pdfkit
- **Server**: `services/nfce-mailer.js` — nodemailer email with HTML DANFE + PDF attachment
- **Server**: automatic indexer scheduled at 23:00 — sends indexing commands to all online BOH machines for the current month
- **Server**: JSON body limit increased from 1MB to 5MB to accommodate indexing responses

---

## [1.0.19] — 2026-06-18

### Changed
- **Aloha module**: removed manual "🔍 Escanear" button — scanning is now fully automatic on expand
- **Agent v1.5.2**: `aloha-scan` now scans `.DBF` files (dBASE Aloha database) instead of SQL Server files; walks `C:\Bootdrv` (skipping AlohaFiscal subtree) and lists top 10 most recent NF-Ce XMLs from `C:\Bootdrv\AlohaFiscal\ServerData\XML`

---

## [1.0.18] — 2026-06-18

### Changed
- **Aloha module** moved from a tab inside MachineCard to a dedicated full-screen overlay module
- Topbar now has 🍕 **Aloha** button (orange) alongside 👥 RH — same pattern
- `MachineCard.jsx` reverted to original state (no Aloha tab)

### Added
- `AlohaModule.jsx` — full-screen overlay listing all BOH servers with scan controls
- Orange CSS class `.pill-solo-aloha` in `styles.css`

---

## [1.0.17] — 2026-06-18

### Added
- **Agent v1.5.1**: new `aloha-scan` command — walks `C:\Bootdrv` recursively and classifies files
  - Database files: `.mdb`, `.mdf`, `.ldf`, `.ndf`, `.db`, `.sqlite`, `.sdf`
  - XML fiscal: `.xml`, `.nfe`, `.nfce` — returns top 10 most recent
  - Config files: `.ini`, `.cfg`, `.conf`, `.config`
  - Returns summary: total files, total size MB, directories list
- **Server**: `GET /api/machines/:id/aloha` — returns latest scan result
- **Server**: `aloha-scan` added to command allowlist in `routes/machines.js`
- **Server**: `getLastAlohaScan()` function in `db.js`
- **Dashboard**: `api.aloha` namespace in `api.js` (`scan`, `getLatest`)
- **Dashboard**: `AlohaTab.jsx` component (superseded by v1.0.18's AlohaModule)

---

## [1.0.16] — 2026-06-17

### Changed
- RH module: partial refresh per clock after RH operations (enroll, update-card, remove)
- Reduces full list reload to targeted single-clock refresh

---

## [1.0.15] — 2026-06-17

### Added
- LGPD path via UNC share (`\\dtfiles.file.core.windows.net\central\LGPD`)
- "Abrir pasta LGPD" button in audit view for direct folder access

---

## [1.0.14] — 2026-06-17

### Added
- LGPD kit on employee removal: automatic log entry + comprovante PDF saved to `G:\CENTRAL\LGPD`

---

## [1.0.13] — 2026-06-16

### Added
- Per-employee "Editar" button in employee table
- Dynamic "Atualizar offline" toggle per clock
- Pre-check reachability before enroll/update-card operations
- Auto-deselect offline clocks

---

## [1.0.12] — 2026-06-16

### Fixed
- `ref2` parsing: concat-then-split strategy (handles combined Refs column)
- Partial clock refresh after operations
- Debug endpoint for employee listing

---

## [1.0.11] — 2026-06-15

### Fixed
- `ref2` column reading from Henry Hexa ADV export
- Clock selector in employee comparison matrix
- `isDivergent` expanded logic

---

## [1.0.10] — 2026-06-15

### Fixed
- Employee listing: deduplication + ref2 column + deterministic pagination

---

## [1.0.9] — 2026-06-14

### Fixed
- Prevent concurrent "Completar Crachá" calls
- Block Remove action while Completar is in progress

---

## [1.0.8] — 2026-06-13

### Added
- Version badge in topbar
- Employee data cache across tab switches in RH module

---

## [1.0.7] — 2026-06-13

### Added
- "Não divergentes" filter in employee table
- `ref2` column in employee comparison matrix
- "Novo Funcionário" button

---

## [1.0.6] — 2026-06-12

### Changed
- `/rh/employees` now async with background job, cache, and frontend polling

---

## [1.0.5] — 2026-06-12

### Fixed
- Niterói clock IP corrected (`192.168.20.150` → `192.168.10.150`)
- Auto-update triggered for IP fix

---

## [1.0.4] — 2026-06-11

### Added
- Live search in SplitView (shows all matching machines across groups)
- Minor layout fixes

---

## [1.0.3] — 2026-06-10

### Added
- 👥 **RH button** in topbar — full-screen overlay module (same pattern now used by Aloha)
- `RhModule.jsx` with Status, Employees, and Audit tabs
- `EmployeeTable` — comparison matrix with CRUD operations
- `ClockStatusGrid` — per-clock status display

---

## [1.0.2] — 2026-06-09

### Added
- `dt-clock-proxy` integration — Henry Hexa ADV clock proxy service
- LGPD offboarding workflow (initial version)

---

## [1.0.1] — 2026-06-08

### Changed
- Removed GlobalInsightsPanel
- Added Insights button to topbar

---

## [1.0.0] — 2026-06-07

### Added
- Initial release
- Fleet management: real-time monitoring, WebSocket, heartbeat every 30s
- Machine cards: CPU, RAM, disk, temperatures, uptime, IP, MAC
- Location groups with display order
- Remote commands: reboot, shutdown, cancel-shutdown, Wake-on-LAN, self-uninstall
- Auto-Wake for WoL-confirmed machines
- Windows Event Log viewer per machine
- AI Insights via Claude Haiku (6-hour interval)
- BIOS configuration report PDF export
- Agent auto-update pipeline
- Azure VM deployment (brazilsouth, Standard_B1ms)
