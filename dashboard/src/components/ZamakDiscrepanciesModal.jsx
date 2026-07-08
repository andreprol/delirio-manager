// dashboard/src/components/ZamakDiscrepanciesModal.jsx
import { useState, useEffect } from 'react'
import { api, getServerUrl }   from '../api'

const TYPE_LABELS = {
  zamak_only: { label: 'Zamak sem DM', color: '#ed8936', desc: 'Existe na Zamak mas sem agente Delirio Manager' },
  dm_only:    { label: 'DM sem Zamak', color: '#667eea', desc: 'Tem agente DM mas sem cobertura na Zamak' },
}

function exportCsv(rows) {
  const header = 'Tipo,Loja,Hostname,Detalhe\n'
  const body   = rows.map(r =>
    [TYPE_LABELS[r.type]?.label || r.type, r.store_name || '', r.device_name || '', r.detail || '']
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  ).join('\n')
  const blob = new Blob(['﻿' + header + body], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a'); a.href = url
  a.download = `discrepancias-zamak-${new Date().toISOString().slice(0,10)}.csv`
  a.click(); URL.revokeObjectURL(url)
}

export function ZamakDiscrepanciesModal({ onClose }) {
  const [data,        setData]        = useState(null)
  const [status,      setStatus]      = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [tab,         setTab]         = useState('zamak_only')
  const [storeFilter, setStoreFilter] = useState('__all__')
  const [docxLoading, setDocxLoading] = useState(false)
  const [error,       setError]       = useState(null)

  useEffect(() => {
    Promise.all([api.zamak.getDiscrepancies(), api.zamak.getStatus()])
      .then(([disc, stat]) => { setData(disc); setStatus(stat) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const rows    = data || []
  const filtered = rows.filter(r =>
    r.type === tab && (storeFilter === '__all__' || r.store_name === storeFilter)
  )
  const stores  = [...new Set(rows.filter(r => r.type === tab).map(r => r.store_name || '').filter(Boolean))].sort()
  const countOf = t => rows.filter(r => r.type === t).length

  async function downloadDocx() {
    setDocxLoading(true)
    try {
      const res = await fetch(`${getServerUrl()}/api/zamak/discrepancies/report`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a'); a.href = url
      a.download = `discrepancias-zamak-${new Date().toISOString().slice(0,10)}.docx`
      a.click(); URL.revokeObjectURL(url)
    } catch (e) {
      alert('Erro ao gerar DOCX: ' + e.message)
    } finally {
      setDocxLoading(false)
    }
  }

  const S = {
    overlay: { position: 'fixed', top: 56, left: 0, right: 0, bottom: 0, background: '#0f0f19', zIndex: 10000, display: 'flex', flexDirection: 'column', fontFamily: 'monospace' },
    header:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', borderBottom: '1px solid #1e1e30' },
    title:   { margin: 0, color: '#667eea', fontSize: '1.05em' },
    sub:     { margin: '2px 0 0', fontSize: '0.75em', color: '#555' },
    actions: { display: 'flex', gap: 8, alignItems: 'center' },
    btn:     (c='#667eea') => ({ background: 'none', border: `1px solid ${c}`, borderRadius: 5, color: c, fontSize: '0.77em', padding: '5px 12px', cursor: 'pointer' }),
    body:    { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '16px 24px', gap: 14 },
    cards:   { display: 'flex', gap: 12 },
    card:    (active, color) => ({ flex: 1, maxWidth: 220, padding: '10px 14px', borderRadius: 8, border: `1px solid ${active ? color : '#1e1e30'}`, background: active ? color + '18' : '#13131f', cursor: 'pointer' }),
    cardNum: (color) => ({ fontSize: '1.5em', fontWeight: 'bold', color }),
    cardLbl: { fontSize: '0.75em', color: '#888', marginTop: 2 },
    filters: { display: 'flex', gap: 10, alignItems: 'center' },
    sel:     { background: '#1a1a2e', border: '1px solid #2d3748', color: '#ccc', borderRadius: 5, padding: '4px 8px', fontSize: '0.8em' },
    table:   { flex: 1, overflowY: 'auto' },
    th:      { color: '#667eea', fontWeight: 'bold', padding: '6px 10px', borderBottom: '1px solid #1e1e30', textAlign: 'left', fontSize: '0.78em', whiteSpace: 'nowrap' },
    td:      { padding: '5px 10px', borderBottom: '1px solid #111', fontSize: '0.78em', color: '#ccc', whiteSpace: 'nowrap' },
    empty:   { color: '#48bb78', padding: 24, fontSize: '0.85em' },
  }

  return (
    <div style={S.overlay}>
      <div style={S.header}>
        <div>
          <h2 style={S.title}>🔀 Discrepâncias Zamak ↔ Delirio Manager</h2>
          <p style={S.sub}>
            {status ? `Último sync: ${new Date(status.byStore?.[0]?.last_sync || Date.now()).toLocaleString('pt-BR')}` : 'Carregando...'}
          </p>
        </div>
        <div style={S.actions}>
          {!loading && !error && <>
            <button style={S.btn('#48bb78')} onClick={() => exportCsv(rows)}>📊 Exportar CSV</button>
            <button style={{ ...S.btn('#667eea'), opacity: docxLoading ? 0.6 : 1 }} onClick={downloadDocx} disabled={docxLoading}>
              {docxLoading ? '⏳ Gerando…' : '📄 Baixar DOCX'}
            </button>
          </>}
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.3em', cursor: 'pointer' }}>✕</button>
        </div>
      </div>

      <div style={S.body}>
        {loading && <p style={{ color: '#888' }}>Carregando discrepâncias...</p>}
        {error   && <p style={{ color: '#e53e3e' }}>Erro: {error}</p>}
        {!loading && !error && <>
          {/* Cards de resumo / tabs */}
          <div style={S.cards}>
            {Object.entries(TYPE_LABELS).map(([type, { label, color, desc }]) => (
              <div key={type} style={S.card(tab === type, color)} onClick={() => { setTab(type); setStoreFilter('__all__') }}>
                <div style={S.cardNum(color)}>{countOf(type)}</div>
                <div style={{ fontSize: '0.82em', color: '#ccc', marginTop: 2 }}>{label}</div>
                <div style={S.cardLbl}>{desc}</div>
              </div>
            ))}
            <div style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid #1e1e30', background: '#13131f' }}>
              <div style={{ fontSize: '1.5em', fontWeight: 'bold', color: '#ccc' }}>{rows.length}</div>
              <div style={{ fontSize: '0.82em', color: '#888', marginTop: 2 }}>Total</div>
              <div style={S.cardLbl}>todas as discrepâncias</div>
            </div>
          </div>

          {/* Filtro por loja */}
          <div style={S.filters}>
            <span style={{ color: '#888', fontSize: '0.78em' }}>Loja:</span>
            <select style={S.sel} value={storeFilter} onChange={e => setStoreFilter(e.target.value)}>
              <option value="__all__">Todas ({countOf(tab)})</option>
              {stores.map(s => {
                const cnt = rows.filter(r => r.type === tab && r.store_name === s).length
                return <option key={s} value={s}>{s} ({cnt})</option>
              })}
            </select>
            <span style={{ color: '#555', fontSize: '0.75em' }}>{filtered.length} resultado(s)</span>
          </div>

          {/* Tabela */}
          <div style={S.table}>
            {filtered.length === 0
              ? <p style={S.empty}>✓ Nenhuma discrepância nesta categoria.</p>
              : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={S.th}>Hostname</th>
                      <th style={S.th}>Loja</th>
                      <th style={S.th}>Detalhe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : '#0d0d1a' }}>
                        <td style={{ ...S.td, color: TYPE_LABELS[r.type]?.color || '#ccc', fontWeight: 'bold' }}>{r.device_name}</td>
                        <td style={S.td}>{r.store_name || '—'}</td>
                        <td style={{ ...S.td, color: '#666', whiteSpace: 'normal' }}>{r.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </div>
        </>}
      </div>
    </div>
  )
}
