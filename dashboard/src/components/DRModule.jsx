import { useState, useEffect } from 'react'
import { api } from '../api'

const STATUS_COLOR = {
  configured:    '#22c55e',
  pending:       '#f59e0b',
  error:         '#ef4444',
  not_installed: '#4b5563',
}
const STATUS_LABEL = {
  configured:    '✅ Protegida',
  pending:       '⏳ Configurando',
  error:         '❌ Erro',
  not_installed: '— Sem DR',
}

export function DRModule({ onClose }) {
  const [overview, setOverview] = useState(null)
  const [machines, setMachines] = useState([])
  const [filter,   setFilter]   = useState('all')
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  async function load() {
    setLoading(true); setError(null)
    try {
      const [ov, ms] = await Promise.all([api.dr.overview(), api.getMachines()])
      setOverview(ov)
      setMachines(ms)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const filtered = machines.filter(m => {
    if (filter === 'configured') return m.dr_setup === 'configured'
    if (filter === 'none')       return !m.dr_setup || m.dr_setup === 'not_installed'
    if (filter === 'error')      return m.dr_setup === 'error'
    return true
  })

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f0f19f0', zIndex: 9999, display: 'flex', flexDirection: 'column', fontFamily: 'monospace' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #1e1e30' }}>
        <div>
          <h2 style={{ margin: 0, color: '#a5b4fc', fontSize: '1.1em' }}>🔒 Bare Metal Recovery</h2>
          <p style={{ margin: '2px 0 0', fontSize: '0.78em', color: '#555' }}>Veeam Agent for Windows FREE + Azure Blob (dtmanagerdr)</p>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.3em', cursor: 'pointer' }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {loading && <p style={{ color: '#888' }}>Carregando...</p>}
        {error   && <p style={{ color: '#ef4444' }}>Erro: {error}</p>}

        {/* Overview cards */}
        {overview && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Protegidas',   value: overview.total,                              color: '#22c55e' },
              { label: 'Backup < 24h', value: `${overview.okLast24h} / ${overview.total}`, color: '#3b82f6' },
              { label: 'Total Azure',  value: `${(overview.totalGb || 0).toFixed(1)} GB`,  color: '#8b5cf6' },
              { label: 'Com falha',    value: overview.failing,                            color: '#ef4444' },
            ].map(card => (
              <div key={card.label} style={{ background: '#1a1a2a', borderRadius: 8, padding: '12px 16px', border: `1px solid ${card.color}33` }}>
                <div style={{ fontSize: '1.5em', fontWeight: 700, color: card.color }}>{card.value}</div>
                <div style={{ fontSize: '0.75em', color: '#888', marginTop: 2 }}>{card.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {[['all', 'Todas'], ['configured', 'Protegidas'], ['none', 'Sem DR'], ['error', 'Com falha']].map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)}
              style={{ background: filter === k ? '#6366f133' : 'transparent', color: filter === k ? '#818cf8' : '#666', border: `1px solid ${filter === k ? '#6366f144' : '#333'}`, padding: '3px 12px', borderRadius: 4, cursor: 'pointer', fontSize: '0.8em' }}>
              {label}
            </button>
          ))}
          <button onClick={load} style={{ marginLeft: 'auto', background: 'none', border: '1px solid #333', color: '#666', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: '0.8em' }}>
            ↻ Atualizar
          </button>
        </div>

        {/* Table */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8em' }}>
          <thead>
            <tr style={{ color: '#555', borderBottom: '1px solid #222' }}>
              {['Máquina', 'Localidade', 'Status DR', 'Último Backup OK', 'Storage', 'Veeam'].map(h => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(m => (
              <tr key={m.id} style={{ borderBottom: '1px solid #1a1a2a' }}>
                <td style={{ padding: '7px 8px', color: '#e2e8f0' }}>{m.display_name || m.hostname}</td>
                <td style={{ padding: '7px 8px', color: '#888' }}>{m.location || '—'}</td>
                <td style={{ padding: '7px 8px' }}>
                  <span style={{ color: STATUS_COLOR[m.dr_setup] || '#4b5563', fontWeight: 600 }}>
                    {STATUS_LABEL[m.dr_setup] || '— Sem DR'}
                  </span>
                </td>
                <td style={{ padding: '7px 8px', color: '#888' }}>
                  {m.dr_last_ok ? new Date(m.dr_last_ok).toLocaleString('pt-BR') : '—'}
                </td>
                <td style={{ padding: '7px 8px', color: '#6ee7b7' }}>
                  {m.dr_storage_gb ? `${m.dr_storage_gb.toFixed(1)} GB` : '—'}
                </td>
                <td style={{ padding: '7px 8px', color: '#555' }}>{m.dr_version || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && filtered.length === 0 && (
          <p style={{ color: '#555', marginTop: 16 }}>Nenhuma máquina neste filtro.</p>
        )}
      </div>
    </div>
  )
}
