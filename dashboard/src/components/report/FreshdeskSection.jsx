// dashboard/src/components/report/FreshdeskSection.jsx
import { useState, useEffect } from 'react'
import { api } from '../../api'

const STATUS_STYLE = {
  open:     { bg: '#3d1f1f', color: '#fc8181', label: 'Aberto' },
  pending:  { bg: '#3d2e1f', color: '#f6ad55', label: 'Pendente' },
  resolved: { bg: '#1f3d2b', color: '#68d391', label: 'Resolvido' },
  closed:   { bg: '#1f2d3d', color: '#63b3ed', label: 'Fechado' },
}

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.open
  return (
    <span style={{
      background: s.bg, color: s.color,
      borderRadius: 4, padding: '1px 6px', fontSize: '0.68rem', fontWeight: 600,
    }}>
      {s.label}
    </span>
  )
}

function TicketRow({ ticket }) {
  const date = (ticket.resolved_at || ticket.created_at || '').slice(0, 10)
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '6px 0', borderBottom: '1px solid #2d3748',
    }}>
      <span style={{ color: '#4a5568', fontSize: '0.7rem', minWidth: 36, paddingTop: 2 }}>
        #{ticket.ticket_id}
      </span>
      <span style={{ flex: 1, color: '#cbd5e0', fontSize: '0.78rem', lineHeight: 1.4 }}>
        {ticket.title}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, minWidth: 80 }}>
        <StatusBadge status={ticket.status} />
        {date && (
          <span style={{ color: '#4a5568', fontSize: '0.65rem' }}>{date}</span>
        )}
      </div>
    </div>
  )
}

export function FreshdeskSection({ storeName }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [open,    setOpen]    = useState(true)

  useEffect(() => {
    setLoading(true)
    api.relatorio.getFreshdesk(storeName)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [storeName])

  const activeCount = data?.active?.length ?? 0
  const closedCount = data?.closed?.length ?? 0
  const total = activeCount + closedCount

  return (
    <div style={{ background: '#171e2e', borderRadius: 8, border: '1px solid #2d3748' }}>
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '10px 12px', color: '#a0aec0',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '.06em' }}>
            FRESHDESK
          </span>
          {activeCount > 0 && (
            <span style={{
              background: '#742a2a', color: '#fc8181',
              borderRadius: 10, padding: '1px 7px', fontSize: '0.68rem', fontWeight: 700,
            }}>
              {activeCount} abertos
            </span>
          )}
          {activeCount === 0 && total > 0 && (
            <span style={{ color: '#4a5568', fontSize: '0.68rem' }}>{total} chamados</span>
          )}
          {!loading && total === 0 && (
            <span style={{ color: '#4a5568', fontSize: '0.68rem' }}>sem chamados</span>
          )}
        </div>
        <span style={{ fontSize: '0.75rem' }}>{open ? '▲' : '▼'}</span>
      </button>

      {/* Body */}
      {open && (
        <div style={{ padding: '0 12px 10px' }}>
          {loading && (
            <p style={{ color: '#4a5568', fontSize: '0.78rem', margin: '8px 0' }}>Carregando...</p>
          )}

          {!loading && total === 0 && (
            <p style={{ color: '#4a5568', fontSize: '0.78rem', margin: '8px 0' }}>
              Nenhum chamado encontrado para esta loja.
            </p>
          )}

          {!loading && activeCount > 0 && (
            <>
              <div style={{ fontSize: '0.68rem', color: '#718096', marginBottom: 4, marginTop: 4 }}>
                ABERTOS / PENDENTES
              </div>
              {data.active.map(t => <TicketRow key={t.ticket_id} ticket={t} />)}
            </>
          )}

          {!loading && closedCount > 0 && (
            <>
              <div style={{ fontSize: '0.68rem', color: '#718096', marginBottom: 4, marginTop: 10 }}>
                FECHADOS RECENTES
              </div>
              {data.closed.map(t => <TicketRow key={t.ticket_id} ticket={t} />)}
            </>
          )}
        </div>
      )}
    </div>
  )
}
