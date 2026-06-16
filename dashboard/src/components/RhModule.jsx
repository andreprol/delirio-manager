import { useState, useEffect } from 'react'
import { api } from '../api'
import { ClockStatusGrid } from './ClockStatusGrid'
import { EmployeeTable } from './EmployeeTable'

const OP_LABELS = {
  offboard:    '🗑 Remoção LGPD',
  enroll:      '✅ Cadastro',
  update_card: '💳 Cartão NFC',
}

function formatDateTime(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString('pt-BR')
  } catch {
    return ts
  }
}

function AuditLog() {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  async function fetchData() {
    setLoading(true)
    setError(null)
    try {
      const [offboard, ops] = await Promise.all([
        api.rh.getOffboardLog(50),
        api.rh.getOperationLog(100),
      ])
      const offboardRows = (offboard || []).map(e => ({ ...e, operation: 'offboard' }))
      const opRows       = (ops || [])
      const merged = [...offboardRows, ...opRows].sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return tb - ta
      })
      setRows(merged)
    } catch (err) {
      setError(err.message || 'Erro ao carregar auditoria.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [])

  const s = {
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: '14px',
      flexWrap: 'wrap',
      gap: '8px',
    },
    title: {
      fontSize: '14px',
      fontWeight: 700,
      color: 'var(--text, #e2e8f0)',
      margin: 0,
    },
    count: {
      fontSize: '13px',
      color: 'var(--text-muted, #94a3b8)',
    },
    refreshBtn: {
      padding: '5px 14px',
      background: 'var(--accent, #3b82f6)',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      fontSize: '13px',
      fontWeight: 600,
      cursor: 'pointer',
      opacity: loading ? 0.6 : 1,
    },
    errorBanner: {
      background: 'rgba(248,113,113,0.12)',
      border: '1px solid var(--red, #f87171)',
      borderRadius: '8px',
      padding: '10px 14px',
      marginBottom: '14px',
      fontSize: '13px',
      color: 'var(--red, #f87171)',
    },
    empty: {
      padding: '32px',
      textAlign: 'center',
      color: 'var(--text-muted, #94a3b8)',
      fontSize: '14px',
    },
    tableWrap: {
      overflowX: 'auto',
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: '13px',
    },
    th: {
      textAlign: 'left',
      padding: '8px 12px',
      background: 'var(--card-bg, #1e2530)',
      color: 'var(--text-muted, #94a3b8)',
      fontWeight: 600,
      fontSize: '12px',
      borderBottom: '1px solid var(--border, #2d3748)',
      whiteSpace: 'nowrap',
    },
    td: {
      padding: '8px 12px',
      borderBottom: '1px solid var(--border, #2d3748)',
      color: 'var(--text, #e2e8f0)',
      verticalAlign: 'middle',
    },
    tdMuted: {
      padding: '8px 12px',
      borderBottom: '1px solid var(--border, #2d3748)',
      color: 'var(--text-muted, #94a3b8)',
      fontSize: '12px',
      fontFamily: 'monospace',
      verticalAlign: 'middle',
    },
    resultOk: {
      color: 'var(--green, #4ade80)',
      fontWeight: 600,
    },
    resultFail: {
      color: 'var(--red, #f87171)',
      fontWeight: 600,
    },
  }

  function ResultCell({ row }) {
    if (row.success) {
      const count = row.ok_count ?? row.removed ?? null
      return (
        <span style={s.resultOk}>
          ✅{count != null ? ` ${count}` : ''}
        </span>
      )
    }
    return <span style={s.resultFail}>❌</span>
  }

  return (
    <div>
      <div style={s.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h4 style={s.title}>Log de Auditoria LGPD</h4>
          {!loading && !error && (
            <span style={s.count}>{rows.length} registro{rows.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        <button
          style={s.refreshBtn}
          onClick={fetchData}
          disabled={loading}
        >
          {loading ? 'Carregando…' : 'Atualizar'}
        </button>
      </div>

      {error && (
        <div style={s.errorBanner}>⚠️ {error}</div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div style={s.empty}>Nenhuma operação registrada ainda.</div>
      )}

      {!error && rows.length > 0 && (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Data/Hora</th>
                <th style={s.th}>Operação</th>
                <th style={s.th}>Funcionário</th>
                <th style={s.th}>CPF</th>
                <th style={s.th}>Acionado por</th>
                <th style={s.th}>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.id ?? i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                  <td style={s.tdMuted}>{formatDateTime(row.timestamp)}</td>
                  <td style={s.td}>{OP_LABELS[row.operation] ?? row.operation}</td>
                  <td style={s.td}>{row.employee_name || '—'}</td>
                  <td style={s.tdMuted}>{row.cpf || '—'}</td>
                  <td style={s.td}>{row.triggered_by || '—'}</td>
                  <td style={s.td}><ResultCell row={row} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const TABS = [
  { key: 'clocks',     label: 'Status dos Relógios' },
  { key: 'employees',  label: 'Funcionários' },
  { key: 'audit',      label: 'Auditoria LGPD' },
]

export function RhModule({ onClose }) {
  const [activeTab, setActiveTab] = useState('clocks')

  const s = {
    overlay: {
      position: 'fixed',
      inset: 0,
      background: 'var(--bg, #0f1117)',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
    },
    panel: {
      flex: 1,
      background: 'var(--bg, #0f1117)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '14px 20px',
      borderBottom: '1px solid var(--border, #2d3748)',
      background: 'var(--card-bg, #1e2530)',
      flexShrink: 0,
      flexWrap: 'wrap',
      gap: '10px',
    },
    headerLeft: {
      display: 'flex',
      alignItems: 'center',
      gap: '20px',
      flexWrap: 'wrap',
    },
    title: {
      fontSize: '15px',
      fontWeight: 700,
      color: 'var(--text, #e2e8f0)',
      margin: 0,
      whiteSpace: 'nowrap',
    },
    tabs: {
      display: 'flex',
      gap: '4px',
    },
    tabBtn: (active) => ({
      padding: '6px 14px',
      background: active ? 'var(--accent, #3b82f6)' : 'transparent',
      color: active ? '#fff' : 'var(--text-muted, #94a3b8)',
      border: active ? 'none' : '1px solid var(--border, #2d3748)',
      borderRadius: '6px',
      fontSize: '13px',
      fontWeight: active ? 700 : 400,
      cursor: 'pointer',
      transition: 'all 0.15s',
      whiteSpace: 'nowrap',
    }),
    closeBtn: {
      padding: '6px 16px',
      background: 'transparent',
      color: 'var(--text-muted, #94a3b8)',
      border: '1px solid var(--border, #2d3748)',
      borderRadius: '6px',
      fontSize: '13px',
      fontWeight: 600,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      flexShrink: 0,
    },
    content: {
      overflowY: 'auto',
      flex: 1,
      padding: '20px',
    },
  }

  return (
    <div style={s.overlay}>
      <div style={s.panel}>
        <div style={s.header}>
          <div style={s.headerLeft}>
            <h2 style={s.title}>Módulo RH — Relógios Henry Hexa</h2>
            <div style={s.tabs}>
              {TABS.map(tab => (
                <button
                  key={tab.key}
                  style={s.tabBtn(activeTab === tab.key)}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose}>Fechar</button>
        </div>

        <div style={s.content}>
          {activeTab === 'clocks'    && <ClockStatusGrid />}
          {activeTab === 'employees' && <EmployeeTable />}
          {activeTab === 'audit'     && <AuditLog />}
        </div>
      </div>
    </div>
  )
}
