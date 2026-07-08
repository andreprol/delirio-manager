// dashboard/src/components/report/ZamakOutagesSection.jsx
import { useState, useEffect } from 'react'
import { api } from '../../api'

const REASON_STYLE = {
  DEVICE_OFFLINE: { bg: '#2d1f3d', color: '#b794f4', label: 'Offline' },
  CHECK_FAILURE:  { bg: '#3d2a1f', color: '#f6ad55', label: 'Check Falhou' },
}

function ReasonBadge({ reason }) {
  const s = REASON_STYLE[reason] || { bg: '#2d2d2d', color: '#a0aec0', label: reason || '?' }
  return (
    <span style={{ fontSize: '0.6rem', fontWeight: 600, padding: '1px 5px', borderRadius: 3,
      background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  )
}

function fmtDuration(min) {
  if (min == null) return null
  if (min < 60) return `${Math.round(min)}min`
  return `${Math.floor(min / 60)}h${Math.round(min % 60).toString().padStart(2, '0')}min`
}

function fmtDate(iso) {
  if (!iso) return '—'
  // iso: "2026-07-06 09:00:19" (UTC)
  return iso.slice(0, 16).replace('T', ' ')
}

function OutageRow({ o }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0',
      borderBottom: '1px solid #1a1f2e' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.68rem', color: '#e2e8f0', fontWeight: 500,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {o.device_name}
        </div>
        <div style={{ fontSize: '0.6rem', color: '#718096', marginTop: 2 }}>
          {fmtDate(o.utc_start)}
          {o.duration_min != null && ` · ${fmtDuration(o.duration_min)}`}
          {o.check_description && ` · ${o.check_description.slice(0, 40)}`}
        </div>
      </div>
      <ReasonBadge reason={o.reason} />
    </div>
  )
}

export function ZamakOutagesSection({ storeName }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [open,    setOpen]    = useState(false)

  useEffect(() => {
    setLoading(true)
    api.zamak.getOutages(storeName)
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [storeName])

  const outages = data || []
  const count   = outages.length

  return (
    <div style={{ background: '#171e2e', borderRadius: 8, border: '1px solid #2d3748', marginTop: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px', color: '#a0aec0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '.06em' }}>
            ZAMAK — OUTAGES (61 DIAS)
          </span>
          {!loading && count > 0 && (
            <span style={{ fontSize: '0.6rem', fontWeight: 600, padding: '1px 6px', borderRadius: 3,
              background: '#2d1f3d', color: '#b794f4' }}>
              {count} evento{count > 1 ? 's' : ''}
            </span>
          )}
          {!loading && count === 0 && (
            <span style={{ fontSize: '0.6rem', color: '#48bb78' }}>✓ Sem outages</span>
          )}
        </div>
        <span style={{ fontSize: '0.7rem', color: '#4a5568' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 12px 10px' }}>
          {loading && <p style={{ fontSize: '0.7rem', color: '#4a5568', margin: 0 }}>Carregando...</p>}
          {!loading && count === 0 && (
            <p style={{ fontSize: '0.7rem', color: '#48bb78', margin: 0 }}>Nenhum outage nos últimos 61 dias.</p>
          )}
          {!loading && count > 0 && outages.map((o, i) => <OutageRow key={i} o={o} />)}
        </div>
      )}
    </div>
  )
}
