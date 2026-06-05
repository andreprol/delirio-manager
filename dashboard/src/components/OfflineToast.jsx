import { useEffect, useState } from 'react'

export function OfflineToast({ toast, onDismiss }) {
  const [progress, setProgress] = useState(100)

  useEffect(() => {
    if (!toast) return
    setProgress(100)
    const start    = Date.now()
    const duration = 8000
    const timer    = setInterval(() => {
      const elapsed = Date.now() - start
      const pct     = Math.max(0, 100 - (elapsed / duration) * 100)
      setProgress(pct)
      if (pct === 0) { clearInterval(timer); onDismiss() }
    }, 100)
    return () => clearInterval(timer)
  }, [toast])

  if (!toast) return null

  return (
    <div className="offline-toast" onClick={onDismiss}>
      <div className="offline-toast-header">
        <span style={{ color: 'var(--red)', fontWeight: 700, fontSize: 11, textTransform: 'uppercase' }}>
          🔴 Máquina Offline
        </span>
        <span style={{ color: '#555', fontSize: 10 }}>clique para fechar</span>
      </div>
      <div className="offline-toast-name">{toast.displayName}</div>
      <div className="offline-toast-loc">{toast.location}</div>
      <div className="offline-toast-progress">
        <div className="offline-toast-bar" style={{ width: `${progress}%` }} />
      </div>
    </div>
  )
}
