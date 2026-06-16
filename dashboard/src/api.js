// api.js - Cliente HTTP para o servidor Delirio Manager

let serverUrl = 'https://dt-manager.brazilsouth.cloudapp.azure.com'

export function setServerUrl(url) {
  serverUrl = url.replace(/\/$/, '')
}

export function getServerUrl() {
  return serverUrl
}

async function request(method, path, body) {
  const res = await fetch(`${serverUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 202) {
    const json = await res.json().catch(() => ({}))
    return { _pending: true, ...json }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export const api = {
  // Machines
  getMachines: ()         => request('GET',  '/api/machines'),
  getMachine:  (id)       => request('GET',  `/api/machines/${id}`),
  getMetrics:  (id, h=24) => request('GET',  `/api/machines/${id}/metrics?hours=${h}`),
  getEvents:   (id)       => request('GET',  `/api/machines/${id}/events`),
  updateMachine: (id, data) => request('PUT', `/api/machines/${id}`, data),

  // Commands
  sendCommand: (id, type, params, confirm) =>
    request('POST', `/api/machines/${id}/commands`, { type, params, confirm }),

  // Alerts
  getAlerts:    ()     => request('GET',    '/api/alerts'),
  createAlert:  (rule) => request('POST',   '/api/alerts', rule),
  deleteAlert:  (id)   => request('DELETE', `/api/alerts/${id}`),

  // Groups
  getGroups:     ()              => request('GET',    '/api/groups'),
  createGroup:   (name)          => request('POST',   '/api/groups', { name }),
  renameGroup:   (name, newName) => request('PUT',    `/api/groups/${encodeURIComponent(name)}`, { newName }),
  deleteGroup:   (name)          => request('DELETE', `/api/groups/${encodeURIComponent(name)}`),

  // Update
  getUpdateVersion:  ()     => request('GET',  '/api/update/version'),
  broadcastUpdate:   ()     => request('POST', '/api/update/broadcast', {}),
  updateMachineNow:  (id)   => request('POST', `/api/update/machine/${id}`, {}),

  // Win Events
  getWinEvents:      (id, scope = 'focused') => request('GET', `/api/machines/${id}/win-events?scope=${scope}`),
  markWinEventsRead: (id)                    => request('PUT', `/api/machines/${id}/win-events/read`),

  // Insights
  getInsights:      (machineId) => request('GET', `/api/insights${machineId ? `?machine_id=${machineId}` : ''}`),
  markInsightRead:  (id)        => request('PUT', `/api/insights/${id}/read`),
  generateInsights: ()          => request('POST', '/api/insights/generate'),

  // Health
  health: () => request('GET', '/health'),

  // Reports
  getBiosReport:   ()     => request('GET', '/api/reports/bios'),
  downloadBiosPdf: async () => {
    const res = await fetch(`${serverUrl}/api/reports/bios/pdf`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.blob()
  },

  // Settings
  getSettings:    ()     => request('GET', '/api/settings'),
  updateSettings: (data) => request('PUT', '/api/settings', data),

  // RH -- Relogios e Funcionarios
  rh: {
    getClockStatus:  () =>
      request('GET', '/api/rh/clocks/status'),
    getEmployees:    () =>
      request('GET', '/api/rh/employees'),
    getOffboardLog:  (limit = 50) =>
      request('GET', `/api/rh/offboard-log?limit=${limit}`),
    getOperationLog: (limit = 100, op = '') =>
      request('GET', `/api/rh/operation-log?limit=${limit}${op ? `&operation=${op}` : ''}`),
    offboard:   (cpf, employeeName, triggeredBy) =>
      request('POST', '/api/rh/offboard',  { cpf, employeeName, triggeredBy }),
    enroll:     (cpf, name, ref1, ref2, password, clockIps) =>
      request('POST', '/api/rh/enroll',    { cpf, name, ref1, ref2, password, clockIps }),
    updateCard: (cpf, ref2, clockIps) =>
      request('PUT',  '/api/rh/employee',  { cpf, ref2, clockIps }),
  },
}
