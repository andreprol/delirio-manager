'use strict'

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron')
const path = require('path')
const fs   = require('fs')
const { spawn, execFile } = require('child_process')
const readline = require('readline')
const { isInsideSensitiveDir } = require('./sensitiveDirGuard')
const { countVisibleNormalWindows } = require('./liveSessionRegistry')

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')
const IS_DEV      = process.env.NODE_ENV === 'development' || !app.isPackaged

// pendingDownloads: url do download -> {targetDir, win} -- Map em vez de 1
// variável única pra evitar race entre downloads concorrentes (ex: PDF da
// DANFE ao mesmo tempo que um arquivo da sessão ao vivo): cada entrada é
// consumida pela MESMA url exata no 'will-download' correspondente, nunca
// pela ordem de chegada. `win` é a janela que REALMENTE pediu o download
// (BrowserWindow.fromWebContents(event.sender), ver ipcMain.handle('download-file')
// abaixo) -- bug real ao vivo (13/11/2026, ASSBOH): antes disto, o
// 'will-download'/'done' sempre mandava 'download-done' pra janela
// PRINCIPAL (a `win` de createWindow(), fixa por closure), nunca pra quem
// de fato chamou downloadFile() -- o fluxo Ctrl+C remoto->local (sessão ao
// vivo, uma BrowserWindow DIFERENTE) nunca recebia o evento, por mais que
// a correlação por url/filename estivesse certa (o arquivo baixava
// certinho, só a notificação ia pro lugar errado). "← Baixar" nunca
// expôs esse bug porque usa só a PROMISE aproximada do próprio invoke
// (resolve assim que o download COMEÇA, não quando termina de verdade),
// nunca onDownloadDone -- só o Ctrl+C, que precisa do savePath real, é
// que dependia da notificação chegar na janela certa.
const pendingDownloads = new Map()

