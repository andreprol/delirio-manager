// dashboard/src/components/report/TopicList.jsx
import { useState } from 'react'
import { getServerUrl } from '../../api'

const SEV_STYLE = {
  critica: { bg: '#2d1f1f', border: '#742a2a', badgeBg: '#742a2a', badgeColor: '#fc8181' },
  alta:    { bg: '#2d2416', border: '#744210', badgeBg: '#744210', badgeColor: '#fbd38d' },
  media:   { bg: '#1a202c', border: '#2d3748', badgeBg: '#1a365d', badgeColor: '#90cdf4' },
  baixa:   { bg: '#1a202c', border: '#2d3748', badgeBg: '#1a4731', badgeColor: '#9ae6b4' },
}

function PhotoStrip({ urls }) {
  const [lightbox, setLightbox] = useState(null)
  const serverUrl = getServerUrl()
  if (!urls || !urls.length) return null
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
        {urls.map((url, i) => {
          const full = url.startsWith('http') ? url : `${serverUrl}${url}`
          return (
            <img
              key={i}
              src={full}
              alt={`Foto ${i + 1}`}
              onClick={() => setLightbox(full)}
              style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 4, border: '1px solid #4a5568', cursor: 'zoom-in' }}
            />
          )
        })}
      </div>
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, background: '#000c', zIndex: 20000, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}
        >
          <img src={lightbox} alt="Foto ampliada" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 4px 32px #000' }} />
        </div>
      )}
    </>
  )
}

export function TopicList({ topics, onResolve, onEdit }) {
  if (!topics.length) {
    return <p style={{ color: '#4a5568', fontSize: '0.8rem' }}>Nenhum tópico aberto nesta loja.</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {topics.map(t => {
        const s = SEV_STYLE[t.severity] || SEV_STYLE.baixa
        return (
          <div key={t.id} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6, padding: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 700, color: s.badgeColor, background: s.badgeBg, padding: '2px 5px', borderRadius: 3, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {t.severity.toUpperCase()}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.75rem', color: '#e2e8f0' }}>{t.description}</div>
              <PhotoStrip urls={t.photo_paths} />
            </div>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
              {t.is_critical_machine ? <span style={{ fontSize: '0.65rem', color: '#e53e3e', fontWeight: 700 }}>🔴 BOH/TERM</span> : null}
              {t.machine_mention && !t.is_critical_machine ? <span style={{ fontSize: '0.65rem', color: '#718096' }}>{t.machine_mention}</span> : null}
              <span style={{ fontSize: '0.65rem', color: '#4a5568' }}>{t.created_at?.slice(0, 10)}</span>
              <button onClick={() => onEdit?.(t)}
                style={{ background: 'none', border: 'none', color: '#718096', cursor: 'pointer', fontSize: '0.8rem', padding: '0 2px', lineHeight: 1 }}
                title="Editar tópico">✏️</button>
              <button onClick={() => onResolve(t.id)}
                style={{ background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', fontSize: '0.85rem', padding: '0 2px', lineHeight: 1 }}
                title="Excluir tópico">🗑</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
