// dashboard/src/components/report/ScoreWidget.jsx
import { useMemo } from 'react'

const DIMS = [
  { key: 'score_hardware',     label: 'Hardware' },
  { key: 'score_software',     label: 'Software / OS' },
  { key: 'score_connectivity', label: 'Conectividade' },
  { key: 'score_security',     label: 'Segurança' },
  { key: 'score_incidents',    label: 'Incidentes' },
  { key: 'score_operational',  label: 'Operacional' },
]

function scoreColor(s) {
  if (s >= 60) return '#e53e3e'
  if (s >= 30) return '#ed8936'
  return '#48bb78'
}

function scoreLabel(s) {
  if (s >= 60) return 'RISCO ALTO'
  if (s >= 30) return 'RISCO MÉDIO'
  return 'RISCO BAIXO'
}

export function ScoreWidget({ scores }) {
  const total = scores?.score_total ?? null
  const color = total !== null ? scoreColor(total) : '#4a5568'
  const label = total !== null ? scoreLabel(total) : 'SEM DADOS'

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 12, background: '#1a202c', borderRadius: 8, padding: 12, alignItems: 'center' }}>
      <div style={{ textAlign: 'center', padding: '0 12px' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '1.5rem', fontWeight: 800, margin: '0 auto' }}>
          {total ?? '—'}
        </div>
        <div style={{ fontSize: '0.7rem', color, fontWeight: 700, marginTop: 4 }}>{label}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {DIMS.map(({ key, label }) => {
          const val = scores?.[key] ?? null
          const c   = val !== null ? scoreColor(val) : '#4a5568'
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 110, fontSize: '0.72rem', color: '#a0aec0' }}>{label}</span>
              <div style={{ flex: 1, height: 8, background: '#2d3748', borderRadius: 4 }}>
                <div style={{ width: `${val ?? 0}%`, height: '100%', background: c, borderRadius: 4 }} />
              </div>
              <span style={{ fontSize: '0.7rem', color: c, width: 32, textAlign: 'right' }}>{val ?? '—'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
