'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

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
  onNormalWindowVisibilityChange: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('live-session:normal-window-visibility', handler)
    return () => ipcRenderer.removeListener('live-session:normal-window-visibility', handler)
  },
  getNormalWindowVisibility: () => ipcRenderer.invoke('live-session:get-normal-window-visibility'),

  // winkeyhook (dashboard/winkeyhook, processo nativo separado) -- tecla
  // Windows/combos Win+R/E/D interceptados ANTES do Explorer local, ver
  // dashboard/electron/main.js (startWinKeyHook) e
  // dashboard/src/components/LiveSessionWindow.jsx. Aditivo ao
  // encaminhamento via onKeyDown que já existia (regra 3, 11/11/2026).
  onWinKeyCombo: (cb) => {
    const handler = (_, combo) => cb(combo)
    ipcRenderer.on('win-key-combo', handler)
    return () => ipcRenderer.removeListener('win-key-combo', handler)
  },
  cleanupDone: () => ipcRenderer.send('live-session-cleanup-done'),
  reportCleanupProgress: () => ipcRenderer.send('live-session-cleanup-progress'),
  reportCleanupFailed: () => ipcRenderer.send('live-session-cleanup-failed'),
  convertRecording: (arrayBuffer, metadata) => ipcRenderer.invoke('convert-recording', arrayBuffer, metadata),

  // Clipboard local (operador) — pra colar texto na sessão ao vivo (modo
  // Normal), ver dashboard/src/components/LiveSessionWindow.jsx
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),

  // Transferência de arquivo (operador → máquina remota) — seletor de
  // arquivo local nativo + leitura do conteúdo pra upload no Blob, ver
  // dashboard/src/hooks/useLiveSession.js (sendFileTransfer).
  pickFile: () => ipcRenderer.invoke('file:pick'),
  readLocalFile: (path) => ipcRenderer.invoke('file:read', path),

  // Drag-and-drop de arquivo (janela → sessão ao vivo): o objeto File do
  // drop não expõe mais `.path` a partir do Electron 32 (removido, ver
  // breaking changes oficiais) — webUtils.getPathForFile é a ponte
  // suportada pra obter o caminho local real a partir do File arrastado.
  getPathForFile: (file) => webUtils.getPathForFile(file),
})
