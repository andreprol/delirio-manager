// dashboard/src/components/report/GenerateModal.jsx
import { useState } from 'react'
import { api } from '../../api'

export function GenerateModal({ storeName, onClose, onGenerated }) {
  const now     = new Date()
  const defMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const [month,      setMonth]      = useState(defMonth)
  const [generating, setGenerating] = useState(false)
  const [result,     setResult]     = useState(null)
  const [feedback,   setFeedback]   = useState('')
  const [fbSaved,    setFbSaved]    = useState(false)
  const [error,      setError]      = useState(null)
  const [dlDone,     setDlDone]     = useState(null) // filename do último download concluído

  function downloadFile(relativeUrl, filename) {
    const url = `${api.getServerUrl?.() || ''}${relativeUrl}`
    if (window.electronAPI?.downloadFile) {
      window.electronAPI.downloadFile(url)
      // Ouve conclusão do download via IPC (only once per click)
      const unsub = window.electronAPI.onDownloadDone?.((data) => {
        if (data.state === 'completed') setDlDone(data.filename)
        unsub?.()
      })
    } else {
      // Fallback: browser normal
      const a = document.createElement('a')
      a.href = url; a.download = filename; a.click()
    }
  }

  async function handleGenerate() {
    setGenerating(true); setError(null); setResult(null); setDlDone(null)
    try {
      const r = await api.relatorio.generate(storeName, month)
      setResult(r)
      onGenerated?.(r)
    } catch (e) {
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  async function handleFeedback() {
    if (!feedback.trim() || !result) return
    await api.relatorio.saveFeedback(storeName, month, feedback, result.runId).catch(() => {})
    setFbSaved(true)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000a', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#1a202c', border: '1px solid #2d3748', borderRadius: 10, padding: 24, width: 480, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h3 style={{ margin: 0, color: '#e2e8f0' }}>📄 Gerar Relatório — {storeName}</h3>

        {!result && (
          <>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Mês de referência</label>
              <input type="month" value={month} onChange={e => setMonth(e.target.value)}
                style={{ display: 'block', marginTop: 4, background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '8px', fontSize: '0.85rem' }}
              />
            </div>
            {error && <div style={{ color: '#fc8181', fontSize: '0.78rem' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={{ background: 'none', border: '1px solid #4a5568', borderRadius: 6, color: '#a0aec0', padding: '7px 14px', cursor: 'pointer', fontSize: '0.8rem' }}>Cancelar</button>
              <button onClick={handleGenerate} disabled={generating}
                style={{ background: '#667eea', border: 'none', borderRadius: 6, color: 'white', padding: '7px 16px', cursor: generating ? 'wait' : 'pointer', fontSize: '0.8rem', opacity: generating ? 0.7 : 1 }}>
                {generating ? '⏳ Gerando... (pode levar 15s)' : '📄 Gerar Relatório'}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            <div style={{ background: '#1a3a2a', border: '1px solid #48bb78', borderRadius: 8, padding: 12 }}>
              <div style={{ color: '#9ae6b4', fontWeight: 700, fontSize: '0.85rem' }}>✅ Relatório gerado!</div>
              <div style={{ color: '#e2e8f0', fontSize: '0.8rem', marginTop: 4 }}>Score: {result.score}/100</div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: '#a0aec0', marginBottom: 8 }}>Escolha o formato para baixar:</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {result.docxUrl && (
                  <button onClick={() => downloadFile(result.docxUrl, `relatorio_${storeName}_${month}.docx`)}
                    style={{ flex: 1, background: '#2b6cb0', border: 'none', borderRadius: 6, color: 'white', padding: '9px 12px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600 }}>
                    ⬇ Word (.docx)
                  </button>
                )}
                {result.pdfUrl && (
                  <button onClick={() => downloadFile(result.pdfUrl, `relatorio_${storeName}_${month}.pdf`)}
                    style={{ flex: 1, background: '#c53030', border: 'none', borderRadius: 6, color: 'white', padding: '9px 12px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600 }}>
                    ⬇ PDF
                  </button>
                )}
              </div>
              {dlDone && (
                <div style={{ color: '#9ae6b4', fontSize: '0.75rem', marginTop: 6 }}>
                  ✅ Salvo na pasta Downloads: {dlDone}
                </div>
              )}
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Sua opinião sobre este relatório (opcional — melhora os próximos)</label>
              <textarea value={feedback} onChange={e => setFeedback(e.target.value)} rows={3}
                disabled={fbSaved}
                style={{ width: '100%', marginTop: 4, background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '8px', fontSize: '0.82rem', resize: 'vertical', boxSizing: 'border-box' }}
                placeholder="Ex: Score muito alto, o problema da impressora não é crítico..."
              />
              {fbSaved
                ? <div style={{ color: '#9ae6b4', fontSize: '0.75rem', marginTop: 4 }}>✅ Feedback salvo — será usado nos próximos relatórios.</div>
                : <button onClick={handleFeedback} disabled={!feedback.trim()}
                    style={{ marginTop: 6, background: 'none', border: '1px solid #4a5568', borderRadius: 6, color: '#a0aec0', padding: '5px 12px', cursor: 'pointer', fontSize: '0.78rem' }}>
                    Salvar Feedback
                  </button>
              }
            </div>
            <button onClick={onClose} style={{ background: '#2d3748', border: 'none', borderRadius: 6, color: '#e2e8f0', padding: '8px', cursor: 'pointer', fontSize: '0.82rem' }}>Fechar</button>
          </>
        )}
      </div>
    </div>
  )
}
