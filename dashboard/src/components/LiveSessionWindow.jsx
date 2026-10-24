import { useState, useEffect, useRef, useCallback } from 'react'
import { useLiveSession } from '../hooks/useLiveSession'
import { api } from '../api'

const MOUSE_BUTTON = { 0: 'left', 2: 'right' }

export function LiveSessionWindow() {
  const [session, setSession] = useState(null) // { sessionId, machineId, mode, dashboardToken, serverUrl }
  const [status, setStatus] = useState('connecting')
  const [recording, setRecording] = useState(false)
  const [recordingSecs, setRecordingSecs] = useState(0)
  const canvasRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const recordingTimerRef = useRef(null)
  const startedAtRef = useRef(null)
  const sessionRef = useRef(null)
  const recordingSecsRef = useRef(0)

  sessionRef.current = session
  recordingSecsRef.current = recordingSecs

  const { sendMouseEvent, sendKeyEvent } = useLiveSession({
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

  // stopRecordingIfActive/endSession leem sessionRef/recordingSecsRef (não
  // session/recordingSecs direto) pra poderem ser estáveis (sem recriar a
  // cada mudança de estado) e ainda assim ler o valor mais recente — usadas
  // dentro do listener de IPC (onCleanupAndClose), que só se inscreve 1x.
  const stopRecordingIfActive = useCallback(async () => {
    if (!mediaRecorderRef.current) return
    const recorder = mediaRecorderRef.current
    mediaRecorderRef.current = null
    clearInterval(recordingTimerRef.current)
    setRecording(false)

    const stopped = new Promise((resolve) => { recorder.onstop = resolve })
    recorder.stop()
    await stopped

    const blob = new Blob(chunksRef.current, { type: 'video/webm' })
    chunksRef.current = []
    const arrayBuffer = await blob.arrayBuffer()
    // Falha na conversão (ffmpeg) não pode travar o encerramento da sessão —
    // sem o catch, endSession nunca chegaria em api.live.stop/cleanupDone, e
    // o botão "Encerrar sessão"/fechar a janela pareceria simplesmente não
    // fazer nada. A gravação se perde nesse caso, mas a sessão encerra.
    try {
      await window.electronAPI.convertRecording(arrayBuffer, {
        machineId: sessionRef.current?.machineId,
        mode: sessionRef.current?.mode,
        startedAt: startedAtRef.current,
        endedAt: new Date().toISOString(),
        durationSec: recordingSecsRef.current,
      })
    } catch (err) {
      console.error('Falha ao converter gravação:', err)
    }
  }, [])

  const endSession = useCallback(async () => {
    const wasRecording = !!mediaRecorderRef.current
    await stopRecordingIfActive()
    if (sessionRef.current?.sessionId) {
      await api.live.stop(sessionRef.current.sessionId, wasRecording)
    }
  }, [stopRecordingIfActive])

  // Clique no botão usa o MESMO fluxo de limpeza do X da janela (endSession
  // + cleanupDone) em vez de chamar window.close() — window.close() faria o
  // main process (ver liveWin.on('close', ...)) mandar outro
  // 'live-session-cleanup-and-close', rodando endSession() (e portanto
  // api.live.stop) uma 2ª vez. cleanupDone() direto já deixa o main process
  // fechar a janela de verdade (__cleanupDone vira true, sem passar pelo
  // preventDefault).
  const handleEndSessionClick = useCallback(async () => {
    await endSession()
    window.electronAPI?.cleanupDone()
  }, [endSession])

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCleanupAndClose(async () => {
      await endSession()
      window.electronAPI.cleanupDone()
    })
    return unsubscribe
  }, [endSession])

  function toggleRecording() {
    if (mediaRecorderRef.current) {
      stopRecordingIfActive()
      return
    }
    const canvas = canvasRef.current
    if (!canvas || typeof canvas.captureStream !== 'function') return
    const stream = canvas.captureStream(10)
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })
    chunksRef.current = []
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorder.start()
    mediaRecorderRef.current = recorder
    startedAtRef.current = new Date().toISOString()
    setRecordingSecs(0)
    setRecording(true)
    recordingTimerRef.current = setInterval(() => setRecordingSecs((s) => s + 1), 1000)
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
        <span>{session.mode === 'normal' ? '🖥 Normal' : '✍️ Shadow'} — {session.machineId}</span>
        <span style={{ color: status === 'connected' ? '#22c55e' : status === 'error' ? '#ef4444' : '#f59e0b' }}>
          {status === 'connected' ? 'Conectado' : status === 'error' ? 'Conexão perdida' : 'Conectando...'}
        </span>
        {recording && <span style={{ color: '#ef4444' }}>⏺ Gravando {recordingSecs}s</span>}
        <div style={{ flex: 1 }} />
        <button onClick={toggleRecording}>{recording ? '⏹ Parar gravação' : '⏺ Gravar'}</button>
        <button onClick={handleEndSessionClick}>Encerrar sessão</button>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
        <canvas
          data-testid="live-canvas"
          ref={canvasRef}
          style={{ maxWidth: '100%', maxHeight: '100%', cursor: session.mode === 'normal' ? 'crosshair' : 'default' }}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
        />
      </div>
    </div>
  )
}
