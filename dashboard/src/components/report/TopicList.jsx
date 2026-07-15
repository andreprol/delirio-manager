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

const BTN = { background: '#2d3748', border: '1px solid #4a5568', borderRadius: 4, color: '#a0aec0', cursor: 'pointer', fontSize: '0.65rem', padding: '2px 7px', lineHeight: 1.4, whiteSpace: 'nowrap' }
const BTN_BLUE = { ...BTN, background: '#1a2744', border: '1px solid #2c4a8a', color: '#90cdf4' }

export function TopicList({ topics, onResolve, onEdit, allStores = [], onMove, onReplicate }) {
  const [movingId,        setMovingId]        = useState(null)
  const [replicatingId,   setReplicatingId]   = useState(null)
  const [replicateSelected, setReplicateSelected] = useState([])

  function toggleReplStore(name) {
    setReplicateSelected(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    )
  }

  function handleMoveSelect(topicId, targetStore) {
    setMovingId(null)
    if (targetStore) onMove?.(topicId, targetStore)
  }

  function handleReplicateConfirm(topicId) {
    if (!replicateSelected.length) return
    onReplicate?.(topicId, replicateSelected)
    setReplicatingId(null)
    setReplicateSelected([])
  }

  if (!topics.length) {
    return <p style={{ color: '#4a5568', fontSize: '0.8rem' }}>Nenhum tópico aberto nesta loja.</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {topics.map(t => {
        const s = SEV_STYLE[t.severity] || SEV_STYLE.baixa
        const isMoving      = movingId      === t.id
        const isReplicating = replicatingId === t.id
        return (
          <div key={t.id} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6, padding: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ fontSize: '0.65rem', fontWeight: 700, color: s.badgeColor, background: s.badgeBg, padding: '2px 5px', borderRadius: 3, whiteSpace: 'nowrap', flexShrink: 0 }}>
                {t.severity.toUpperCase()}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.75rem', color: '#e2e8f0' }}>{t.description}</div>
                <PhotoStrip urls={t.photo_paths} />
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {t.is_critical_machine ? <span style={{ fontSize: '0.65rem', color: '#e53e3e', fontWeight: 700 }}>🔴 BOH/TERM</span> : null}
                {t.machine_mention && !t.is_critical_machine ? <span style={{ fontSize: '0.65rem', color: '#718096' }}>{t.machine_mention}</span> : null}
                <span style={{ fontSize: '0.65rem', color: '#4a5568' }}>{t.created_at?.slice(0, 10)}</span>
                <button onClick={() => onEdit?.(t)} style={BTN} title="Editar tópico">✏️ Editar</button>
                {allStores.length > 0 && (
                  <button
                    onClick={() => { setMovingId(isMoving ? null : t.id); setReplicatingId(null) }}
                    style={BTN_BLUE} title="Mover para outra loja">📦 Mover</button>
                )}
                {allStores.length > 0 && (
                  <button
                    onClick={() => { setReplicatingId(isReplicating ? null : t.id); setReplicateSelected([]); setMovingId(null) }}
                    style={BTN_BLUE} title="Replicar para outras lojas">🔁 Replicar</button>
                )}
                <button onClick={() => onResolve(t.id)}
                  style={{ background: '#2d1f1f', border: '1px solid #742a2a', borderRadius: 4, color: '#fc8181', cursor: 'pointer', fontSize: '0.65rem', padding: '2px 7px', lineHeight: 1.4, whiteSpace: 'nowrap' }}
                  title="Excluir tópico">✕ Excluir</button>
              </div>
            </div>

            {/* Move inline picker */}
            {isMoving && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: '0.65rem', color: '#90cdf4' }}>Mover para:</span>
                <select
                  defaultValue=""
                  onChange={e => handleMoveSelect(t.id, e.target.value)}
                  style={{ fontSize: '0.65rem', background: '#1a202c', border: '1px solid #4a5568', borderRadius: 4, color: '#e2e8f0', padding: '2px 6px' }}
                >
                  <option value="" disabled>Selecionar loja…</option>
                  {allStores.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
                <button onClick={() => setMovingId(null)} style={{ ...BTN, color: '#fc8181', border: '1px solid #742a2a' }}>Cancelar</button>
              </div>
            )}

            {/* Replicate inline picker */}
            {isReplicating && (
              <div style={{ marginTop: 6, padding: '6px 8px', background: '#1a1a2e', borderRadius: 4, border: '1px solid #2c4a8a' }}>
                <div style={{ fontSize: '0.65rem', color: '#90cdf4', marginBottom: 4 }}>Replicar para:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                  {allStores.map(name => (
                    <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.65rem', color: '#a0aec0', cursor: 'pointer' }}>
                      <input type="checkbox" checked={replicateSelected.includes(name)} onChange={() => toggleReplStore(name)} />
                      {name}
                    </label>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    onClick={() => handleReplicateConfirm(t.id)}
                    disabled={!replicateSelected.length}
                    style={{ ...BTN_BLUE, opacity: replicateSelected.length ? 1 : 0.4 }}>
                    ✓ Confirmar ({replicateSelected.length})
                  </button>
                  <button onClick={() => { setReplicatingId(null); setReplicateSelected([]) }} style={{ ...BTN, color: '#fc8181', border: '1px solid #742a2a' }}>Cancelar</button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
