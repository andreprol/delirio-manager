import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'

const STATUS_COLOR = { online: '#22c55e', offline: '#ef4444', unknown: '#6b7280' }

// Máquinas BOH são aquelas cujo hostname termina em BOH
function isBOH(machine) {
  return machine.hostname?.toUpperCase().endsWith('BOH')
}

function fmtDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

function fmtMB(mb) {
  if (!mb && mb !== 0) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`
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
    tag: {
      display: 'inline-block',
      background: 'var(--bg-hover)',
      border: '1px solid var(--border)',
      borderRadius: '4px',
      padding: '2px 8px',
      fontSize: '11px',
      fontFamily: 'monospace',
      marginRight: '4px',
      marginBottom: '4px',
    },
  }

  return (
    <div>
      {/* Resumo */}
      <div style={{ ...s.section, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '18px' }}>
        {[
          { label: 'Total de arquivos', value: scan.total_files?.toLocaleString('pt-BR') || '0' },
          { label: 'Tamanho total',     value: fmtMB(scan.total_size_mb) },
          { label: 'Banco de dados',    value: `${scan.database_files?.length || 0} arquivo(s)` },
          { label: 'XMLs fiscais',      value: (scan.xml_fiscal?.total || 0).toLocaleString('pt-BR') },
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

      {/* Pastas */}
      {scan.directories?.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>📁 Pastas em C:\Bootdrv</div>
          <div>{scan.directories.map(d => <span key={d} style={s.tag}>{d}</span>)}</div>
        </div>
      )}

      {/* Banco de Dados */}
      <div style={s.section}>
        <div style={s.sectionTitle}>🗄️ Banco de Dados ({scan.database_files?.length || 0})</div>
        {scan.database_files?.length > 0 ? (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Arquivo</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Tamanho</th>
                <th style={s.th}>Modificado</th>
              </tr>
            </thead>
            <tbody>
              {scan.database_files.map((f, i) => (
                <tr key={i}>
                  <td style={{ ...s.td, ...s.mono, maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path}</td>
                  <td style={{ ...s.td, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtMB(f.size_mb)}</td>
                  <td style={{ ...s.td, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{f.mod_time?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Nenhum arquivo de banco encontrado</span>
        )}
      </div>

      {/* XMLs Fiscais */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          📄 XMLs Fiscais — {(scan.xml_fiscal?.total || 0).toLocaleString('pt-BR')} arquivos
          {scan.xml_fiscal?.latest_date && (
            <span style={{ fontWeight: 400, color: 'var(--text-muted)', textTransform: 'none', marginLeft: '8px', fontSize: '11px' }}>
              · mais recente: {scan.xml_fiscal.latest_date}
            </span>
          )}
        </div>
        {scan.xml_fiscal?.recent?.length > 0 ? (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Arquivo</th>
                <th style={s.th}>Data</th>
              </tr>
            </thead>
            <tbody>
              {scan.xml_fiscal.recent.map((f, i) => (
                <tr key={i}>
                  <td style={{ ...s.td, ...s.mono, maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path}</td>
                  <td style={{ ...s.td, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{f.mod_time?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Nenhum XML encontrado</span>
        )}
      </div>

      {/* Configs */}
      {scan.config_files?.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>⚙️ Configurações ({scan.config_files.length})</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {scan.config_files.map((f, i) => (
              <div key={i} style={{ fontFamily: 'monospace', marginBottom: '2px' }}>
                {f.path} <span style={{ color: 'var(--text)' }}>({fmtMB(f.size_mb)})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {scan.error && (
        <div style={{ color: 'var(--red)', fontSize: '12px', marginTop: '8px' }}>⚠ {scan.error}</div>
      )}
    </div>
  )
}

// ── Linha de uma máquina BOH ─────────────────────────────────────────────────

function BohRow({ machine, expanded, onToggle }) {
  const [scan,     setScan]     = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error,    setError]    = useState(null)

  const loadScan = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.aloha.getLatest(machine.id)
      setScan(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [machine.id])

  useEffect(() => {
    if (expanded && !scan && !loading) loadScan()
  }, [expanded, scan, loading, loadScan])

  async function handleScan() {
    setScanning(true)
    setError(null)
    try {
      await api.aloha.scan(machine.id)
      setTimeout(() => { loadScan(); setScanning(false) }, 15000)
    } catch (e) {
      setError(e.message)
      setScanning(false)
    }
  }

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
    dot: {
      width: '8px', height: '8px',
      borderRadius: '50%',
      background: statusColor,
      flexShrink: 0,
    },
    name: { fontWeight: 700, fontSize: '13px', flex: '0 0 auto' },
    location: { fontSize: '12px', color: 'var(--text-muted)', flex: 1 },
    meta: { fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' },
    actions: { display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 },
    detail: { padding: '14px 18px', borderTop: '1px solid var(--border)' },
  }

  const scanMeta = scan
    ? `${scan.total_files?.toLocaleString('pt-BR') || '?'} arquivos · ${fmtMB(scan.total_size_mb)} · scan ${fmtDate(scan.acked_at || scan.scanned_at)}`
    : null

  return (
    <div style={s.row}>
      <div style={s.rowHeader} onClick={onToggle}>
        <span style={s.dot} />
        <span style={s.name}>{machine.hostname}</span>
        <span style={s.location}>{machine.location || machine.displayName || '—'}</span>
        {scanMeta && <span style={s.meta}>{scanMeta}</span>}
        {!scan && !loading && (
          <span style={{ ...s.meta, color: 'var(--yellow)' }}>Sem scan</span>
        )}
        {loading && <span style={s.meta}>Carregando…</span>}
        <div style={s.actions} onClick={e => e.stopPropagation()}>
          <button
            className="btn btn-success"
            style={{ fontSize: '11px', padding: '3px 10px' }}
            disabled={scanning || machine.status !== 'online'}
            title={machine.status !== 'online' ? 'Máquina offline' : 'Escanear C:\\Bootdrv'}
            onClick={handleScan}
          >
            {scanning ? '⏳ Escaneando…' : '🔍 Escanear'}
          </button>
          {scan && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: '11px', padding: '3px 8px' }}
              onClick={loadScan}
              disabled={loading}
            >↻</button>
          )}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={s.detail}>
          {scanning && (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '10px' }}>
              ⏳ Scan enviado ao agente, aguardando resultado (~15s)…
            </div>
          )}
          {error && <div style={{ color: 'var(--red)', fontSize: '12px', marginBottom: '8px' }}>⚠ {error}</div>}
          {!scan && !loading && !scanning && (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
              Nenhum scan disponível. Clique em "🔍 Escanear" para mapear C:\Bootdrv.
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
    panel: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
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
    title: { fontSize: '15px', fontWeight: 700, margin: 0, whiteSpace: 'nowrap' },
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
    content: { overflowY: 'auto', flex: 1, padding: '20px' },
    empty: { color: 'var(--text-muted)', fontSize: '13px', marginTop: '40px', textAlign: 'center' },
  }

  const onlineCount  = bohMachines.filter(m => m.status === 'online').length
  const offlineCount = bohMachines.length - onlineCount

  return (
    <div style={s.overlay}>
      <div style={s.panel}>
        <div style={s.header}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0' }}>
            <h2 style={s.title}>🍕 Aloha — Servidores BOH</h2>
            <span style={s.subtitle}>
              {bohMachines.length} servidores
              {onlineCount > 0 && <span style={{ color: '#22c55e' }}> · {onlineCount} online</span>}
              {offlineCount > 0 && <span style={{ color: '#ef4444' }}> · {offlineCount} offline</span>}
            </span>
          </div>
          <button style={s.closeBtn} onClick={onClose}>Fechar</button>
        </div>

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
      </div>
    </div>
  )
}
