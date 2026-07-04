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
})
