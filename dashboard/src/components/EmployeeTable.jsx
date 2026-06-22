import { useState, useEffect, useRef } from 'react'
import { api } from '../api'

// Module-level cache and background poll — persists while the app is open, survives tab switches
let _empCache     = null
let _empCacheTime = null
let _polling      = false
const _listeners  = new Set()

// Runs independently of any component — continues even when RH module is closed.
// Subscribers (components) register via _listeners; they receive the result when the poll finishes.
async function _startBackgroundPoll() {
  if (_polling) return
  _polling = true
  try {
    let attempts = 0
    const MAX_ATTEMPTS = 80  // 80 × 5 s ≈ 6.5 min
    while (attempts < MAX_ATTEMPTS) {
      const result = await api.rh.getEmployees()
      if (!result._pending) {
        _empCache     = result
        _empCacheTime = new Date()
        _listeners.forEach(fn => fn({ ok: true, result }))
        return
      }
      await new Promise(r => setTimeout(r, 5000))
      attempts++
    }
    _listeners.forEach(fn => fn({ ok: false, error: 'Tempo excedido aguardando relógios (> 6 min)' }))
  } finally {
    _polling = false
  }
}

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
      sync:   { bg: 'rgba(59,130,246,0.15)',  color: '#60a5fa', border: 'rgba(59,130,246,0.4)'  },
      edit:   { bg: 'rgba(99,102,241,0.15)',  color: '#818cf8', border: 'rgba(99,102,241,0.4)'  },
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
  // Enrollment / edit form
  enrollForm: {
    background: 'var(--card-bg, #1e2530)',
    border: '1px solid rgba(59,130,246,0.4)',
    borderRadius: '10px',
    padding: '14px 16px',
    marginBottom: '14px',
  },
  editForm: {
    background: 'var(--card-bg, #1e2530)',
    border: '1px solid rgba(99,102,241,0.4)',
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
  clockSelectorPanel: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    alignItems: 'center',
    background: 'var(--card-bg, #1e2530)',
    border: '1px solid var(--border, #2d3748)',
    borderRadius: '8px',
    padding: '8px 12px',
    marginBottom: '12px',
    fontSize: '12px',
  },
  clockSelectorLabel: {
    color: 'var(--text-muted, #94a3b8)',
    fontWeight: 600,
    marginRight: '4px',
    whiteSpace: 'nowrap',
  },
  clockCheckLabel: (checked, offline) => ({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '3px 8px',
    borderRadius: '4px',
    cursor: 'pointer',
    background: checked ? 'rgba(59,130,246,0.15)' : 'transparent',
    border: `1px solid ${checked ? 'rgba(59,130,246,0.4)' : 'var(--border, #2d3748)'}`,
    color: offline ? 'var(--text-muted, #94a3b8)' : (checked ? '#93c5fd' : 'var(--text-muted, #94a3b8)'),
    userSelect: 'none',
    transition: 'background 0.1s, border 0.1s',
  }),
  singleClockBadge: {
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 700,
    background: 'rgba(251,191,36,0.15)',
    color: '#fbbf24',
    border: '1px solid rgba(251,191,36,0.35)',
    whiteSpace: 'nowrap',
  },
}

function isDivergent(emp, absentIn, incompleteIn) {
  const a = absentIn     ?? emp.absentIn     ?? []
  const i = incompleteIn ?? emp.incompleteIn ?? []
  return a.length > 0 || i.length > 0
}

function isIncomplete(incompleteIn) {
  return (incompleteIn ?? []).length > 0
}

