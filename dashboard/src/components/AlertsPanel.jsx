import { useState, useEffect } from 'react'

const STORAGE_KEY = 'dt_alerts'

function loadAlerts() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}
function saveAlertsToStorage(alerts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts.slice(0, 100)))
}

export function AlertsPanel({ newOfflineAlert, onClose }) {
  const [alerts, setAlerts] = useState(loadAlerts)

  useEffect(() => {
    if (!newOfflineAlert) return
    setAlerts(prev => {
      const updated = [{ ...newOfflineAlert, id: Date.now(), read: false }, ...prev]
      saveAlertsToStorage(updated)
      return updated
    })
  }, [newOfflineAlert])

  function markAllRead() {
    setAlerts(prev => {
      const updated = prev.map(a => ({ ...a, read: true }))
      saveAlertsToStorage(updated)
      return updated
    })
  }

  const unread = alerts.filter(a => !a.read).length

  return (
    <div className="alerts-panel">
      <div className="alerts-panel-header">
        <span>🔔 Alertas {unread > 0 && <span className="tab-badge">{unread}</span>}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {unread > 0 && (
            <button className="link-btn" onClick={markAllRead}>Marcar todos lidos</button>
          )}
          <button className="link-btn" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="alerts-panel-list">
        {alerts.length === 0 && (
          <div className="tab-empty">Nenhum alerta registrado.</div>
        )}
        {alerts.map(a => (
          <div key={a.id} className={`alert-item ${a.read ? 'alert-read' : ''}`}>
            <div className="alert-item-title">
              <span style={{ color: 'var(--red)', fontWeight: 700 }}>{a.displayName}</span>
              {!a.read && <span className="alert-new-dot" />}
            </div>
            <div className="alert-item-sub">{a.location}</div>
            <div className="alert-item-time">
              {new Date(a.id).toLocaleString('pt-BR')}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function useAlertsCount() {
  const [count, setCount] = useState(() => loadAlerts().filter(a => !a.read).length)
  useEffect(() => {
    const onStorage = () => setCount(loadAlerts().filter(a => !a.read).length)
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  return [count, setCount]
}
