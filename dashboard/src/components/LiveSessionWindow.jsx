import { useState, useEffect, useRef, useCallback } from 'react'
import { useLiveSession } from '../hooks/useLiveSession'
import { useNormalWindowVisibility } from '../hooks/useNormalWindowVisibility'
import { api, setServerUrl, setAdminSecret } from '../api'

const MOUSE_BUTTON = { 0: 'left', 2: 'right' }

const VK_LWIN = 91
const VK_RWIN = 92

// Ctrl (esquerdo) + 'V' — mesmos VKs de EMERGENCY_RELEASE_KEYCODES/onKeyDown.
const VK_CONTROL = 17
const VK_V = 86

// Lista fixa pro botão de emergência "Liberar teclas travadas" — não
// depende do rastreamento de heldKeysRef (que só sabe o que ESTA janela
// viu desde que foi aberta); solta por garantia as modificadoras mais
// perigosas de travar, mesmo que o keydown tenha acontecido antes da
// sessão atual ou por um caminho que o rastreamento não previu.
const EMERGENCY_RELEASE_KEYCODES = [91, 92, 17, 162, 163, 18, 164, 165, 16, 160, 161]

// WIN_COMBO_VK traduz os eventos que o winkeyhook manda ("win+r" etc, ver
// electron/main.js) pro keyCode da tecla que acompanha Win -- mesmos
// valores que o VK_* do Win32 e o keyCode que o navegador usa pra letras
// (82='R', 69='E', 68='D'), sem precisar de tradução adicional.
const WIN_COMBO_VK = { 'win+r': 82, 'win+e': 69, 'win+d': 68 }