export function EmployeeTable() {
  const [data, setData]           = useState(_empCache)
  const [loading, setLoading]     = useState(_polling)
  const [showWarning, setShowWarning] = useState(false)

  const [search, setSearch]       = useState('')
  const [filter, setFilter]       = useState('all') // 'all' | 'divergent' | 'synced'

  // Enrollment form state
  const [enrollTarget, setEnrollTarget] = useState(null) // employee object
  const [enrollRef1, setEnrollRef1]     = useState('')
  const [enrollRef2, setEnrollRef2]     = useState('')
  const [enrolling, setEnrolling]       = useState(false)

  // Edit employee form state (edits ref2 in-place on all clocks where employee is present)
  const [editTarget, setEditTarget] = useState(null)
  const [editRef2, setEditRef2]     = useState('')
  const [editSaving, setEditSaving] = useState(false)

  // Clock selector — Set of IPs to include; empty Set = all clocks
  const [selectedClockIps, setSelectedClockIps] = useState(new Set())

  // Operation status
  const [opStatus, setOpStatus]   = useState(null) // { type, title, clocks }
  const [removing, setRemoving]   = useState(null) // cpf being removed
  const [completing, setCompleting] = useState(null) // cpf sendo completado

  // Partial refresh of offline clocks
  const [refreshingOffline, setRefreshingOffline] = useState(false)

  // Bulk sync all divergent employees
  const [syncAllRunning, setSyncAllRunning]     = useState(false)
  const [syncAllProgress, setSyncAllProgress]   = useState(null) // { sent, total }
  const [syncAllJobs, setSyncAllJobs]           = useState([])   // [{ cpf, name, targetIps, jobId, status, clocks, enrolled, failed }]
  const _syncRefreshTriggered                   = useRef(false)

  // New employee form
  const [newEmpMode, setNewEmpMode]     = useState(false)
  const [newEmpName, setNewEmpName]     = useState('')
  const [newEmpCpf, setNewEmpCpf]       = useState('')
  const [newEmpRef1, setNewEmpRef1]     = useState('')
  const [newEmpRef2, setNewEmpRef2]     = useState('')
  const [newEnrolling, setNewEnrolling] = useState(false)

  // Subscribe to background poll — delivers result even if user navigated away while loading
  useEffect(() => {
    function onPollDone({ ok, result, error }) {
      if (ok) applyData(result)
      else setOpStatus({ type: 'error', title: `Erro ao carregar: ${error}`, clocks: [] })
      setLoading(false)
    }
    _listeners.add(onPollDone)
    return () => _listeners.delete(onPollDone)
  }, [])

  // Auto-refresh after all sync jobs complete
  useEffect(() => {
    if (syncAllJobs.length === 0 || syncAllRunning) return
    const allDone = syncAllJobs.every(j => ['done', 'timeout', 'error'].includes(j.status))
    if (!allDone || _syncRefreshTriggered.current) return
    _syncRefreshTriggered.current = true
    const ips = [...new Set(syncAllJobs.flatMap(j => j.targetIps))]
    setRefreshingOffline(true)
    refreshTargetClocks(ips)
  }, [syncAllJobs, syncAllRunning])

  // Apply data after any load — sets cache and auto-selects only online clocks
  function applyData(result) {
    _empCache     = result
    _empCacheTime = new Date()
    setData(result)
    const onlineIps = new Set((result.clocks || []).filter(c => c.success).map(c => c.ip))
    // If all clocks are online use empty Set (= "all" mode); otherwise select only online ones
    setSelectedClockIps(onlineIps.size < (result.allClockIps || []).length ? onlineIps : new Set())
  }

  async function handleRefreshOffline() {
    // Refresh only offline clocks that are currently checked in the selector
    const offlineIps = displayClockIps.filter(ip => !clockStatusMap[ip])
    if (offlineIps.length === 0) return
    setRefreshingOffline(true)
    setOpStatus(null)
    try {
      await api.rh.refreshClocks(offlineIps)
      let attempts = 0
      while (attempts < 60) {
        await new Promise(r => setTimeout(r, 5000))
        const result = await api.rh.getEmployees()
        if (!result._pending) {
          applyData(result)
          break
        }
        attempts++
      }
      if (attempts >= 60) throw new Error('Tempo excedido aguardando relógios')
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao atualizar: ${err.message}`, clocks: [], detail: err.detail || null })
    } finally {
      setRefreshingOffline(false)
    }
  }

  async function pollJob(jobIndex, jobId, cpf) {
    // Fase 1: 40 × 3s = 2 min — jobs no início da fila respondem rápido
    // Fase 2: 360 × 30s = 3h — jobs aguardando fila longa, sem spam de requests
    const phases = [
      { attempts: 40, interval: 3000 },
      { attempts: 360, interval: 30000 },
    ]
    for (const { attempts, interval } of phases) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        await new Promise(r => setTimeout(r, interval))
        try {
          const res = await api.rh.pollEnroll(jobId)
          if (res.status === 'running') continue
          setSyncAllJobs(prev => prev.map((j, i) => i !== jobIndex ? j : {
            ...j, status: 'done',
            clocks:   res.clocks   || [],
            enrolled: res.enrolled ?? 0,
            failed:   res.failed   ?? 0,
          }))
          // Atualiza o contador em tempo real — não espera o auto-rescan final
          const enrolledIps = (res.clocks || []).filter(c => c.success).map(c => c.clockIp)
          if (enrolledIps.length > 0 && cpf) {
            patchEmployee(cpf, e => ({
              ...e,
              presentIn: [...e.presentIn, ...enrolledIps.filter(ip => !e.presentIn.includes(ip))],
              absentIn:  e.absentIn.filter(ip => !enrolledIps.includes(ip)),
            }))
          }
          return
        } catch { /* keep polling */ }
      }
    }
    setSyncAllJobs(prev => prev.map((j, i) => i !== jobIndex ? j : { ...j, status: 'timeout' }))
  }

  async function handleSyncAll() {
    // Only target online clocks — offline clocks cause Playwright timeouts that block the queue
    const onlineIps = new Set((data?.clocks || []).filter(c => c.success).map(c => c.ip))
    const toSync = (data?.employees || [])
      .map(emp => ({
        ...emp,
        targetIps: (emp.absentIn ?? []).filter(ip => onlineIps.has(ip)),
      }))
      .filter(emp => emp.targetIps.length > 0 && (emp.ref1 || '').trim())
    if (!toSync.length) {
      setOpStatus({ type: 'error', title: 'Nenhum funcionário com relógios online ausentes.', clocks: [] })
      return
    }
    _syncRefreshTriggered.current = false
    setSyncAllJobs(toSync.map(emp => ({
      cpf: emp.cpf, name: emp.name, targetIps: emp.targetIps,
      jobId: null, status: 'pending', clocks: [], enrolled: 0, failed: 0,
    })))
    setSyncAllRunning(true)
    setSyncAllProgress({ sent: 0, total: toSync.length })
    setOpStatus(null)
    for (let i = 0; i < toSync.length; i++) {
      const emp = toSync[i]
      try {
        const res = await api.rh.enroll(
          emp.cpf,
          emp.name,
          emp.ref1.trim(),
          (emp.ref2 || '').trim(),
          '',
          emp.targetIps,
        )
        setSyncAllJobs(prev => prev.map((j, idx) => idx === i ? { ...j, jobId: res.jobId, status: 'polling' } : j))
        pollJob(i, res.jobId, emp.cpf)
      } catch {
        setSyncAllJobs(prev => prev.map((j, idx) => idx === i ? { ...j, status: 'error' } : j))
      }
      setSyncAllProgress({ sent: i + 1, total: toSync.length })
    }
    setSyncAllRunning(false)
    setSyncAllProgress(null)
  }

  // Optimistic patch — immediately updates one employee's clock status in local state
  // based on the API result, before the background Playwright re-scan confirms it.
  function patchEmployee(cpf, patchFn) {
    setData(prev => {
      if (!prev?.employees) return prev
      const updated    = prev.employees.map(e => e.cpf === cpf ? patchFn(e) : e)
      const divergent  = updated.filter(e => e.absentIn.length  > 0)
      const incomplete = updated.filter(e => e.incompleteIn.length > 0)
      const next = { ...prev, employees: updated, divergent: divergent.length, incomplete: incomplete.length, synchronized: updated.length - divergent.length }
      _empCache = next
      return next
    })
  }

  // Partial refresh of only the target clocks — used after enroll/edit/remove.
  // Does NOT touch opStatus or loading state so the operation result stays visible.
  async function refreshTargetClocks(clockIps) {
    if (!clockIps || clockIps.length === 0) return
    try {
      await api.rh.refreshClocks(clockIps)
      let attempts = 0
      while (attempts < 60) {
        await new Promise(r => setTimeout(r, 5000))
        const result = await api.rh.getEmployees()
        if (!result._pending) {
          applyData(result)
          break
        }
        attempts++
      }
    } catch (_) {
      // silent — operation result already shown in opStatus
    }
  }

  function loadEmployees() {
    setShowWarning(false)
    setOpStatus(null)
    setLoading(true)
    _startBackgroundPoll()  // fire-and-forget — continues even if this module closes
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
    setEditTarget(null)
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
      let result = await api.rh.enroll(
        enrollTarget.cpf,
        enrollTarget.name,
        enrollRef1.trim(),
        enrollRef2.trim(),
        '',
        clockIps,
      )
      // Enroll é assíncrono — faz polling a cada 3s até o job completar
      while (result._pending && result.jobId) {
        await new Promise(r => setTimeout(r, 3000))
        result = await api.rh.pollEnroll(result.jobId)
      }
      const allOk = result.failed === 0
      const type  = allOk ? 'success' : result.enrolled > 0 ? 'partial' : 'error'
      const clockChips = (result.clocks || []).map(c => ({
        label: IP_TO_STORE[c.clockIp] || c.clockIp,
        ok:    c.success,
        msg:   !c.success ? (c.message || null) : null,
      }))
      setOpStatus({
        type,
        title: allOk
          ? `Cadastrado em ${result.enrolled} relógio(s).`
          : `Cadastrado em ${result.enrolled}, falhou em ${result.failed}.`,
        clocks: clockChips,
      })
      closeEnrollForm()
      const enrolledIps = (result.clocks || []).filter(c => c.success).map(c => c.clockIp)
      if (enrolledIps.length > 0) {
        patchEmployee(enrollTarget.cpf, e => ({
          ...e,
          presentIn: [...e.presentIn, ...enrolledIps.filter(ip => !e.presentIn.includes(ip))],
          absentIn:  e.absentIn.filter(ip => !enrolledIps.includes(ip)),
        }))
      }
      refreshTargetClocks(clockIps)
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao cadastrar: ${err.message}`, clocks: [], detail: err.detail || null })
    } finally {
      setEnrolling(false)
    }
  }

  function openNewEmpForm() {
    closeEnrollForm()
    closeEditForm()
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
      let result = await api.rh.enroll(
        newEmpCpf.trim(),
        newEmpName.trim().toUpperCase(),
        newEmpRef1.trim(),
        newEmpRef2.trim(),
        '',
        undefined, // undefined = todos os relógios (CLOCK_IPS no servidor)
      )
      // Enroll é assíncrono — faz polling a cada 3s até o job completar
      while (result._pending && result.jobId) {
        await new Promise(r => setTimeout(r, 3000))
        result = await api.rh.pollEnroll(result.jobId)
      }
      const allOk = result.failed === 0
      const type  = allOk ? 'success' : result.enrolled > 0 ? 'partial' : 'error'
      const clockChips = (result.clocks || []).map(c => ({
        label: IP_TO_STORE[c.clockIp] || c.clockIp,
        ok:    c.success,
        msg:   !c.success ? (c.message || null) : null,
      }))
      setOpStatus({
        type,
        title: allOk
          ? `${newEmpName.trim().toUpperCase()} cadastrado em ${result.enrolled} relógio(s).`
          : `Cadastrado em ${result.enrolled}, falhou em ${result.failed}.`,
        clocks: clockChips,
      })
      const cpfNew  = newEmpCpf.trim()
      const nameNew = newEmpName.trim().toUpperCase()
      const ref1New = newEmpRef1.trim()
      const ref2New = newEmpRef2.trim()
      closeNewEmpForm()
      const enrolledIps = (result.clocks || []).filter(c => c.success).map(c => c.clockIp)
      if (enrolledIps.length > 0) {
        setData(prev => {
          if (!prev?.employees || prev.employees.some(e => e.cpf === cpfNew)) return prev
          const reachableIps = (prev.clocks || []).filter(c => c.success).map(c => c.ip)
          const newEmpObj = { name: nameNew, cpf: cpfNew, ref1: ref1New, ref2: ref2New, presentIn: enrolledIps, absentIn: reachableIps.filter(ip => !enrolledIps.includes(ip)), incompleteIn: [] }
          const updated    = [...prev.employees, newEmpObj]
          const divergent  = updated.filter(e => e.absentIn.length  > 0)
          const incomplete = updated.filter(e => e.incompleteIn.length > 0)
          const next = { ...prev, employees: updated, total: updated.length, divergent: divergent.length, incomplete: incomplete.length, synchronized: updated.length - divergent.length }
          _empCache = next
          return next
        })
      }
      refreshTargetClocks((result.clocks || []).map(c => c.clockIp))
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao cadastrar: ${err.message}`, clocks: [], detail: err.detail || null })
    } finally {
      setNewEnrolling(false)
    }
  }

  // Edit employee — updates Ref2 (NFC card) on all clocks where employee is present
  function openEditForm(emp) {
    setEditTarget(emp)
    setEditRef2(emp.ref2 || '')
    setEnrollTarget(null)
    setOpStatus(null)
  }

  function closeEditForm() {
    setEditTarget(null)
    setEditRef2('')
  }

  async function handleEditSave() {
    if (!editTarget) return
    if (!editRef2.trim()) {
      setOpStatus({ type: 'error', title: 'Informe o número do crachá NFC para salvar.', clocks: [] })
      return
    }
    setEditSaving(true)
    setOpStatus(null)
    try {
      const result = await api.rh.updateCard(editTarget.cpf, editRef2.trim(), editTarget.presentIn)
      const allOk = result.failed === 0
      const type  = allOk ? 'success' : result.updated > 0 ? 'partial' : 'error'
      const clockChips = (result.clocks || []).map(c => ({
        label: IP_TO_STORE[c.clockIp] || c.clockIp,
        ok:    c.success,
        msg:   !c.success ? (c.message || null) : null,
      }))
      setOpStatus({
        type,
        title: allOk
          ? `Crachá atualizado em ${result.updated} relógio(s).`
          : `Atualizado em ${result.updated}, falhou em ${result.failed}.`,
        clocks: clockChips,
      })
      const cpfEdited = editTarget.cpf
      const newRef2   = editRef2.trim()
      closeEditForm()
      const updatedIps = (result.clocks || []).filter(c => c.success).map(c => c.clockIp)
      if (updatedIps.length > 0) {
        patchEmployee(cpfEdited, e => ({
          ...e,
          ref2: newRef2 || e.ref2,
          incompleteIn: e.incompleteIn.filter(ip => !updatedIps.includes(ip)),
        }))
      }
      refreshTargetClocks(editTarget.presentIn || [])
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao salvar: ${err.message}`, clocks: [], detail: err.detail || null })
    } finally {
      setEditSaving(false)
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
        msg:   !c.success ? (c.message || null) : null,
      }))
      setOpStatus({
        type,
        title: allOk
          ? `Crachá atualizado em ${result.updated} relógio(s).`
          : `Atualizado em ${result.updated}, falhou em ${result.failed}.`,
        clocks: clockChips,
      })
      const updatedIps2 = (result.clocks || []).filter(c => c.success).map(c => c.clockIp)
      if (updatedIps2.length > 0) {
        patchEmployee(emp.cpf, e => ({
          ...e,
          incompleteIn: e.incompleteIn.filter(ip => !updatedIps2.includes(ip)),
        }))
      }
      refreshTargetClocks(emp.incompleteIn || [])
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao completar crachá: ${err.message}`, clocks: [], detail: err.detail || null })
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
        msg:   !(c.success || c.alreadyAbsent) ? (c.message || null) : null,
      }))
      setOpStatus({
        type,
        title: allOk
          ? `"${emp.name}" removido de ${result.removed} relógio(s).`
          : `Removido de ${result.removed}, falhou em ${result.failed}.`,
        clocks: clockChips,
        detail: result.lgpdExplorerPath
          ? `📁 Comprovante LGPD: ${result.lgpdExplorerPath}`
          : result.lgpdError
          ? `⚠️ Comprovante LGPD não salvo: ${result.lgpdError}`
          : null,
      })
      const removedIps = (result.clocks || []).filter(c => c.success || c.alreadyAbsent).map(c => c.clockIp)
      if (removedIps.length > 0) {
        setData(prev => {
          if (!prev?.employees) return prev
          const updated = prev.employees
            .map(e => {
              if (e.cpf !== emp.cpf) return e
              return { ...e, presentIn: e.presentIn.filter(ip => !removedIps.includes(ip)), absentIn: [...e.absentIn, ...removedIps.filter(ip => !e.absentIn.includes(ip))] }
            })
            .filter(e => e.cpf !== emp.cpf || e.presentIn.length > 0)
          const divergent  = updated.filter(e => e.absentIn.length  > 0)
          const incomplete = updated.filter(e => e.incompleteIn.length > 0)
          const next = { ...prev, employees: updated, total: updated.length, divergent: divergent.length, incomplete: incomplete.length, synchronized: updated.length - divergent.length }
          _empCache = next
          return next
        })
      }
      refreshTargetClocks((result.clocks || []).map(c => c.clockIp))
    } catch (err) {
      setOpStatus({ type: 'error', title: `Erro ao remover: ${err.message}`, clocks: [], detail: err.detail || null })
    } finally {
      setRemoving(null)
    }
  }

  // Todos os IPs tentados (incluindo offline) — vem do backend
  const allClockIps    = data?.allClockIps ?? []
  // Map ip -> bool (true = leitura bem-sucedida nessa rodada)
  const clockStatusMap = Object.fromEntries((data?.clocks ?? []).map(c => [c.ip, c.success]))

  // Clock selector helpers
  function toggleClock(ip) {
    setSelectedClockIps(prev => {
      const next = new Set(prev.size === 0 ? allClockIps : prev)
      if (next.has(ip)) { next.delete(ip); if (next.size === 0) return new Set() }
      else next.add(ip)
      if (next.size === allClockIps.length) return new Set() // all = default
      return next
    })
  }
  function selectAllClocks() { setSelectedClockIps(new Set()) }

  // Effective clock IPs for display: subset when selector active, all otherwise
  const displayClockIps = selectedClockIps.size > 0
    ? allClockIps.filter(ip => selectedClockIps.has(ip))
    : allClockIps
  const singleClockMode = displayClockIps.length === 1
  const allSelected     = selectedClockIps.size === 0

  // Offline IPs within the current selection — drives the "Atualizar offline" button
  const offlineSelectedIps = displayClockIps.filter(ip => !clockStatusMap[ip])

  // Per-employee helper: effective absent/incomplete relative to displayClockIps
  function effectiveSets(emp) {
    if (allSelected) {
      return { absentIn: emp.absentIn ?? [], incompleteIn: emp.incompleteIn ?? [] }
    }
    return {
      absentIn:     (emp.absentIn     ?? []).filter(ip => displayClockIps.includes(ip)),
      incompleteIn: (emp.incompleteIn ?? []).filter(ip => displayClockIps.includes(ip)),
    }
  }

  // Filter employees
  const employees = data?.employees || []
  const filtered  = employees.filter(emp => {
    // Clock-selector: only show employees present in at least one selected clock
    if (!allSelected) {
      const presentInSelected = emp.presentIn?.some(ip => displayClockIps.includes(ip))
      if (!presentInSelected) return false
    }
    const q = search.trim().toLowerCase()
    if (q && !emp.name.toLowerCase().includes(q) && !emp.cpf.includes(q)) return false
    const { absentIn, incompleteIn } = effectiveSets(emp)
    const divergent = isDivergent(emp, absentIn, incompleteIn)
    if (filter === 'divergent'  && !divergent)               return false
    if (filter === 'synced'     &&  divergent)               return false
    if (filter === 'incomplete' && !isIncomplete(incompleteIn)) return false
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
                <span key={c.label} style={styles.clockChip(c.ok)} title={c.msg || undefined}>
                  {c.ok ? '✅' : '❌'} {c.label}
                </span>
              ))}
            </div>
          )}
          {opStatus.clocks.some(c => !c.ok && c.msg) && (
            <div style={{ marginTop: '8px', fontSize: '12px', lineHeight: '1.6', fontFamily: 'monospace', opacity: 0.85 }}>
              {opStatus.clocks.filter(c => !c.ok && c.msg).map(c => (
                <div key={c.label}>❌ {c.label}: {c.msg}</div>
              ))}
            </div>
          )}
          {opStatus.detail && (
            <div style={{ marginTop: '8px', fontSize: '12px', opacity: 0.85, fontFamily: 'monospace' }}>
              {opStatus.detail}
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

      {/* Edit employee form — edits Ref2 (NFC card) across all clocks where employee is present */}
      {editTarget && (
        <div style={styles.editForm}>
          <div style={styles.enrollTitle}>
            ✏️ Editar: {editTarget.name}
          </div>
          <div style={styles.enrollRow}>
            <div style={styles.enrollField}>
              <label style={styles.enrollLabel}>CPF</label>
              <input
                style={{ ...styles.enrollInput, color: 'var(--text-muted, #94a3b8)' }}
                value={editTarget.cpf}
                readOnly
              />
            </div>
            <div style={styles.enrollField}>
              <label style={styles.enrollLabel}>Ref1 — Matrícula (somente leitura)</label>
              <input
                style={{ ...styles.enrollInput, color: 'var(--text-muted, #94a3b8)' }}
                value={editTarget.ref1 || '—'}
                readOnly
              />
            </div>
            <div style={styles.enrollField}>
              <label style={styles.enrollLabel}>Ref2 — Crachá NFC</label>
              <input
                style={styles.enrollInput}
                value={editRef2}
                onChange={e => setEditRef2(e.target.value)}
                placeholder="Número do cartão"
                autoFocus
              />
            </div>
          </div>
          <div style={styles.enrollClocks}>
            Será atualizado em:{' '}
            {(editTarget.presentIn || []).map(ip => (
              <span key={ip} style={{ ...styles.clockChip(true), marginRight: '4px', display: 'inline-block' }}>
                {IP_TO_STORE[ip] || ip}
              </span>
            ))}
          </div>
          <div style={styles.enrollBtnRow}>
            <button
              style={{ ...styles.loadBtn, background: 'rgba(99,102,241,0.8)', ...(editSaving ? styles.loadBtnDisabled : {}) }}
              onClick={handleEditSave}
              disabled={editSaving}
            >
              {editSaving ? 'Salvando…' : 'Salvar'}
            </button>
            <button
              style={{ ...styles.loadBtn, background: '#334155' }}
              onClick={closeEditForm}
              disabled={editSaving}
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

      {/* Clock Selector */}
      {data && !loading && allClockIps.length > 0 && (
        <div style={styles.clockSelectorPanel}>
          <span style={styles.clockSelectorLabel}>Relógios na leitura:</span>
          <label
            style={styles.clockCheckLabel(allSelected, false)}
            onClick={selectAllClocks}
          >
            <input
              type="checkbox"
              checked={allSelected}
              onChange={selectAllClocks}
              style={{ margin: 0, accentColor: '#3b82f6' }}
            />
            Todos
          </label>
          {allClockIps.map(ip => {
            const checked = allSelected || selectedClockIps.has(ip)
            const offline = !clockStatusMap[ip]
            return (
              <label
                key={ip}
                style={styles.clockCheckLabel(checked, offline)}
                onClick={() => toggleClock(ip)}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleClock(ip)}
                  style={{ margin: 0, accentColor: '#3b82f6' }}
                />
                {IP_TO_STORE[ip] || ip}
                {offline && <span style={{ fontSize: '10px', opacity: 0.6 }}> (offline)</span>}
              </label>
            )
          })}
          {singleClockMode && (
            <span style={styles.singleClockBadge}>
              Modo leitura única — {IP_TO_STORE[displayClockIps[0]] || displayClockIps[0]}
            </span>
          )}
          {offlineSelectedIps.length > 0 && (
            <button
              style={{
                ...styles.loadBtn,
                padding: '3px 10px',
                fontSize: '12px',
                background: '#334155',
                marginLeft: 'auto',
                ...(refreshingOffline || loading ? styles.loadBtnDisabled : {}),
              }}
              onClick={handleRefreshOffline}
              disabled={refreshingOffline || loading}
            >
              {refreshingOffline
                ? 'Atualizando…'
                : `Atualizar offline (${offlineSelectedIps.length})`}
            </button>
          )}
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
          {divergentCount > 0 && !enrollTarget && !editTarget && (
            <button
              style={{
                ...styles.loadBtn,
                background: syncAllRunning ? '#92400e' : '#d97706',
                marginLeft: 'auto',
                ...(syncAllRunning || loading ? styles.loadBtnDisabled : {}),
              }}
              onClick={handleSyncAll}
              disabled={syncAllRunning || loading}
              title={`Enfileira ${divergentCount} funcionário(s) no clock-proxy para cadastro em todos os relógios onde estão ausentes`}
            >
              {syncAllRunning
                ? `Enviando ${syncAllProgress?.sent ?? 0}/${syncAllProgress?.total ?? divergentCount}…`
                : `⚡ Sincronizar Todos (${divergentCount})`}
            </button>
          )}
        </div>
      )}

      {/* Sync progress panel */}
      {syncAllJobs.length > 0 && (
        <div style={{
          margin: '8px 0',
          background: 'var(--card-bg, #1e2530)',
          border: '1px solid var(--border, #2d3748)',
          borderRadius: '8px',
          padding: '12px',
          fontSize: '12px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text, #e2e8f0)' }}>
              ⚡ Sincronizar Todos
              {' — '}
              {syncAllRunning
                ? `enviando ${syncAllProgress?.sent ?? 0}/${syncAllProgress?.total ?? syncAllJobs.length}…`
                : `${syncAllJobs.filter(j => j.status === 'done').length}/${syncAllJobs.length} concluídos`}
            </span>
            {!syncAllRunning && syncAllJobs.every(j => ['done','timeout','error'].includes(j.status)) && (
              <button
                onClick={() => setSyncAllJobs([])}
                style={{ background: 'transparent', border: '1px solid var(--border, #2d3748)', borderRadius: '4px', color: 'var(--text-muted, #94a3b8)', cursor: 'pointer', padding: '2px 10px', fontSize: '11px' }}
              >
                Fechar
              </button>
            )}
          </div>
          <div style={{ maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {syncAllJobs.map((job, i) => {
              const icon = job.status === 'pending' ? '⌛'
                : job.status === 'polling'  ? '⏳'
                : job.status === 'timeout'  ? '⏱️'
                : job.status === 'error'    ? '❌'
                : job.enrolled > 0 && job.failed === 0 ? '✅'
                : job.enrolled > 0          ? '⚠️'
                : '❌'
              return (
                <div key={job.cpf} style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '4px 6px', borderRadius: '4px',
                  background: job.status === 'pending' ? 'transparent' : 'rgba(255,255,255,0.03)',
                }}>
                  <span style={{ width: '18px', textAlign: 'center', flexShrink: 0 }}>{icon}</span>
                  <span style={{ minWidth: '160px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text, #e2e8f0)', fontWeight: 600 }}>
                    {job.name}
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', flex: 1 }}>
                    {(job.status === 'pending' || job.status === 'polling') && job.targetIps.map(ip => (
                      <span key={ip} style={{
                        padding: '1px 6px', borderRadius: '3px', fontSize: '11px',
                        background: 'rgba(148,163,184,0.1)', color: 'var(--text-muted, #94a3b8)',
                        border: '1px solid rgba(148,163,184,0.2)',
                      }}>
                        {job.status === 'polling' ? '⏳ ' : ''}{IP_TO_STORE[ip] || ip}
                      </span>
                    ))}
                    {job.status === 'done' && job.clocks.map(c => (
                      <span key={c.clockIp} title={c.message || undefined} style={{
                        padding: '1px 6px', borderRadius: '3px', fontSize: '11px', fontWeight: 600,
                        background: c.success ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)',
                        color: c.success ? '#4ade80' : '#f87171',
                        border: `1px solid ${c.success ? 'rgba(74,222,128,0.25)' : 'rgba(248,113,113,0.25)'}`,
                      }}>
                        {c.success ? '✓' : '✗'} {IP_TO_STORE[c.clockIp] || c.clockIp}
                      </span>
                    ))}
                    {job.status === 'error' && (
                      <span style={{ padding: '1px 6px', borderRadius: '3px', fontSize: '11px', background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.25)' }}>
                        Erro ao enfileirar
                      </span>
                    )}
                    {job.status === 'timeout' && (
                      <span style={{ padding: '1px 6px', borderRadius: '3px', fontSize: '11px', background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.25)' }}>
                        Timeout (3 min)
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
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
                {displayClockIps.map(ip => (
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
                    colSpan={5 + displayClockIps.length}
                    style={{ ...styles.td, textAlign: 'center', color: 'var(--text-muted, #94a3b8)', padding: '24px' }}
                  >
                    Nenhum funcionário encontrado.
                  </td>
                </tr>
              ) : (
                filtered.map(emp => {
                  const { absentIn: effAbsent, incompleteIn: effIncomplete } = effectiveSets(emp)
                  const divergent  = isDivergent(emp, effAbsent, effIncomplete)
                  const incomplete = isIncomplete(effIncomplete)
                  const rowStyle   = divergent ? styles.trDivergent : styles.trNormal
                  const isRemoving = removing === emp.cpf
                  const isEditing  = editTarget?.cpf === emp.cpf

                  // In single-clock mode, show ref2 empty if that clock doesn't have it
                  const displayRef2 = (singleClockMode && emp.incompleteIn?.includes(displayClockIps[0]))
                    ? ''
                    : emp.ref2

                  const absentStores     = effAbsent.map(ip => IP_TO_STORE[ip] || ip)
                  const incompleteStores = effIncomplete.map(ip => IP_TO_STORE[ip] || ip)
                  const tooltipLines = []
                  if (absentStores.length)     tooltipLines.push(`Ausente em: ${absentStores.join(', ')}`)
                  if (incompleteStores.length) tooltipLines.push(`Sem crachá NFC em: ${incompleteStores.join(', ')}`)
                  const warningTooltip = tooltipLines.join('\n') || 'Divergente'

                  return (
                    <tr key={emp.cpf} style={rowStyle}>
                      <td style={styles.td}>
                        {divergent && (
                          <span title={warningTooltip} style={{ marginRight: '5px', fontSize: '12px', cursor: 'help' }}>⚠️</span>
                        )}
                        {emp.name}
                      </td>
                      <td style={{ ...styles.td, ...styles.cpfText }}>{emp.cpf}</td>
                      <td style={{ ...styles.td, ...styles.cpfText }}>{emp.ref1 || '—'}</td>
                      <td style={{ ...styles.td, ...styles.cpfText }}>{displayRef2 || '—'}</td>
                      {displayClockIps.map(ip => {
                        const clockOk      = clockStatusMap[ip]
                        const present      = emp.presentIn?.includes(ip)
                        const incompleteIp = emp.incompleteIn?.includes(ip)
                        let content, title, extraStyle = {}
                        if (!clockOk) {
                          content    = '—'
                          title      = 'Relógio offline nesta leitura'
                          extraStyle = { color: 'var(--text-muted, #94a3b8)' }
                        } else if (present && incompleteIp) {
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
                          {divergent && !singleClockMode && !enrollTarget && !editTarget && (
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
                          {incomplete && emp.ref2 && !singleClockMode && !enrollTarget && !editTarget && (
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
                          {isEditing ? (
                            <span style={{ fontSize: '11px', color: '#818cf8' }}>
                              Editando acima ↑
                            </span>
                          ) : (
                            <button
                              style={{
                                ...styles.actionBtn('edit'),
                                ...(isRemoving || !!completing ? styles.actionBtnDisabled : {}),
                              }}
                              onClick={() => openEditForm(emp)}
                              disabled={isRemoving || !!completing || !!enrollTarget}
                            >
                              Editar
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
