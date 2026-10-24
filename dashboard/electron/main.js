'use strict'

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs   = require('fs')
const { spawn } = require('child_process')

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')
const IS_DEV      = process.env.NODE_ENV === 'development' || !app.isPackaged

// app.asar.unpacked: ffmpeg-static embute um binário nativo, que não pode
// ser executado de dentro do .asar — asarUnpack (package.json/build) copia
// esse binário pra fora, em app.asar.unpacked; em dev (sem asar) a troca de
// string não encontra 'app.asar' e não faz nada, path já está certo.
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')

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
    width:  1920,
    height: 900,
    minWidth:  1760,
    minHeight: 700,
    title: 'Delirio Manager',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })

  // Intercepta todos os downloads → salva direto na pasta Downloads do usuário (sem dialog)
  win.webContents.session.on('will-download', (event, item) => {
    const savePath = path.join(app.getPath('downloads'), item.getFilename())
    item.setSavePath(savePath)
    item.on('done', (e, state) => {
      if (!win.isDestroyed()) {
        win.webContents.send('download-done', { state, filename: item.getFilename(), savePath })
      }
    })
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

// Janela separada por sessão ao vivo (acesso remoto) — uma por máquina, o
// operador pode abrir mais de uma ao mesmo tempo. Carrega o MESMO bundle
// (dist/index.html) que a janela principal; main.jsx decide qual React root
// montar checando `electronAPI.isLiveSessionWindow` (flag em process.argv,
// lida no preload — nunca segredo ali). Os parâmetros da sessão (incluindo
// dashboardToken) viajam só por IPC, depois da janela terminar de carregar
// — nunca em URL/hash (ver spec 2026-10-24: evita token em histórico de
// navegação ou devtools).
function createLiveSessionWindow(params) {
  const liveWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Delirio Manager — Sessão ao vivo',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--live-session'],
    },
  })

  liveWin.setMenuBarVisibility(false)

  if (IS_DEV) {
    liveWin.loadURL('http://localhost:5173')
  } else {
    liveWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  liveWin.webContents.once('did-finish-load', () => {
    liveWin.webContents.send('live-session-init', params)
  })

  // Fechar a janela (X) é equivalente a "Encerrar sessão" (decisão da spec
  // 2026-10-24) — mas não fecha na hora: pede pro renderer limpar primeiro
  // (parar gravação em andamento + POST /stop), só destrói a janela quando
  // ele confirmar via 'live-session-cleanup-done'. Sem isso, o companion
  // continuaria transmitindo sem ninguém olhando, e uma gravação em
  // andamento seria descartada sem perguntar.
  liveWin.on('close', (event) => {
    if (liveWin.__cleanupDone) return
    event.preventDefault()
    liveWin.webContents.send('live-session-cleanup-and-close')
    // Rede de segurança: se o renderer nunca confirmar (fechou a janela
    // antes do React montar e se inscrever, preload falhou, travou no meio
    // da conversão), a janela ficaria IMPOSSÍVEL de fechar pra sempre —
    // event.preventDefault() já bloqueou o close, e nada mais chamaria
    // cleanupDone(). Força o fechamento depois de 10s mesmo sem resposta.
    setTimeout(() => {
      if (!liveWin.isDestroyed() && !liveWin.__cleanupDone) {
        liveWin.__cleanupDone = true
        liveWin.close()
      }
    }, 10000)
  })

  liveWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  return liveWin
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
    if (!win.isDestroyed()) win.webContents.send('update-error', { message: err?.message })
  })
  autoUpdater.on('update-not-available', () => {
    if (!win.isDestroyed()) win.webContents.send('update-not-available')
  })
  autoUpdater.on('update-available', (info) => {
    if (!win.isDestroyed()) win.webContents.send('update-available', { version: info.version })
  })
  autoUpdater.on('download-progress', (prog) => {
    if (!win.isDestroyed()) win.webContents.send('download-progress', { percent: Math.round(prog.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdate = { version: info.version }
    if (!win.isDestroyed()) win.webContents.send('update-downloaded', { version: info.version })
  })

  // Verificação automática na abertura
  win.webContents.once('did-finish-load', () => {
    autoUpdater.checkForUpdates().catch((err) => {
      process.stderr.write(`[autoUpdater] checkForUpdates error: ${err?.message}\n`)
    })
  })

  ipcMain.handle('updater:get-pending', () => pendingUpdate)

  // Verificação manual sob demanda (botão "Verificar atualização")
  ipcMain.handle('updater:check-now', () => {
    if (!app.isPackaged) return { status: 'dev' }
    autoUpdater.checkForUpdates().catch((err) => {
      process.stderr.write(`[autoUpdater] manual check error: ${err?.message}\n`)
    })
    return { status: 'checking' }
  })
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

  // IPC: abre o File Explorer com o arquivo selecionado (highlight)
  ipcMain.handle('shell:showItemInFolder', (_, filePath) => {
    if (typeof filePath !== 'string') return
    const resolved = path.resolve(filePath)
    const downloadsRoot = path.resolve(app.getPath('downloads'))
    const norm = resolved.toLowerCase()
    const prefix = downloadsRoot.toLowerCase() + path.sep
    if (norm !== downloadsRoot.toLowerCase() && !norm.startsWith(prefix)) return
    shell.showItemInFolder(resolved)
  })

  // IPC: download de arquivo para a pasta Downloads do usuário (sem dialog)
  ipcMain.handle('download-file', (_, { url }) => {
    if (!win || win.isDestroyed()) return false
    win.webContents.downloadURL(url)
    return true
  })

  // IPC: instalar update e reiniciar (só funciona em produção)
  ipcMain.handle('updater:quit-and-install', () => {
    if (!app.isPackaged) return
    const { autoUpdater } = require('electron-updater')
    autoUpdater.quitAndInstall()
  })

  // IPC: cresce a janela para acomodar o topbar quando necessário.
  // Só aumenta — nunca encolhe. Garante que qualquer novo botão
  // adicionado no futuro não fica escondido além da borda direita.
  ipcMain.handle('window:fit-topbar', (_, neededWidth) => {
    if (!win || win.isDestroyed()) return
    if (typeof neededWidth !== 'number' || neededWidth <= 0) return
    const [currentW, currentH] = win.getSize()
    const [currentMinW, currentMinH] = win.getMinimumSize()
    const newW    = Math.max(currentW,    Math.ceil(neededWidth))
    const newMinW = Math.max(currentMinW, Math.ceil(neededWidth))
    if (newMinW !== currentMinW) win.setMinimumSize(newMinW, currentMinH)
    if (newW    !== currentW)    win.setSize(newW, currentH, true) // true = animate
  })

  // IPC: abre a janela de sessão ao vivo (acesso remoto)
  ipcMain.handle('live-session:open', (_, params) => {
    createLiveSessionWindow(params)
    return true
  })

  // IPC: a janela de sessão confirmou que já limpou (parou gravação, avisou
  // o servidor) — agora pode fechar de verdade.
  ipcMain.on('live-session-cleanup-done', (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (senderWin && !senderWin.isDestroyed()) {
      senderWin.__cleanupDone = true
      senderWin.close()
    }
  })

  // IPC: converte a gravação WebM (MediaRecorder, renderer) pra MP4 via
  // ffmpeg-static, pergunta onde salvar, grava .mp4 + .json de metadados.
  ipcMain.handle('convert-recording', async (event, arrayBuffer, metadata) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    const tmpDir    = app.getPath('temp')
    const stamp     = Date.now()
    const webmPath  = path.join(tmpDir, `delirio-live-${stamp}.webm`)
    const mp4Path   = path.join(tmpDir, `delirio-live-${stamp}.mp4`)

    fs.writeFileSync(webmPath, Buffer.from(arrayBuffer))

    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, ['-y', '-i', webmPath, '-c:v', 'libx264', '-preset', 'fast', mp4Path])
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-500)}`))
        })
      })
    } finally {
      fs.unlink(webmPath, () => {})
    }

    const suggestedName = `${metadata?.hostname || metadata?.machineId || 'sessao'}_${stamp}.mp4`
    const { canceled, filePath } = await dialog.showSaveDialog(senderWin, {
      title: 'Salvar gravação da sessão ao vivo',
      defaultPath: path.join(app.getPath('downloads'), suggestedName),
      filters: [{ name: 'Vídeo MP4', extensions: ['mp4'] }],
    })

    if (canceled || !filePath) {
      fs.unlink(mp4Path, () => {})
      return { saved: false }
    }

    fs.copyFileSync(mp4Path, filePath)
    fs.unlink(mp4Path, () => {})

    const jsonPath = filePath.replace(/\.mp4$/i, '.json')
    fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2))

    return { saved: true, filePath, jsonPath }
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
