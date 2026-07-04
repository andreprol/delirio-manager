'use strict'

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const fs   = require('fs')

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')
const IS_DEV      = process.env.NODE_ENV === 'development' || !app.isPackaged

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { serverUrl: 'https://dt-manager.brazilsouth.cloudapp.azure.com' }
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

function createWindow() {
  let win = new BrowserWindow({
    width:  1600,
    height: 900,
    minWidth:  1520,
    minHeight: 700,
    title: 'Delirio Manager',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })

  // Remove menu bar em producao
  if (!IS_DEV) win.setMenuBarVisibility(false)

  if (IS_DEV) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

function setupAutoUpdater(win) {
  // Só verifica updates em producao (app empacotado)
  if (!app.isPackaged) return

  const { autoUpdater } = require('electron-updater')

  autoUpdater.logger               = null
  autoUpdater.autoDownload         = true
  autoUpdater.autoInstallOnAppQuit = true

  // Buffer: sempre armazena o update; o renderer puxa via getPendingUpdate após montar
  // (isLoading() não é guarda confiável para SPA — HTML termina antes do React montar)
  let pendingUpdate = null

  autoUpdater.on('error', (err) => {
    process.stderr.write(`[autoUpdater] error: ${err?.message}\n`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdate = { version: info.version }
    // Push para o renderer se já estiver montado (caso normal: download termina depois do mount)
    if (!win.isDestroyed()) {
      win.webContents.send('update-downloaded', { version: info.version })
    }
  })

  // Aguarda a página carregar antes de iniciar a verificação
  win.webContents.once('did-finish-load', () => {
    autoUpdater.checkForUpdates().catch((err) => {
      process.stderr.write(`[autoUpdater] checkForUpdates error: ${err?.message}\n`)
    })
  })

  // Renderer puxa o update pendente via invoke após registrar o listener push
  // (cobre o caso raro onde update-downloaded chega antes do useEffect registrar o listener)
  ipcMain.handle('updater:get-pending', () => pendingUpdate)
}

app.whenReady().then(() => {
  // IPC: ler/salvar configuracao
  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', (_, cfg) => { saveConfig(cfg); return true })

  // IPC: abrir pasta no Windows Explorer — allowlist de roots permitidos
  ipcMain.handle('shell:openPath', (_, folderPath) => {
    if (typeof folderPath !== 'string') return
    // Bloqueia UNC paths explícitos (\\server\share ou //server/share)
    if (folderPath.startsWith('\\\\') || folderPath.startsWith('//')) return

    const resolved = path.resolve(folderPath)

    // Roots confiáveis: userData do app + downloads + pasta LGPD configurada
    const cfg = loadConfig()
    const allowedRoots = [
      app.getPath('userData'),
      app.getPath('downloads'),
      cfg.lgpdExplorerRoot,
    ].filter(Boolean).map(r => path.resolve(r))

    const withinRoot = allowedRoots.some(root => {
      const prefix = root.endsWith(path.sep) ? root : root + path.sep
      const norm   = resolved.toLowerCase()
      return norm === root.toLowerCase() || norm.startsWith(prefix.toLowerCase())
    })

    if (!withinRoot) {
      console.warn(`[security] shell:openPath bloqueado — fora do allowlist: ${resolved}`)
      return
    }

    return shell.openPath(resolved)
  })

  // IPC: instalar update e reiniciar (só funciona em produção)
  ipcMain.handle('updater:quit-and-install', () => {
    if (!app.isPackaged) return
    const { autoUpdater } = require('electron-updater')
    autoUpdater.quitAndInstall()
  })

  const win = createWindow()
  setupAutoUpdater(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
