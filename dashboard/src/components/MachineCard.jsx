import { useState, useEffect, useRef } from 'react'
import { EventsTab } from './EventsTab'
import { InsightsTab } from './InsightsTab'

const STATUS_COLOR = { online: '#22c55e', offline: '#ef4444', unknown: '#6b7280' }
const STATUS_LABEL = { online: 'Online', offline: 'Offline', unknown: 'Desconhecido' }

const WOL_BADGE = {
  unknown:         null,
  driver_disabled: { color: '#ef4444', label: 'WoL ✗',     title: 'Driver Windows desabilitado — agente tentou habilitar' },
  driver_enabled:  { color: '#f59e0b', label: 'WoL ○',      title: 'Driver OK — WoL não testado. Desligue e Ligue para testar.' },
  testing:         { color: '#f59e0b', label: 'WoL …',       title: 'Teste em andamento' },
  wol_confirmed:   { color: '#22c55e', label: 'WoL ✓',       title: 'Wake-on-LAN confirmado e funcionando' },
  bios_needed:     { color: '#f59e0b', label: 'WoL ⚠ BIOS', title: 'Driver OK mas BIOS precisa ser configurado. Verifique alertas.' },
}

export function MachineCard({ machine, onCommand, onWol, onMoveToGroup, groupsList = [] }) {
  const [expanded,    setExpanded]    = useState(false)
  const [confirmCmd,  setConfirmCmd]  = useState(null)
  const [confirmText, setConfirmText] = useState('')
  const [loading,     setLoading]     = useState(false)
  const [contextMenu, setContextMenu] = useState(null)
  const [activeTab,     setActiveTab]     = useState('metrics')
  const [eventsUnread,  setEventsUnread]  = useState(machine.winEventsUnread || 0)
  const [insightsUnread, setInsightsUnread] = useState(0)

  const menuRef = useRef(null)

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contextMenu])

  function handleRightClick(e) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const m       = machine.lastMetrics || {}
  const status  = machine.status || 'unknown'
  const isCrit  = machine.critica
  const color   = STATUS_COLOR[status]

  const ramPct  = m.ramTotalMB > 0 ? ((m.ramTotalMB - m.ramFreeMB) / m.ramTotalMB) * 100 : 0
  const diskPct = m.diskTotalGB > 0 ? ((m.diskTotalGB - m.diskFreeGB) / m.diskTotalGB) * 100 : 0

  const lastSeen = machine.lastSeen
    ? new Date(machine.lastSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : '--:--'

  function formatDuration(fromIso) {
    if (!fromIso) return null
    const diffMs  = Date.now() - new Date(fromIso).getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return 'agora'
    if (diffMin < 60) return `${diffMin}min`
    const h = Math.floor(diffMin / 60)
    const d = Math.floor(h / 24)
    if (d > 0) return `${d}d ${h % 24}h`
    return `${h}h ${diffMin % 60}min`
  }

  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 60000)
    return () => clearInterval(t)
  }, [])

  const onlineDuration  = status === 'online'  && machine.onlineSince ? formatDuration(machine.onlineSince) : null
  const offlineDuration = status === 'offline' && machine.lastSeen    ? formatDuration(machine.lastSeen)   : null

  async function handleCommand(type) {
    if (type === 'uninstall' || (isCrit && ['reboot','shutdown'].includes(type))) {
      setConfirmCmd(type); setConfirmText(''); return
    }
    await execCommand(type)
  }

  async function execCommand(type, confirmVal) {
    setLoading(true)
    try { await onCommand(machine.id, type, {}, confirmVal) }
    catch (err) { alert(`Erro: ${err.message}`) }
    finally { setLoading(false); setConfirmCmd(null) }
  }

  const confirmId = confirmCmd === 'uninstall'
    ? (machine.displayName || machine.id)
    : machine.id

  return (
    <>
    <div
      className={`mc ${status} ${isCrit ? 'mc-crit' : ''} ${expanded ? 'mc-open' : ''}`}
      onClick={() => !confirmCmd && setExpanded(e => !e)}
      onContextMenu={handleRightClick}
    >
      {/* ── Linha compacta (sempre visível) ── */}
      <div className="mc-row">
        <span className="mc-dot" style={{ background: color }} />
        <span className="mc-name" title={machine.hostname}>
          {machine.displayName || machine.hostname}
        </span>
        {isCrit && <span className="mc-badge-crit">CRIT</span>}
        {machine.pendingCommand && <span className="mc-badge-pend">…</span>}
        {(() => {
          const badge = WOL_BADGE[machine.wolStatus]
          if (!badge) return null
          return (
            <span
              style={{
                fontSize: '10px',
                padding: '1px 5px',
                borderRadius: '4px',
                background: badge.color + '22',
                color: badge.color,
                border: `1px solid ${badge.color}55`,
                cursor: 'default',
                marginLeft: '4px',
              }}
              title={badge.title}
            >
              {badge.label}
            </span>
          )
        })()}
        <span className="mc-status" style={{ color }}>{STATUS_LABEL[status]}</span>
      </div>

      {/* ── Painel expandido ── */}
      {expanded && (
        <div className="mc-detail" onClick={e => e.stopPropagation()}>
          <div className="mc-tabs">
            <button
              className={`mc-tab ${activeTab === 'metrics' ? 'mc-tab-active' : ''}`}
              onClick={() => setActiveTab('metrics')}
            >Métricas</button>
            <button
              className={`mc-tab ${activeTab === 'events' ? 'mc-tab-active' : ''}`}
              onClick={() => setActiveTab('events')}
            >
              Eventos
              {eventsUnread > 0 && (
                <span className="tab-badge">{eventsUnread}</span>
              )}
            </button>
            <button
              className={`mc-tab ${activeTab === 'insights' ? 'mc-tab-active' : ''}`}
              onClick={() => setActiveTab('insights')}
            >
              ✨ Insights
              {insightsUnread > 0 && <span className="tab-badge">{insightsUnread}</span>}
            </button>
          </div>

          {activeTab === 'metrics' && (
            <>
              <div className="mc-info-grid">
                <span className="mc-info-label">IP</span>
                <span>{machine.ipInterno || '—'}</span>
                <span className="mc-info-label">MAC</span>
                <span>{machine.mac || '—'}</span>
                {machine.wolStatus && machine.wolStatus !== 'unknown' && (() => {
                  const badge = WOL_BADGE[machine.wolStatus]
                  if (!badge) return null
                  return (
                    <>
                      <span className="mc-info-label">WoL</span>
                      <span style={{ color: badge.color }} title={badge.title}>
                        {badge.label}
                        {machine.wolStatus === 'bios_needed' && machine.motherboard && (
                          <span style={{ color: '#6b7280', fontSize: '11px', marginLeft: '4px' }}>
                            ({machine.motherboard.split('|')[0]})
                          </span>
                        )}
                      </span>
                    </>
                  )
                })()}
                {status === 'online' && onlineDuration && (
                  <>
                    <span className="mc-info-label">Online há</span>
                    <span style={{ color: 'var(--green)' }}>{onlineDuration}</span>
                  </>
                )}
                {status === 'offline' && offlineDuration && (
                  <>
                    <span className="mc-info-label">Offline há</span>
                    <span style={{ color: 'var(--red)' }}>{offlineDuration}</span>
                  </>
                )}
                {!onlineDuration && !offlineDuration && (
                  <>
                    <span className="mc-info-label">Visto</span>
                    <span>{lastSeen}</span>
                  </>
                )}
                <span className="mc-info-label">Agente</span>
                <span>v{machine.agentVersion || '?'}</span>
                <span className="mc-info-label">Uptime</span>
                <span>{m.uptimeH != null ? `${Math.round(m.uptimeH)}h` : '—'}</span>
              </div>

              <div className="mc-metrics">
                <MetricBar label="CPU"   pct={m.cpuPct || 0} />
                <MetricBar label="RAM"   pct={ramPct} />
                <MetricBar label="Disco" pct={diskPct} />
                <div className="mc-temps">
                  {m.cpuTempC > 0 && (
                    <span className="mc-temp-item">
                      CPU <span style={{ color: m.cpuTempC > 80 ? 'var(--red)' : 'var(--text)' }}>
                        {Math.round(m.cpuTempC)}°C
                      </span>
                    </span>
                  )}
                  {m.roomTempC > 0 && (
                    <span className="mc-temp-item">
                      Sala <span style={{ color: m.roomTempC > 35 ? 'var(--yellow)' : 'var(--text)' }}>
                        {Math.round(m.roomTempC)}°C
                      </span>
                    </span>
                  )}
                </div>
              </div>

              {!confirmCmd ? (
                <div className="mc-actions">
                  <button className="btn btn-success"
                    disabled={loading || status === 'online'}
                    onClick={async () => {
                      setLoading(true)
                      try { await onWol(machine.id) }
                      catch (err) { alert(err.message) }
                      finally { setLoading(false) }
                    }}>
                    Ligar
                  </button>
                  <button className="btn btn-warn"
                    disabled={loading || status !== 'online'}
                    onClick={() => handleCommand('reboot')}>
                    Reiniciar
                  </button>
                  <button className="btn btn-danger"
                    disabled={loading || status !== 'online'}
                    onClick={() => handleCommand('shutdown')}>
                    Desligar
                  </button>
                  <button className="btn btn-uninstall"
                    disabled={loading || status !== 'online'}
                    onClick={() => handleCommand('uninstall')}>
                    Desinstalar
                  </button>
                </div>
              ) : (
                <div className="confirm-box">
                  <p className="confirm-warn">
                    {confirmCmd === 'uninstall'
                      ? <>Remove o agente permanentemente. Digite <strong>{confirmId}</strong>:</>
                      : <>Máquina CRÍTICA. Digite <strong>{confirmId}</strong> para confirmar:</>
                    }
                  </p>
                  <input className="confirm-input" autoFocus
                    value={confirmText} onChange={e => setConfirmText(e.target.value)}
                    placeholder={confirmId}
                  />
                  <div className="confirm-actions">
                    <button
                      className={`btn ${confirmCmd === 'uninstall' ? 'btn-uninstall' : 'btn-danger'}`}
                      disabled={confirmText !== confirmId || loading}
                      onClick={() => execCommand(confirmCmd, confirmId)}
                    >Confirmar</button>
                    <button className="btn btn-secondary" onClick={() => setConfirmCmd(null)}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {activeTab === 'events' && (
            <EventsTab
              machineId={machine.id}
              onRead={() => setEventsUnread(0)}
            />
          )}
          {activeTab === 'insights' && (
            <InsightsTab
              machineId={machine.id}
              onRead={() => setInsightsUnread(0)}
            />
          )}
        </div>
      )}
    </div>

    {/* ── Context menu (botão direito) ── */}
    {contextMenu && (
      <div ref={menuRef} className="context-menu"
        style={{ top: contextMenu.y, left: contextMenu.x }}
        onClick={e => e.stopPropagation()}>
        <div className="ctx-header">{machine.displayName || machine.id}</div>
        <div className="ctx-section">Mover para grupo:</div>
        {groupsList.map(g => (
          <button key={g.name}
            className={`ctx-item ${machine.location === g.name ? 'ctx-active' : ''}`}
            onClick={() => { onMoveToGroup(machine.id, g.name); setContextMenu(null) }}>
            {machine.location === g.name && '✓ '}{g.name}
          </button>
        ))}
        {machine.location && (
          <button className="ctx-item ctx-remove"
            onClick={() => { onMoveToGroup(machine.id, ''); setContextMenu(null) }}>
            Remover do grupo
          </button>
        )}
      </div>
    )}
    </>
  )
}

function MetricBar({ label, pct }) {
  const color = pct > 85 ? '#ef4444' : pct > 65 ? '#f59e0b' : '#3b82f6'
  return (
    <div className="mc-bar-row">
      <span className="mc-bar-label">{label}</span>
      <div className="mc-bar-bg">
        <div className="mc-bar-fill" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
      </div>
      <span className="mc-bar-val">{Math.round(pct)}%</span>
    </div>
  )
}
