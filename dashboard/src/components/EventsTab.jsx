import { useState, useEffect } from 'react'
import { api } from '../api'

const LEVEL_ICON  = { critical: '🔴', error: '🔴', warning: '🟡', info: '🟢' }
const LEVEL_COLOR = { critical: '#ef4444', error: '#ef4444', warning: '#f59e0b', info: '#94a3b8' }

export function EventsTab({ machineId, onRead }) {
  const [scope,    setScope]    = useState('focused')
  const [events,   setEvents]   = useState([])
  const [loading,  setLoading]  = useState(true)
  const [expanded, setExpanded] = useState(null) // id of expanded event

  useEffect(() => {
    setLoading(true)
    api.getWinEvents(machineId, scope)
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoading(false))
  }, [machineId, scope])

  useEffect(() => {
    api.markWinEventsRead(machineId).catch(() => {})
    onRead?.()
  }, [machineId])

  if (loading) return <div className="tab-loading">Carregando eventos...</div>

  if (events.length === 0) return (
    <div className="tab-empty">
      Nenhum evento registrado neste período.{' '}
      {scope === 'focused' && (
        <button className="link-btn" onClick={() => setScope('broad')}>
          Ver modo Amplo
        </button>
      )}
    </div>
  )

  return (
    <div className="events-tab">
      <div className="events-scope-toggle">
        <button
          className={`scope-btn ${scope === 'focused' ? 'scope-active' : ''}`}
          onClick={() => setScope('focused')}
        >🎯 Focado</button>
        <button
          className={`scope-btn ${scope === 'broad' ? 'scope-active' : ''}`}
          onClick={() => setScope('broad')}
        >📋 Amplo</button>
      </div>

      <div className="events-list">
        {events.map(ev => (
          <div key={ev.id} className="event-row">
            <div
              className="event-summary"
              onClick={() => setExpanded(expanded === ev.id ? null : ev.id)}
            >
              <span className="event-icon">{LEVEL_ICON[ev.level] || '⚪'}</span>
              <span className="event-time">
                {new Date(ev.event_time).toLocaleTimeString('pt-BR', {
                  hour: '2-digit', minute: '2-digit', second: '2-digit'
                })}
              </span>
              <span className="event-translation">{ev.translation}</span>
              <span className="event-arrow">{expanded === ev.id ? '▼' : '▶'}</span>
            </div>
            {expanded === ev.id && (
              <div className="event-detail">
                <span className="event-detail-label">Event ID:</span> {ev.event_id}
                {' · '}
                <span className="event-detail-label">Fonte:</span> {ev.source}
                {ev.raw_message && (
                  <pre className="event-raw">{ev.raw_message}</pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
