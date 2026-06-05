import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'

const SEV_COLOR = { critical: 'var(--red)', warning: 'var(--yellow)', info: 'var(--blue)' }
const SEV_ICON  = { critical: '🔴', warning: '🟡', info: '🔵' }

export function GlobalInsightsPanel({ refreshTrigger }) {
  const [insights,    setInsights]    = useState([])
  const [collapsed,   setCollapsed]   = useState(true)
  const [generating,  setGenerating]  = useState(false)
  const [generateMsg, setGenerateMsg] = useState(null)

  const load = useCallback(() => {
    api.getInsights().then(setInsights).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load, refreshTrigger])

  const unread = insights.filter(i => !i.is_read).length

  async function handleGenerate() {
    setGenerating(true)
    setGenerateMsg(null)
    try {
      const result = await api.generateInsights()
      const n = result?.generated ?? 0
      setGenerateMsg(n > 0 ? `${n} insight${n !== 1 ? 's' : ''} gerado${n !== 1 ? 's' : ''}` : 'Nenhum padrão novo encontrado')
      load()
    } catch (err) {
      setGenerateMsg(`Erro: ${err.message}`)
    } finally {
      setGenerating(false)
      setTimeout(() => setGenerateMsg(null), 4000)
    }
  }

  return (
    <div className="global-insights">
      <div className="global-insights-header" onClick={() => setCollapsed(c => !c)}>
        <span>
          ✨ Insights de IA
          {unread > 0 && <span className="tab-badge" style={{ marginLeft: 6 }}>{unread}</span>}
          {generateMsg && (
            <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>
              — {generateMsg}
            </span>
          )}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="pill-solo"
            style={{ padding: '2px 10px', fontSize: 11 }}
            onClick={e => { e.stopPropagation(); handleGenerate() }}
            disabled={generating}
            title="Gerar insights agora (analisa logs com IA)"
          >
            {generating ? '⏳ Gerando...' : '⚡ Gerar agora'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="global-insights-list">
          {insights.length === 0 && generating && (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '4px 0' }}>
              Analisando logs com IA...
            </div>
          )}
          {insights.slice(0, 10).map(ins => (
            <div key={ins.id} className="global-insight-row">
              <span style={{ color: SEV_COLOR[ins.severity], flexShrink: 0 }}>
                {SEV_ICON[ins.severity]}
              </span>
              <div style={{ flex: 1 }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  {ins.display_name || ins.hostname || 'Global'}
                </span>
                {' — '}
                <span style={{ fontSize: 12 }}>{ins.pattern}</span>
              </div>
              {ins.solution && (
                <span title={ins.solution} style={{ color: '#2ecc71', fontSize: 12, cursor: 'help' }}>💡</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
