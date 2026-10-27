import { useState, useEffect } from 'react'
import { api } from '../api'

// Nomes têm que bater exatamente com as chaves de STORE_GEOFENCE
// (server/config/storeGeofence.js) — grafia diferente faz o geofence daquela
// loja nunca casar, silenciosamente (sem erro).
const STORES = ['Gávea', 'Metropolitano', 'Bshop', 'Assembleia', 'Città', 'Ipanema', 'Rio Sul', 'Tijuca', 'Niterói']

const emptyForm = { cpf: '', name: '', store: STORES[0], senha: '' }
const emptyCorrection = { type: 'in', timestamp: '', motivo: '' }

// server_ts é ISO em UTC. <input type="datetime-local"> edita em hora LOCAL do
// browser — usar getHours()/getMinutes() (locais), nunca slice() na string UTC,
// senão o valor mostrado (e o que volta no submit) fica deslocado pelo fuso.
function toLocalInputValue(isoUtc) {
  const d = new Date(isoUtc)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function PontoRemotoModule({ onClose }) {
  const [tab, setTab] = useState('employees') // 'employees' | 'entries'

  const [employees, setEmployees] = useState([])
  const [loadingEmployees, setLoadingEmployees] = useState(true)
  const [form, setForm] = useState(emptyForm)
  const [creating, setCreating] = useState(false)

  const [entries, setEntries] = useState([])
  const [loadingEntries, setLoadingEntries] = useState(false)
  const [filterEmployeeId, setFilterEmployeeId] = useState('')
  const [correctingId, setCorrectingId] = useState(null)
  const [correction, setCorrection] = useState(emptyCorrection)

  const [error, setError] = useState(null)

  async function loadEmployees() {
    setLoadingEmployees(true); setError(null)
    try {
      const { employees: list } = await api.pontoRemoto.listEmployees()
      setEmployees(list)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingEmployees(false)
    }
  }

  async function loadEntries() {
    setLoadingEntries(true); setError(null)
    try {
      const { entries: list } = await api.pontoRemoto.listEntries(filterEmployeeId || null)
      setEntries(list)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingEntries(false)
    }
  }

  useEffect(() => { loadEmployees() }, [])
  useEffect(() => { if (tab === 'entries') loadEntries() }, [tab, filterEmployeeId])

  function employeeName(id) {
    return employees.find((e) => e.id === id)?.name || `#${id}`
  }

  async function handleCreate() {
    if (!form.cpf.trim() || !form.name.trim() || !form.senha.trim()) return
    setCreating(true); setError(null)
    try {
      await api.pontoRemoto.createEmployee(form)
      setForm(emptyForm)
      loadEmployees()
    } catch (e) {
      setError(e.message)
    } finally {
      setCreating(false)
    }
  }

  const [togglingIds, setTogglingIds] = useState(() => new Set())

  async function handleToggleActive(emp) {
    if (togglingIds.has(emp.id)) return
    setTogglingIds((prev) => new Set(prev).add(emp.id))
    try {
      await api.pontoRemoto.setEmployeeActive(emp.id, !emp.active)
      setEmployees((prev) => prev.map((e) => (e.id === emp.id ? { ...e, active: e.active ? 0 : 1 } : e)))
    } catch (e) {
      setError(e.message)
    } finally {
      setTogglingIds((prev) => { const next = new Set(prev); next.delete(emp.id); return next })
    }
  }

  function startCorrection(entry) {
    setCorrectingId(entry.id)
    setCorrection({ type: entry.type, timestamp: toLocalInputValue(entry.server_ts), motivo: '' })
  }

  async function submitCorrection() {
    if (!correction.motivo.trim()) return
    try {
      await api.pontoRemoto.correctEntry(correctingId, {
        tipo: correction.type,
        timestamp: new Date(correction.timestamp).toISOString(),
        motivo: correction.motivo.trim(),
      })
      setCorrectingId(null)
      loadEntries()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f0f19f0', zIndex: 9999, display: 'flex', flexDirection: 'column', fontFamily: 'monospace', color: '#e5e7eb' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #1e1e30' }}>
        <div>🕐 Ponto Remoto — Funcionários e espelho de ponto</div>
        <button className="btn btn-secondary" onClick={onClose}>Fechar</button>
      </div>

      <div style={{ display: 'flex', gap: 8, padding: '12px 24px 0' }}>
        <button className={tab === 'employees' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('employees')}>Funcionários</button>
        <button className={tab === 'entries' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('entries')}>Espelho de Ponto</button>
      </div>

      <div style={{ padding: 24, overflow: 'auto', flex: 1 }}>
        {error && <div className="test-result err" style={{ marginBottom: 12 }}>{error}</div>}

        {tab === 'employees' && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <input className="form-input" placeholder="CPF" value={form.cpf}
                onChange={(e) => setForm((f) => ({ ...f, cpf: e.target.value }))} />
              <input className="form-input" placeholder="Nome" value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              <select className="form-input" value={form.store}
                onChange={(e) => setForm((f) => ({ ...f, store: e.target.value }))}>
                {STORES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input className="form-input" type="password" placeholder="Senha inicial" value={form.senha}
                onChange={(e) => setForm((f) => ({ ...f, senha: e.target.value }))} />
              <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>Cadastrar</button>
            </div>

            {loadingEmployees ? <div>Carregando...</div> : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Nome</th>
                    <th style={{ textAlign: 'left' }}>CPF</th>
                    <th style={{ textAlign: 'left' }}>Loja</th>
                    <th>Ativo</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp) => (
                    <tr key={emp.id}>
                      <td>{emp.name}</td>
                      <td>{emp.cpf}</td>
                      <td>{emp.store}</td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={!!emp.active} disabled={togglingIds.has(emp.id)} onChange={() => handleToggleActive(emp)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === 'entries' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <select className="form-input" value={filterEmployeeId} onChange={(e) => setFilterEmployeeId(e.target.value)}>
                <option value="">Todos os funcionários</option>
                {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
              </select>
            </div>

            {loadingEntries ? <div>Carregando...</div> : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Funcionário</th>
                    <th style={{ textAlign: 'left' }}>Quando</th>
                    <th>Tipo</th>
                    <th>Geofence</th>
                    <th>Origem</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{employeeName(entry.employee_id)}</td>
                      <td>{new Date(entry.server_ts).toLocaleString('pt-BR')}</td>
                      <td style={{ textAlign: 'center' }}>{entry.type === 'in' ? 'Entrada' : 'Saída'}</td>
                      <td style={{ textAlign: 'center' }}>
                        {entry.within_geofence === null ? '—' : entry.within_geofence ? '✅' : '⚠️ fora'}
                      </td>
                      <td style={{ textAlign: 'center' }}>{entry.corrects_id ? `correção de #${entry.corrects_id}` : entry.created_by}</td>
                      <td>
                        {correctingId === entry.id ? (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <select className="form-input" value={correction.type}
                              onChange={(e) => setCorrection((c) => ({ ...c, type: e.target.value }))}>
                              <option value="in">Entrada</option>
                              <option value="out">Saída</option>
                            </select>
                            <input className="form-input" type="datetime-local" value={correction.timestamp}
                              onChange={(e) => setCorrection((c) => ({ ...c, timestamp: e.target.value }))} />
                            <input className="form-input" placeholder="Motivo" value={correction.motivo}
                              onChange={(e) => setCorrection((c) => ({ ...c, motivo: e.target.value }))} />
                            <button className="btn btn-primary" onClick={submitCorrection}>Salvar</button>
                            <button className="btn btn-secondary" onClick={() => setCorrectingId(null)}>Cancelar</button>
                          </div>
                        ) : (
                          <button className="btn btn-secondary" onClick={() => startCorrection(entry)}>Corrigir</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  )
}