// THIS_PC_SENTINEL: valor especial de "diretório" que significa "mostra
// as unidades disponíveis" em vez de uma pasta de verdade -- equivalente
// ao "Este Computador"/"This PC" do Explorer. Precisa ser EXATAMENTE
// igual ao mesmo literal em dashboard/src/components/FileBrowserModal.jsx
// e à thisPCSentinel em agent/filetransfer_windows.go (lado remoto) -- os
// 3 lados concordam só por este comentário + os testes de cada um, mesmo
// risco já documentado pra LIVE_SESSION_MSG/CLOSE_CODES (server).
const THIS_PC_SENTINEL = 'Este Computador'

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

  // Intercepta todos os downloads → salva direto na pasta Downloads do
  // usuário por padrão (sem dialog) -- pendingDownloads (módulo, abaixo)
  // deixa um chamador específico (navegador de arquivos dual-pane, Ctrl+C
  // remoto->local) escolher outra pasta, mantendo este default pra quem
  // não escolhe (ex: PDF da DANFE, AlohaDANFESearch.jsx). Registrado uma
  // única vez aqui (no window PRINCIPAL), mas cobre downloads de QUALQUER
  // janela: todas as BrowserWindow deste app (sem `partition` própria no
  // webPreferences) compartilham o mesmo session.defaultSession, então
  // este listener dispara pra download pedido por qualquer uma.
  win.webContents.session.on('will-download', (event, item) => {
    // requestUrl capturado AQUI (não de novo em 'done') -- é a mesma chave
    // que pendingDownloads já usa.
    const requestUrl = item.getURL()
    if (!requestUrl) {
      // Achado 🟡 do code-reviewer: download falhou ANTES da URL resolver
      // (erro de rede/DNS pré-request, raro) -- log não resolve, mas fica
      // registrado pra diagnóstico futuro.
      console.warn('[download] will-download sem URL resolvida -- item:', item.getFilename())
    }
    const pending = pendingDownloads.get(requestUrl)
    pendingDownloads.delete(requestUrl)
    const targetDir = pending?.targetDir || app.getPath('downloads')
    // Bug real ao vivo (13/11/2026, ASSBOH): manda 'download-done' pra
    // quem REALMENTE pediu este download (pending.win), não sempre pra
    // `win` (a janela PRINCIPAL) -- ver comentário completo em
    // pendingDownloads, acima. Sem isso, o fluxo Ctrl+C remoto->local
    // (sessão ao vivo, outra BrowserWindow) nunca recebia a notificação
    // nenhuma, mesmo com o download completando certinho no disco --
    // "← Baixar" nunca expôs isso por só confiar na promise aproximada do
    // invoke, nunca em onDownloadDone de verdade. targetWin cai pra `win`
    // só se a janela que pediu já foi destruída/fechada nesse meio-tempo
    // (ex: operador fechou a sessão ao vivo com o download em andamento).
    const targetWin = (pending?.win && !pending.win.isDestroyed()) ? pending.win : win
    const savePath = path.join(targetDir, item.getFilename())
    item.setSavePath(savePath)
    item.on('done', (e, state) => {
      if (!targetWin.isDestroyed()) {
        targetWin.webContents.send('download-done', { state, filename: item.getFilename(), savePath, url: requestUrl })
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

// 'live-session:open' chega do renderer (MachineCard, janela principal) e
// viaja direto até dentro de outra BrowserWindow via IPC — sem validar os
// campos, um objeto com shape arbitrário atravessaria esse boundary sem
// checagem de tipo/tamanho (achado 🟡 na revisão desta mudança, que passou
// a incluir machineName, texto livre digitado pelo operador no rename da
// máquina). Nenhum dos campos é segredo em si, mas normalizar aqui evita
// que um valor malformado (tipo errado, string gigante) se propague pro
// renderer da janela de sessão.
function sanitizeLiveSessionParams(params) {
  const p = params || {}
  return {
    sessionId:      typeof p.sessionId === 'string' ? p.sessionId : '',
    machineId:      typeof p.machineId === 'string' ? p.machineId : '',
    machineName:    typeof p.machineName === 'string' ? p.machineName.slice(0, 200) : undefined,
    mode:           p.mode === 'normal' ? 'normal' : 'shadow',
    dashboardToken: typeof p.dashboardToken === 'string' ? p.dashboardToken : '',
    serverUrl:      typeof p.serverUrl === 'string' ? p.serverUrl : '',
  }
}

// Janela separada por sessão ao vivo (acesso remoto) — uma por máquina, o
// operador pode abrir mais de uma ao mesmo tempo. Carrega o MESMO bundle
// (dist/index.html) que a janela principal; main.jsx decide qual React root
// montar checando `electronAPI.isLiveSessionWindow` (flag em process.argv,
// lida no preload — nunca segredo ali). Os parâmetros da sessão (incluindo
// dashboardToken) viajam só por IPC, depois da janela terminar de carregar
// — nunca em URL/hash (ver spec 2026-10-24: evita token em histórico de
// navegação ou devtools).
// liveSessionWindows: todas as janelas de sessão ao vivo abertas (Normal ou
// Shadow). Cada BrowserWindow ganha __liveSessionMode pra countVisibleNormalWindows
// saber quais contam. broadcastNormalWindowVisibility recalcula e manda pra
// TODAS (inclusive a que acabou de mudar) sempre que algo relevante muda —
// regra 3 de André (11/11/2026): tecla Windows só funciona quando
// exatamente 1 janela Normal está visível ao mesmo tempo.
const liveSessionWindows = new Set()

function computeVisibleNormalCount() {
  const snapshot = [...liveSessionWindows].map((w) => ({
    mode: w.__liveSessionMode,
    minimized: w.isDestroyed() ? false : w.isMinimized(),
    destroyed: w.isDestroyed(),
  }))
  return countVisibleNormalWindows(snapshot)
}

function broadcastNormalWindowVisibility() {
  const visibleNormalCount = computeVisibleNormalCount()
  for (const w of liveSessionWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send('live-session:normal-window-visibility', { visibleNormalCount })
    }
  }
}

// winkeyhook (dashboard/winkeyhook, binário Go separado -- SEM relação com
// o agent/serviço das ~130 lojas) instala um hook de teclado de baixo
// nível (WH_KEYBOARD_LL) pra interceptar a tecla Windows e os combos
// Win+R/E/D ANTES do Explorer local processá-los -- testado ao vivo
// (12/11/2026) que globalShortcut/RegisterHotKey do próprio Electron NÃO
// dá: Windows já reserva Win sozinho (Electron nem aceita o acelerador) e
// Win+R/Win+L (RegisterHotKey recusa, já reservado pelo sistema). Só roda
// enquanto uma janela de sessão Normal tem FOCO (não só visível) -- ADITIVO
// ao encaminhamento via onKeyDown em LiveSessionWindow.jsx (regra 3,
// 11/11/2026), nunca substitui: enquanto o hook está ativo, o Windows
// nunca entrega WM_KEYDOWN de Win/R/E/D pra NENHUMA janela (nem a nossa),
// então o caminho antigo simplesmente não dispara -- os 2 caminhos são
// mutuamente exclusivos por construção. Se o hook não subir por qualquer
// motivo (exe ausente, SetWindowsHookExW falhar), a rede de segurança
// antiga continua funcionando exatamente como antes, sem nenhuma mudança
// de comportamento.
let winKeyHookProcess = null
let winKeyHookTargetWin = null
let winKeyHookStopTimer = null

function winkeyhookExePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'winkeyhook.exe')
    : path.join(__dirname, '..', 'winkeyhook', 'winkeyhook.exe')
}

function startWinKeyHook() {
  if (winKeyHookProcess) return
  const exePath = winkeyhookExePath()
  if (!fs.existsSync(exePath)) {
    console.warn('[winkeyhook] binário não encontrado, seguindo sem hook de teclado Windows:', exePath)
    return
  }
  const proc = spawn(exePath, [], { windowsHide: true })
  winKeyHookProcess = proc

  // stderr nunca lido antes (achado do code-reviewer): se
  // SetWindowsHookExW falhar lá dentro (main.go escreve lá e sai com
  // exit 1), o Electron só via o 'exit' silencioso, sem diagnóstico
  // nenhum de por que o hook não subiu -- justo no cenário de fallback
  // que o design já prevê (ver comentário acima).
  proc.stderr.on('data', (chunk) => {
    console.warn('[winkeyhook]', chunk.toString().trim())
  })

  const rl = readline.createInterface({ input: proc.stdout })
  rl.on('line', (line) => {
    const combo = line.trim()
    if (!combo || combo === 'ready') return
    if (winKeyHookTargetWin && !winKeyHookTargetWin.isDestroyed()) {
      winKeyHookTargetWin.webContents.send('win-key-combo', combo)
    }
  })

  const clearIfCurrent = () => { if (winKeyHookProcess === proc) winKeyHookProcess = null }
  proc.on('exit', clearIfCurrent)
  proc.on('error', (err) => {
    console.warn('[winkeyhook] falha ao iniciar:', err.message)
    clearIfCurrent()
  })
}

function stopWinKeyHook() {
  if (!winKeyHookProcess) return
  winKeyHookProcess.kill()
  winKeyHookProcess = null
}

// updateWinKeyHookTarget decide, a cada foco/perda de foco de uma janela
// de sessão Normal, se o hook deve estar rodando e PRA QUAL janela
// encaminhar os eventos dele. Debounce de 150ms antes de parar -- trocar
// foco entre 2 janelas Normal dispara blur-da-antiga seguido de
// focus-da-nova, e sem o debounce o hook pararia e religaria sem
// necessidade a cada troca.
function updateWinKeyHookTarget(win, focused) {
  if (win.__liveSessionMode !== 'normal') return
  clearTimeout(winKeyHookStopTimer)
  if (focused) {
    winKeyHookTargetWin = win
    startWinKeyHook()
    return
  }
  if (winKeyHookTargetWin !== win) return
  winKeyHookStopTimer = setTimeout(() => {
    winKeyHookTargetWin = null
    stopWinKeyHook()
  }, 150)
}

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

  liveWin.__liveSessionMode = params.mode
  liveSessionWindows.add(liveWin)
  liveWin.on('minimize', broadcastNormalWindowVisibility)
  liveWin.on('restore', broadcastNormalWindowVisibility)
  liveWin.on('show', broadcastNormalWindowVisibility)
  liveWin.on('focus', () => updateWinKeyHookTarget(liveWin, true))
  liveWin.on('blur', () => updateWinKeyHookTarget(liveWin, false))

  // setMenu(null) (não só setMenuBarVisibility(false)): Electron cria um menu
  // PADRÃO automaticamente quando nenhum é definido (Edit > Paste com
  // acelerador Ctrl+V, entre outros) -- setMenuBarVisibility só esconde a
  // BARRA visualmente, o acelerador nativo continua ativo e intercepta
  // Ctrl+V ANTES do keydown chegar no DOM/React desta janela. Achado ao vivo
  // 05/11/2026: Ctrl+V na sessão Normal nunca disparava nosso onKeyDown
  // (zero erro no console -- o código simplesmente nunca rodava), caindo no
  // role 'paste' padrão do Electron em vez da interceptação de
  // clipboard-paste (LiveSessionWindow.jsx). setMenu(null) remove o menu
  // inteiro (barra + aceleradores), não só a visibilidade.
  liveWin.setMenu(null)
  liveWin.setMenuBarVisibility(false)

  // setMenu(null) acima também remove o atalho padrão de DevTools (F12/
  // Ctrl+Shift+I), que no Electron vem do menu da aplicação — efeito
  // colateral não intencional do fix de Ctrl+V acima, achado ao vivo
  // 11/11/2026 (André não conseguia abrir o DevTools pra diagnosticar um
  // bug real de transferência de arquivo). Religa só o atalho de DevTools
  // via before-input-event, sem trazer de volta o menu inteiro (que
  // reintroduziria o acelerador de Paste que causava o bug original de
  // Ctrl+V). preventDefault só nesse atalho específico — qualquer outra
  // tecla segue intacta pro keydown/keyup normal do React (captura/injeção
  // de input remoto, EMERGENCY_RELEASE_KEYCODES, etc.), sem interferência.
  liveWin.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const isDevToolsShortcut = input.key === 'F12' ||
      (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (isDevToolsShortcut) {
      event.preventDefault()
      liveWin.webContents.toggleDevTools()
    }
  })

  if (IS_DEV) {
    liveWin.loadURL('http://localhost:5173')
  } else {
    liveWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  liveWin.webContents.once('did-finish-load', () => {
    liveWin.webContents.send('live-session-init', params)
    broadcastNormalWindowVisibility()
  })

  // Fechar a janela (X) é equivalente a "Encerrar sessão" (decisão da spec
  // 2026-10-24) — mas não fecha na hora: pede pro renderer limpar primeiro
  // (parar gravação em andamento + POST /stop), só destrói a janela quando
  // ele confirmar via 'live-session-cleanup-done'. Sem isso, o companion
  // continuaria transmitindo sem ninguém olhando, e uma gravação em
  // andamento seria descartada sem perguntar.
  //
  // __cleanupStarted evita mandar 'live-session-cleanup-and-close' de novo
  // se o usuário insistir no X enquanto o cleanup já está em andamento —
  // sem isso o renderer reiniciaria o heartbeat a cada clique repetido.
  liveWin.on('close', (event) => {
    if (liveWin.__cleanupDone) return
    event.preventDefault()
    if (!liveWin.__cleanupStarted) {
      liveWin.__cleanupStarted = true
      liveWin.webContents.send('live-session-cleanup-and-close')
    }
    armCleanupSafetyTimer(liveWin)
  })

  liveWin.on('closed', () => {
    liveSessionWindows.delete(liveWin)
    updateWinKeyHookTarget(liveWin, false)
    broadcastNormalWindowVisibility()
  })

  liveWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  return liveWin
}

// Rede de segurança do cleanup ao fechar a janela de sessão ao vivo: se o
// renderer nunca confirmar (fechou antes do React montar, preload falhou,
// travou de verdade), a janela ficaria IMPOSSÍVEL de fechar pra sempre —
// event.preventDefault() já bloqueou o close, e nada mais chamaria
// cleanupDone(). Um timeout fixo curto, porém, força o fechamento mesmo com
// o cleanup legitimamente em andamento — ex: operador decidindo onde salvar
// a gravação no dialog.showSaveDialog, que pode levar bem mais que alguns
// segundos — perdendo a gravação em silêncio (achado 🔴 da revisão
// cross-cutting independente). Por isso o timer é REARMADO a cada
// 'live-session-cleanup-progress' que o renderer manda enquanto está de
// fato trabalhando (ver LiveSessionWindow.jsx, heartbeat de 4s durante o
// cleanup) — só expira de verdade se o renderer parar de responder por
// completo (travado/morto), não enquanto espera decisão humana.
const CLEANUP_SAFETY_TIMEOUT_MS = 15000

function armCleanupSafetyTimer(liveWin) {
  clearTimeout(liveWin.__cleanupSafetyTimer)
  liveWin.__cleanupSafetyTimer = setTimeout(() => {
    if (!liveWin.isDestroyed() && !liveWin.__cleanupDone) {
      liveWin.__cleanupDone = true
      liveWin.close()
    }
  }, CLEANUP_SAFETY_TIMEOUT_MS)
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
    // Bloqueia UNC paths explícitos (\\server\share ou //server/share) —
    // regex em vez de startsWith pega barra misturada também (ver
    // file:read, mesmo achado de code review aplicado aqui por consistência)
    if (/^[\\/]{2}/.test(folderPath)) return

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

  // IPC: download de arquivo -- pasta Downloads por padrão (sem dialog),
  // ou targetDir explícito (navegador de arquivos dual-pane, ver
  // pendingDownloads acima e o 'will-download' que consome isto).
  // BrowserWindow.fromWebContents(event.sender) -- NUNCA a `win` fixa
  // deste closure (bug real ao vivo 13/11/2026, ver comentário completo
  // em pendingDownloads): quem chama este IPC pode ser a janela PRINCIPAL
  // (relatório, DANFE) OU uma janela de sessão ao vivo (Ctrl+C
  // remoto->local, "← Baixar") -- o download tem que voltar pra notificar
  // QUEM PEDIU, não sempre a principal.
  ipcMain.handle('download-file', (event, { url, targetDir }) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin || senderWin.isDestroyed()) return false
    pendingDownloads.set(url, { targetDir, win: senderWin })
    senderWin.webContents.downloadURL(url)
    return true
  })

  // IPC: abre o seletor de PASTA nativo do Windows -- botão "📂 Procurar
  // pasta..." no painel LOCAL do navegador de arquivos dual-pane
  // (FileBrowserModal.jsx). Só existe pro lado local: não tem como abrir o
  // Explorer DENTRO da sessão remota pra loja clicar -- a navegação remota
  // continua só por list-remote-dir (breadcrumb + duplo-clique).
  ipcMain.handle('pick-local-folder', async (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(senderWin, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // IPC: escreve um arquivo de verdade no clipboard do Windows (CF_HDROP)
  // -- fluxo Ctrl+C remoto->local do Acesso Remoto (ver
  // LiveSessionWindow.jsx): depois de baixar o arquivo copiado na loja,
  // isto deixa ele pronto pro operador colar (Ctrl+V) em QUALQUER app
  // local, inclusive fora do Delirio Manager -- o `clipboard` do Electron
  // (importado acima) só escreve texto/imagem, não arquivo, por isso
  // reusa winkeyhook.exe num modo one-shot separado do hook persistente
  // de teclado (ver dashboard/winkeyhook/clipboardwrite.go), via
  // child_process.execFile (espera terminar, não fica em pé como
  // startWinKeyHook).
  ipcMain.handle('clipboard-write-file', (_, filePath) => {
    // Achado 🟡 do code-reviewer: sem validar, qualquer chamador (bug
    // futuro no renderer) podia mandar escrever QUALQUER caminho local
    // acessível no clipboard do operador -- este fluxo só deveria tocar o
    // que ele MESMO acabou de baixar (sempre em Downloads, ver
    // downloadRemoteFileToLocalClipboard/handleFileTransferStatus,
    // LiveSessionWindow.jsx -- nunca passa targetDir).
    const downloadsDir = path.resolve(app.getPath('downloads'))
    const resolvedPath = path.resolve(filePath || '')
    if (resolvedPath !== downloadsDir && !resolvedPath.startsWith(downloadsDir + path.sep)) {
      return Promise.reject(new Error('Caminho fora da pasta Downloads -- recusado'))
    }
    const exePath = winkeyhookExePath()
    if (!fs.existsSync(exePath)) {
      return Promise.reject(new Error('winkeyhook.exe não encontrado, não dá pra escrever no clipboard'))
    }
    return new Promise((resolve, reject) => {
      execFile(exePath, ['--write-clipboard-file', filePath], { windowsHide: true }, (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message))
          return
        }
        resolve(true)
      })
    })
  })

  // Release automático do AGENT (build + /api/update/publish + /broadcast
  // via agent/release-auto.ps1) -- botão "🚀 Release Agent", App.jsx. So
  // funciona nesta maquina (precisa do repo + toolchain Go instalados),
  // por isso caminho absoluto fixo em vez de relativo a __dirname (que
  // aponta pro app.asar quando empacotado, não pro repo fonte).
  const RELEASE_AUTO_SCRIPT = 'F:\\RichClub\\agent\\release-auto.ps1'
  let releaseAutoRunning = false

  ipcMain.handle('agent-release-auto:run', (event) => {
    if (releaseAutoRunning) {
      return Promise.reject(new Error('Ja tem um release em andamento -- espera terminar.'))
    }
    if (!fs.existsSync(RELEASE_AUTO_SCRIPT)) {
      return Promise.reject(new Error(`Script nao encontrado em ${RELEASE_AUTO_SCRIPT} -- esse botao so funciona na maquina com o repo clonado.`))
    }
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    releaseAutoRunning = true
    return new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RELEASE_AUTO_SCRIPT],
        { windowsHide: true })
      let tail = ''
      const onData = (d) => {
        const text = d.toString()
        tail = (tail + text).slice(-2000)
        senderWin?.webContents.send('agent-release-auto:progress', text)
      }
      proc.stdout.on('data', onData)
      proc.stderr.on('data', onData)
      proc.on('error', (err) => { releaseAutoRunning = false; reject(err) })
      proc.on('close', (code) => {
        releaseAutoRunning = false
        if (code === 0) resolve({ ok: true })
        else reject(new Error(`release-auto.ps1 saiu com codigo ${code}:\n${tail}`))
      })
    })
  })

  // listWindowsDrives enumera as unidades existentes (C:\, D:\, etc.) --
  // usado quando list-local-dir recebe THIS_PC_SENTINEL em vez de um
  // caminho de verdade. fs.access (não readdir) só confirma existência,
  // sem ler conteúdo -- mais barato pra 26 tentativas, a maioria vazia.
  async function listWindowsDrives() {
    const entries = []
    for (let i = 65; i <= 90; i++) {
      const letter = `${String.fromCharCode(i)}:\\`
      try {
        await fs.promises.access(letter)
        entries.push({ name: letter, isDir: true, size: 0, modTime: null })
      } catch { /* unidade nao existe ou sem midia (ex: leitor de CD vazio) -- pula */ }
    }
    return entries
  }

  // IPC: lista um diretório LOCAL (do ponto de vista do operador) --
  // painel esquerdo do navegador de arquivos dual-pane (FileBrowserModal.jsx),
  // espelho de list-remote-dir (agent/filetransfer_windows.go). dirPath
  // vazio abre na área de trabalho do operador; THIS_PC_SENTINEL lista as
  // unidades disponíveis em vez de uma pasta de verdade (Andre pediu pra
  // dar pra navegar entre TODAS as unidades, não só a árvore do Desktop).
  //
  // isInsideSensitiveAppDir + bloqueio de UNC: achado 🟠 do code-reviewer
  // -- esta rota lia QUALQUER caminho sem a mesma guarda que file:read já
  // usa (definida abaixo, hoisted) pra impedir um renderer comprometido de
  // enumerar app.getPath('userData') (onde mora o config.json/adminSecret
  // do Dashboard, achado 🔴 CRÍTICO em revisão anterior deste arquivo) --
  // listar nomes/tamanhos já seria o suficiente pra reconhecimento, sem
  // precisar nem ler o conteúdo. UNC bloqueado pelo mesmo motivo de
  // file:read: fs.readdir num caminho \\host\share dispara handshake SMB
  // de saída (vazamento de credencial NTLM) se o host não for confiável.
  ipcMain.handle('list-local-dir', async (_, dirPath) => {
    if (dirPath === THIS_PC_SENTINEL) {
      return { path: THIS_PC_SENTINEL, entries: await listWindowsDrives() }
    }
    const target = dirPath || app.getPath('desktop')
    if (/^[\\/]{2}/.test(target)) {
      return { path: target, error: 'Caminho de rede (UNC) não é permitido' }
    }
    const resolvedTarget = path.resolve(target)
    if (isInsideSensitiveAppDir(resolvedTarget)) {
      return { path: target, error: 'Listagem recusada: caminho dentro dos diretórios internos do app' }
    }

    let dirents
    try {
      dirents = await fs.promises.readdir(resolvedTarget, { withFileTypes: true })
    } catch (err) {
      return { path: target, error: err.message }
    }

    // Ordena ANTES de cortar pelo teto -- achado 🟠 do code-reviewer:
    // fs.readdir não garante NENHUMA ordem específica (diferente do Go,
    // que ao menos devolve alfabético bruto) -- cortar antes de reordenar
    // "pastas primeiro" descartava entradas de forma essencialmente
    // arbitrária/inconsistente entre chamadas numa pasta grande. Ordenar
    // os Dirent crus (isDirectory()/name, sem stat ainda) é barato -- só
    // faz stat() nos que sobrarem depois do corte.
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    // Mesmo teto do lado remoto (maxRemoteDirEntries, agent/filetransfer_windows.go)
    // -- uma pasta com dezenas de milhares de arquivos não pode travar a
    // UI tentando renderizar tudo de uma vez.
    const maxLocalDirEntries = 2000
    const survivors = dirents.slice(0, maxLocalDirEntries)

    // stat() em paralelo (achado 🟡 do code-reviewer) -- sequencial podia
    // levar segundos numa pasta grande ou unidade de rede lenta, já que
    // cada stat() esperava o anterior terminar antes de começar.
    const statted = await Promise.all(survivors.map(async (d) => {
      try {
        const stat = await fs.promises.stat(path.join(resolvedTarget, d.name))
        return { name: d.name, isDir: d.isDirectory(), size: stat.size, modTime: stat.mtime.toISOString() }
      } catch {
        return null // entrada ilegível (permissão, link quebrado) -- pulada, não derruba a listagem inteira
      }
    }))
    const entries = statted.filter(Boolean)

    return { path: resolvedTarget, entries }
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
    createLiveSessionWindow(sanitizeLiveSessionParams(params))
    return true
  })

  // IPC: contagem ATUAL de janelas Normal visíveis, puxada pelo renderer no
  // mount — o push (broadcastNormalWindowVisibility) sozinho não garante que
  // o listener já está montado a tempo de receber o primeiro envio logo
  // após did-finish-load (mesma classe de race já resolvida aqui pra update
  // via updater:get-pending, acima).
  ipcMain.handle('live-session:get-normal-window-visibility', () => ({
    visibleNormalCount: computeVisibleNormalCount(),
  }))

  // IPC: a janela de sessão confirmou que já limpou (parou gravação, avisou
  // o servidor) — agora pode fechar de verdade.
  ipcMain.on('live-session-cleanup-done', (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (senderWin && !senderWin.isDestroyed()) {
      clearTimeout(senderWin.__cleanupSafetyTimer)
      senderWin.__cleanupDone = true
      senderWin.close()
    }
  })

  // IPC: a janela de sessão avisa que o cleanup ainda está em andamento de
  // verdade — rearma a rede de segurança (armCleanupSafetyTimer) pra não
  // forçar o fechamento no meio de um trabalho legítimo.
  ipcMain.on('live-session-cleanup-progress', (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (senderWin && !senderWin.isDestroyed()) armCleanupSafetyTimer(senderWin)
  })

  // IPC: a janela de sessão avisa que o cleanup FALHOU (ex: api.live.stop
  // rejeitou por rede) — reseta __cleanupStarted pra o PRÓXIMO X da janela
  // reenviar 'live-session-cleanup-and-close' e tentar de novo. Sem isso
  // (achado 🔴 na revisão desta mudança, que removeu o botão "Encerrar
  // sessão"): __cleanupStarted nunca resetava, então um 2º clique no X só
  // rearmava o timer de segurança (sempre feito, ver liveWin.on('close')
  // abaixo) sem nunca reenviar o IPC — a única tentativa real ficava a
  // única, e a sessão acabava órfã no servidor quando o timeout de 15s
  // forçava o fechamento sem sucesso.
  ipcMain.on('live-session-cleanup-failed', (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (senderWin && !senderWin.isDestroyed()) senderWin.__cleanupStarted = false
  })

  // IPC: lê a área de transferência LOCAL do operador (nunca a da máquina
  // remota) — usado pelo Ctrl+V interceptado em LiveSessionWindow.jsx (modo
  // Normal) pra mandar o texto via clipboard-paste em vez de deixar o
  // navegador/Electron colar o clipboard da sessão remota por engano.
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())

  // IPC: lê o CAMINHO de um arquivo copiado (Ctrl+C no Explorer) da área de
  // transferência LOCAL do operador -- usado pelo Ctrl+V interceptado em
  // LiveSessionWindow.jsx pra oferecer uma 3ª via de transferência de
  // arquivo (além do botão e do arrastar-e-soltar), sem reabrir o dialog.
  // Explorer no Windows preenche o formato CF_HDROP (lista completa, só
  // acessível via parsing binário da struct DROPFILES) E, em paralelo, o
  // formato clássico "FileNameW" com o caminho UTF-16 do PRIMEIRO arquivo
  // copiado -- suficiente pro caso de suporte remoto (1 arquivo por vez,
  // igual ao botão/drag). clipboard.has/readBuffer são a API pública do
  // Electron pra formatos nativos arbitrários, sem precisar de módulo
  // nativo extra só pra isso.
  ipcMain.handle('clipboard:read-file-path', () => {
    if (!clipboard.has('FileNameW')) return null
    const raw = clipboard.readBuffer('FileNameW').toString('ucs2').replace(/\0+$/, '')
    return raw || null
  })

  // file:read não usa mais allowlist-de-origem (só path que passou pelo
  // dialog de file:pick) — achado pela revisão: isso quebraria o
  // arrastar-e-soltar (Task 10, plano em
  // docs/superpowers/plans/2026-11-11-file-transfer.md, ainda não
  // implementada aqui), que nunca passa pelo dialog — o .path de um File
  // arrastado do Explorer é definido pelo próprio Chromium a partir do
  // payload REAL de drag-and-drop do SO, e um script no renderer não
  // consegue forjar esse valor pra uma string arbitrária. Então não há
  // diferença de confiança real entre "veio do dialog" e "veio do drop":
  // os 2 são gesto genuíno do operador no SO. Defesa em profundidade em
  // vez da allowlist: nunca ler de dentro dos próprios diretórios internos
  // do app (instalação/recursos) — isso bloqueia o cenário real que a
  // allowlist também tentava cobrir (renderer comprometido lendo
  // .secrets/admin-secret.txt ou outro arquivo interno do app, achado 🔴
  // CRÍTICO na revisão anterior), sem quebrar nenhum dos 2 jeitos
  // legítimos de escolher um arquivo.
  //
  // Lista de diretórios sensíveis inclui app.getPath('userData') — é lá que
  // mora o CONFIG_PATH deste próprio arquivo (adminSecret em produção, ver
  // CLAUDE.md "Onde fica o ADMIN_SECRET") — faltava antes (🔴 CRÍTICO achado
  // em code review, confirmado por execução direta: um renderer comprometido
  // conseguia ler o config.json do Dashboard via file:read, bypassando
  // completamente essa checagem). A comparação case-insensitive (NTFS não
  // diferencia maiúscula/minúscula) fica em sensitiveDirGuard.js, extraído
  // pra módulo próprio testável sem mockar Electron (mesmo padrão de
  // liveSessionRegistry.js/countVisibleNormalWindows).
  function isInsideSensitiveAppDir(resolvedPath) {
    const sensitiveDirs = [
      app.getAppPath(),
      process.resourcesPath,
      __dirname,
      app.getPath('userData'),
    ]
    return isInsideSensitiveDir(resolvedPath, sensitiveDirs)
  }

  // Limite de tamanho antes de carregar o arquivo inteiro em memória no
  // processo principal (que também serve todas as outras janelas do
  // Dashboard) — sem isso, um arquivo gigante travaria/estouraria memória
  // pro app inteiro, não só a janela de sessão ao vivo (achado 🟠 ALTO na
  // revisão). 2GB — reconciliado com o limite já documentado no lado
  // servidor (blobSas.js MAX_FILE_BYTES); a parede de 500MB anterior
  // bloqueava em silêncio, sem explicação nenhuma pro operador, qualquer
  // arquivo válido entre 500MB e 2GB (achado na revisão).
  const MAX_FILE_READ_BYTES = 2 * 1024 * 1024 * 1024

  // IPC: lê o conteúdo do arquivo local arrastado (drag-and-drop) ou
  // selecionado no navegador de arquivos dual-pane (FileBrowserModal.jsx),
  // pra upload pro Blob. Qualquer caminho absoluto é aceito — a defesa
  // real é isInsideSensitiveAppDir acima, não a origem do path.
  ipcMain.handle('file:read', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new Error('Caminho de arquivo inválido')
    }
    // path.isAbsolute considera UNC path (\\server\share\x) absoluto também —
    // bloqueia explícito, pra não disparar handshake SMB de saída
    // (vazamento de credencial NTLM) a partir de um path que um renderer
    // comprometido poderia fornecer. Regex (não startsWith('\\\\')/('//'))
    // pega barra misturada tipo '\/server/share/x' ou '/\\server/share/x'
    // também — path.resolve normaliza qualquer uma dessas pra UNC de
    // verdade, e um startsWith só-barra-dupla-do-mesmo-tipo não via isso
    // (achado real de code review, bypass confirmado por execução direta).
    if (/^[\\/]{2}/.test(filePath)) {
      throw new Error('Caminho de rede (UNC) não é permitido')
    }
    const resolvedPath = path.resolve(filePath)
    if (isInsideSensitiveAppDir(resolvedPath)) {
      throw new Error('Leitura recusada: caminho dentro dos diretórios internos do app')
    }
    const fs = require('fs/promises')
    const stat = await fs.stat(resolvedPath)
    if (stat.size > MAX_FILE_READ_BYTES) {
      throw new Error(`Arquivo muito grande (${Math.round(stat.size / 1024 / 1024)}MB, limite ${MAX_FILE_READ_BYTES / 1024 / 1024}MB)`)
    }
    const buf = await fs.readFile(resolvedPath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
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
    } catch (err) {
      // Em erro, o ffmpeg pode ter escrito mp4Path parcialmente antes de
      // falhar — sem isso, ficava órfão em app.getPath('temp') pra sempre a
      // cada conversão que falhasse (achado 🟠 da revisão cross-cutting).
      fs.unlink(mp4Path, () => {})
      throw err
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

// Mata o winkeyhook de forma SÍNCRONA no quit -- achado 🔴 do
// code-reviewer (12/11/2026): o encerramento normal (fechar a última
// janela Normal enquanto focada) dispara 'closed' (agenda o debounce de
// 150ms) e, no mesmo ciclo, window-all-closed→app.quit() -- o processo
// Electron costuma encerrar ANTES do timer disparar, deixando
// winkeyhook.exe órfão com o hook WH_KEYBOARD_LL ainda instalado: a
// tecla Windows (+R/E/D) do PRÓPRIO operador ficaria morta globalmente
// até alguém matar o processo manualmente ou reiniciar -- o mesmo tipo
// de incidente ("tecla presa") que este fix existe pra evitar, agora do
// lado local. before-quit roda sempre antes do processo encerrar de
// verdade, sem depender do debounce.
app.on('before-quit', () => {
  clearTimeout(winKeyHookStopTimer)
  stopWinKeyHook()
})
