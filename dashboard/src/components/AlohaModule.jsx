import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api'
import { AlohaDANFESearch } from './AlohaDANFESearch'

const STATUS_COLOR = { online: '#22c55e', offline: '#ef4444', unknown: '#6b7280' }

function isBOH(machine) {
  return machine.hostname?.toUpperCase().endsWith('BOH')
}

function fmtDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

function fmtMB(mb) {
  if (!mb && mb !== 0) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`
}

// ── Painel de detalhes de um scan ────────────────────────────────────────────

function ScanDetail({ scan }) {
  if (!scan) return null

  const s = {
    section: { marginBottom: '16px' },
    sectionTitle: {
      fontSize: '11px',
      fontWeight: 700,
      color: 'var(--text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      marginBottom: '6px',
    },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
    th: { padding: '3px 8px 5px 0', fontWeight: 600, color: 'var(--text-muted)', textAlign: 'left' },
    td: { padding: '4px 8px 4px 0', borderTop: '1px solid var(--border)', verticalAlign: 'top' },
    mono: { fontFamily: 'monospace', fontSize: '11px' },
  }

  const nfceTotal = scan.nfce?.total || 0

  return (
    <div>
      {/* Resumo */}
      <div style={{ ...s.section, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px', marginBottom: '18px' }}>
        {[
          { label: 'NF-Ce emitidas',     value: nfceTotal.toLocaleString('pt-BR') },
          { label: 'NF-Ce mais recente', value: scan.nfce?.latest_date || '—' },
        ].map(({ label, value }) => (
          <div key={label} style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '10px 14px',
          }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</div>
            <div style={{ fontSize: '15px', fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* NF-Ce */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          📄 NF-Ce — {nfceTotal.toLocaleString('pt-BR')} documentos
          {!scan.nfce?.path_exists && (
            <span style={{ fontWeight: 400, color: 'var(--red)', textTransform: 'none', marginLeft: '8px', fontSize: '11px' }}>
              · pasta AlohaFiscal não encontrada
            </span>
          )}
        </div>
        {scan.nfce?.recent?.length > 0 ? (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Arquivo XML</th>
                <th style={s.th}>Data</th>
              </tr>
            </thead>
            <tbody>
              {scan.nfce.recent.map((f, i) => (
                <tr key={i}>
                  <td style={{ ...s.td, ...s.mono, maxWidth: '400px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path}</td>
                  <td style={{ ...s.td, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{f.mod_time?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
            {scan.nfce?.path_exists ? 'Nenhum XML encontrado' : 'Caminho C:\\Bootdrv\\AlohaFiscal\\ServerData\\XML não existe neste servidor'}
          </span>
        )}
      </div>

      {scan.error && (
        <div style={{ color: 'var(--red)', fontSize: '12px', marginTop: '8px' }}>⚠ {scan.error}</div>
      )}
    </div>
  )
}

// ── Cache de módulo — sobrevive desmontagem/remontagem do AlohaModule ────────
const _scanCache = {}

// ── Linha de uma máquina BOH ─────────────────────────────────────────────────

function BohRow({ machine, expanded, onToggle }) {
  const [scan,          setScan]          = useState(_scanCache[machine.id] || null)
  const [loading,       setLoading]       = useState(false)
  const [autoScanning,  setAutoScanning]  = useState(false)
  const [error,         setError]         = useState(null)
  const didLoadRef     = useRef(!!_scanCache[machine.id])
  const didAutoScanRef = useRef(!!_scanCache[machine.id])

  const loadScan = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.aloha.getLatest(machine.id)
      if (data) _scanCache[machine.id] = data
      setScan(data)
      return data
    } catch (e) {
      setError(e.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [machine.id])

  useEffect(() => {
    if (!expanded || didLoadRef.current) return
    didLoadRef.current = true

    const run = async () => {
      const data = await loadScan()
      // Auto-scan se não há dados e a máquina está online
      if (!data && machine.status === 'online' && !didAutoScanRef.current) {
        didAutoScanRef.current = true
        setAutoScanning(true)
        try {
          await api.aloha.scan(machine.id)
          // Polling a cada 5s por até 60s (agente pode demorar até 1 ciclo de heartbeat)
          let attempts = 0
          const poll = async () => {
            attempts++
            const result = await loadScan()
            if (result || attempts >= 12) {
              setAutoScanning(false)
            } else {
              setTimeout(poll, 5000)
            }
          }
          setTimeout(poll, 5000)
        } catch (e) {
          setError(e.message)
          setAutoScanning(false)
        }
      }
    }

    run()
  }, [expanded, loadScan, machine.id, machine.status])

  const statusColor = STATUS_COLOR[machine.status] || STATUS_COLOR.unknown

  const s = {
    row: {
      border: '1px solid var(--border)',
      borderRadius: '8px',
      marginBottom: '8px',
      overflow: 'hidden',
      background: 'var(--card-bg)',
    },
    rowHeader: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '10px 14px',
      cursor: 'pointer',
      userSelect: 'none',
    },
    dot:      { width: '8px', height: '8px', borderRadius: '50%', background: statusColor, flexShrink: 0 },
    name:     { fontWeight: 700, fontSize: '13px', flex: '0 0 auto' },
    location: { fontSize: '12px', color: 'var(--text-muted)', flex: 1 },
    meta:     { fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' },
    detail:   { padding: '14px 18px', borderTop: '1px solid var(--border)' },
  }

  const scanMeta = scan
    ? `${(scan.nfce?.total || 0).toLocaleString('pt-BR')} NF-Ce · verificado ${fmtDate(scan.acked_at || scan.scanned_at)}`
    : null

  return (
    <div style={s.row}>
      <div style={s.rowHeader} onClick={onToggle}>
        <span style={s.dot} />
        <span style={s.name}>{machine.hostname}</span>
        <span style={s.location}>{machine.location || machine.displayName || '—'}</span>
        {scanMeta && <span style={s.meta}>{scanMeta}</span>}
        {!scan && !loading && !autoScanning && (
          <span style={{ ...s.meta, color: 'var(--yellow)' }}>Sem scan</span>
        )}
        {(loading || autoScanning) && (
          <span style={s.meta}>{autoScanning ? '⏳ Escaneando…' : 'Carregando…'}</span>
        )}
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          {scan && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: '11px', padding: '3px 8px' }}
              onClick={loadScan}
              disabled={loading}
              title="Recarregar dados do último scan"
            >↻</button>
          )}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={s.detail}>
          {autoScanning && (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '10px' }}>
              ⏳ Primeiro scan em andamento, aguardando resultado (~15s)…
            </div>
          )}
          {error && <div style={{ color: 'var(--red)', fontSize: '12px', marginBottom: '8px' }}>⚠ {error}</div>}
          {!scan && !loading && !autoScanning && (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
              {machine.status !== 'online'
                ? 'Máquina offline — não é possível escanear.'
                : 'Nenhum scan disponível.'}
            </div>
          )}
          {loading && <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Carregando…</div>}
          {scan && <ScanDetail scan={scan} />}
        </div>
      )}
    </div>
  )
}

// ── Módulo principal ─────────────────────────────────────────────────────────

export function AlohaModule({ onClose, machines = [] }) {
  const bohMachines = machines.filter(isBOH)
  const [view,     setView]     = useState('servers') // 'servers' | 'danfe'
  const [expanded, setExpanded] = useState(null)

  function toggleExpand(id) {
    setExpanded(prev => prev === id ? null : id)
  }

  const s = {
    overlay: {
      position: 'fixed',
      inset: 0,
      background: 'var(--bg, #0f1117)',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
    },
    panel:  { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '14px 20px',
      borderBottom: '1px solid var(--border, #2d3748)',
      background: 'var(--card-bg, #1e2530)',
      flexShrink: 0,
      gap: '12px',
    },
    title:    { fontSize: '15px', fontWeight: 700, margin: 0, whiteSpace: 'nowrap' },
    subtitle: { fontSize: '12px', color: 'var(--text-muted)', marginLeft: '10px' },
    closeBtn: {
      padding: '6px 16px',
      background: 'transparent',
      color: 'var(--text-muted)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      fontSize: '13px',
      fontWeight: 600,
      cursor: 'pointer',
      flexShrink: 0,
    },
    tabs: { display: 'flex', gap: '4px' },
    tab: (active) => ({
      padding: '5px 14px',
      background: active ? 'var(--accent, #3b82f6)' : 'transparent',
      color: active ? '#fff' : 'var(--text-muted)',
      border: `1px solid ${active ? 'var(--accent, #3b82f6)' : 'var(--border)'}`,
      borderRadius: '6px',
      fontSize: '12px',
      fontWeight: active ? 700 : 400,
      cursor: 'pointer',
    }),
    content: { overflowY: 'auto', flex: 1, padding: '20px' },
    empty:   { color: 'var(--text-muted)', fontSize: '13px', marginTop: '40px', textAlign: 'center' },
  }

  const onlineCount  = bohMachines.filter(m => m.status === 'online').length
  const offlineCount = bohMachines.length - onlineCount

  return (
    <div style={s.overlay}>
      <div style={s.panel}>
        <div style={s.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}>
            <h2 style={s.title}>🍕 Aloha</h2>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {bohMachines.length} servidores
              {onlineCount > 0 && <span style={{ color: '#22c55e' }}> · {onlineCount} online</span>}
              {offlineCount > 0 && <span style={{ color: '#ef4444' }}> · {offlineCount} offline</span>}
            </span>
            <div style={s.tabs}>
              <button style={s.tab(view === 'servers')} onClick={() => setView('servers')}>Servidores BOH</button>
              <button style={s.tab(view === 'danfe')}   onClick={() => setView('danfe')}>🧾 Buscar DANFE</button>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose}>Fechar</button>
        </div>

        {view === 'servers' ? (
          <div style={s.content}>
            {bohMachines.length === 0 ? (
              <div style={s.empty}>
                Nenhum servidor BOH encontrado no Delirio Manager.<br />
                <span style={{ fontSize: '11px' }}>Máquinas BOH têm hostname terminando em BOH (ex: METROBOH, CITTABOH).</span>
              </div>
            ) : (
              bohMachines.map(machine => (
                <BohRow
                  key={machine.id}
                  machine={machine}
                  expanded={expanded === machine.id}
                  onToggle={() => toggleExpand(machine.id)}
                />
              ))
            )}
          </div>
        ) : (
          bohMachines.length === 0 ? (
            <div style={{ ...s.content, ...s.empty }}>
              Nenhum servidor BOH encontrado.
            </div>
          ) : (
            <AlohaDANFESearch bohMachines={bohMachines} />
          )
        )}
      </div>
    </div>
  )
}
