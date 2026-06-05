import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import { useWebSocket } from './useWebSocket'

function mapMachine(m) {
  return {
    ...m,
    wolStatus:   m.wolStatus   || m.wol_status  || 'unknown',
    motherboard: m.motherboard || '',
  }
}

export function useMachines() {
  const [machines,         setMachines]         = useState([])
  const [groups,           setGroupsList]        = useState([]) // lista de grupos do servidor
  const [httpOk,           setHttpOk]            = useState(false)
  const [wsConnected,      setWsConnected]       = useState(false)
  const [lastUpdate,       setLastUpdate]        = useState(null)
  const [alerts,           setAlerts]            = useState([])
  const [lastOffline,      setLastOffline]       = useState(null)
  const [insightVersion,   setInsightVersion]    = useState(0)

  const fetchAll = useCallback(async () => {
    try {
      const [list, grps] = await Promise.all([
        api.getMachines(),
        api.getGroups(),
      ])
      setMachines(list.map(mapMachine))
      setGroupsList(grps)
      setHttpOk(true)
      setLastUpdate(new Date())
    } catch {
      setHttpOk(false)
    }
  }, [])

  const fetchGroups = useCallback(async () => {
    try {
      const grps = await api.getGroups()
      setGroupsList(grps)
    } catch {}
  }, [])

  const handleWsMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'ws:connected':
        setWsConnected(true)
        fetchAll()
        break
      case 'ws:disconnected':
        setWsConnected(false)
        break
      case 'machine:update':
        setMachines(prev => {
          const idx = prev.findIndex(m => m.id === msg.data.machineId)
          if (idx === -1) { fetchAll(); return prev }
          const updated = [...prev]
          updated[idx] = mapMachine({
            ...updated[idx],
            status:      'online',
            lastSeen:    msg.data.lastSeen || new Date().toISOString(),
            lastMetrics: msg.data.metrics  || updated[idx].lastMetrics,
            wol_status:  msg.data.wolStatus ?? msg.data.wol_status ?? updated[idx].wolStatus,
            motherboard: msg.data.motherboard ?? updated[idx].motherboard,
          })
          return updated
        })
        setLastUpdate(new Date())
        break
      case 'machine:offline':
        setMachines(prev => {
          const updated = prev.map(m =>
            m.id === msg.data.machineId
              ? { ...m, status: 'offline', lastSeen: msg.data.lastSeen || m.lastSeen, onlineSince: msg.data.onlineSince || m.onlineSince }
              : m
          )
          const offlineMachine = updated.find(m => m.id === msg.data.machineId)
          if (offlineMachine) {
            setLastOffline({
              machineId:   offlineMachine.id,
              displayName: offlineMachine.displayName || offlineMachine.id,
              location:    offlineMachine.location || 'Sem localidade',
              lastSeen:    msg.data.lastSeen || offlineMachine.lastSeen,
            })
          }
          return updated
        })
        break
      case 'groups:updated':
        setGroupsList(msg.data || [])
        break
      case 'new_insight':
        setInsightVersion(v => v + 1)
        break
      case 'alert':
        setAlerts(prev => [msg.data, ...prev].slice(0, 20))
        break
      case 'command:acked':
        setMachines(prev => prev.map(m =>
          m.id === msg.data.machineId ? { ...m, pendingCommand: null } : m
        ))
        break
    }
  }, [fetchAll])

  useWebSocket(handleWsMessage)

  useEffect(() => { fetchAll() }, [fetchAll])

  useEffect(() => {
    const t = setInterval(fetchAll, 30000)
    return () => clearInterval(t)
  }, [fetchAll])

  const sendCommand = useCallback(async (machineId, type, params, confirm) => {
    const result = await api.sendCommand(machineId, type, params, confirm)
    setMachines(prev => prev.map(m =>
      m.id === machineId ? { ...m, pendingCommand: type } : m
    ))
    return result
  }, [])

  const wolMachine = useCallback(async (targetId) => {
    const target = machines.find(m => m.id === targetId)
    if (!target) throw new Error('Máquina não encontrada')
    if (!target.mac) throw new Error('MAC ainda não registrado — aguarde o próximo heartbeat e tente novamente')

    const relay = machines.find(m =>
      m.id !== targetId &&
      m.location === target.location &&
      m.status === 'online'
    )
    if (!relay) throw new Error('Nenhuma máquina online no mesmo grupo para retransmitir o sinal')

    await api.sendCommand(relay.id, 'wol', { mac: target.mac, targetId })

    // Atualiza badge da target imediatamente sem esperar poll de 30s
    setMachines(prev => prev.map(m =>
      m.id === targetId ? { ...m, wolStatus: 'testing' } : m
    ))
  }, [machines, setMachines])

  const moveMachineToGroup = useCallback(async (machineId, groupName) => {
    await api.updateMachine(machineId, { location: groupName })
    setMachines(prev => prev.map(m =>
      m.id === machineId ? { ...m, location: groupName } : m
    ))
  }, [])

  const createGroup = useCallback(async (name) => {
    await api.createGroup(name)
    await fetchGroups()
  }, [fetchGroups])

  const renameGroup = useCallback(async (oldName, newName) => {
    await api.renameGroup(oldName, newName)
    setMachines(prev => prev.map(m =>
      m.location === oldName ? { ...m, location: newName } : m
    ))
    await fetchGroups()
  }, [fetchGroups])

  const deleteGroup = useCallback(async (name) => {
    await api.deleteGroup(name)
    setMachines(prev => prev.map(m =>
      m.location === name ? { ...m, location: '' } : m
    ))
    await fetchGroups()
  }, [fetchGroups])

  // Monta mapa de grupos: todos os grupos do servidor + maquinas sem grupo
  const groupMap = {}

  // Inicializa todos os grupos registrados (incluindo vazios)
  groups.forEach(g => { groupMap[g.name] = [] })

  // Distribui maquinas nos grupos
  machines.forEach(m => {
    const loc = m.location || ''
    if (!groupMap[loc]) groupMap[loc] = []
    groupMap[loc].push(m)
  })

  return {
    machines, groupMap, groupsList: groups,
    connected: httpOk, wsConnected,
    lastUpdate, alerts, lastOffline,
    sendCommand, wolMachine, moveMachineToGroup,
    createGroup, renameGroup, deleteGroup,
    refresh: fetchAll,
    insightVersion,
  }
}
