import { useState, useEffect } from 'react'

export function UpdateToast() {
  const [update, setUpdate] = useState(null)

  useEffect(() => {
    if (!window.electronAPI?.onUpdateDownloaded) return
    window.electronAPI.onUpdateDownloaded((data) => setUpdate(data))
  }, [])

  if (!update) return null

  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24,
      background: '#12122a', border: '1px solid #667eea88',
      borderRadius: 10, padding: '14px 16px',
      zIndex: 9998, display: 'flex', flexDirection: 'column', gap: 10,
      boxShadow: '0 4px 24px #667eea44', width: 280,
      fontFamily: 'monospace',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ color: '#818cf8', fontWeight: 600, fontSize: '0.88em' }}>
          ⬆ Atualização disponível
        </span>
        <button
          onClick={() => setUpdate(null)}
          style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '1em', lineHeight: 1 }}
        >✕</button>
      </div>
      <span style={{ color: '#9ca3af', fontSize: '0.78em', lineHeight: 1.4 }}>
        Versão <strong style={{ color: '#c4b5fd' }}>{update.version}</strong> baixada e pronta para instalar.
      </span>
      <button
        onClick={() => window.electronAPI.quitAndInstall()}
        style={{
          background: '#667eea', border: 'none', borderRadius: 6,
          color: '#fff', padding: '7px 0', cursor: 'pointer',
          fontSize: '0.82em', fontWeight: 600, letterSpacing: '0.02em',
        }}
      >
        Reiniciar agora
      </button>
    </div>
  )
}
