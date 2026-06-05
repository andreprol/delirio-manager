# Delirio Manager — Dashboard

Electron desktop application for the Delirio Manager fleet management system. Built with React + Vite, packaged with electron-builder.

## Stack

- **Shell**: Electron 34
- **UI**: React 18 + Vite 6
- **Styling**: Plain CSS (dark theme, CSS variables)
- **State**: React hooks (no external state library)
- **Real-time**: Native WebSocket with auto-reconnect

## Project Structure

```
dashboard/
├── electron/
│   ├── main.js        # Electron main process — window, config storage, IPC
│   └── preload.js     # Context bridge (exposes electronAPI to renderer)
├── src/
│   ├── main.jsx       # React entry point
│   ├── App.jsx        # Root component, settings modal, layout
│   ├── api.js         # HTTP client for all server endpoints
│   ├── styles.css     # All styles (single file, CSS variables)
│   ├── hooks/
│   │   ├── useMachines.js    # Global machine state + WebSocket integration
│   │   └── useWebSocket.js   # WebSocket connection with auto-reconnect
│   └── components/
│       ├── MachineCard.jsx           # Expandable machine card with tabs
│       ├── LocationGroup.jsx         # Group of machine cards (cards view)
│       ├── SplitView.jsx             # Split layout: sidebar + machine panel
│       ├── GlobalInsightsPanel.jsx   # AI insights bar at the top
│       ├── InsightsTab.jsx           # AI insights tab inside MachineCard
│       ├── EventsTab.jsx             # Windows Event Log tab inside MachineCard
│       ├── AlertsPanel.jsx           # Sliding alerts history panel
│       ├── OfflineToast.jsx          # Toast notification for offline machines
│       └── UpdatePanel.jsx           # Agent update broadcast modal
└── package.json
```

## Development

```bash
npm install
npm run dev        # Vite dev server at http://localhost:5173
```

> In dev mode, the Electron window loads from `http://localhost:5173`. Run `npm run dev` and open the Electron app (or just use the browser for layout work).

## Build

```bash
npm run build      # Vite build only (dist/) — does NOT update the packaged app
npm run dist       # Full Electron build → dist-electron/
```

> **Critical**: Always use `npm run dist` when you want to test the packaged app. The Electron executable loads from an `.asar` archive that is only updated by `npm run dist`. Running `npm run build` alone has no effect on the installed app.

### Output

- `dist-electron/win-unpacked/Delirio Manager.exe` — portable executable (no install needed)
- `dist-electron/Delirio Manager Setup 1.0.0.exe` — NSIS installer

## Key Design Decisions

### Single CSS file
All styles live in `src/styles.css` using CSS custom properties (`--bg`, `--green`, `--red`, etc.). No CSS-in-JS, no Tailwind — keeps the bundle small and the dark theme easy to maintain.

### No external state management
Machine state is managed by the `useMachines` hook using plain `useState` + `useCallback`. WebSocket events update the state directly without any store.

### Config persistence
The server URL is stored via Electron's `app.getPath('userData')/config.json` (Windows: `%APPDATA%\delirio-manager-dashboard\config.json`). In the browser (non-Electron), it falls back to `localStorage`.

### AI Insights refresh flow
```
Server generates insight
    → WebSocket broadcast: new_insight
    → useMachines: insightVersion++
    → GlobalInsightsPanel: re-fetches via useEffect([refreshTrigger])
    → UI updates automatically
```

## Components Overview

### MachineCard
Expandable card showing machine status. Three tabs when expanded:
- **Metrics** — live CPU/RAM/disk bars, temperatures, IP, MAC, uptime
- **Events** — Windows Event Log (focused: critical IDs only / full: last 200)
- **✨ Insights** — AI-detected patterns with severity and suggested solutions

### GlobalInsightsPanel
Collapsible bar rendered above the main content area. Starts collapsed to preserve screen space. Shows up to 10 insights sorted by severity. Includes a "Generate now" button that triggers an immediate server-side AI analysis cycle.

### SplitView
Two-pane layout: location sidebar on the left, machine grid on the right. Location items support right-click context menu for rename/delete. Double-click on a location name to inline-rename.

### useMachines Hook
Central state hub. Manages:
- HTTP polling every 30 seconds as fallback
- WebSocket message handling (machine updates, offline events, group changes, insights)
- All mutation actions (commands, WoL, group management)
- Exposes `insightVersion` for insight refresh triggering

## Server URL Configuration

Default: `https://dt-manager.brazilsouth.cloudapp.azure.com`

Change via: **⚙ Config → URL do servidor → Salvar URL**

The app includes a connection test button that calls `/health` to verify the URL before saving.
