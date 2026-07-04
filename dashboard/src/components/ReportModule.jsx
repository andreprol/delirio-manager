// dashboard/src/components/ReportModule.jsx
import { useState, useEffect } from 'react'
import { api }             from '../api'
import { StoreList }       from './report/StoreList'
import { StoreDashboard }  from './report/StoreDashboard'

export function ReportModule({ onClose }) {
  const [stores,        setStores]        = useState([])
  const [selectedStore, setSelectedStore] = useState(null)
  const [loading,       setLoading]       = useState(true)

  async function loadStores() {
    setLoading(true)
    try {
      const s = await api.relatorio.getStores()
      setStores(s)
      if (s.length && !selectedStore) setSelectedStore(s[0].name)
    } catch (e) {
      console.error('[ReportModule]', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadStores() }, [])

  return (
    <div style={{ position: 'fixed', top: 56, left: 0, right: 0, bottom: 0, background: '#0f0f19', zIndex: 9999, display: 'flex', flexDirection: 'column', fontFamily: 'monospace' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #1e1e30' }}>
        <div>
          <h2 style={{ margin: 0, color: '#667eea', fontSize: '1.1em' }}>📊 Relatório Mensal de TI</h2>
          <p style={{ margin: '2px 0 0', fontSize: '0.78em', color: '#555' }}>Tópicos · Freshdesk · Score de Risco · Geração .docx + .pdf</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={loadStores} disabled={loading} style={{ background: 'none', border: '1px solid #2d3748', borderRadius: 5, color: '#667eea', fontSize: '0.78em', padding: '4px 10px', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1 }}>
            {loading ? '...' : '↻ Atualizar'}
          </button>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.3em', cursor: 'pointer' }}>✕</button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {loading
          ? <p style={{ color: '#888', padding: 24 }}>Carregando lojas...</p>
          : (
            <>
              <StoreList
                stores={stores}
                selectedStore={selectedStore}
                onSelect={setSelectedStore}
              />
              {selectedStore
                ? <StoreDashboard key={selectedStore} storeName={selectedStore} />
                : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4a5568' }}>Selecione uma loja</div>
              }
            </>
          )
        }
      </div>
    </div>
  )
}
