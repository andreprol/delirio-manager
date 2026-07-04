// dashboard/src/components/report/TopicForm.jsx
import { useState } from 'react'
import { api } from '../../api'

const SEVERITIES = ['baixa', 'media', 'alta', 'critica']
const SEV_COLOR  = { baixa: '#4299e1', media: '#ed8936', alta: '#e53e3e', critica: '#9f7aea' }

export function TopicForm({ storeName, onCreated, onCancel }) {
  const [description,     setDescription]     = useState('')
  const [severity,        setSeverity]         = useState('media')
  const [machineMention,  setMachineMention]   = useState('')
  const [saving,          setSaving]           = useState(false)
  const [error,           setError]            = useState(null)

  const isCritical = /^(TERM|BOH)/i.test(machineMention.trim())

  async function handleSubmit(e) {
    e.preventDefault()
    if (!description.trim()) return
    setSaving(true); setError(null)
    try {
      const topic = await api.relatorio.createTopic({
        store_name:      storeName,
        description:     description.trim(),
        severity:        isCritical ? 'critica' : severity,
        machine_mention: machineMention.trim() || null,
        created_by:      'TI',
      })
      onCreated(topic)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000a', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onCancel()}>
      <form onSubmit={handleSubmit} style={{ background: '#1a202c', border: '1px solid #2d3748', borderRadius: 10, padding: 24, width: 460, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 style={{ margin: 0, color: '#e2e8f0', fontSize: '0.95rem' }}>Novo Tópico — {storeName}</h3>

        <div>
          <label style={{ fontSize: '0.75rem', color: '#a0aec0' }}>Descrição do problema *</label>
          <textarea
            value={description} onChange={e => setDescription(e.target.value)}
            required rows={3}
            style={{ width: '100%', background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '8px', fontSize: '0.85rem', resize: 'vertical', boxSizing: 'border-box', marginTop: 4 }}
            placeholder="Descreva o problema em detalhes..."
          />
        </div>

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
          <button type="submit" disabled={saving || !description.trim()}
            style={{ background: '#667eea', border: 'none', borderRadius: 6, color: 'white', padding: '7px 16px', cursor: saving ? 'wait' : 'pointer', fontSize: '0.8rem', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Salvando...' : 'Registrar Tópico'}
          </button>
        </div>
      </form>
    </div>
  )
}
