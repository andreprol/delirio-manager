import { useState, useEffect, useRef, useCallback } from 'react'
import { useLiveSession } from '../hooks/useLiveSession'
import { api, setServerUrl, setAdminSecret } from '../api'

const MOUSE_BUTTON = { 0: 'left', 2: 'right' }

export function LiveSessionWindow() {
  const [session, setSession] = useState(null) // { sessionId, machineId, mode, dashboardToken, serverUrl }
  const [status, setStatus] = useState('connecting')
  const [recording, setRecording] = useState(false)
  const [inputLocked, setInputLocked] = useState(false)
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

  const { sendInput, sendMouseEvent, sendKeyEvent } = useLiveSession({
    serverUrl: session?.serverUrl,
    sessionId: session?.sessionId,
    dashboardToken: session?.dashboardToken,
    mode: session?.mode,
    canvasRef,
    onStatusChange: setStatus,
  })

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

  function handleMouseDown(e) {
    if (session?.mode !== 'normal') return
    sendMouseEvent('mousedown', e.clientX, e.clientY, MOUSE_BUTTON[e.button] || 'left')
  }
  function handleMouseUp(e) {
    if (session?.mode !== 'normal') return
    sendMouseEvent('mouseup', e.clientX, e.clientY, MOUSE_BUTTON[e.button] || 'left')
  }
  function handleMouseMove(e) {
    if (session?.mode !== 'normal') return
    sendMouseEvent('mousemove', e.clientX, e.clientY)
  }

  useEffect(() => {
    if (session?.mode !== 'normal') return
    function onKeyDown(e) { sendKeyEvent('keydown', e.keyCode) }
    function onKeyUp(e) { sendKeyEvent('keyup', e.keyCode) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [session?.mode, sendKeyEvent])

  if (!session) {
    return <div style={{ color: '#9ca3af', padding: 24, fontFamily: 'monospace' }}>Conectando à sessão...</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f1117', color: '#e5e7eb', fontFamily: 'monospace' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: '1px solid #1e1e30' }}>
        <span>{session.mode === 'normal' ? '🖥 Normal' : '✍️ Shadow'} — {session.machineName || session.machineId}</span>
        <span style={{ color: status === 'connected' ? '#22c55e' : status === 'error' ? '#ef4444' : '#f59e0b' }}>
          {status === 'connected' ? 'Conectado' : status === 'error' ? 'Conexão perdida' : 'Conectando...'}
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
            {inputLocked ? '🔓 Liberar input local' : '🔒 Bloquear input local'}
          </button>
        )}
        <button className={`btn ${recording ? 'btn-danger' : 'btn-secondary'}`} onClick={toggleRecording} disabled={ending}>
          {recording ? '⏹ Parar gravação' : '⏺ Gravar'}
        </button>
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
