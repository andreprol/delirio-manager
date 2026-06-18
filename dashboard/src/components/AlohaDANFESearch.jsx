import { useState, useCallback } from 'react'
import { api, getServerUrl } from '../api'

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    })
  } catch { return iso }
}

function fmtMoeda(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// ── Email modal ───────────────────────────────────────────────────────────────

function EmailModal({ record, machineId, onClose }) {
  const [toEmail,    setToEmail]    = useState('')
  const [extraCCs,   setExtraCCs]   = useState('')
  const [sending,    setSending]    = useState(false)
  const [sent,       setSent]       = useState(false)
  const [error,      setError]      = useState(null)

  async function handleSend() {
    if (!toEmail.trim()) return
    setSending(true)
    setError(null)
    try {
      const ccs = extraCCs.split(/[,;\s]+/).map(e => e.trim()).filter(Boolean)
      await api.nfce.sendEmail(machineId, record.chave, toEmail.trim(), ccs)
      setSent(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setSending(false)
    }
  }

  const s = {
    overlay: {
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
    modal: {
      background: 'var(--card-bg, #1e2530)', border: '1px solid var(--border)',
      borderRadius: '10px', padding: '24px', width: '420px', maxWidth: '90vw',
    },
    label: { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px', display: 'block' },
    input: {
      width: '100%', padding: '8px 10px', background: 'var(--bg, #0f1117)',
      border: '1px solid var(--border)', borderRadius: '6px', color: 'inherit',
      fontSize: '13px', boxSizing: 'border-box',
    },
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px', fontSize: '15px' }}>Enviar DANFE por email</h3>
        <p style={{ margin: '0 0 16px', fontSize: '12px', color: 'var(--text-muted)' }}>
          NF-e Nº {record.n_nf} · {fmtMoeda(record.v_nf)} · {fmtDate(record.dh_emi)}
        </p>

        {sent ? (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: '28px' }}>✅</div>
            <p style={{ margin: '8px 0 0', fontWeight: 600 }}>DANFE enviada para {toEmail}</p>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
              CC: bruno@delirio.com.br, suporteti@delirio.com.br
            </p>
            <button className="btn btn-secondary" style={{ marginTop: '16px' }} onClick={onClose}>Fechar</button>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: '14px' }}>
              <label style={s.label}>E-mail do cliente *</label>
              <input
                type="email"
                style={s.input}
                placeholder="cliente@email.com"
                value={toEmail}
                onChange={e => setToEmail(e.target.value)}
                autoFocus
              />
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={s.label}>E-mails adicionais (separados por vírgula ou ponto-e-vírgula)</label>
              <input
                type="text"
                style={s.input}
                placeholder="gerente@loja.com, contador@escritorio.com"
                value={extraCCs}
                onChange={e => setExtraCCs(e.target.value)}
              />
            </div>

            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px' }}>
              CC automático: <span style={{ color: 'var(--text)' }}>bruno@delirio.com.br, suporteti@delirio.com.br</span>
            </div>

            {error && (
              <div style={{ color: 'var(--red)', fontSize: '12px', marginBottom: '12px' }}>⚠ {error}</div>
            )}

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={onClose} disabled={sending}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleSend} disabled={sending || !toEmail.trim()}>
                {sending ? 'Enviando…' : 'Enviar DANFE'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Result row ────────────────────────────────────────────────────────────────

function ResultRow({ record, machineId }) {
  const [emailOpen,    setEmailOpen]    = useState(false)
  const [downloading,  setDownloading]  = useState(false)

  const products = (record.products_text || '').split(' | ').filter(Boolean).slice(0, 3)

  async function downloadPDF() {
    setDownloading(true)
    try {
      const blob = await api.nfce.downloadDanfe(machineId, record.chave, record.n_nf)
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `DANFE-${record.n_nf}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert('Erro ao gerar DANFE: ' + e.message)
    } finally {
      setDownloading(false)
    }
  }

  const s = {
    row: {
      display: 'grid',
      gridTemplateColumns: '80px 140px 90px 1fr 120px',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 12px',
      borderBottom: '1px solid var(--border)',
      fontSize: '12px',
    },
    actions: { display: 'flex', gap: '4px', justifyContent: 'flex-end' },
  }

  return (
    <>
      <div style={s.row}>
        <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>Nº {record.n_nf}</span>
        <span style={{ color: 'var(--text-muted)' }}>{fmtDate(record.dh_emi)}</span>
        <span style={{ fontWeight: 700, color: '#22c55e' }}>{fmtMoeda(record.v_nf)}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {products.join(' · ') || '—'}
        </span>
        <div style={s.actions}>
          <button
            className="btn btn-secondary"
            style={{ fontSize: '10px', padding: '3px 8px' }}
            onClick={downloadPDF}
            disabled={downloading}
            title="Baixar DANFE em PDF"
          >
            {downloading ? '⏳' : '⬇ PDF'}
          </button>
          <button
            className="btn btn-secondary"
            style={{ fontSize: '10px', padding: '3px 8px' }}
            onClick={() => setEmailOpen(true)}
            title="Enviar DANFE por email"
          >
            ✉ Email
          </button>
        </div>
      </div>

      {emailOpen && (
        <EmailModal record={record} machineId={machineId} onClose={() => setEmailOpen(false)} />
      )}
    </>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function AlohaDANFESearch({ bohMachines }) {
  const [machineId,  setMachineId]  = useState(bohMachines[0]?.id || '')
  const [dateFrom,   setDateFrom]   = useState('')
  const [dateTo,     setDateTo]     = useState('')
  const [valueMin,   setValueMin]   = useState('')
  const [valueMax,   setValueMax]   = useState('')
  const [product,    setProduct]    = useState('')
  const [results,    setResults]    = useState(null)
  const [total,      setTotal]      = useState(0)
  const [offset,     setOffset]     = useState(0)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)
  const [indexing,      setIndexing]      = useState(false)
  const [indexMsg,      setIndexMsg]      = useState(null)
  const [histIndexing,  setHistIndexing]  = useState(false)
  const [histMsg,       setHistMsg]       = useState(null)

  const LIMIT = 50

  const doSearch = useCallback(async (newOffset = 0) => {
    if (!machineId) return
    setLoading(true)
    setError(null)
    try {
      const data = await api.nfce.search(machineId, {
        dateFrom: dateFrom || undefined,
        dateTo:   dateTo   || undefined,
        valueMin: valueMin !== '' ? valueMin : undefined,
        valueMax: valueMax !== '' ? valueMax : undefined,
        product:  product  || undefined,
        limit:    LIMIT,
        offset:   newOffset,
      })
      setResults(data.results || [])
      setTotal(data.total || 0)
      setOffset(newOffset)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [machineId, dateFrom, dateTo, valueMin, valueMax, product])

  async function triggerIndex() {
    if (!machineId) return
    setIndexing(true)
    setIndexMsg(null)
    try {
      const r = await api.aloha.triggerIndex(machineId)
      setIndexMsg(`${r.days} comandos enviados para ${r.month}. O agente processará em instantes.`)
    } catch (e) {
      setIndexMsg('Erro: ' + e.message)
    } finally {
      setIndexing(false)
    }
  }

  async function triggerHistory() {
    if (!machineId) return
    setHistIndexing(true)
    setHistMsg(null)
    try {
      const r = await api.aloha.triggerHistory(machineId)
      setHistMsg(r.message || 'Indexação histórica iniciada.')
    } catch (e) {
      setHistMsg('Erro: ' + e.message)
    } finally {
      setHistIndexing(false)
    }
  }

  const s = {
    wrap:     { padding: '16px 20px', overflowY: 'auto', flex: 1 },
    form:     {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      gap: '10px',
      marginBottom: '16px',
      background: 'var(--card-bg)',
      border: '1px solid var(--border)',
      borderRadius: '8px',
      padding: '14px',
    },
    label:    { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '3px', display: 'block' },
    input:    {
      width: '100%', padding: '6px 8px',
      background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: '5px', color: 'inherit', fontSize: '12px', boxSizing: 'border-box',
    },
    tableHead: {
      display: 'grid',
      gridTemplateColumns: '80px 140px 90px 1fr 120px',
      gap: '8px',
      padding: '6px 12px',
      fontSize: '11px',
      fontWeight: 700,
      color: 'var(--text-muted)',
      background: 'var(--card-bg)',
      borderRadius: '6px 6px 0 0',
      border: '1px solid var(--border)',
      borderBottom: 'none',
    },
  }

  return (
    <div style={s.wrap}>
      {/* Search form */}
      <div style={s.form}>
        <div>
          <label style={s.label}>Servidor BOH</label>
          <select style={s.input} value={machineId} onChange={e => setMachineId(e.target.value)}>
            {bohMachines.map(m => (
              <option key={m.id} value={m.id}>{m.hostname} {m.location ? `— ${m.location}` : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={s.label}>Data inicial</label>
          <input type="date" style={s.input} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div>
          <label style={s.label}>Data final</label>
          <input type="date" style={s.input} value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
        <div>
          <label style={s.label}>Valor mín. (R$)</label>
          <input type="number" style={s.input} placeholder="0,00" step="0.01" value={valueMin} onChange={e => setValueMin(e.target.value)} />
        </div>
        <div>
          <label style={s.label}>Valor máx. (R$)</label>
          <input type="number" style={s.input} placeholder="999,99" step="0.01" value={valueMax} onChange={e => setValueMax(e.target.value)} />
        </div>
        <div>
          <label style={s.label}>Produto (texto)</label>
          <input type="text" style={s.input} placeholder="pizza, refrigerante…" value={product} onChange={e => setProduct(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch(0)} />
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px' }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => doSearch(0)} disabled={loading || !machineId}>
            {loading ? 'Buscando…' : '🔍 Buscar'}
          </button>
        </div>
      </div>

      {/* Indexing controls */}
      <div style={{ marginBottom: '14px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
        <button
          className="btn btn-secondary"
          style={{ fontSize: '11px', padding: '4px 10px' }}
          onClick={triggerIndex}
          disabled={indexing || !machineId}
          title="Solicita ao agente que indexe todas as NF-Ce do mês atual"
        >
          {indexing ? '⏳ Aguardando…' : '⚙ Indexar mês atual'}
        </button>
        <button
          className="btn btn-secondary"
          style={{ fontSize: '11px', padding: '4px 10px' }}
          onClick={triggerHistory}
          disabled={histIndexing || !machineId}
          title="Indexa todo o histórico disponível nas pastas do servidor BOH"
        >
          {histIndexing ? '⏳ Descobrindo meses…' : '📦 Indexar histórico completo'}
        </button>
        {indexMsg && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{indexMsg}</span>
        )}
        {histMsg && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{histMsg}</span>
        )}
      </div>

      {error && (
        <div style={{ color: 'var(--red)', fontSize: '12px', marginBottom: '12px' }}>⚠ {error}</div>
      )}

      {/* Results */}
      {results === null && !loading && (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', marginTop: '40px' }}>
          Use os filtros acima para buscar uma DANFE.<br />
          <span style={{ fontSize: '11px' }}>
            Se não há resultados, clique em "Indexar mês atual" para que o agente leia as NF-Ce.
          </span>
        </div>
      )}

      {results !== null && (
        <>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            {total} resultado{total !== 1 ? 's' : ''} encontrado{total !== 1 ? 's' : ''}
            {total > LIMIT && ` — exibindo ${offset + 1}–${Math.min(offset + LIMIT, total)}`}
          </div>

          {results.length > 0 && (
            <div style={{ border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden' }}>
              <div style={s.tableHead}>
                <span>Nº NF-e</span>
                <span>Emissão</span>
                <span>Valor</span>
                <span>Produtos</span>
                <span style={{ textAlign: 'right' }}>Ações</span>
              </div>
              {results.map(r => (
                <ResultRow key={r.chave} record={r} machineId={machineId} />
              ))}
            </div>
          )}

          {results.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', marginTop: '24px' }}>
              Nenhuma NF-Ce encontrada com esses filtros.
            </div>
          )}

          {/* Pagination */}
          {total > LIMIT && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '16px' }}>
              <button className="btn btn-secondary" disabled={offset === 0}
                onClick={() => doSearch(offset - LIMIT)}>← Anterior</button>
              <button className="btn btn-secondary" disabled={offset + LIMIT >= total}
                onClick={() => doSearch(offset + LIMIT)}>Próxima →</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
