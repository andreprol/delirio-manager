// dashboard/src/components/report/TopicForm.jsx
import { useState, useRef, useCallback } from 'react'
import { api, getServerUrl } from '../../api'

const SEVERITIES = ['baixa', 'media', 'alta', 'critica']
const SEV_COLOR  = { baixa: '#4299e1', media: '#ed8936', alta: '#e53e3e', critica: '#9f7aea' }

// initialTopic: tópico existente para edição (undefined = criação)
export function TopicForm({ storeName, onCreated, onSaved, onCancel, initialTopic }) {
  const isEditing = !!initialTopic

  const [description,    setDescription]    = useState(initialTopic?.description   ?? '')
  const [severity,       setSeverity]        = useState(initialTopic?.severity      ?? 'media')
  const [machineMention, setMachineMention]  = useState(initialTopic?.machine_mention ?? '')
  const [saving,         setSaving]          = useState(false)
  const [error,          setError]           = useState(null)

  // Fotos existentes do tópico (modo edição) → já têm URL, sem upload pendente
  const serverUrl = getServerUrl()
  const existingPhotos = (initialTopic?.photo_paths ?? []).map(url => ({
    id: url, url, localPreview: url.startsWith('http') ? url : `${serverUrl}${url}`,
    name: url.split('/').pop(), uploading: false, error: null,
  }))

  // photos: [{ id, url, localPreview, name, uploading, error }]
  const [photos, setPhotos] = useState(existingPhotos)
  const fileInputRef = useRef(null)

  const isCritical = /^(TERM|BOH)/i.test(machineMention.trim())

  // Faz upload de um File e adiciona ao array de fotos
  const uploadFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return
    const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`
    const localPreview = URL.createObjectURL(file)
    setPhotos(prev => [...prev, { id, url: null, localPreview, name: file.name || 'imagem.png', uploading: true, error: null }])
    try {
      const { url } = await api.relatorio.uploadPhoto(file)
      setPhotos(prev => prev.map(p => p.id === id ? { ...p, url, uploading: false } : p))
    } catch (e) {
      setPhotos(prev => prev.map(p => p.id === id ? { ...p, uploading: false, error: e.message } : p))
    }
  }, [])

  // Botão de arquivo
  const handleFileChange = (e) => {
    Array.from(e.target.files).forEach(uploadFile)
    e.target.value = ''
  }

  // Colar print de tela no textarea
  const handlePaste = (e) => {
    const items = Array.from(e.clipboardData?.items || [])
    const imageItems = items.filter(i => i.type.startsWith('image/'))
    if (imageItems.length === 0) return
    e.preventDefault() // não colar texto "blob:" no textarea
    imageItems.forEach(item => {
      const file = item.getAsFile()
      if (file) uploadFile(file)
    })
  }

  const removePhoto = (id) => {
    setPhotos(prev => {
      const p = prev.find(x => x.id === id)
      if (p?.localPreview) URL.revokeObjectURL(p.localPreview)
      return prev.filter(x => x.id !== id)
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!description.trim()) return
    if (photos.some(p => p.uploading)) { setError('Aguarde o upload das fotos terminar.'); return }
    setSaving(true); setError(null)
    try {
      const photo_paths = photos.filter(p => p.url).map(p => p.url)
      const payload = {
        description:     description.trim(),
        severity:        isCritical ? 'critica' : severity,
        machine_mention: machineMention.trim() || null,
        photo_paths:     photo_paths.length ? photo_paths : undefined,
      }
      let topic
      if (isEditing) {
        topic = await api.relatorio.updateTopic(initialTopic.id, payload)
        onSaved?.(topic)
      } else {
        topic = await api.relatorio.createTopic({ ...payload, store_name: storeName, created_by: 'TI' })
        onCreated?.(topic)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#000a', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onCancel()}
    >
      <form
        onSubmit={handleSubmit}
        style={{ background: '#1a202c', border: '1px solid #2d3748', borderRadius: 10, padding: 24, width: 500, maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <h3 style={{ margin: 0, color: '#e2e8f0', fontSize: '0.95rem' }}>
          {isEditing ? `Editar Tópico — ${storeName}` : `Novo Tópico — ${storeName}`}
        </h3>

        {/* Descrição */}
        <div>
          <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Descrição do problema *</label>
          <textarea
            value={description} onChange={e => setDescription(e.target.value)}
            onPaste={handlePaste}
            required rows={3}
            style={{ width: '100%', background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '8px', fontSize: '0.85rem', resize: 'vertical', boxSizing: 'border-box', marginTop: 4 }}
            placeholder="Descreva o problema em detalhes... (Cole um print aqui para anexá-lo)"
          />
        </div>

        {/* Fotos */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Fotos / Evidências</label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{ background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#a0aec0', padding: '4px 10px', cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              📎 Adicionar fotos
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFileChange} />
          </div>

          {photos.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {photos.map(p => (
                <div key={p.id} style={{ position: 'relative', width: 90, height: 90, borderRadius: 6, overflow: 'hidden', border: `1px solid ${p.error ? '#fc8181' : '#4a5568'}`, background: '#2d3748', flexShrink: 0 }}>
                  <img
                    src={p.localPreview}
                    alt={p.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: p.uploading ? 0.4 : 1 }}
                  />
                  {p.uploading && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: '1.2rem' }}>⏳</span>
                    </div>
                  )}
                  {p.error && (
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: '#c53030cc', color: '#fff', fontSize: '0.6rem', padding: '2px 4px', textAlign: 'center' }}>
                      Falhou
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removePhoto(p.id)}
                    style={{ position: 'absolute', top: 2, right: 2, background: '#1a202ccc', border: 'none', borderRadius: '50%', color: '#e2e8f0', width: 20, height: 20, cursor: 'pointer', fontSize: '0.7rem', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {photos.length === 0 && (
            <div style={{ background: '#2d3748', border: '1px dashed #4a5568', borderRadius: 6, padding: '10px 12px', fontSize: '0.75rem', color: '#718096', textAlign: 'center' }}>
              Cole um print com <kbd style={{ background: '#1a202c', border: '1px solid #4a5568', borderRadius: 3, padding: '1px 4px' }}>Ctrl+V</kbd> no campo de descrição, ou clique em "Adicionar fotos"
            </div>
          )}
        </div>

        {/* Máquina */}
        <div>
          <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Máquina envolvida (opcional)</label>
          <input
            value={machineMention} onChange={e => setMachineMention(e.target.value)}
            style={{ width: '100%', background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '8px', fontSize: '0.85rem', boxSizing: 'border-box', marginTop: 4 }}
            placeholder="Ex: METROBOH, TERMBSHOP6..."
          />
          {isCritical && (
            <div style={{ marginTop: 4, fontSize: '0.72rem', color: '#fc8181', fontWeight: 700 }}>
              🔴 Máquina crítica detectada (BOH/TERM) — severidade será CRÍTICA automaticamente
            </div>
          )}
        </div>

        {/* Severidade */}
        {!isCritical && (
          <div>
            <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Severidade</label>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {SEVERITIES.map(s => (
                <button key={s} type="button" onClick={() => setSeverity(s)}
                  style={{ flex: 1, padding: '5px 0', borderRadius: 6, border: `1px solid ${severity === s ? SEV_COLOR[s] : '#4a5568'}`,
                    background: severity === s ? `${SEV_COLOR[s]}22` : 'transparent',
                    color: severity === s ? SEV_COLOR[s] : '#718096', fontSize: '0.75rem', cursor: 'pointer', textTransform: 'capitalize' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && <div style={{ color: '#fc8181', fontSize: '0.78rem' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={onCancel}
            style={{ background: 'none', border: '1px solid #4a5568', borderRadius: 6, color: '#a0aec0', padding: '7px 14px', cursor: 'pointer', fontSize: '0.8rem' }}>
            Cancelar
          </button>
          <button type="submit" disabled={saving || !description.trim() || photos.some(p => p.uploading)}
            style={{ background: '#667eea', border: 'none', borderRadius: 6, color: 'white', padding: '7px 16px', cursor: (saving || photos.some(p => p.uploading)) ? 'wait' : 'pointer', fontSize: '0.8rem', opacity: (saving || photos.some(p => p.uploading)) ? 0.7 : 1 }}>
            {saving ? 'Salvando...' : photos.some(p => p.uploading) ? 'Aguardando upload...' : isEditing ? 'Salvar Alterações' : 'Registrar Tópico'}
          </button>
        </div>
      </form>
    </div>
  )
}
