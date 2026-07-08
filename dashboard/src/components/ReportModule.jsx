// dashboard/src/components/ReportModule.jsx
import { useState, useEffect }           from 'react'
import { api }                           from '../api'
import { StoreList }                     from './report/StoreList'
import { StoreDashboard }                from './report/StoreDashboard'
import { ZamakDiscrepanciesModal }       from './ZamakDiscrepanciesModal'

export function ReportModule({ onClose }) {
  const [stores,             setStores]             = useState([])
  const [selectedStore,      setSelectedStore]      = useState(null)
  const [loading,            setLoading]            = useState(true)
  const [showDiscrepancies,  setShowDiscrepancies]  = useState(false)
  const [zamakByStore,       setZamakByStore]       = useState({})

  async function loadStores(force = false) {
    setLoading(true)
    try {
      const s = await api.relatorio.getStores(force)
      setStores(s)
      if (s.length && !selectedStore) setSelectedStore(s[0].name)
    } catch (e) {
      console.error('[ReportModule]', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadStores()
    api.zamak.getStatus()
      .then(s => {
        // Índice duplo: chave exata + chave normalizada (sem acentos, lowercase)
        // para absorver divergências de encoding entre Zamak e DM
        const strip = v => (v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        const map = {}
        for (const row of (s.byStore || [])) {
          map[row.store_name]         = row   // chave exata
          map[strip(row.store_name)]  = row   // chave normalizada
        }
        setZamakByStore(map)
      })
      .catch(() => {})
  }, [])

  return (
    <div style={{ position: 'fixed', top: 56, left: 0, right: 0, bottom: 0, background: '#0f0f19', zIndex: 9999, display: 'flex', flexDirection: 'column', fontFamily: 'monospace' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #1e1e30' }}>
        <div>
          <h2 style={{ margin: 0, color: '#667eea', fontSize: '1.1em' }}>📊 Relatório Mensal de TI</h2>
          <p style={{ margin: '2px 0 0', fontSize: '0.78em', color: '#555' }}>Tópicos · Freshdesk · Score de Risco · Geração .docx + .pdf</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => setShowDiscrepancies(true)} style={{ background: 'none', border: '1px solid #ed8936', borderRadius: 5, color: '#ed8936', fontSize: '0.78em', padding: '4px 10px', cursor: 'pointer' }}>
            🔀 Discrepâncias
          </button>
          <button onClick={() => loadStores(true)} disabled={loading} style={{ background: 'none', border: '1px solid #2d3748', borderRadius: 5, color: '#667eea', fontSize: '0.78em', padding: '4px 10px', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1 }}>
            {loading ? '⏳ Sincronizando…' : '↻ Atualizar'}
          </button>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.3em', cursor: 'pointer' }}>✕</button>
        </div>
      </div>

      {showDiscrepancies && <ZamakDiscrepanciesModal onClose={() => setShowDiscrepancies(false)} />}

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
                zamakByStore={zamakByStore}
              />
              {selectedStore
                ? <StoreDashboard key={selectedStore} storeName={selectedStore} onStoreListRefresh={loadStores} />
                : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4a5568' }}>Selecione uma loja</div>
              }
            </>
          )
        }
      </div>
    </div>
  )
}
