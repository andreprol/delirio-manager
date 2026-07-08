// dashboard/src/components/report/ZamakThreatsSection.jsx
import { useState, useEffect } from 'react'
import { api } from '../../api'

const STATUS_STYLE = {
  quarantined: { bg: '#2d1f3d', color: '#b794f4', label: 'Quarentena' },
  detected:    { bg: '#3d1f1f', color: '#fc8181', label: 'Detectada'  },
  cleaned:     { bg: '#1f3d2b', color: '#68d391', label: 'Removida'   },
}

function StatusBadge({ status }) {
  const key  = (status || '').toLowerCase()
  const s    = STATUS_STYLE[key] || { bg: '#2d2d2d', color: '#a0aec0', label: status || '?' }
  return (
    <span style={{ fontSize: '0.6rem', fontWeight: 600, padding: '1px 5px', borderRadius: 3,
      background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  )
}

function ThreatRow({ threat }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0',
      borderBottom: '1px solid #1a1f2e' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.72rem', color: '#e2e8f0', fontWeight: 500,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {threat.threat_name || 'Desconhecida'}
        </div>
        <div style={{ fontSize: '0.62rem', color: '#718096', marginTop: 1 }}>
          {threat.device_name}{threat.category ? ` · ${threat.category}` : ''}
        </div>
      </div>
      <StatusBadge status={threat.last_status} />
    </div>
  )
}

export function ZamakThreatsSection({ storeName }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [open,    setOpen]    = useState(true)

  useEffect(() => {
    setLoading(true)
    api.zamak.getThreats(storeName)
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [storeName])

  const threats = data || []
  const count   = threats.length

  return (
    <div style={{ borderTop: '1px solid #1e2a3a', marginTop: 2 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 0', color: '#a0aec0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '.08em', color: '#4a5568' }}>
            ZAMAK — AMEAÇAS MAV
          </span>
          {!loading && count > 0 && (
            <span style={{ fontSize: '0.6rem', fontWeight: 600, padding: '1px 6px', borderRadius: 3,
              background: '#3d1f1f', color: '#fc8181' }}>
              {count} ativa{count > 1 ? 's' : ''}
            </span>
          )}
          {!loading && count === 0 && (
            <span style={{ fontSize: '0.6rem', color: '#48bb78' }}>✓ Sem ameaças</span>
          )}
        </div>
        <span style={{ fontSize: '0.7rem', color: '#4a5568' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ paddingBottom: 8 }}>
          {loading && <p style={{ fontSize: '0.7rem', color: '#4a5568', margin: 0 }}>Carregando...</p>}
          {!loading && count === 0 && (
            <p style={{ fontSize: '0.7rem', color: '#48bb78', margin: 0 }}>Nenhuma ameaça ativa nesta loja.</p>
          )}
          {!loading && count > 0 && threats.map((t, i) => (
            <ThreatRow key={i} threat={t} />
          ))}
        </div>
      )}
    </div>
  )
}
