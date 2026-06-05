# Topbar Layout Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir nomes truncados nos cards, garantir visibilidade completa do menu em qualquer tamanho de janela, e redesenhar o topbar com estilo "pills modulares" (Opção C2 aprovada).

**Architecture:** Três arquivos tocados — `main.js` (largura mínima da janela), `styles.css` (novo sistema de pills + grid maior), `App.jsx` (layout C2: busca centralizada com spacers, botões em grupos funcionais). Zero mudanças em lógica, servidor ou componentes filhos.

**Tech Stack:** Electron 34, React 19, CSS custom properties (já existentes no projeto)

---

## Mapa de arquivos

| Arquivo | Ação | O que muda |
|---------|------|------------|
| `dashboard/electron/main.js` | Modificar | `minWidth: 900` → `minWidth: 1200` |
| `dashboard/src/styles.css` | Modificar | Grid 180→210px (×2), adicionar `.pill-group/.pill-btn/.pill-solo`, remover `.view-toggle/.view-btn/.icon-btn` |
| `dashboard/src/App.jsx` | Modificar | topbar-center com spacers, topbar-right com pills |

---

## Task 1: Largura mínima da janela Electron

**Files:**
- Modify: `dashboard/electron/main.js`

- [ ] **Step 1: Atualizar minWidth**

Localizar a linha `minWidth: 900` dentro de `new BrowserWindow({...})` e substituir por:

```javascript
minWidth: 1200,
```

O arquivo completo após a mudança:

```javascript
'use strict'

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const fs   = require('fs')

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')
const IS_DEV      = process.env.NODE_ENV === 'development' || !app.isPackaged

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { serverUrl: 'https://dt-manager.brazilsouth.cloudapp.azure.com' }
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

function createWindow() {
  const win = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  1200,
    minHeight: 600,
    title: 'Delirio Manager',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })

  if (!IS_DEV) win.setMenuBarVisibility(false)

  if (IS_DEV) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', (_, cfg) => { saveConfig(cfg); return true })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

---

## Task 2: CSS — grid maior + sistema de pills

**Files:**
- Modify: `dashboard/src/styles.css`

- [ ] **Step 1: Aumentar mínimo dos cards de 180px para 210px**

Localizar `.group-machines` (linha ~145) e `.split-machines` (linha ~405) e alterar em ambas:

```css
/* .group-machines */
.group-machines {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 6px;
  align-items: start;
}

/* .split-machines */
.split-machines {
  flex: 1; overflow-y: auto; padding: 16px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 6px; align-content: start;
}
```

- [ ] **Step 2: Adicionar classe `.topbar-search` para fixar largura da busca**

Localizar o bloco `.search-input` (linha ~61) e adicionar logo abaixo:

```css
.topbar-search { width: 260px; flex-shrink: 0; }
```

- [ ] **Step 3: Remover classes antigas de topbar que serão substituídas**

Localizar e **deletar completamente** os blocos:
- `.view-toggle { ... }` (linha ~332)
- `.view-btn { ... }` (linha ~336)
- `.view-btn:hover { ... }` (linha ~340)
- `.view-btn-active { ... }` (linha ~341)
- `.icon-btn { ... }` (linha ~81)
- `.icon-btn:hover { ... }` (linha ~86)

- [ ] **Step 4: Adicionar sistema de pills no lugar das classes removidas**

Adicionar ao final da seção `/* ── Topbar ── */` (após `.topbar *`), substituindo onde estavam `.icon-btn` e `.view-toggle`:

```css
/* ── Pills (topbar buttons) ─────────────────────────────────────────────── */
.pill-group {
  display: flex;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  flex-shrink: 0;
}
.pill-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 11px; font-size: 12px; cursor: pointer;
  background: transparent; border: none;
  border-right: 1px solid var(--border);
  color: var(--text-muted);
  transition: all .15s;
  white-space: nowrap;
}
.pill-btn:last-child { border-right: none; }
.pill-btn:hover { background: var(--border); color: var(--text); }
.pill-btn-active { background: var(--blue) !important; color: #fff !important; }

.pill-solo {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 11px; font-size: 12px; cursor: pointer;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text-muted);
  transition: all .15s; white-space: nowrap; flex-shrink: 0;
}
.pill-solo:hover { background: var(--border); color: var(--text); }
.pill-solo:disabled { opacity: .5; cursor: not-allowed; }

