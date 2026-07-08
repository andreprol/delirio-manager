// dashboard/src/components/report/ZamakPerformanceSection.jsx
import { useState, useEffect } from 'react'
import { api } from '../../api'

function barColor(pct) {
  if (pct == null) return '#4a5568'
  if (pct > 60)   return '#fc8181'
  if (pct > 30)   return '#f6ad55'
  return '#68d391'
}

function MiniBar({ label, pct }) {
  const color = barColor(pct)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
      <span style={{ fontSize: '0.6rem', color: '#718096', width: 30, textAlign: 'right', flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, background: '#1a202c', borderRadius: 3, height: 6, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(pct ?? 0, 100)}%`, height: '100%', background: color, borderRadius: 3, transition: 'width .3s' }} />
      </div>
      <span style={{ fontSize: '0.6rem', color, width: 32, textAlign: 'right', flexShrink: 0 }}>
        {pct != null ? `${Math.round(pct)}%` : '—'}
      </span>
    </div>
  )
}

function DeviceRow({ row }) {
  const ramUsedPct = (row.ram_total_mb && row.ram_avail_avg != null)
    ? (1 - row.ram_avail_avg / row.ram_total_mb) * 100
    : null

  const hasData = row.cpu_avg != null || ramUsedPct != null || row.disk_time_avg != null

  return (
    <div style={{ padding: '6px 0', borderBottom: '1px solid #1a1f2e' }}>
      <div style={{ fontSize: '0.68rem', color: '#e2e8f0', fontWeight: 500, marginBottom: 4 }}>
        {row.device_name}
        {!hasData && <span style={{ fontSize: '0.58rem', color: '#4a5568', marginLeft: 8 }}>sem dados de performance</span>}
      </div>
      {hasData && (
        <>
          <MiniBar label="CPU"  pct={row.cpu_avg} />
          <MiniBar label="RAM"  pct={ramUsedPct} />
          <MiniBar label="Disk" pct={row.disk_time_avg} />
        </>
      )}
    </div>
  )
}

export function ZamakPerformanceSection({ storeName }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [open,    setOpen]    = useState(false)

  useEffect(() => {
    setLoading(true)
    api.zamak.getPerformance(storeName)
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [storeName])

  const rows    = data || []
  const withData = rows.filter(r => r.cpu_avg != null || r.disk_time_avg != null)
  const count   = rows.length

  return (
    <div style={{ background: '#171e2e', borderRadius: 8, border: '1px solid #2d3748', marginTop: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px', color: '#a0aec0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '.06em' }}>
            ZAMAK — PERFORMANCE
          </span>
          {!loading && count > 0 && (
            <span style={{ fontSize: '0.6rem', color: '#4a9eff' }}>
              {count} dispositivo{count > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <span style={{ fontSize: '0.7rem', color: '#4a5568' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 12px 10px' }}>
          {loading && <p style={{ fontSize: '0.7rem', color: '#4a5568', margin: 0 }}>Carregando...</p>}
          {!loading && count === 0 && (
            <p style={{ fontSize: '0.7rem', color: '#4a5568', margin: 0 }}>Nenhum dado de performance disponível.</p>
          )}
          {!loading && count > 0 && rows.map((r, i) => <DeviceRow key={i} row={r} />)}
        </div>
      )}
    </div>
  )
}
