import { useState, useEffect } from 'react'
import { useMachines } from './hooks/useMachines'
import { LocationGroup } from './components/LocationGroup'
import { SplitView } from './components/SplitView'
import { UpdatePanel } from './components/UpdatePanel'
import { OfflineToast }                from './components/OfflineToast'
import { AlertsPanel, useAlertsCount } from './components/AlertsPanel'
import { RhModule } from './components/RhModule'
import { api, setServerUrl, getServerUrl } from './api'

export default function App() {
  const [serverUrl, setServerUrlState] = useState('https://dt-manager.brazilsouth.cloudapp.azure.com')
  const [showSettings, setShowSettings] = useState(false)
  const [showUpdate,   setShowUpdate]   = useState(false)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [configLoaded, setConfigLoaded] = useState(false)
  const [autoWakeEnabled, setAutoWakeEnabled] = useState(false)
  const [autoWakeLoading, setAutoWakeLoading] = useState(false)
  const [generating,      setGenerating]      = useState(false)
  const [generateMsg,     setGenerateMsg]     = useState(null)

  const {
    machines, groupMap, groupsList,
    connected, wsConnected, lastUpdate, alerts,
    lastOffline,
    sendCommand, wolMachine, moveMachineToGroup,
    createGroup, renameGroup, deleteGroup,
    refresh, insightVersion,
  } = useMachines()

  const [offlineToast,    setOfflineToast]    = useState(null)
  const [showAlertsPanel, setShowAlertsPanel] = useState(false)
  const [showRh, setShowRh] = useState(false)
  const [newOfflineAlert, setNewOfflineAlert] = useState(null)
  const [alertsCount,     setAlertsCount]     = useAlertsCount()

  useEffect(() => {
    if (!lastOffline) return
    setOfflineToast(lastOffline)
    setNewOfflineAlert(lastOffline)
    setAlertsCount(c => c + 1)
  }, [lastOffline])

  const [newGroupName,      setNewGroupName]      = useState('')
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [viewMode,          setViewMode]          = useState('split') // 'cards' | 'split'
  const [selectedGroup,     setSelectedGroup]     = useState(null)

  async function handleCreateGroup() {
    const name = newGroupName.trim()
    if (!name) return
    await createGroup(name)
    setNewGroupName('')
    setShowNewGroupInput(false)
  }

  // Carrega config salva (Electron) ou localStorage
  useEffect(() => {
    async function load() {
      let url = serverUrl
      try {
        if (window.electronAPI) {
          const cfg = await window.electronAPI.getConfig()
          if (cfg?.serverUrl) url = cfg.serverUrl
        } else {
          const saved = localStorage.getItem('serverUrl')
          if (saved) url = saved
        }
      } catch {}
      setServerUrlState(url)
      setServerUrl(url)
      setConfigLoaded(true)
      try {
        const settings = await api.getSettings()
        setAutoWakeEnabled(settings.autoWake?.enabled === true)
      } catch {}
    }
    load()
  }, [])

  async function saveServerUrl(url) {
    setServerUrlState(url)
    setServerUrl(url)
    try {
      if (window.electronAPI) {
        await window.electronAPI.setConfig({ serverUrl: url })
      } else {
        localStorage.setItem('serverUrl', url)
      }
    } catch {}
    setShowSettings(false)
    refresh()
  }

  async function toggleAutoWake() {
    setAutoWakeLoading(true)
    try {
      const newVal = !autoWakeEnabled
      await api.updateSettings({ autoWake: { enabled: newVal } })
      setAutoWakeEnabled(newVal)
    } catch (err) {
      alert(`Erro ao alterar Auto-Wake: ${err.message}`)
    } finally {
      setAutoWakeLoading(false)
    }
  }

  async function handleGenerate() {
    setGenerating(true)
    setGenerateMsg(null)
    try {
      const result = await api.generateInsights()
      const n = result?.generated ?? 0
      setGenerateMsg(n > 0 ? `${n} insight${n !== 1 ? 's' : ''} gerado${n !== 1 ? 's' : ''}` : 'Nenhum padrão novo')
      setTimeout(() => setGenerateMsg(null), 4000)
    } catch (err) {
      setGenerateMsg(`Erro: ${err.message}`)
      setTimeout(() => setGenerateMsg(null), 4000)
    } finally {
      setGenerating(false)
    }
  }

  async function handleBiosReport() {
    try {
      const blob = await api.downloadBiosPdf()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `relatorio-bios-${new Date().toISOString().split('T')[0]}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert(`Erro ao gerar relatório: ${err.message}`)
    }
  }

  // Filtra maquinas por busca e status
  // Inclui grupos vazios (sem maquinas) para permitir preparar antes do piloto
  const filteredGroups = Object.entries(groupMap)
    .map(([loc, macs]) => {
      const filtered = macs.filter(m => {
        const matchSearch = !search ||
          (m.displayName || m.id).toLowerCase().includes(search.toLowerCase()) ||
          (m.ipInterno || '').includes(search)
        const matchStatus = filterStatus === 'all' || m.status === filterStatus
        return matchSearch && matchStatus
      })
      // Mantém grupos vazios registrados no servidor mesmo quando filtrando
      const isRegistered = groupsList.some(g => g.name === loc)
      return [loc, filtered, isRegistered]
    })
    .filter(([loc, macs, isRegistered]) => {
      if (search || filterStatus !== 'all') return macs.length > 0
      return macs.length > 0 || isRegistered // mostra grupos vazios so sem filtro
    })
    .sort(([a], [b]) => {
      // "Sem localidade" sempre por ultimo
      if (a === '') return 1
      if (b === '') return -1
      const idxA = groupsList.findIndex(g => g.name === a)
      const idxB = groupsList.findIndex(g => g.name === b)
      if (idxA >= 0 && idxB >= 0) return idxA - idxB
      return a.localeCompare(b)
    })
    .map(([loc, macs]) => [loc, macs])

  const totalOnline  = machines.filter(m => m.status === 'online').length
  const totalOffline = machines.filter(m => m.status === 'offline').length

  if (!configLoaded) return <div className="loading">Carregando...</div>

  return (
    <div className="app">
      {/* Topbar */}
      <header className="topbar">
        <div className="topbar-left">
          <span className="logo">Delirio Manager</span>
          <div className={`conn-status ${connected ? 'connected' : 'disconnected'}`}>
            <span className="conn-dot" />
            {connected ? 'API OK' : 'Sem conexao'}
          </div>
          <div className="conn-status" style={{ color: wsConnected ? 'var(--green)' : 'var(--text-muted)' }}
               title={wsConnected ? 'Tempo real via WebSocket' : 'Atualizando a cada 30s'}>
            <span className="conn-dot" style={{ width: 6, height: 6, background: wsConnected ? 'var(--green)' : '#4b5563' }} />
            {wsConnected ? 'Tempo real' : '30s sync'}
          </div>
        </div>

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

        <div className="topbar-right">
          <div className="stats">
            <span className="stat-chip online">{totalOnline} online</span>
            <span className="stat-chip offline">{totalOffline} offline</span>
          </div>

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

          <button
            className="pill-solo"
            onClick={handleBiosReport}
            title="Gerar PDF com máquinas aguardando configuração de BIOS"
          >
            📋 Rel. BIOS
          </button>

          <button
            className={`pill-solo ${autoWakeEnabled ? 'pill-solo-green' : ''}`}
            onClick={toggleAutoWake}
            disabled={autoWakeLoading}
            title={autoWakeEnabled ? 'Auto-Wake ativado — clique para desativar' : 'Auto-Wake desativado — clique para ativar'}
          >
            {autoWakeLoading ? '...' : autoWakeEnabled ? '🔄 Auto-Wake ON' : '⏻ Auto-Wake'}
          </button>

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
            <button
              className="pill-btn"
              onClick={handleGenerate}
              disabled={generating}
              title="Gerar insights de IA agora (analisa logs das máquinas)"
            >
              {generating ? '⏳...' : generateMsg ? `✨ ${generateMsg}` : '✨ Insights'}
            </button>
          </div>

          <button
            className="pill-solo pill-solo-rh"
            onClick={() => setShowRh(true)}
            title="Módulo RH — Relógios e Funcionários"
          >
            👥 RH
          </button>

          <button
            className="bell-btn"
            onClick={() => { setShowAlertsPanel(v => !v); if (!showAlertsPanel) setAlertsCount(0) }}
            title="Alertas"
          >
            🔔
            {alertsCount > 0 && <span className="bell-badge">{alertsCount}</span>}
          </button>

          <button className="pill-solo" onClick={() => setShowSettings(true)} title="Configuracoes">
            ⚙ Config
          </button>
        </div>
      </header>

      {/* Input rapido para novo grupo */}
      {showNewGroupInput && (
        <div className="new-group-bar">
          <input
            className="new-group-input"
            placeholder="Nome do grupo (ex: Loja Tijuca)"
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateGroup(); if (e.key === 'Escape') setShowNewGroupInput(false) }}
            autoFocus
          />
          <button className="btn btn-primary" onClick={handleCreateGroup}>Criar</button>
          <button className="btn btn-secondary" onClick={() => setShowNewGroupInput(false)}>Cancelar</button>
        </div>
      )}

      {/* Banner de desconexao */}
      {!connected && (
        <div className="offline-banner">
          Sem conexao com o servidor. Tentando reconectar...
        </div>
      )}

      {/* Alertas recentes */}
      {alerts.length > 0 && (
        <div className="alerts-bar">
          {alerts.slice(0, 3).map((a, i) => (
            <div key={i} className={`alert-chip alert-${a.type}`}>
              {a.message}
            </div>
          ))}
        </div>
      )}

      {/* Conteudo principal */}
      {viewMode === 'cards' ? (
        <main className="main-content">
          {filteredGroups.length === 0 ? (
            <div className="empty-state">
              {machines.length === 0
                ? 'Nenhuma maquina registrada. Instale o agente nas maquinas para comecar.'
                : 'Nenhuma maquina encontrada com os filtros atuais.'}
            </div>
          ) : (
            filteredGroups.map(([loc, macs]) => (
              <LocationGroup
                key={loc || '__sem_grupo__'}
                name={loc || 'Sem localidade'}
                machines={macs}
                onCommand={sendCommand}
                onWol={wolMachine}
                onMoveToGroup={moveMachineToGroup}
                onRename={(old, novo) => renameGroup(old, novo)}
                onDelete={() => deleteGroup(loc)}
                groupsList={groupsList}
                isEmpty={macs.length === 0}
              />
            ))
          )}
        </main>
      ) : (
        <SplitView
          filteredGroups={filteredGroups}
          allGroups={
            Object.entries(groupMap)
              .map(([loc, macs]) => [loc, macs, groupsList.some(g => g.name === loc)])
              .filter(([loc, macs, isReg]) => macs.length > 0 || isReg)
              .sort(([a], [b]) => {
                if (a === '') return 1
                if (b === '') return -1
                const iA = groupsList.findIndex(g => g.name === a)
                const iB = groupsList.findIndex(g => g.name === b)
                if (iA >= 0 && iB >= 0) return iA - iB
                return a.localeCompare(b)
              })
          }
          groupsList={groupsList}
          onCommand={sendCommand}
          onWol={wolMachine}
          onMoveToGroup={moveMachineToGroup}
          onRename={renameGroup}
          onDelete={deleteGroup}
          selectedGroup={selectedGroup}
          onSelectGroup={setSelectedGroup}
        />
      )}

      {/* Rodape */}
      <footer className="statusbar">
        <span>{machines.length} maquinas | {groupsList.length} localidades</span>
        {lastUpdate && (
          <span>Atualizado: {lastUpdate.toLocaleTimeString('pt-BR')}</span>
        )}
        <span>{serverUrl}</span>
      </footer>

      {/* Modal de atualizacao de agentes */}
      {showUpdate && <UpdatePanel onClose={() => setShowUpdate(false)} />}

      {/* Modal de configuracoes */}
      {showSettings && (
        <SettingsModal
          currentUrl={serverUrl}
          onSave={saveServerUrl}
          onClose={() => setShowSettings(false)}
        />
      )}

      <OfflineToast toast={offlineToast} onDismiss={() => setOfflineToast(null)} />
      {showAlertsPanel && (
        <AlertsPanel
          newOfflineAlert={newOfflineAlert}
          onClose={() => setShowAlertsPanel(false)}
        />
      )}
      {showRh && <RhModule onClose={() => setShowRh(false)} />}
    </div>
  )
}

function SettingsModal({ currentUrl, onSave, onClose }) {
  const [url, setUrl] = useState(currentUrl)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  // Insights config
  const [aiEnabled,    setAiEnabled]    = useState(false)
  const [aiHasKey,     setAiHasKey]     = useState(false)
  const [aiKey,        setAiKey]        = useState('')
  const [savingAi,     setSavingAi]     = useState(false)
  const [aiMsg,        setAiMsg]        = useState(null)

  useEffect(() => {
    api.getSettings().then(s => {
      setAiEnabled(s.insights?.enabled === true)
      setAiHasKey(s.insights?.hasApiKey === true)
    }).catch(() => {})
  }, [])

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      setServerUrl(url)
      const h = await api.health()
      setTestResult({ ok: true, msg: `OK - v${h.version} - ${h.machines} maquinas` })
    } catch (err) {
      setTestResult({ ok: false, msg: err.message })
    } finally {
      setTesting(false)
    }
  }

  async function saveAiConfig() {
    setSavingAi(true)
    setAiMsg(null)
    try {
      const payload = { insights: { enabled: aiEnabled } }
      if (aiKey.trim()) payload.insights.claude_api_key = aiKey.trim()
      await api.updateSettings(payload)
      if (aiKey.trim()) setAiHasKey(true)
      setAiKey('')
      setAiMsg({ ok: true, text: 'Configuracao salva. Engine reiniciado.' })
    } catch (err) {
      setAiMsg({ ok: false, text: err.message })
    } finally {
      setSavingAi(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">Configuracoes</h2>

        <label className="form-label">URL do servidor</label>
        <input
          className="form-input"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://dt-manager.brazilsouth.cloudapp.azure.com"
        />

        {testResult && (
          <div className={`test-result ${testResult.ok ? 'ok' : 'err'}`}>
            {testResult.msg}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={testConnection} disabled={testing}>
            {testing ? 'Testando...' : 'Testar conexao'}
          </button>
          <button className="btn btn-primary" onClick={() => onSave(url)}>
            Salvar URL
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0' }} />

        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text)' }}>
          ✨ Insights de IA (Claude)
        </h3>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={aiEnabled}
              onChange={e => setAiEnabled(e.target.checked)}
              style={{ accentColor: 'var(--purple)', width: 15, height: 15 }}
            />
            <span className="form-label" style={{ margin: 0 }}>Analise automatica de logs (a cada 6h)</span>
          </label>
        </div>

        <label className="form-label">
          Chave Claude API
          {aiHasKey && !aiKey && (
            <span style={{ marginLeft: 8, color: 'var(--green)', fontSize: 11 }}>● Configurada</span>
          )}
          {!aiHasKey && (
            <span style={{ marginLeft: 8, color: 'var(--red)', fontSize: 11 }}>● Nao configurada</span>
          )}
        </label>
        <input
          className="form-input"
          type="password"
          value={aiKey}
          onChange={e => setAiKey(e.target.value)}
          placeholder={aiHasKey ? 'Digite nova chave para substituir...' : 'sk-ant-api03-...'}
          autoComplete="new-password"
        />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          Obtenha em console.anthropic.com — o modelo usado e claude-haiku-4-5 (barato).
        </div>

        {aiMsg && (
          <div className={`test-result ${aiMsg.ok ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>
            {aiMsg.text}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={saveAiConfig} disabled={savingAi}>
            {savingAi ? 'Salvando...' : 'Salvar config de IA'}
          </button>
        </div>
      </div>
    </div>
  )
}
