import { useState, useEffect } from 'react'
import { api } from '../api'

export function WatchlistModule({ onClose }) {
  const [keywords, setKeywords] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  const [newKeyword, setNewKeyword] = useState('')
  const [adding, setAdding] = useState(false)

  async function load() {
    setLoading(true); setError(null)
    try {
      setKeywords(await api.watchlist.list())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleAdd() {
    const trimmed = newKeyword.trim()
    if (!trimmed) return
    setAdding(true); setError(null)
    try {
      const resp = await api.watchlist.create(trimmed)
      setKeywords((prev) => [...prev, { id: resp.id, keyword: resp.keyword, active: true, created_at: new Date().toISOString() }])
      setNewKeyword('')
    } catch (e) {
      setError(e.message)
    } finally {
      setAdding(false)
    }
  }

  async function handleToggleActive(kw) {
    try {
      await api.watchlist.setActive(kw.id, !kw.active)
      setKeywords((prev) => prev.map((k) => (k.id === kw.id ? { ...k, active: !k.active } : k)))
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleRemove(kw) {
    if (!window.confirm(`Excluir a palavra-chave "${kw.keyword}"? Isso não pode ser desfeito.`)) return
    try {
      await api.watchlist.remove(kw.id)
      setKeywords((prev) => prev.filter((k) => k.id !== kw.id))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f0f19f0', zIndex: 9999, display: 'flex', flexDirection: 'column', fontFamily: 'monospace', color: '#e5e7eb' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #1e1e30' }}>
        <div>🔎 Watchlist — Palavras-chave monitoradas</div>
        <button className="btn btn-secondary" onClick={onClose}>Fechar</button>
      </div>

      <div style={{ padding: 24, overflow: 'auto', flex: 1 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            className="form-input"
            placeholder="Nova palavra-chave"
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
          />
          <button className="btn btn-primary" onClick={handleAdd} disabled={adding}>Adicionar</button>
        </div>

        {error && <div className="test-result err">{error}</div>}
        {loading ? (
          <div>Carregando...</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Palavra-chave</th>
                <th>Ativa</th>
                <th>Criada em</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keywords.map((kw) => (
                <tr key={kw.id}>
                  <td>{kw.keyword}</td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={kw.active} onChange={() => handleToggleActive(kw)} />
                  </td>
                  <td>{new Date(kw.created_at).toLocaleString('pt-BR')}</td>
                  <td>
                    <button className="btn btn-danger" onClick={() => handleRemove(kw)}>Excluir</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
