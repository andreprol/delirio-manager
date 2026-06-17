import { useState } from 'react'
import { api } from '../api'

// Module-level cache — persists while the app is open, survives tab switches
let _empCache     = null
let _empCacheTime = null

const IP_TO_STORE = {
  '192.168.15.151': 'Gávea',
  '192.168.14.151': 'Metro',
  '192.168.12.151': 'Bshop',
  '192.168.0.151':  'Assembl.',
  '192.168.13.151': 'Città',
  '192.168.18.151': 'Ipanema',
  '192.168.16.151': 'Rio Sul',
  '192.168.20.151': 'Tijuca',
  '192.168.10.150': 'Niterói',
}

const styles = {
  container: {
    padding: '16px',
    background: 'var(--bg, #181c20)',
    color: 'var(--text, #e2e8f0)',
    fontFamily: 'inherit',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '16px',
    flexWrap: 'wrap',
    gap: '8px',
  },
  title: {
    fontSize: '15px',
    fontWeight: 700,
    color: 'var(--text, #e2e8f0)',
    margin: 0,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
  },
  summary: {
    fontSize: '13px',
    color: 'var(--text-muted, #94a3b8)',
  },
  summaryDivergent: {
    fontWeight: 700,
    color: 'var(--yellow, #fbbf24)',
  },
  summaryTotal: {
    fontWeight: 700,
    color: 'var(--green, #4ade80)',
  },
  loadBtn: {
    padding: '6px 14px',
    background: 'var(--accent, #3b82f6)',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
  loadBtnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  warningBanner: {
    background: 'rgba(251,191,36,0.10)',
    border: '1px solid rgba(251,191,36,0.4)',
    borderRadius: '8px',
    padding: '10px 14px',
    marginBottom: '14px',
    fontSize: '13px',
    color: 'var(--yellow, #fbbf24)',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  loadingMsg: {
    textAlign: 'center',
    padding: '32px 0',
    fontSize: '14px',
    color: 'var(--text-muted, #94a3b8)',
  },
  controls: {
    display: 'flex',
    gap: '10px',
    marginBottom: '14px',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  searchInput: {
    padding: '6px 10px',
    background: 'var(--card-bg, #1e2530)',
    border: '1px solid var(--border, #2d3748)',
    borderRadius: '6px',
    color: 'var(--text, #e2e8f0)',
    fontSize: '13px',
    outline: 'none',
    width: '220px',
  },
  toggleGroup: {
    display: 'flex',
    border: '1px solid var(--border, #2d3748)',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  toggleBtn: (active) => ({
    padding: '5px 12px',
    background: active ? 'var(--accent, #3b82f6)' : 'var(--card-bg, #1e2530)',
    color: active ? '#fff' : 'var(--text-muted, #94a3b8)',
    border: 'none',
    fontSize: '12px',
    fontWeight: active ? 700 : 400,
    cursor: 'pointer',
    transition: 'background 0.15s',
  }),
  tableWrapper: {
    overflowX: 'auto',
    borderRadius: '10px',
    border: '1px solid var(--border, #2d3748)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
    minWidth: '600px',
  },
  th: {
    background: 'var(--card-bg, #1e2530)',
    color: 'var(--text-muted, #94a3b8)',
    fontWeight: 600,
    fontSize: '12px',
    padding: '8px 10px',
    textAlign: 'left',
    borderBottom: '1px solid var(--border, #2d3748)',
    whiteSpace: 'nowrap',
  },
  thCenter: {
    background: 'var(--card-bg, #1e2530)',
    color: 'var(--text-muted, #94a3b8)',
    fontWeight: 600,
    fontSize: '12px',
    padding: '8px 10px',
    textAlign: 'center',
    borderBottom: '1px solid var(--border, #2d3748)',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '8px 10px',
    borderBottom: '1px solid var(--border, #2d3748)',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
  },
  tdCenter: {
    padding: '8px 10px',
    borderBottom: '1px solid var(--border, #2d3748)',
    textAlign: 'center',
    verticalAlign: 'middle',
  },
  trNormal: {
    background: 'transparent',
  },
  trDivergent: {
    background: 'rgba(251,191,36,0.06)',
  },
  trHoverDivergent: {
    background: 'rgba(251,191,36,0.10)',
  },
  cpfText: {
    fontFamily: 'monospace',
    fontSize: '12px',
    color: 'var(--text-muted, #94a3b8)',
  },
  actionBtn: (variant) => {
    const map = {
      sync:   { bg: 'rgba(59,130,246,0.15)', color: '#60a5fa', border: 'rgba(59,130,246,0.4)' },
      remove: { bg: 'rgba(248,113,113,0.12)', color: '#f87171', border: 'rgba(248,113,113,0.35)' },
    }
    const v = map[variant] || map.sync
    return {
      padding: '3px 10px',
      background: v.bg,
      color: v.color,
      border: `1px solid ${v.border}`,
      borderRadius: '5px',
      fontSize: '12px',
      fontWeight: 600,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
  },
  actionBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  actionsCell: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  // Enrollment form
  enrollForm: {
    background: 'var(--card-bg, #1e2530)',
    border: '1px solid rgba(59,130,246,0.4)',
    borderRadius: '10px',
    padding: '14px 16px',
    marginBottom: '14px',
  },
  enrollTitle: {
    fontWeight: 700,
    fontSize: '14px',
    color: 'var(--text, #e2e8f0)',
    marginBottom: '10px',
  },
  enrollRow: {
    display: 'flex',
    gap: '10px',
    flexWrap: 'wrap',
    marginBottom: '10px',
    alignItems: 'flex-end',
  },
  enrollField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  enrollLabel: {
    fontSize: '11px',
    color: 'var(--text-muted, #94a3b8)',
    fontWeight: 600,
  },
  enrollInput: {
    padding: '5px 10px',
    background: '#181c20',
    border: '1px solid var(--border, #2d3748)',
    borderRadius: '6px',
    color: 'var(--text, #e2e8f0)',
    fontSize: '13px',
    outline: 'none',
    minWidth: '140px',
  },
  enrollClocks: {
    fontSize: '12px',
    color: 'var(--text-muted, #94a3b8)',
    marginBottom: '10px',
  },
  enrollBtnRow: {
    display: 'flex',
    gap: '8px',
  },
  // Status area
  statusBox: (type) => {
    const map = {
      success: { bg: 'rgba(74,222,128,0.10)', border: 'rgba(74,222,128,0.35)', color: '#4ade80' },
      partial: { bg: 'rgba(251,191,36,0.10)', border: 'rgba(251,191,36,0.35)', color: '#fbbf24' },
      error:   { bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.35)', color: '#f87171' },
    }
    const v = map[type] || map.error
    return {
      background: v.bg,
      border: `1px solid ${v.border}`,
      borderRadius: '8px',
      padding: '10px 14px',
      marginBottom: '14px',
      fontSize: '13px',
      color: v.color,
    }
  },
  statusTitle: {
    fontWeight: 700,
    marginBottom: '6px',
  },
  statusClockList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginTop: '6px',
  },
  clockChip: (ok) => ({
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    background: ok ? 'rgba(74,222,128,0.15)' : 'rgba(248,113,113,0.15)',
    color: ok ? '#4ade80' : '#f87171',
    border: `1px solid ${ok ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}`,
  }),
}

function isDivergent(emp) {
  return emp.absentIn && emp.absentIn.length > 0
}

function isIncomplete(emp) {
  return emp.incompleteIn && emp.incompleteIn.length > 0
}

export function EmployeeTable() {
  const [data, setData]           = useState(_empCache)
  const [loading, setLoading]     = useState(false)
  const [showWarning, setShowWarning] = useState(false)

  const [search, setSearch]       = useState('')
  const [filter, setFilter]       = useState('all') // 'all' | 'divergent' | 'synced'

  // Enrollment form state
  const [enrollTarget, setEnrollTarget] = useState(null) // employee object
  const [enrollRef1, setEnrollRef1]     = useState('')
  const [enrollRef2, setEnrollRef2]     = useState('')
  const [enrolling, setEnrolling]       = useState(false)

  // Operation status
  const [opStatus, setOpStatus]   = useState(null) // { type, title, clocks }
  const [removing, setRemoving]   = useState(null) // cpf being removed
  const [completing, setCompleting] = useState(null) // cpf sendo completado

  // New employee form
  const [newEmpMode, setNewEmpMode]     = useState(false)
  const [newEmpName, setNewEmpName]     = useState('')
  const [newEmpCpf, setNewEmpCpf]       = useState('')
  const [newEmpRef1, setNewEmpRef1]     = useState('')
  const [newEmpRef2, setNewEmpRef2]     = useState('')
  const [newEnrolling, setNewEnrolling] = useState(false)

  async function loadEmployees() {
    setShowWarning(false)
    setLoading(true)
    setOpStatus(null)
    try {
      let result
      let attempts = 0
      const MAX_ATTEMPTS = 80 // 80 × 5s = ~6.5 min
      do {
        result = await api.rh.getEmployees()
        if (result._pending) {
          await new Promise(r => setTimeout(r, 5000))
          attempts++
        }
      } while (result._pending && attempts < MAX_ATTEMPTS)

      if (result._pending) {
        throw new Error('Tempo excedido aguardando relógios (> 6 min)')
      }
      _empCache     = result
      _empCacheTime = new Date()
      setData(result)
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao carregar: ${err.message}`, clocks: [] })
    } finally {
      setLoading(false)
    }
  }

  function handleLoadClick() {
    if (data) {
      loadEmployees() // já tem dados — atualizar sem aviso
    } else {
      setShowWarning(true)
    }
  }

  function handleConfirmLoad() {
    setShowWarning(false)
    loadEmployees()
  }

  function openEnrollForm(emp) {
    setEnrollTarget(emp)
    setEnrollRef1(emp.ref1 || '')
    setEnrollRef2(emp.ref2 || '')
    setOpStatus(null)
  }

  function closeEnrollForm() {
    setEnrollTarget(null)
    setEnrollRef1('')
    setEnrollRef2('')
  }

  async function handleEnroll() {
    if (!enrollTarget) return
    if (!enrollRef1.trim()) {
      setOpStatus({ type: 'error', title: 'Ref1 (matrícula) é obrigatória.', clocks: [] })
      return
    }
    setEnrolling(true)
    setOpStatus(null)
    try {
      const clockIps = enrollTarget.absentIn || []
      const result = await api.rh.enroll(
        enrollTarget.cpf,
        enrollTarget.name,
        enrollRef1.trim(),
        enrollRef2.trim(),
        '',
        clockIps,
      )
      const allOk = result.failed === 0
      const type  = allOk ? 'success' : result.enrolled > 0 ? 'partial' : 'error'
      const clockChips = (result.clocks || []).map(c => ({
        label: IP_TO_STORE[c.clockIp] || c.clockIp,
        ok:    c.success,
      }))
      setOpStatus({
        type,
        title: allOk
          ? `Cadastrado em ${result.enrolled} relógio(s).`
          : `Cadastrado em ${result.enrolled}, falhou em ${result.failed}.`,
        clocks: clockChips,
      })
      closeEnrollForm()
      // Refresh data so table reflects new state
      loadEmployees()
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao cadastrar: ${err.message}`, clocks: [] })
    } finally {
      setEnrolling(false)
    }
  }

  function openNewEmpForm() {
    closeEnrollForm()
    setNewEmpMode(true)
    setNewEmpName('')
    setNewEmpCpf('')
    setNewEmpRef1('')
    setNewEmpRef2('')
    setOpStatus(null)
  }

  function closeNewEmpForm() {
    setNewEmpMode(false)
    setNewEmpName('')
    setNewEmpCpf('')
    setNewEmpRef1('')
    setNewEmpRef2('')
  }

  async function handleNewEnroll() {
    if (!newEmpName.trim()) { setOpStatus({ type: 'error', title: 'Nome é obrigatório.', clocks: [] }); return }
    if (!newEmpCpf.trim())  { setOpStatus({ type: 'error', title: 'CPF é obrigatório.', clocks: [] }); return }
    if (!newEmpRef1.trim()) { setOpStatus({ type: 'error', title: 'Ref1 (matrícula) é obrigatória.', clocks: [] }); return }
    setNewEnrolling(true)
    setOpStatus(null)
    try {
      const result = await api.rh.enroll(
        newEmpCpf.trim(),
        newEmpName.trim().toUpperCase(),
        newEmpRef1.trim(),
        newEmpRef2.trim(),
        '',
        undefined, // undefined = todos os relógios (CLOCK_IPS no servidor)
      )
      const allOk = result.failed === 0
      const type  = allOk ? 'success' : result.enrolled > 0 ? 'partial' : 'error'
      const clockChips = (result.clocks || []).map(c => ({
        label: IP_TO_STORE[c.clockIp] || c.clockIp,
        ok:    c.success,
      }))
      setOpStatus({
        type,
        title: allOk
          ? `${newEmpName.trim().toUpperCase()} cadastrado em ${result.enrolled} relógio(s).`
          : `Cadastrado em ${result.enrolled}, falhou em ${result.failed}.`,
        clocks: clockChips,
      })
      closeNewEmpForm()
      loadEmployees()
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao cadastrar: ${err.message}`, clocks: [] })
    } finally {
      setNewEnrolling(false)
    }
  }

  async function handleCompleteCard(emp) {
    setCompleting(emp.cpf)
    setOpStatus(null)
    try {
      const result = await api.rh.updateCard(emp.cpf, emp.ref2, emp.incompleteIn)
      const allOk  = result.failed === 0
      const type   = allOk ? 'success' : result.updated > 0 ? 'partial' : 'error'
      const clockChips = (result.clocks || []).map(c => ({
        label: IP_TO_STORE[c.clockIp] || c.clockIp,
        ok:    c.success,
      }))
      setOpStatus({
        type,
        title: allOk
          ? `Crachá atualizado em ${result.updated} relógio(s).`
          : `Atualizado em ${result.updated}, falhou em ${result.failed}.`,
        clocks: clockChips,
      })
      loadEmployees()
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao completar crachá: ${err.message}`, clocks: [] })
    } finally {
      setCompleting(null)
    }
  }

  async function handleRemove(emp) {
    const confirmed = window.confirm(
      `Remover "${emp.name}" (CPF ${emp.cpf}) de TODOS os relógios?\n\nEsta ação não pode ser desfeita.`
    )
    if (!confirmed) return
    setRemoving(emp.cpf)
    setOpStatus(null)
    try {
      const result = await api.rh.offboard(emp.cpf, emp.name, 'dashboard')
      const allOk  = result.failed === 0
      const type   = allOk ? 'success' : result.removed > 0 ? 'partial' : 'error'
      const clockChips = (result.clocks || []).map(c => ({
        label: IP_TO_STORE[c.clockIp] || c.clockIp,
        ok:    c.success || c.alreadyAbsent,
      }))
      setOpStatus({
        type,
        title: allOk
          ? `"${emp.name}" removido de ${result.removed} relógio(s).`
          : `Removido de ${result.removed}, falhou em ${result.failed}.`,
        clocks: clockChips,
      })
      // Refresh
      loadEmployees()
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao remover: ${err.message}`, clocks: [] })
    } finally {
      setRemoving(null)
    }
  }

  // Todos os IPs tentados (incluindo offline) — vem do backend
  const allClockIps    = data?.allClockIps ?? []
  // Map ip -> bool (true = leitura bem-sucedida nessa rodada)
  const clockStatusMap = Object.fromEntries((data?.clocks ?? []).map(c => [c.ip, c.success]))

  // Filter employees
  const employees = data?.employees || []
  const filtered  = employees.filter(emp => {
    const q = search.trim().toLowerCase()
    if (q && !emp.name.toLowerCase().includes(q) && !emp.cpf.includes(q)) return false
    if (filter === 'divergent'  && !isDivergent(emp))  return false
    if (filter === 'synced'     &&  isDivergent(emp))  return false
    if (filter === 'incomplete' && !isIncomplete(emp)) return false
    return true
  })

  const totalCount     = data?.total ?? 0
  const divergentCount  = data?.divergent ?? 0
  const incompleteCount = data?.incomplete ?? 0

  return (
    <div style={styles.container}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* Header */}
      <div style={styles.header}>
        <h3 style={styles.title}>Funcionários nos Relógios</h3>
        <div style={styles.headerRight}>
          {data && (
            <span style={styles.summary}>
              <span style={styles.summaryTotal}>{totalCount}</span>
              {' funcionários | '}
              <span style={styles.summaryDivergent}>{divergentCount}</span>
              {' com divergência'}
              {incompleteCount > 0 && (
                <>
                  {' | '}
                  <span style={{ fontWeight: 700, color: 'var(--yellow, #fbbf24)' }}>
                    {incompleteCount}
                  </span>
                  {' incompletos'}
                </>
              )}
              {_empCacheTime && (
                <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 8 }}>
                  · {_empCacheTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </span>
          )}
          <button
            style={{ ...styles.loadBtn, background: '#334155' }}
            onClick={openNewEmpForm}
            disabled={loading}
          >
            + Novo Funcionário
          </button>
          <button
            style={{ ...styles.loadBtn, ...(loading ? styles.loadBtnDisabled : {}) }}
            onClick={handleLoadClick}
            disabled={loading}
          >
            {loading ? 'Carregando…' : data ? 'Atualizar' : 'Carregar Funcionários'}
          </button>
        </div>
      </div>

      {/* Warning banner before load */}
      {showWarning && (
        <div style={styles.warningBanner}>
          <span>⚠️</span>
          <span style={{ flex: 1 }}>
            Esta consulta pode levar <strong>vários minutos</strong> pois precisa conectar a todos os relógios.
            Deseja continuar?
          </span>
          <button
            style={{ ...styles.loadBtn, padding: '4px 12px', fontSize: '12px' }}
            onClick={handleConfirmLoad}
          >
            Sim, carregar
          </button>
          <button
            style={{ ...styles.loadBtn, padding: '4px 12px', fontSize: '12px', background: '#334155' }}
            onClick={() => setShowWarning(false)}
          >
            Cancelar
          </button>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div style={styles.loadingMsg}>
          <div style={{ marginBottom: '8px' }}>⏳ Consultando todos os relógios…</div>
          <div style={{ fontSize: '12px' }}>Isso pode levar vários minutos.</div>
        </div>
      )}

      {/* Operation status */}
      {opStatus && (
        <div style={styles.statusBox(opStatus.type)}>
          <div style={styles.statusTitle}>{opStatus.title}</div>
          {opStatus.clocks.length > 0 && (
            <div style={styles.statusClockList}>
              {opStatus.clocks.map(c => (
                <span key={c.label} style={styles.clockChip(c.ok)}>
                  {c.ok ? '✅' : '❌'} {c.label}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Enrollment form */}
      {enrollTarget && (
        <div style={styles.enrollForm}>
          <div style={styles.enrollTitle}>
            Cadastrar: {enrollTarget.name}
          </div>
          <div style={styles.enrollRow}>
            <div style={styles.enrollField}>
              <label style={styles.enrollLabel}>CPF</label>
              <input
                style={{ ...styles.enrollInput, color: 'var(--text-muted, #94a3b8)' }}
                value={enrollTarget.cpf}
                readOnly
              />
            </div>
            <div style={styles.enrollField}>
              <label style={styles.enrollLabel}>Ref1 — Matrícula *</label>
              <input
                style={styles.enrollInput}
                value={enrollRef1}
                onChange={e => setEnrollRef1(e.target.value)}
                placeholder="ex: 00123"
              />
            </div>
            <div style={styles.enrollField}>
              <label style={styles.enrollLabel}>Ref2 — Crachá NFC (opcional)</label>
              <input
                style={styles.enrollInput}
                value={enrollRef2}
                onChange={e => setEnrollRef2(e.target.value)}
                placeholder="Número do cartão"
              />
            </div>
          </div>
          <div style={styles.enrollClocks}>
            Relógios alvo:{' '}
            {(enrollTarget.absentIn || []).map(ip => (
              <span key={ip} style={{ ...styles.clockChip(false), marginRight: '4px', display: 'inline-block' }}>
                {IP_TO_STORE[ip] || ip}
              </span>
            ))}
            {enrollTarget.absentIn?.length === 0 && (
              <span style={{ color: 'var(--green, #4ade80)' }}>Nenhum — já sincronizado.</span>
            )}
          </div>
          <div style={styles.enrollBtnRow}>
            <button
              style={{ ...styles.loadBtn, ...(enrolling ? styles.loadBtnDisabled : {}) }}
              onClick={handleEnroll}
              disabled={enrolling}
            >
              {enrolling ? 'Cadastrando…' : 'Cadastrar'}
            </button>
            <button
              style={{ ...styles.loadBtn, background: '#334155' }}
              onClick={closeEnrollForm}
              disabled={enrolling}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* New employee form */}
      {newEmpMode && (
        <div style={styles.enrollForm}>
          <div style={styles.enrollTitle}>Cadastrar novo funcionário em todos os relógios</div>
          <div style={styles.enrollRow}>
            <div style={styles.enrollField}>
              <label style={styles.enrollLabel}>Nome *</label>
              <input
                style={{ ...styles.enrollInput, minWidth: '200px' }}
                value={newEmpName}
                onChange={e => setNewEmpName(e.target.value)}
                placeholder="Nome completo"
              />
            </div>
            <div style={styles.enrollField}>
              <label style={styles.enrollLabel}>CPF *</label>
              <input
                style={styles.enrollInput}
                value={newEmpCpf}
                onChange={e => setNewEmpCpf(e.target.value)}
                placeholder="000.000.000-00"
              />
            </div>
            <div style={styles.enrollField}>
              <label style={styles.enrollLabel}>Ref1 — Matrícula *</label>
              <input
                style={styles.enrollInput}
                value={newEmpRef1}
                onChange={e => setNewEmpRef1(e.target.value)}
                placeholder="ex: 00123"
              />
            </div>
            <div style={styles.enrollField}>
              <label style={styles.enrollLabel}>Ref2 — Crachá NFC (opcional)</label>
              <input
                style={styles.enrollInput}
                value={newEmpRef2}
                onChange={e => setNewEmpRef2(e.target.value)}
                placeholder="Número do cartão"
              />
            </div>
          </div>
          <div style={styles.enrollClocks}>
            Será cadastrado em todos os relógios acessíveis no momento.
          </div>
          <div style={styles.enrollBtnRow}>
            <button
              style={{ ...styles.loadBtn, ...(newEnrolling ? styles.loadBtnDisabled : {}) }}
              onClick={handleNewEnroll}
              disabled={newEnrolling}
            >
              {newEnrolling ? 'Cadastrando…' : 'Cadastrar em todos'}
            </button>
            <button
              style={{ ...styles.loadBtn, background: '#334155' }}
              onClick={closeNewEmpForm}
              disabled={newEnrolling}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Controls */}
      {data && !loading && (
        <div style={styles.controls}>
          <input
            style={styles.searchInput}
            placeholder="Buscar por nome ou CPF…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div style={styles.toggleGroup}>
            <button
              style={styles.toggleBtn(filter === 'all')}
              onClick={() => setFilter('all')}
            >
              Todos
            </button>
            <button
              style={styles.toggleBtn(filter === 'divergent')}
              onClick={() => setFilter('divergent')}
            >
              Só divergentes
            </button>
            <button
              style={styles.toggleBtn(filter === 'synced')}
              onClick={() => setFilter('synced')}
            >
              Não divergentes
            </button>
            <button
              style={styles.toggleBtn(filter === 'incomplete')}
              onClick={() => setFilter('incomplete')}
            >
              Incompletos
            </button>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-muted, #94a3b8)' }}>
            {filtered.length} exibidos
          </span>
        </div>
      )}

      {/* Table */}
      {data && !loading && (
        <div style={styles.tableWrapper}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Nome</th>
                <th style={styles.th}>CPF</th>
                <th style={styles.th}>Ref1</th>
                <th style={styles.th}>Ref2 — Crachá</th>
                {allClockIps.map(ip => (
                  <th key={ip} style={styles.thCenter} title={clockStatusMap[ip] ? ip : `${ip} — offline`}>
                    {IP_TO_STORE[ip] || ip}
                    {!clockStatusMap[ip] && (
                      <span style={{ color: 'var(--text-muted, #94a3b8)', fontSize: '10px', display: 'block', fontWeight: 400 }}>
                        offline
                      </span>
                    )}
                  </th>
                ))}
                <th style={styles.th}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={5 + allClockIps.length}
                    style={{ ...styles.td, textAlign: 'center', color: 'var(--text-muted, #94a3b8)', padding: '24px' }}
                  >
                    Nenhum funcionário encontrado.
                  </td>
                </tr>
              ) : (
                filtered.map(emp => {
                  const divergent = isDivergent(emp)
                  const rowStyle  = divergent ? styles.trDivergent : styles.trNormal
                  const isRemoving = removing === emp.cpf

                  return (
                    <tr key={emp.cpf} style={rowStyle}>
                      <td style={styles.td}>
                        {divergent && (
                          <span title="Divergente" style={{ marginRight: '5px', fontSize: '12px' }}>⚠️</span>
                        )}
                        {emp.name}
                      </td>
                      <td style={{ ...styles.td, ...styles.cpfText }}>{emp.cpf}</td>
                      <td style={{ ...styles.td, ...styles.cpfText }}>{emp.ref1 || '—'}</td>
                      <td style={{ ...styles.td, ...styles.cpfText }}>{emp.ref2 || '—'}</td>
                      {allClockIps.map(ip => {
                        const clockOk    = clockStatusMap[ip]
                        const present    = emp.presentIn?.includes(ip)
                        const incomplete = emp.incompleteIn?.includes(ip)
                        let content, title, extraStyle = {}
                        if (!clockOk) {
                          content    = '—'
                          title      = 'Relógio offline nesta leitura'
                          extraStyle = { color: 'var(--text-muted, #94a3b8)' }
                        } else if (present && incomplete) {
                          content = '⚠️'
                          title   = 'Presente mas crachá NFC ausente neste relógio'
                        } else if (present) {
                          content = '✅'
                          title   = 'Presente'
                        } else {
                          content = '❌'
                          title   = 'Ausente'
                        }
                        return (
                          <td key={ip} style={{ ...styles.tdCenter, ...extraStyle }} title={title}>
                            {content}
                          </td>
                        )
                      })}
                      <td style={styles.td}>
                        <div style={styles.actionsCell}>
                          {divergent && !enrollTarget && (
                            <button
                              style={styles.actionBtn('sync')}
                              onClick={() => openEnrollForm(emp)}
                              disabled={isRemoving}
                            >
                              Sincronizar
                            </button>
                          )}
                          {enrollTarget?.cpf === emp.cpf && (
                            <span style={{ fontSize: '11px', color: 'var(--yellow, #fbbf24)' }}>
                              Form aberto acima ↑
                            </span>
                          )}
                          {isIncomplete(emp) && emp.ref2 && !enrollTarget && (
                            <button
                              style={{
                                ...styles.actionBtn('sync'),
                                ...(completing === emp.cpf ? styles.actionBtnDisabled : {}),
                              }}
                              onClick={() => handleCompleteCard(emp)}
                              disabled={!!completing || isRemoving}
                            >
                              {completing === emp.cpf ? 'Atualizando…' : 'Completar Crachá'}
                            </button>
                          )}
                          <button
                            style={{
                              ...styles.actionBtn('remove'),
                              ...(isRemoving ? styles.actionBtnDisabled : {}),
                            }}
                            onClick={() => handleRemove(emp)}
                            disabled={isRemoving || !!enrollTarget || completing === emp.cpf}
                          >
                            {isRemoving ? 'Removendo…' : 'Remover'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
