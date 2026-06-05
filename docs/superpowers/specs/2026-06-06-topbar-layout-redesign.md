# Topbar Layout Redesign — Design Spec

## Objetivo

Corrigir três problemas de layout no dashboard Electron do Delirio Manager:
1. Nomes de máquinas truncados nos cards
2. Botões do menu ficam ocultos/cortados em janelas menores
3. Visual do topbar pouco estruturado

## Decisão de Design: Opção C2

Aprovada pelo usuário após comparação visual. Características:
- **Pills modulares**: botões agrupados em "pills" por função
- **Busca centralizada**: spacers iguais dos dois lados, largura fixa (~260px), filtro de status junto dela
- **Cards com mínimo maior**: 210px (era 180px) — nomes sempre visíveis
- **Largura mínima da janela**: 1200px (era 900px)

---

## Mudanças por arquivo

### 1. `dashboard/electron/main.js`
- `minWidth: 900` → `minWidth: 1200`
- `width: 1400` permanece (já adequado)

### 2. `dashboard/src/styles.css`

#### Cards — mínimo de largura
```css
/* Antes */
.group-machines {
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}
.split-machines {
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}

/* Depois */
.group-machines {
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
}
.split-machines {
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
}
```

#### Topbar center — busca centralizada
```css
/* Antes */
.topbar-center { display: flex; gap: 8px; flex: 1; }

/* Depois */
.topbar-center {
  display: flex; align-items: center; gap: 8px;
  flex: 1; justify-content: center;
}
.topbar-search { width: 260px; flex-shrink: 0; }
```

#### Novos estilos — Pills
Adicionar ao styles.css:
```css
/* ── Pill groups (topbar) ────────────────────────────────────────────────── */
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

#### Remover / substituir
- `.view-toggle`, `.view-btn`, `.view-btn-active` — substituídos por `.pill-group` / `.pill-btn` / `.pill-btn-active`
- `.icon-btn`, `.icon-btn-active` — substituídos por `.pill-solo` / `.pill-solo-green`

### 3. `dashboard/src/App.jsx`

#### topbar-center: layout C2
```jsx
<div className="topbar-center">
  {/* spacer esquerdo */}
  <div style={{ flex: 1 }} />
  <input
    className="search-input topbar-search"
    placeholder="Buscar máquina ou IP..."
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
  {/* spacer direito */}
  <div style={{ flex: 1 }} />
</div>
```

#### topbar-right: pills modulares
```jsx
<div className="topbar-right">
  {/* Stats */}
  <span className="stat-chip online">{totalOnline} online</span>
  <span className="stat-chip offline">{totalOffline} offline</span>

  {/* View toggle pill */}
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
  <button className="pill-solo" onClick={handleBiosReport} title="Gerar PDF com máquinas aguardando BIOS">
    📋 Rel. BIOS
  </button>

  {/* Auto-Wake toggle */}
  <button
    className={`pill-solo ${autoWakeEnabled ? 'pill-solo-green' : ''}`}
    onClick={toggleAutoWake}
    disabled={autoWakeLoading}
    title={autoWakeEnabled ? 'Auto-Wake ativado — clique para desativar' : 'Auto-Wake desativado'}
  >
    {autoWakeLoading ? '...' : autoWakeEnabled ? '🔄 Auto-Wake ON' : '⏻ Auto-Wake'}
  </button>

  {/* Ações de gestão */}
  <div className="pill-group">
    <button className="pill-btn" onClick={() => setShowNewGroupInput(v => !v)} title="Criar novo grupo">
      + Grupo
    </button>
    <button className="pill-btn" onClick={refresh} title="Atualizar">
      ↻
    </button>
    <button className="pill-btn" onClick={() => setShowUpdate(true)} title="Publicar nova versão do agente">
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
  <button className="pill-solo" onClick={() => setShowSettings(true)} title="Configurações">
    ⚙ Config
  </button>
</div>
```

---

## Resumo de arquivos tocados

| Arquivo | Tipo de mudança |
|---------|----------------|
| `dashboard/electron/main.js` | `minWidth` 900 → 1200 |
| `dashboard/src/styles.css` | grid `180px` → `210px` (×2), novo CSS pills, remover `.view-toggle`/`.icon-btn` |
| `dashboard/src/App.jsx` | topbar-center com spacers, topbar-right com pills |

---

## O que NÃO muda
- Lógica de filtros, busca, viewMode
- Qualquer componente filho (LocationGroup, SplitView, MachineCard, etc.)
- Servidor, agente, deploy
- Demais estilos (cards, modais, sidebar, etc.)
