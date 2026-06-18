import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'

export function AlohaTab({ machineId, machineStatus }) {
  const [scan,    setScan]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error,   setError]   = useState(null)

  const loadScan = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.aloha.getLatest(machineId)
      setScan(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [machineId])

  useEffect(() => { loadScan() }, [loadScan])

  async function handleScan() {
    setScanning(true)
    setError(null)
    try {
      await api.aloha.scan(machineId)
      // O agente executará em ~10s; aguarda 15s e recarrega
      setTimeout(() => {
        loadScan()
        setScanning(false)
      }, 15000)
    } catch (e) {
      setError(e.message)
      setScanning(false)
    }
  }

  const fmtDate = (iso) => iso
    ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : '—'

  const fmtMB = (mb) => mb >= 1024
    ? `${(mb / 1024).toFixed(1)} GB`
    : `${mb.toFixed(0)} MB`

  return (
    <div style={{ padding: '8px 0', fontSize: '12px' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <button
          className="btn btn-success"
          disabled={scanning || machineStatus !== 'online'}
          onClick={handleScan}
          title={machineStatus !== 'online' ? 'Máquina offline' : ''}
        >
          {scanning ? '⏳ Escaneando...' : '🔍 Escanear Aloha'}
        </button>
        {scan && !scanning && (
          <button className="btn btn-secondary" onClick={loadScan} disabled={loading}>
            ↻ Atualizar
          </button>
        )}
        {scanning && (
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            Aguardando resposta do agente (~15s)…
          </span>
        )}
      </div>

      {error && (
        <div style={{ color: 'var(--red)', marginBottom: '8px', fontSize: '11px' }}>{error}</div>
      )}

      {loading && !scan && (
        <div style={{ color: 'var(--text-muted)' }}>Carregando…</div>
      )}

      {!loading && !scan && !error && (
        <div style={{ color: 'var(--text-muted)' }}>
          Nenhum scan realizado. Clique em "Escanear Aloha" para mapear C:\Bootdrv.
        </div>
      )}

      {scan && (
        <>
          {/* Cabeçalho do scan */}
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            padding: '8px 10px',
            marginBottom: '10px',
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: '4px 12px', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)' }}>Scan em</span>
              <span>{fmtDate(scan.acked_at || scan.scanned_at)}</span>
              <span style={{ color: 'var(--text-muted)' }}>Status</span>
              <span style={{ color: scan.bootdrv_exists ? 'var(--green)' : 'var(--red)' }}>
                {scan.bootdrv_exists ? '✓ C:\\Bootdrv encontrado' : '✗ Não encontrado'}
              </span>
              <span style={{ color: 'var(--text-muted)' }}>Total</span>
              <span>{scan.total_files?.toLocaleString('pt-BR')} arquivos</span>
              <span style={{ color: 'var(--text-muted)' }}>Tamanho</span>
              <span>{fmtMB(scan.total_size_mb || 0)}</span>
            </div>
            {scan.error && (
              <div style={{ color: 'var(--red)', marginTop: '4px', fontSize: '11px' }}>{scan.error}</div>
            )}
          </div>

          {/* Diretórios */}
          {scan.directories?.length > 0 && (
            <Section title="📁 Pastas em C:\Bootdrv">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {scan.directories.map(d => (
                  <span key={d} style={{
                    background: 'var(--bg-hover)',
                    border: '1px solid var(--border)',
                    borderRadius: '4px',
                    padding: '2px 8px',
                    fontSize: '11px',
                    fontFamily: 'monospace',
                  }}>{d}</span>
                ))}
              </div>
            </Section>
          )}

          {/* Banco de dados */}
          <Section title={`🗄️ Banco de Dados (${scan.database_files?.length || 0} arquivo${scan.database_files?.length !== 1 ? 's' : ''})`}>
            {scan.database_files?.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '2px 6px 4px 0', fontWeight: 500 }}>Arquivo</th>
                    <th style={{ padding: '2px 6px 4px 0', fontWeight: 500, textAlign: 'right' }}>Tamanho</th>
                    <th style={{ padding: '2px 0 4px 0', fontWeight: 500 }}>Modificado</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.database_files.map((f, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '3px 6px 3px 0', fontFamily: 'monospace', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>
                        {f.path}
                      </td>
                      <td style={{ padding: '3px 6px 3px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {fmtMB(f.size_mb)}
                      </td>
                      <td style={{ padding: '3px 0', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                        {f.mod_time?.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>Nenhum arquivo de banco encontrado</span>
            )}
          </Section>

          {/* XMLs Fiscais */}
          <Section title={`📄 XMLs Fiscais (${scan.xml_fiscal?.total?.toLocaleString('pt-BR') || 0} arquivos)`}>
            {scan.xml_fiscal?.total > 0 ? (
              <>
                <div style={{ marginBottom: '6px', color: 'var(--text-muted)', fontSize: '11px' }}>
                  Mais recente: <strong style={{ color: 'var(--text)' }}>{scan.xml_fiscal.latest_date || '—'}</strong>
                  {scan.xml_fiscal.total > 10 && (
                    <span> · Exibindo os 10 mais recentes</span>
                  )}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                      <th style={{ padding: '2px 6px 4px 0', fontWeight: 500 }}>Arquivo</th>
                      <th style={{ padding: '2px 0 4px 0', fontWeight: 500 }}>Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scan.xml_fiscal.recent.map((f, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '3px 6px 3px 0', fontFamily: 'monospace', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>
                          {f.path}
                        </td>
                        <td style={{ padding: '3px 0', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                          {f.mod_time?.slice(0, 10)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>Nenhum XML fiscal encontrado</span>
            )}
          </Section>

          {/* Configs */}
          {scan.config_files?.length > 0 && (
            <Section title={`⚙️ Configurações (${scan.config_files.length})`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {scan.config_files.map((f, i) => (
                  <span key={i} style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-muted)' }}>
                    {f.path} <span style={{ color: 'var(--text)' }}>({fmtMB(f.size_mb)})</span>
                  </span>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        marginBottom: '6px',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}
