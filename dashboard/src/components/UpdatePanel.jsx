import { useState, useRef } from 'react'
import { api, getServerUrl } from '../api'

export function UpdatePanel({ onClose }) {
  const [step, setStep]           = useState('idle') // idle | uploading | broadcasting | done | error
  const [progress, setProgress]   = useState(0)
  const [publishedVersion, setPublishedVersion] = useState(null)
  const [broadcastResult, setBroadcastResult]   = useState(null)
  const [error, setError]         = useState(null)
  const [serverVersion, setServerVersion] = useState(null)
  const fileRef = useRef(null)

  async function loadServerVersion() {
    try {
      const v = await api.getUpdateVersion()
      setServerVersion(v)
    } catch {}
  }

  // Carrega versao atual ao abrir
  useState(() => { loadServerVersion() })

  async function handlePublish() {
    const file = fileRef.current?.files?.[0]
    if (!file) { setError('Selecione o arquivo delirio-agent.exe primeiro.'); return }

    const version = document.getElementById('new-version').value.trim()
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      setError('Versao invalida. Use o formato: 1.2.3')
      return
    }

    setStep('uploading')
    setError(null)
    setProgress(0)

    try {
      const buffer = await file.arrayBuffer()

      // Upload via fetch com tracking de progresso
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${getServerUrl()}/api/update/publish`)
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.setRequestHeader('X-Agent-Version', version)

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round(e.loaded / e.total * 100))
      }

      await new Promise((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status === 200) resolve(JSON.parse(xhr.responseText))
          else reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`))
        }
        xhr.onerror = () => reject(new Error('Falha na conexao'))
        xhr.send(buffer)
      })

      setPublishedVersion(version)
      setProgress(100)
      setStep('done-publish')
      loadServerVersion()
    } catch (err) {
      setError(err.message)
      setStep('error')
    }
  }

  async function handleBroadcast() {
    setStep('broadcasting')
    setError(null)
    try {
      const result = await api.broadcastUpdate()
      setBroadcastResult(result)
      setStep('done')
    } catch (err) {
      setError(err.message)
      setStep('error')
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 500 }} onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">Publicar Atualizacao do Agente</h2>

        {/* Versao atual no servidor */}
        {serverVersion && (
          <div className="version-info">
            <span>Versao atual no servidor: </span>
            <strong style={{ color: 'var(--green)' }}>v{serverVersion.version}</strong>
            {serverVersion.publishedAt && (
              <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>
                publicada em {new Date(serverVersion.publishedAt).toLocaleString('pt-BR')}
              </span>
            )}
          </div>
        )}

        {/* Passo 1: Selecionar arquivo e versao */}
        <div className="update-step">
          <div className="step-num">1</div>
          <div className="step-body">
            <div className="form-label">Nova versao</div>
            <input
              id="new-version"
              className="form-input"
              placeholder="1.1.0"
              style={{ width: 120 }}
              defaultValue=""
            />
            <div className="form-label" style={{ marginTop: 10 }}>
              Arquivo delirio-agent.exe
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".exe"
              style={{ color: 'var(--text)', marginBottom: 10, fontSize: 12 }}
            />
            <button
              className="btn btn-primary"
              onClick={handlePublish}
              disabled={step === 'uploading'}
            >
              {step === 'uploading' ? `Enviando ${progress}%...` : 'Publicar no servidor'}
            </button>
          </div>
        </div>

        {/* Barra de progresso do upload */}
        {step === 'uploading' && (
          <div className="metric-bar-bg" style={{ margin: '8px 0' }}>
            <div className="metric-bar-fill" style={{ width: `${progress}%`, background: 'var(--blue)', height: 8 }} />
          </div>
        )}

        {/* Passo 2: Enviar para agentes */}
        {(step === 'done-publish' || step === 'broadcasting' || step === 'done') && (
          <div className="update-step" style={{ marginTop: 16 }}>
            <div className="step-num" style={{ background: step === 'done' ? 'var(--green)' : 'var(--blue)' }}>2</div>
            <div className="step-body">
              <div style={{ marginBottom: 8 }}>
                v{publishedVersion} publicada. Enviar comando de atualizacao para todos os agentes online?
              </div>
              {step === 'done' && broadcastResult ? (
                <div style={{ color: 'var(--green)' }}>
                  Comando enviado para <strong>{broadcastResult.sent}</strong> maquinas online.
                  Os agentes vao atualizar nos proximos 30 segundos.
                </div>
              ) : (
                <button
                  className="btn btn-success"
                  onClick={handleBroadcast}
                  disabled={step === 'broadcasting'}
                >
                  {step === 'broadcasting' ? 'Enviando...' : 'Atualizar todos os agentes online'}
                </button>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="test-result err" style={{ marginTop: 12 }}>{error}</div>
        )}

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}