.pill-solo-green {
  background: rgba(34,197,94,.1);
  border-color: rgba(34,197,94,.3);
  color: var(--green);
}
.pill-solo-green:hover { background: rgba(34,197,94,.2); }
```

---

## Task 3: App.jsx — topbar-center e topbar-right

**Files:**
- Modify: `dashboard/src/App.jsx`

- [ ] **Step 1: Substituir o bloco `topbar-center` inteiro**

Localizar o bloco:
```jsx
        <div className="topbar-center">
          <input
            className="search-input"
            placeholder="Buscar maquina ou IP..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className="filter-select"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
          >
            <option value="all">Todas ({machines.length})</option>
            <option value="online">Online ({totalOnline})</option>
            <option value="offline">Offline ({totalOffline})</option>
          </select>
        </div>
```

Substituir por:
```jsx
        <div className="topbar-center">
          <div style={{ flex: 1 }} />
          <input
            className="search-input topbar-search"
            placeholder="Buscar maquina ou IP..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className="filter-select"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
          >
            <option value="all">Todas ({machines.length})</option>
            <option value="online">Online ({totalOnline})</option>
            <option value="offline">Offline ({totalOffline})</option>
          </select>
          <div style={{ flex: 1 }} />
        </div>
```

- [ ] **Step 2: Substituir o bloco `topbar-right` inteiro**

Localizar o bloco `<div className="topbar-right">` e todo seu conteúdo até o `</div>` de fechamento.

O bloco atual começa em:
```jsx
        <div className="topbar-right">
          <div className="stats">
```

Substituir **todo** o bloco por:
```jsx
        <div className="topbar-right">
          <div className="stats">
            <span className="stat-chip online">{totalOnline} online</span>
            <span className="stat-chip offline">{totalOffline} offline</span>
          </div>

          {/* View toggle */}
          <div className="pill-group">
            <button
              className={`pill-btn ${viewMode === 'cards' ? 'pill-btn-active' : ''}`}
              onClick={() => setViewMode('cards')}
              title="Visualização em cards"
            >⊞ Cards</button>
            <button
              className={`pill-btn ${viewMode === 'split' ? 'pill-btn-active' : ''}`}
              onClick={() => setViewMode('split')}
              title="Visualização em painel"
            >▤ Painel</button>
          </div>

          {/* Relatório BIOS */}
          <button
            className="pill-solo"
            onClick={handleBiosReport}
            title="Gerar PDF com máquinas aguardando configuração de BIOS"
          >
            📋 Rel. BIOS
          </button>

          {/* Auto-Wake toggle */}
          <button
            className={`pill-solo ${autoWakeEnabled ? 'pill-solo-green' : ''}`}
            onClick={toggleAutoWake}
            disabled={autoWakeLoading}
            title={autoWakeEnabled ? 'Auto-Wake ativado — clique para desativar' : 'Auto-Wake desativado — clique para ativar'}
          >
            {autoWakeLoading ? '...' : autoWakeEnabled ? '🔄 Auto-Wake ON' : '⏻ Auto-Wake'}
          </button>

          {/* Grupo + Atualizar + Agentes */}
          <div className="pill-group">
            <button className="pill-btn" onClick={() => setShowNewGroupInput(v => !v)} title="Criar novo grupo">
              + Grupo
            </button>
            <button className="pill-btn" onClick={refresh} title="Atualizar">
              ↻
            </button>
            <button className="pill-btn" onClick={() => setShowUpdate(true)} title="Publicar nova versao do agente">
              ⬆ Agentes
            </button>
          </div>

          {/* Alertas */}
          <button
            className="bell-btn"
            onClick={() => { setShowAlertsPanel(v => !v); if (!showAlertsPanel) setAlertsCount(0) }}
            title="Alertas"
          >
            🔔
            {alertsCount > 0 && <span className="bell-badge">{alertsCount}</span>}
          </button>

          {/* Config */}
          <button className="pill-solo" onClick={() => setShowSettings(true)} title="Configuracoes">
            ⚙ Config
          </button>
        </div>
```

---

## Task 4: Build Electron

- [ ] **Step 1: Build do dashboard**

```powershell
cd F:\RichClub\dashboard
npm run build
```

Esperado: conclusão sem erros de TypeScript/JSX. Pasta `dist/` atualizada.

- [ ] **Step 2: Verificar visualmente**

Fechar e reabrir o Delirio Manager (Electron).

Checklist visual:
- [ ] Topbar mostra pills agrupados: `⊞ Cards | ▤ Painel`, `📋 Rel. BIOS`, `⏻ Auto-Wake`, `+ Grupo | ↻ | ⬆ Agentes`, `🔔`, `⚙ Config`
- [ ] Busca centralizada, não invade os botões
- [ ] Nomes de máquinas visíveis nos cards (sem "...")
- [ ] Botão Auto-Wake OFF: cinza neutro
- [ ] Clicar Auto-Wake: fica verde com `🔄 Auto-Wake ON`
- [ ] Janela não redimensiona abaixo de 1200px
