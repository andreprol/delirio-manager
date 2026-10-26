'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig:  ()    => ipcRenderer.invoke('config:get'),
  setConfig:  (cfg) => ipcRenderer.invoke('config:set', cfg),
  openPath:   (p)   => ipcRenderer.invoke('shell:openPath', p),

  // Auto-updater
  onUpdateDownloaded: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('update-downloaded', handler)
    return () => ipcRenderer.removeListener('update-downloaded', handler)
  },
  getPendingUpdate:   ()    => ipcRenderer.invoke('updater:get-pending'),
  quitAndInstall:     ()    => ipcRenderer.invoke('updater:quit-and-install'),

  // Janela cresce para acomodar o topbar quando necessário
  fitTopbar: (neededWidth) => ipcRenderer.invoke('window:fit-topbar', neededWidth),

  // Download de arquivo → salva direto na pasta Downloads (sem dialog do Windows Explorer)
  downloadFile:    (url)  => ipcRenderer.invoke('download-file', { url }),
  showInFolder:    (p)    => ipcRenderer.invoke('shell:showItemInFolder', p),
  onDownloadDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('download-done', handler)
    return () => ipcRenderer.removeListener('download-done', handler)
  },

  // Verificação manual de atualização
  checkForUpdates: () => ipcRenderer.invoke('updater:check-now'),
  onUpdateNotAvailable: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('update-not-available', handler)
    return () => ipcRenderer.removeListener('update-not-available', handler)
  },
  onUpdateError: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('update-error', handler)
    return () => ipcRenderer.removeListener('update-error', handler)
  },
  onUpdateAvailable: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('update-available', handler)
    return () => ipcRenderer.removeListener('update-available', handler)
  },
  onDownloadProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('download-progress', handler)
    return () => ipcRenderer.removeListener('download-progress', handler)
  },

  // Sessão ao vivo (acesso remoto) — ver dashboard/electron/main.js
  isLiveSessionWindow: process.argv.includes('--live-session'),
  openLiveSessionWindow: (params) => ipcRenderer.invoke('live-session:open', params),
  onLiveSessionInit: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('live-session-init', handler)
    return () => ipcRenderer.removeListener('live-session-init', handler)
  },
  onCleanupAndClose: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('live-session-cleanup-and-close', handler)
    return () => ipcRenderer.removeListener('live-session-cleanup-and-close', handler)
  },
  cleanupDone: () => ipcRenderer.send('live-session-cleanup-done'),
  reportCleanupProgress: () => ipcRenderer.send('live-session-cleanup-progress'),
  reportCleanupFailed: () => ipcRenderer.send('live-session-cleanup-failed'),
  convertRecording: (arrayBuffer, metadata) => ipcRenderer.invoke('convert-recording', arrayBuffer, metadata),
})