export function LiveSessionWindow() {
  const [session, setSession] = useState(null) // { sessionId, machineId, mode, dashboardToken, serverUrl }
  const [status, setStatus] = useState('connecting')
  // statusRef: leitura síncrona de status dentro dos listeners de
  // teclado (window.addEventListener, registrados 1x por sessão/modo, não
  // por mudança de status — ver efeito de onKeyDown/onKeyUp abaixo) sem
  // precisar incluir `status` na dependência do efeito, o que
  // reatacharia os listeners a cada reconexão (mesmo padrão de modeRef em
  // useLiveSession.js).
  const statusRef = useRef(status)
  statusRef.current = status
  const [recording, setRecording] = useState(false)
  const [inputLocked, setInputLocked] = useState(false)
  // remoteUser chega pelo WS (session-info, mandado 1x pelo companion no
  // início da sessão) -- nunca pelo IPC live-session-init, que não carrega
  // esse campo (achado real 12/11/2026: session.remoteUser era lido mas
  // NUNCA setado em lugar nenhum, defaultDestDir sempre caía no fallback
  // literal "Loja", que quase nunca batia com o usuário de verdade logado
  // na loja). null até a mensagem chegar -- nesse meio-tempo o placeholder
  // abaixo pede confirmação em vez de mentir um caminho provavelmente errado.
  const [remoteUser, setRemoteUser] = useState(null)
  const handleSessionInfo = useCallback((msg) => { setRemoteUser(msg.remoteUser) }, [])
  const [recordingSecs, setRecordingSecs] = useState(0)
  const canvasRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const recordingTimerRef = useRef(null)
  const startedAtRef = useRef(null)
  const sessionRef = useRef(null)
  const recordingSecsRef = useRef(0)
  const endSessionPromiseRef = useRef(null)
  const stoppingRef = useRef(null)
  const wasRecordingRef = useRef(false)
  const [ending, setEnding] = useState(false)
  const [closeError, setCloseError] = useState(null)
  const [recordingError, setRecordingError] = useState(null)

  sessionRef.current = session
  recordingSecsRef.current = recordingSecs

  const [fileDestDir, setFileDestDir] = useState('')
  const [fileTransferProgress, setFileTransferProgress] = useState(null) // {bytesReceived, bytesTotal} | 'error: ...' | 'done' | null
  // Guarda se já existe uma transferência em andamento — tanto o upload pro
  // Blob (síncrono do ponto de vista desta função) quanto o download real na
  // máquina remota (assíncrono, só termina quando handleFileTransferStatus
  // recebe file-transfer-done/-error pelo WS). transferringRef é checado
  // sincronamente (não a state, que só atualiza no próximo render) pra
  // bloquear de verdade um 2º clique/drop disparado antes do primeiro
  // terminar — sem isso, 2 transferências concorrentes compartilhariam o
  // mesmo fileTransferProgress/handleFileTransferStatus e cada WS msg
  // (progress/done/error) sobrescreveria o estado da outra, além de
  // disparar 2 uploads + 2 comandos file-transfer sem necessidade
  // (achado 🟠 do code-reviewer).
  const transferringRef = useRef(false)
  const [isTransferring, setIsTransferring] = useState(false)

  const handleFileTransferStatus = useCallback((msg) => {
    if (msg.type === 'file-transfer-progress') {
      setFileTransferProgress({ bytesReceived: msg.bytesReceived, bytesTotal: msg.bytesTotal })
    } else if (msg.type === 'file-transfer-done') {
      setFileTransferProgress('done')
      transferringRef.current = false
      setIsTransferring(false)
    } else if (msg.type === 'file-transfer-error') {
      setFileTransferProgress('error: ' + msg.message)
      transferringRef.current = false
      setIsTransferring(false)
    }
  }, [])

  const { sendInput, sendMouseEvent, sendKeyEvent, sendClipboardPaste, sendFileTransfer } = useLiveSession({
    serverUrl: session?.serverUrl,
    sessionId: session?.sessionId,
    dashboardToken: session?.dashboardToken,
    mode: session?.mode,
    canvasRef,
    onStatusChange: setStatus,
    onFileTransferStatus: handleFileTransferStatus,
    onSessionInfo: handleSessionInfo,
  })

  // Enquanto remoteUser ainda não chegou (session-info é mandado 1x, pode
  // levar um instante ou nunca chegar — agent antigo sem essa versão), o
  // placeholder do campo de destino (abaixo, no JSX) pede pro operador
  // confirmar o caminho em vez de mostrar um default provavelmente errado.
  const defaultDestDir = remoteUser ? `C:\\Users\\${remoteUser}\\Desktop` : ''

  // sendLocalFileToRemote é o caminho ÚNICO pra transferência de arquivo —
  // tanto o botão "Enviar arquivo" (handlePickFile) quanto o drop na janela
  // (handleDrop) terminam aqui, pra não duplicar a lógica de upload+comando.
  const sendLocalFileToRemote = useCallback(async (localPath, fileNameHint) => {
    // Ignora silenciosamente um 2º clique/drop enquanto a transferência
    // anterior ainda não terminou (upload pro Blob OU download remoto) —
    // ver comentário em transferringRef acima.
    if (transferringRef.current) return
    // Sem conexão ativa (status !== 'connected'): sendFileTransfer (via
    // sendInput) faria no-op silencioso no WS fechado, e nenhum
    // file-transfer-done/-error nunca chegaria pra destravar isTransferring
    // — ficaria preso "transferindo" pra sempre. O botão já fica desabilitado
    // nesse estado, mas um arrastar-e-soltar não passa por esse disabled,
    // então a checagem tem que estar aqui, não só na UI do botão.
    if (status !== 'connected') {
      setFileTransferProgress('error: sem conexão com a sessão ao vivo')
      return
    }
    // Sem destino nenhum (nem digitado pelo operador, nem o default —
    // remoteUser ainda não chegou via session-info): melhor recusar aqui
    // do que mandar destDir vazio pro companion (que faria MkdirAll("")
    // falhar só no lado remoto, sem o operador saber por quê).
    // .trim(): um valor só com espaço(s) digitado por engano é truthy em JS
    // -- sem o trim, passava o guard abaixo como se fosse um destino válido
    // e ia pro companion, que cria o diretório " " em vez de recusar (achado
    // do code-reviewer, 12/11/2026).
    const destDir = fileDestDir.trim() || defaultDestDir
    if (!destDir) {
      setFileTransferProgress('error: confirme o caminho de destino antes de enviar')
      return
    }
    transferringRef.current = true
    setIsTransferring(true)
    const fileName = fileNameHint || localPath.split(/[\\/]/).pop()
    setFileTransferProgress({ bytesReceived: 0, bytesTotal: 0 })
    try {
      const fileBuffer = await window.electronAPI.readLocalFile(localPath)
      const { uploadUrl, downloadUrl } = await api.live.getFileUploadUrl(session.sessionId, fileName, fileBuffer.byteLength)
      const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob' }, body: fileBuffer })
      if (!putRes.ok) {
        // Diagnostico temporario (11/11/2026): mensagem generica nao dava pra
        // saber POR QUE o Azure recusou (CORS? SAS expirada/invalida? 403?) --
        // inclui status + corpo da resposta (Azure devolve XML com
        // <Code>/<Message> explicando o motivo real).
        const bodyText = await putRes.text().catch(() => '(sem corpo)')
        setFileTransferProgress(`error: falha ao subir pro Blob (HTTP ${putRes.status}): ${bodyText.slice(0, 300)}`)
        transferringRef.current = false
        setIsTransferring(false)
        return
      }
      sendFileTransfer(downloadUrl, fileName, destDir)
      // transferringRef/isTransferring continuam true daqui até
      // handleFileTransferStatus receber file-transfer-done/-error — o
      // upload pro Blob terminou aqui, mas o download na máquina remota
      // ainda está em andamento nesse ponto.
    } catch (err) {
      // err?.message, não err.message: uma rejeição sem Error de verdade
      // (ex: IPC rejeitando com algo não padronizado) lançaria TypeError
      // aqui dentro, sem handler, travando isTransferring=true pra sempre —
      // mesmo padrão de bug já corrigido em stopRecordingIfActive/
      // onCleanupAndClose neste mesmo arquivo (achado 🟠 do code-reviewer).
      setFileTransferProgress('error: ' + (err?.message || 'falha ao enviar arquivo'))
      transferringRef.current = false
      setIsTransferring(false)
    }
  }, [session, fileDestDir, defaultDestDir, sendFileTransfer, status])

  const handlePickFile = useCallback(async () => {
    const localPath = await window.electronAPI.pickFile()
    if (!localPath) return
    sendLocalFileToRemote(localPath)
  }, [sendLocalFileToRemote])

  // handleDrop só repassa pra sendLocalFileToRemote (mesma lógica do
  // botão) — o guard de mode aqui é a ÚNICA barreira contra um drop em
  // Shadow virar comando: o onDrop/onDragOver no JSX abaixo está no
  // elemento raiz sempre renderizado, sem condicional por mode, então é
  // este `if` dentro da função que decide, não o wrapper.
  //
  // file.path no objeto File arrastado foi REMOVIDO a partir do Electron
  // 32 (breaking change oficial) — webUtils.getPathForFile (exposto via
  // preload.js) é a ponte suportada pra pegar o caminho local real.
  const handleDrop = useCallback(async (e) => {
    e.preventDefault()
    if (session?.mode !== 'normal') return
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    // getPathForFile tem seu próprio try/catch (não o try/catch de
    // sendLocalFileToRemote, que só começa DEPOIS desta linha) — sem isso,
    // uma rejeição aqui vira unhandled rejection silenciosa, mesma classe
    // de bug já corrigida antes neste arquivo (stopRecordingIfActive,
    // onCleanupAndClose).
    try {
      const localPath = await window.electronAPI.getPathForFile(file)
      sendLocalFileToRemote(localPath, file.name)
    } catch (err) {
      setFileTransferProgress('error: ' + (err?.message || 'falha ao resolver o arquivo arrastado'))
    }
  }, [session, sendLocalFileToRemote])

  // dropEffect: achado real (13/11/2026) — preventDefault() sozinho no
  // dragover é o suficiente pra um drag INTERNO da própria página HTML5,
  // mas um arquivo real vindo do Explorer é um drag OLE do próprio Windows,
  // que o Chromium embute via IDropTarget nativo: sem setar dropEffect
  // explicitamente aqui, ele fica 'none' (default), e o Windows trata isso
  // como "não pode soltar aqui" NO NÍVEL DO SO -- o cursor mostra o ícone
  // de bloqueio sobre a janela inteira (não só o canvas) e o 'drop' nunca
  // chega a disparar, mesmo com preventDefault(). André relatou exatamente
  // isso ("nem consegue entrar no frame", nas duas direções) -- sintoma
  // clássico de dropEffect nunca setado, não um bug no handler de drop em
  // si (que nunca chegava a ser chamado). Só é setado quando o drag carrega
  // arquivo(s) de verdade
  // (dataTransfer.types inclui 'Files') — achado do code-reviewer: setar
  // incondicionalmente faz QUALQUER drag sobre a janela (texto selecionado,
  // imagem de outra página) mostrar o cursor de "copiar" mesmo quando o
  // handleDrop não faz nada com esse conteúdo (ele só lê
  // e.dataTransfer.files).
  // pasteClipboardToRemote resolve o Ctrl+V interceptado em onKeyDown: 3ª
  // via de transferência de arquivo (Ctrl+C no Explorer → Ctrl+V aqui,
  // mesmo caminho do botão/drag) com fallback pro paste de texto já
  // existente. Extraída do onKeyDown pra não aumentar ainda mais a
  // complexidade ciclomática dessa função (já trata vários atalhos/teclas)
  // — achado do code-reviewer. transferringRef.current também é checado
  // AQUI, antes de sequer ler o clipboard: sendLocalFileToRemote já tem
  // essa guarda no início de si mesma, mas só depois do round-trip IPC de
  // readClipboardFilePath -- dois Ctrl+V físicos rápidos disparariam 2
  // leituras de clipboard concorrentes antes da 1ª guarda interna rodar,
  // arriscando 2 uploads do mesmo arquivo (achado 🟠 do code-reviewer).
  const pasteClipboardToRemote = useCallback(() => {
    if (transferringRef.current) return
    window.electronAPI?.readClipboardFilePath().then((filePath) => {
      if (filePath) {
        sendLocalFileToRemote(filePath).catch((err) => {
          console.error('Falha ao enviar arquivo colado pra sessão remota:', err)
        })
        return
      }
      window.electronAPI?.readClipboardText().then((text) => {
        if (!text) return
        sendClipboardPaste(text)
        // injectClipboardPaste solta Ctrl no remoto ao final da sequência
        // sintética — se o operador ainda está segurando Ctrl fisicamente
        // (comum: Ctrl+V é 2 teclas, Ctrl já desceu antes), reafirma o
        // keydown pra não dessincronizar o estado local/remoto.
        if (heldKeysRef.current.has(VK_CONTROL)) sendKeyEvent('keydown', VK_CONTROL)
      }).catch((err) => {
        console.error('Falha ao ler clipboard local pra colar na sessão remota:', err)
      })
    }).catch((err) => {
      console.error('Falha ao checar arquivo no clipboard local:', err)
    })
  }, [sendLocalFileToRemote, sendClipboardPaste, sendKeyEvent])

  const acceptFileDrag = useCallback((e) => {
    e.preventDefault()
    if (e.dataTransfer.types?.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onLiveSessionInit((data) => setSession(data))
    return unsubscribe
  }, [])

  // Cada BrowserWindow é um processo/renderer separado, com sua PRÓPRIA
  // instância do módulo api.js (serverUrl/adminSecret começam vazios aqui,
  // mesmo que já configurados na janela principal) — achado em produção:
  // "Encerrar sessão" sempre dava 401 (X-Admin-Secret inválido), mesmo
  // logo depois de "Shadow"/"Normal" terem funcionado (esses passam pelo
  // MachineCard, na janela PRINCIPAL, cujo api.js está configurado).
  // Carrega a mesma config.json que a janela principal usa, pra esta
  // janela também mandar o header certo em api.live.stop.
  useEffect(() => {
    window.electronAPI?.getConfig().then((cfg) => {
      if (cfg?.serverUrl) setServerUrl(cfg.serverUrl)
      if (cfg?.adminSecret) setAdminSecret(cfg.adminSecret)
    }).catch(() => {})
  }, [])

  // O BrowserWindow nasce com title: 'Delirio Manager — Sessão ao vivo'
  // (main.js), mas o Electron sobrescreve o título da janela com
  // document.title assim que a página termina de carregar — como esta
  // janela carrega o MESMO dist/index.html da janela principal
  // (<title>Delirio Manager</title>), o título visível virava só "Delirio
  // Manager", sem distinguir das outras janelas abertas.
  useEffect(() => {
    document.title = 'Delirio Manager — Sessão ao vivo'
  }, [])

  // stopRecordingIfActive/endSession leem sessionRef/recordingSecsRef (não
  // session/recordingSecs direto) pra poderem ser estáveis (sem recriar a
  // cada mudança de estado) e ainda assim ler o valor mais recente — usadas
  // dentro do listener de IPC (onCleanupAndClose), que só se inscreve 1x.
  //
  // stoppingRef guarda a fila de conversões pendentes — achado 🔴 da 5ª
  // rodada de verificação: parar a gravação manualmente (toggleRecording,
  // fire-and-forget) e fechar a janela (X) logo depois, antes da
  // conversão/dialog de salvar terminar, fazia a chamada de dentro de
  // endSession ver mediaRecorderRef.current já null (zerado sincronamente
  // pela 1ª chamada) e retornar na hora — endSession seguia pra
  // api.live.stop/cleanupDone() e fechava a janela enquanto o ffmpeg/dialog
  // da 1ª chamada ainda rodavam contra ela, perdendo a gravação em
  // silêncio.
  //
  // Checar mediaRecorderRef.current ANTES de stoppingRef.current (não o
  // contrário) é o que importa aqui — achado 🔴 da 6ª rodada de
  // verificação: checar stoppingRef primeiro faria uma 2ª gravação (B),
  // começada enquanto a conversão de uma 1ª (A) ainda está rodando, nunca
  // ser parada de verdade — stopRecordingIfActive devolveria a promise
  // velha de A sem nunca tocar em B, perdendo B em silêncio quando a
  // sessão encerrar. recorder.stop() de quem está ativo AGORA roda sempre
  // na hora (flush imediato, não espera fila); só a conversão (ffmpeg +
  // convertRecording) é encadeada atrás de qualquer conversão anterior
  // ainda pendente — nunca 2 conversões concorrentes, e a promise
  // devolvida representa "todas as paradas pendentes até aqui".
  const stopRecordingIfActive = useCallback(() => {
    const current = mediaRecorderRef.current
    if (!current) {
      return stoppingRef.current ?? Promise.resolve()
    }

    mediaRecorderRef.current = null
    clearInterval(recordingTimerRef.current)
    setRecording(false)

    const { recorder, chunks } = current
    const metadata = {
      machineId: sessionRef.current?.machineId,
      mode: sessionRef.current?.mode,
      startedAt: startedAtRef.current,
      endedAt: new Date().toISOString(),
      durationSec: recordingSecsRef.current,
    }

    const stopped = new Promise((resolve) => { recorder.onstop = resolve })
    recorder.stop()

    // convertThisRecording NUNCA pode rejeitar — é o invariante que a fila
    // em stoppingRef depende pra sempre drenar: como chainedB encadeia via
    // previous.then(convertB) (linha abaixo), uma rejeição aqui se
    // propagaria pela cadeia inteira sem handler, e qualquer conversão já
    // enfileirada atrás desta nunca rodaria — perdida em silêncio, sem
    // nem setar recordingError pra ela (achado 🟠 da 7ª rodada de
    // verificação: o try/catch cobria só convertRecording, não new
    // Blob/blob.arrayBuffer logo acima, que também podem lançar/rejeitar).
    const convertThisRecording = async () => {
      try {
        await stopped
        const blob = new Blob(chunks, { type: 'video/webm' })
        const arrayBuffer = await blob.arrayBuffer()
        await window.electronAPI.convertRecording(arrayBuffer, metadata)
      } catch (err) {
        // Falha em qualquer parte da conversão (ffmpeg) não pode travar o
        // encerramento da sessão nem a fila — sem o catch, endSession
        // nunca chegaria em api.live.stop/cleanupDone, e fechar a janela
        // pareceria simplesmente não fazer nada.
        // A gravação se perde nesse caso, mas a sessão encerra e a fila
        // continua — e o operador vê o erro (recordingError), não só um
        // console.error silencioso.
        console.error('Falha ao converter gravação:', err)
        // err?.message, não err.message: uma rejeição sem motivo (ex:
        // Promise.reject() sem argumento) faria err.message lançar
        // TypeError aqui dentro, sem handler — reintroduzindo o exato
        // bug 🟠 que este fluxo corrigiu (fila trava, próximas gravações
        // nunca convertem). Achado 🟡 da 8ª rodada de verificação.
        setRecordingError(err?.message || 'falha ao salvar a gravação')
      }
    }

    const previous = stoppingRef.current ?? Promise.resolve()
    const chained = previous.then(convertThisRecording)
    stoppingRef.current = chained
    chained.finally(() => {
      // Só limpa se nada mais recente já tiver encadeado por cima
      // enquanto esta promise rodava (outra gravação pode ter começado e
      // parado nesse meio-tempo).
      if (stoppingRef.current === chained) stoppingRef.current = null
    })

    return chained
  }, [])

  // endSession só é disparado pelo X da janela (onCleanupAndClose, via
  // main.js) — guarda defensiva contra ser chamado mais de 1 vez (ex: o
  // listener de IPC disparando de novo antes do 1º terminar) chamaria
  // api.live.stop 2x pra mesma sessão sem isso. endSessionPromiseRef
  // guarda a MESMA promise entre chamadas: quem chama primeiro faz o
  // trabalho de verdade, qualquer chamada concorrente espera essa mesma
  // promise em vez de disparar um 2º stop.
  //
  // Em caso de falha (ex: api.live.stop rejeita por erro de rede), limpa
  // endSessionPromiseRef e `ending` antes de relançar — achado da verificação
  // da revisão cross-cutting: sem isso, a promise rejeitada ficava cacheada
  // pra sempre, travando o fechamento permanentemente (só o timeout de 15s
  // do main process acabava fechando a janela, sem nunca avisar o servidor
  // de verdade). Com o reset, uma nova tentativa (o main process reenviando
  // o cleanup) pode rodar o fluxo de novo.
  const endSession = useCallback(() => {
    if (!endSessionPromiseRef.current) {
      endSessionPromiseRef.current = (async () => {
        setEnding(true)
        try {
          // wasRecordingRef.current já reflete "gravou em algum momento
          // desta sessão" — setado no INÍCIO de toggleRecording (achado 🟠
          // da 4ª rodada: setar aqui, derivado de mediaRecorderRef.current,
          // ficava false se o operador tivesse parado a gravação manualmente
          // ANTES de encerrar a sessão — mediaRecorderRef já estaria null).
          // É pegajoso entre tentativas de endSession também (achado 🟠 da
          // 3ª rodada): stopRecordingIfActive zera mediaRecorderRef ANTES de
          // api.live.stop poder falhar, então recalcular a partir dele numa
          // 2ª tentativa (depois de uma 1ª falha de rede) sempre daria
          // false, mesmo tendo gravado.
          await stopRecordingIfActive()
          if (sessionRef.current?.sessionId) {
            await api.live.stop(sessionRef.current.sessionId, wasRecordingRef.current)
          }
        } catch (err) {
          endSessionPromiseRef.current = null
          setEnding(false)
          throw err
        }
      })()
    }
    return endSessionPromiseRef.current
  }, [stopRecordingIfActive])

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCleanupAndClose(async () => {
      // Heartbeat: avisa o main process (armCleanupSafetyTimer) que o
      // cleanup está de fato em andamento enquanto durar — sem isso, a
      // rede de segurança do main.js forçaria o fechamento da janela
      // ainda com a conversão/dialog de salvar em andamento, perdendo a
      // gravação em silêncio (achado 🔴 da revisão cross-cutting).
      window.electronAPI.reportCleanupProgress?.()
      const heartbeat = setInterval(() => window.electronAPI.reportCleanupProgress?.(), 4000)
      setCloseError(null)
      try {
        await endSession()
        window.electronAPI.cleanupDone()
      } catch (err) {
        // Falha ao encerrar via X da janela: não fecha sozinho, não chama
        // cleanupDone. reportCleanupFailed() avisa o main process (ver
        // main.js) pra resetar __cleanupStarted — sem isso, um 2º clique no
        // X só rearmava o timer de segurança, nunca reenviava o IPC de
        // cleanup, e a janela só fechava pelo timeout de 15s SEM nunca
        // avisar o servidor (sessão órfã). Com o reset, um novo X refaz o
        // fluxo (ending já foi resetado dentro de endSession).
        console.error('Falha ao encerrar sessão ao vivo:', err)
        setCloseError(err?.message || 'falha ao encerrar a sessão')
        window.electronAPI.reportCleanupFailed?.()
      } finally {
        clearInterval(heartbeat)
      }
    })
    return unsubscribe
  }, [endSession])

  function toggleRecording() {
    if (mediaRecorderRef.current) {
      stopRecordingIfActive().catch((err) => console.error('Falha ao parar gravação:', err))
      return
    }
    const canvas = canvasRef.current
    if (!canvas || typeof canvas.captureStream !== 'function') return
    const stream = canvas.captureStream(10)
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })
    const chunks = []
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.start()
    // { recorder, chunks } — não recorder._chunks: mutar a instância nativa
    // de MediaRecorder com um campo de app é code smell (achado 🔵 da 5ª
    // rodada de verificação); um objeto próprio evita isso sem perder o
    // dono-por-instância que elimina a mistura de chunks entre gravações.
    mediaRecorderRef.current = { recorder, chunks }
    // Setado aqui, não dentro de endSession: é o único momento que sabe de
    // verdade que uma gravação começou, independente de quando/se a sessão
    // vier a ser encerrada depois.
    wasRecordingRef.current = true
    setRecordingError(null)
    startedAtRef.current = new Date().toISOString()
    setRecordingSecs(0)
    setRecording(true)
    recordingTimerRef.current = setInterval(() => setRecordingSecs((s) => s + 1), 1000)
  }

  // Trava/libera o mouse/teclado FÍSICO do usuário local da loja, via
  // BlockInput no companion (ver input_windows.go) — evita o usuário da
  // loja brigar pelo cursor com o operador remoto durante o suporte.
  // Fire-and-forget (mesmo padrão de sendMouseEvent/sendKeyEvent): sem ack
  // do companion nesta v1, o estado do botão é otimista.
  function toggleInputLock() {
    const next = !inputLocked
    sendInput({ type: next ? 'lock-local-input' : 'unlock-local-input' })
    setInputLocked(next)
  }

  // status !== 'reconnecting' (não status === 'connected': 'connecting' é
  // o handshake inicial, onde sendInput/sendMouseEvent já no-opam sozinhos
  // via ws.readyState !== OPEN — sem bug nenhum ali, então sem motivo pra
  // alargar o guard e arriscar comportamento diferente nesse caso):
  // achado 🟡 do code-reviewer — durante 'reconnecting' especificamente
  // (companion caiu, mas o relay dá uma folga antes de matar a sessão, ver
  // liveSessionRelay.js) o socket dashboard↔servidor CONTINUA aberto
  // (diferente de 'connecting'), então sem este guard todo
  // clique/mousemove seria mandado de verdade e descartado em silêncio em
  // routeMessage (companionWs null) — sem nenhum feedback.
  function handleMouseDown(e) {
    if (session?.mode !== 'normal' || status === 'reconnecting') return
    sendMouseEvent('mousedown', e.clientX, e.clientY, MOUSE_BUTTON[e.button] || 'left')
  }
  function handleMouseUp(e) {
    if (session?.mode !== 'normal' || status === 'reconnecting') return
    sendMouseEvent('mouseup', e.clientX, e.clientY, MOUSE_BUTTON[e.button] || 'left')
  }
  function handleMouseMove(e) {
    if (session?.mode !== 'normal' || status === 'reconnecting') return
    sendMouseEvent('mousemove', e.clientX, e.clientY)
  }

  // Teclas atualmente "pressionadas" do ponto de vista desta janela — toda
  // vez que o foco pode ter se perdido (blur, aba escondida, troca de
  // modo, desmontagem) soltamos tudo que ainda está aqui, por garantia.
  // Sem isso, qualquer evento que impeça o onKeyUp normal de disparar
  // (não só a tecla Windows — Alt-Tab, perder foco pro SO por qualquer
  // motivo) deixa a tecla logicamente travada na máquina remota pra
  // sempre, sem nenhum jeito de perceber até alguém tentar digitar de
  // novo e ver "outra coisa" acontecer na tela.
  const heldKeysRef = useRef(new Set())
  const visibleNormalCountRef = useNormalWindowVisibility()

  const releaseAllHeldKeys = useCallback(() => {
    heldKeysRef.current.forEach((code) => sendKeyEvent('keyup', code))
    heldKeysRef.current.clear()
  }, [sendKeyEvent])

  // Botão manual de emergência (ver EMERGENCY_RELEASE_KEYCODES) — rede de
  // segurança separada de releaseAllHeldKeys: cobre o caso em que o keyup
  // se perdeu ANTES desta janela sequer registrar a tecla como pressionada
  // (ex: ela foi aberta depois do keydown problemático).
  function releaseStuckKeys() {
    EMERGENCY_RELEASE_KEYCODES.forEach((code) => {
      sendKeyEvent('keyup', code)
      // Só remove do rastreamento as teclas que de fato soltamos aqui —
      // um clear() geral apagaria também teclas NÃO-modificadoras que o
      // operador ainda esteja legitimamente segurando (ex: uma letra em
      // repeat), fazendo o safety-net automático de blur/visibilitychange
      // "esquecer" delas e nunca soltá-las depois (achado 🟡 do
      // code-reviewer, 04/11/2026).
      heldKeysRef.current.delete(code)
    })
  }

  useEffect(() => {
    if (session?.mode !== 'normal') return
    function onKeyDown(e) {
      if ((e.keyCode === VK_LWIN || e.keyCode === VK_RWIN) && visibleNormalCountRef.current !== 1) {
        return
      }
      // Ctrl+V intercetado: nunca encaminha o keydown cru de 'V' — isso
      // colaria o clipboard da máquina REMOTA (área de transferência que o
      // Windows da loja já tinha). Em vez disso lê o clipboard LOCAL do
      // operador (Electron, via IPC) e manda clipboard-paste, que o
      // companion resolve numa chamada só (seta clipboard remoto + injeta
      // Ctrl+V).
      //
      // 🔴 bug real corrigido (code-reviewer): o `return` tinha que estar
      // FORA do `!e.repeat` — antes, um evento de auto-repeat (segurar
      // Ctrl+V, o SO manda keydown repetido) caía no `if` como falso e
      // SEGUIA pro fluxo normal abaixo, encaminhando o keydown cru de 'V'
      // pro remoto. Com Ctrl já down lá (reafirmado pelo próprio paste),
      // isso disparava um Ctrl+V de verdade na máquina remota — colando o
      // clipboard REMOTO, exatamente o vetor que esta interceptação existe
      // pra bloquear. Repeat agora só pula o disparo de UM novo paste, mas
      // continua interceptado/bloqueado (preventDefault + return) sempre.
      if (e.ctrlKey && e.keyCode === VK_V) {
        e.preventDefault()
        if (e.repeat) return
        // Checa arquivo ANTES de texto (dentro de pasteClipboardToRemote):
        // copiar um arquivo no Explorer não deixa nada útil no clipboard de
        // texto, então a ordem nunca rouba um paste de texto legítimo.
        pasteClipboardToRemote()
        return
      }
      // statusRef === 'reconnecting' (não "!== connected" — mesmo motivo
      // dos handlers de mouse acima: 'connecting' já no-opa sozinho via
      // ws.readyState, sem bug ali): mesmo achado 🟡 do code-reviewer —
      // durante 'reconnecting' o socket dashboard↔servidor segue aberto,
      // então sem isto o keydown seria mandado de verdade e descartado em
      // silêncio (companionWs null em routeMessage), sem nenhum feedback.
      // onKeyUp (abaixo) NÃO ganha o mesmo guard de propósito: soltar uma
      // tecla já rastreada em heldKeysRef precisa continuar acontecendo
      // pra não dessincronizar o rastreamento local, mesmo que o envio em
      // si vire no-op do outro lado.
      if (statusRef.current === 'reconnecting') return
      heldKeysRef.current.add(e.keyCode)
      sendKeyEvent('keydown', e.keyCode)
    }
    function onKeyUp(e) {
      if ((e.keyCode === VK_LWIN || e.keyCode === VK_RWIN) && !heldKeysRef.current.has(e.keyCode)) {
        return
      }
      // Keyup de 'V' sem keydown correspondente registrado (caso Ctrl+V
      // interceptado acima, que nunca adiciona a heldKeysRef) — não manda
      // um keyup órfão pro remoto, mesma fonte de verdade já usada pelo
      // resto deste rastreamento (ver releaseStuckKeys).
      if (e.keyCode === VK_V && !heldKeysRef.current.has(VK_V)) return
      heldKeysRef.current.delete(e.keyCode)
      sendKeyEvent('keyup', e.keyCode)
    }
    function onBlur() { releaseAllHeldKeys() }
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') releaseAllHeldKeys()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      releaseAllHeldKeys()
    }
  }, [session?.mode, sendKeyEvent, releaseAllHeldKeys, pasteClipboardToRemote])

  // winkeyhook (processo nativo separado, ver electron/main.js) manda 1
  // evento por combo detectado ANTES do Explorer local processá-lo --
  // aditivo ao onKeyDown acima (regra 3): quando o hook está ativo, o
  // Windows nunca entrega o keydown de Win/R/E/D pra esta janela (nem pra
  // nenhuma), então o caminho acima simplesmente não dispara pra essas
  // teclas -- sem duplo encaminhamento. Se o hook não estiver rodando por
  // qualquer motivo, nada chega aqui e o caminho acima (regra 3) continua
  // sendo a única rede, exatamente como antes desta sessão.
  useEffect(() => {
    if (session?.mode !== 'normal') return
    const unsubscribe = window.electronAPI?.onWinKeyCombo((combo) => {
      if (combo === 'win-tap') {
        sendKeyEvent('keydown', VK_LWIN)
        sendKeyEvent('keyup', VK_LWIN)
        return
      }
      const vk = WIN_COMBO_VK[combo]
      if (!vk) return
      sendKeyEvent('keydown', VK_LWIN)
      sendKeyEvent('keydown', vk)
      sendKeyEvent('keyup', vk)
      sendKeyEvent('keyup', VK_LWIN)
    })
    return unsubscribe
  }, [session?.mode, sendKeyEvent])

  if (!session) {
    return <div style={{ color: '#9ca3af', padding: 24, fontFamily: 'monospace' }}>Conectando à sessão...</div>
  }

  return (
    <div
      data-testid="live-session-dropzone"
      onDrop={handleDrop}
      onDragOver={acceptFileDrag}
      onDragEnter={acceptFileDrag}
      style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f1117', color: '#e5e7eb', fontFamily: 'monospace' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: '1px solid #1e1e30' }}>
        <span>{session.mode === 'normal' ? '🖥 Normal' : '✍️ Shadow'} — {session.machineName || session.machineId}</span>
        <span style={{ color: status === 'connected' ? '#22c55e' : status === 'error' ? '#ef4444' : '#f59e0b' }}>
          {status === 'connected' ? 'Conectado'
            : status === 'error' ? 'Conexão perdida'
            : status === 'reconnecting' ? 'Reconectando à máquina remota...'
            : 'Conectando...'}
        </span>
        {recording && <span style={{ color: '#ef4444' }}>⏺ Gravando {recordingSecs}s</span>}
        {ending && <span style={{ color: '#f59e0b' }}>Encerrando sessão...</span>}
        <div style={{ flex: 1 }} />
        {closeError && <span style={{ color: '#ef4444' }}>Erro ao encerrar: {closeError} — feche a janela de novo pra tentar outra vez.</span>}
        {recordingError && <span style={{ color: '#ef4444' }}>Erro na gravação: {recordingError}</span>}
        {session.mode === 'normal' && (
          <button
            className={`btn ${inputLocked ? 'btn-danger' : 'btn-secondary'}`}
            onClick={toggleInputLock}
            disabled={ending || status !== 'connected'}
            title={status !== 'connected' ? 'Sem conexão com a sessão ao vivo' : undefined}
          >
            {inputLocked ? '🔓 Destravar usuário' : '🔒 Travar usuário'}
          </button>
        )}
        {session.mode === 'normal' && (
          <button
            className="btn btn-secondary"
            onClick={releaseStuckKeys}
            disabled={ending || status !== 'connected'}
            title="Solta Win/Ctrl/Alt/Shift caso alguma tenha ficado travada (ex: tecla abriu um menu e roubou o foco antes do keyup sair)"
          >
            ⌨️ Liberar teclas travadas
          </button>
        )}
        <button className={`btn ${recording ? 'btn-danger' : 'btn-secondary'}`} onClick={toggleRecording} disabled={ending}>
          {recording ? '⏹ Parar gravação' : '⏺ Gravar'}
        </button>
        {session?.mode === 'normal' && (
          <div className="file-transfer-controls" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="text"
              value={fileDestDir}
              onChange={(e) => setFileDestDir(e.target.value)}
              placeholder={defaultDestDir || 'Confirme o caminho de destino'}
              style={{ width: 220 }}
            />
            <button
              className="btn btn-secondary"
              onClick={handlePickFile}
              disabled={ending || isTransferring || status !== 'connected'}
              title={
                isTransferring ? 'Já existe uma transferência em andamento'
                  : status !== 'connected' ? 'Sem conexão com a sessão ao vivo'
                  : undefined
              }
            >
              Enviar arquivo
            </button>
            {fileTransferProgress && typeof fileTransferProgress === 'object' && (
              <progress value={fileTransferProgress.bytesReceived} max={fileTransferProgress.bytesTotal || 1} />
            )}
            {fileTransferProgress === 'done' && <span style={{ color: '#22c55e' }}>Arquivo enviado ✓</span>}
            {typeof fileTransferProgress === 'string' && fileTransferProgress.startsWith('error') && (
              <span style={{ color: '#ef4444' }}>{fileTransferProgress}</span>
            )}
          </div>
        )}
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
        <canvas
          data-testid="live-canvas"
          ref={canvasRef}
          style={{ maxWidth: '100%', maxHeight: '100%', cursor: 'default' }}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
        />
      </div>
    </div>
  )
}
