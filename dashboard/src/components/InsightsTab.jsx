import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'

const SEV_ICON  = { critical: '🔴', warning: '🟡', info: '🔵' }
const SEV_COLOR = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' }

export function InsightsTab({ machineId, onRead }) {
  const [insights,   setInsights]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [generating, setGenerating] = useState(false)
  const [genMsg,     setGenMsg]     = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    api.getInsights(machineId)
      .then(setInsights)
      .catch(() => setInsights([]))
      .finally(() => setLoading(false))
  }, [machineId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    insights.filter(i => !i.is_read).forEach(i => {
      api.markInsightRead(i.id).catch(() => {})
    })
    if (insights.length > 0) onRead?.()
  }, [insights])

  async function handleGenerate() {
    setGenerating(true)
    setGenMsg(null)
    try {
      const result = await api.generateInsights()
      const n = result?.generated ?? 0
      setGenMsg(n > 0 ? `${n} insight${n !== 1 ? 's' : ''} gerado${n !== 1 ? 's' : ''}` : 'Nenhum padrão novo encontrado')
      load()
    } catch (err) {
      setGenMsg(`Erro: ${err.message}`)
    } finally {
      setGenerating(false)
    }
  }

  if (loading) return <div className="tab-loading">Carregando...</div>

  return (
    <div className="insights-tab">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <button
          className="btn btn-secondary"
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? '⏳ Gerando...' : '⚡ Gerar agora'}
        </button>
        {genMsg && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{genMsg}</span>
        )}
      </div>

      {insights.length === 0 && !generating && (
        <div className="tab-empty">
          Nenhum padrão detectado ainda. Clique em "Gerar agora" ou aguarde o ciclo automático de 6h.
        </div>
      )}

      {insights.map(ins => (
        <div key={ins.id} className={`insight-item sev-${ins.severity}`}>
          <div className="insight-header">
            <span style={{ color: SEV_COLOR[ins.severity] }}>
              {SEV_ICON[ins.severity]}{' '}
              {ins.severity === 'critical' ? 'Crítico' : ins.severity === 'warning' ? 'Atenção' : 'Info'}
            </span>
            <span className="insight-date">
              {new Date(ins.generated_at).toLocaleDateString('pt-BR')}
            </span>
          </div>
          <p className="insight-pattern">{ins.pattern}</p>
          {ins.solution && (
            <div className="insight-solution">
              <span className="insight-solution-label">💡 Solução sugerida</span>
              <p>{ins.solution}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
