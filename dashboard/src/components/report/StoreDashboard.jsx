// dashboard/src/components/report/StoreDashboard.jsx
import { useState, useEffect } from 'react'
import { api } from '../../api'
import { ScoreWidget }      from './ScoreWidget'
import { TopicList }        from './TopicList'
import { TopicForm }        from './TopicForm'
import { GenerateModal }    from './GenerateModal'
import { FreshdeskSection } from './FreshdeskSection'

export function StoreDashboard({ storeName, onStoreListRefresh }) {
  const [topics,        setTopics]       = useState([])
  const [latestRun,     setLatestRun]    = useState(null)
  const [loading,       setLoading]      = useState(true)
  const [showForm,      setShowForm]     = useState(false)
  const [showGenerate,  setShowGenerate] = useState(false)
  const [editingTopic,  setEditingTopic] = useState(null)

  async function load() {
    setLoading(true)
    try {
      const [t, h] = await Promise.all([
        api.relatorio.getTopics(storeName),
        api.relatorio.getHistory(storeName),
      ])
      setTopics(t)
      setLatestRun(h[0] || null)
    } catch {}
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [storeName])

  async function handleResolve(id) {
    if (!confirm('Marcar este tópico como resolvido? Ele irá para o histórico.')) return
    await api.relatorio.resolveTopic(id).catch(() => {})
    load()
  }

  const scores = latestRun ? {
    score_total:        latestRun.score_total,
    score_hardware:     latestRun.score_hardware,
    score_software:     latestRun.score_software,
    score_connectivity: latestRun.score_connectivity,
    score_security:     latestRun.score_security,
    score_incidents:    latestRun.score_incidents,
  } : null

  const lastSync = latestRun ? `Último relatório: ${latestRun.generated_at?.slice(0,10)}` : 'Sem relatório gerado ainda'

  return (
    <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#e2e8f0' }}>{storeName}</div>
          <div style={{ fontSize: '0.75rem', color: '#718096' }}>{lastSync}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setShowForm(true)}
            style={{ background: '#2d3748', border: '1px solid #4a5568', borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', cursor: 'pointer', fontSize: '0.75rem' }}>
            + Novo Tópico
          </button>
          <button onClick={() => setShowGenerate(true)}
            style={{ background: '#667eea', border: 'none', borderRadius: 6, color: 'white', padding: '6px 10px', cursor: 'pointer', fontSize: '0.75rem' }}>
            📄 Gerar Relatório
          </button>
        </div>
      </div>

      {/* Score */}
      {scores && <ScoreWidget scores={scores} />}
      {!scores && !loading && (
        <div style={{ background: '#1a202c', borderRadius: 8, padding: 12, color: '#4a5568', fontSize: '0.8rem' }}>
          Nenhum relatório gerado ainda — clique em "Gerar Relatório" para calcular o score.
        </div>
      )}

      {/* Tópicos */}
      <div>
        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#a0aec0', letterSpacing: '.06em', marginBottom: 6 }}>
          TÓPICOS ABERTOS ({topics.length})
        </div>
        {loading
          ? <p style={{ color: '#4a5568', fontSize: '0.78rem' }}>Carregando...</p>
          : <TopicList topics={topics} onResolve={handleResolve} onEdit={t => setEditingTopic(t)} />
        }
      </div>

      {/* Freshdesk */}
      <FreshdeskSection storeName={storeName} />

      {/* Modais */}
      {showForm && (
        <TopicForm storeName={storeName}
          onCreated={t => { setTopics(prev => [t, ...prev]); setShowForm(false) }}
          onCancel={() => setShowForm(false)}
        />
      )}
      {showGenerate && (
        <GenerateModal storeName={storeName}
          onClose={() => { setShowGenerate(false); load(); onStoreListRefresh?.() }}
          onGenerated={() => {}}
        />
      )}
      {editingTopic && (
        <TopicForm
          storeName={storeName}
          initialTopic={editingTopic}
          onSaved={updated => {
            setTopics(prev => prev.map(t => t.id === updated.id ? updated : t))
            setEditingTopic(null)
          }}
          onCancel={() => setEditingTopic(null)}
        />
      )}
    </div>
  )
}
