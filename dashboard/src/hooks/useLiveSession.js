import { useEffect, useRef, useCallback } from 'react'

// Troca o esquema da URL do servidor (http->ws, https->wss) e monta a query
// que o WebSocketServer em /live (server/services/liveSessionRelay.js)
// espera — mesmo formato que buildLiveWebSocketURL no agent (Go), só que o
// lado dashboard usa role=dashboard + dashboardToken em vez de
// role=companion + companionToken.
export function buildLiveSessionWsUrl(serverUrl, sessionId, dashboardToken) {
  const wsBase = serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws')
  const params = new URLSearchParams({ sessionId, role: 'dashboard', token: dashboardToken })
  return `${wsBase}/live?${params.toString()}`
}

// Converte uma coordenada de clique/mouse no espaço de EXIBIÇÃO do canvas
// (rect = canvas.getBoundingClientRect(), em pixels de tela do operador) pra
// coordenada no espaço da RESOLUÇÃO REAL da máquina remota (frameWidth/
// frameHeight) — o frame JPEG vem na resolução nativa da máquina, que quase
// nunca bate com o tamanho que o canvas ocupa na tela de quem está operando.
export function scaleInputCoordinate(clientX, clientY, rect, frameWidth, frameHeight) {
  const x = Math.round((clientX - rect.left) / rect.width * frameWidth)
  const y = Math.round((clientY - rect.top) / rect.height * frameHeight)
  return { x, y }
}

const RECONNECT_DELAY_MS = 3000

// useLiveSession conecta no WS /live como role=dashboard, desenha cada frame
// recebido no canvas apontado por canvasRef, e expõe sendInput pra mandar
// eventos de mouse/teclado de volta. O componente (LiveSessionWindow) só
// registra os listeners de mouse/teclado em mode normal, mas isso por si só
// não é garantia estrutural — um guard esquecido no componente mandaria
// input numa sessão Shadow sem nenhuma segunda barreira do lado cliente. Por
// isso sendInput também recusa (defesa em profundidade, mesmo princípio do
// relay no servidor — liveSessionRelay.routeMessage nunca repassa input em
// Shadow mesmo que o dashboard mande por engano/bug).
export function useLiveSession({ serverUrl, sessionId, dashboardToken, mode, canvasRef, onStatusChange }) {
  const wsRef = useRef(null)
  const hasRetriedRef = useRef(false)
  const frameSizeRef = useRef({ width: 0, height: 0 })
  const mountedRef = useRef(true)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const notifyStatus = useCallback((status) => {
    onStatusChange?.(status)
  }, [onStatusChange])

  const drawFrame = useCallback(async (data) => {
    if (!(data instanceof Blob)) return
    const bitmap = await createImageBitmap(data)
    frameSizeRef.current = { width: bitmap.width, height: bitmap.height }
    const canvas = canvasRef.current
    if (canvas) {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
      }
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
    }
    bitmap.close?.()
  }, [canvasRef])

  const connect = useCallback(() => {
    if (!mountedRef.current) return
    const url = buildLiveSessionWsUrl(serverUrl, sessionId, dashboardToken)
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => notifyStatus('connected')
    ws.onmessage = (e) => { drawFrame(e.data) }
    ws.onclose = () => {
      if (!mountedRef.current) return
      notifyStatus('disconnected')
      if (!hasRetriedRef.current) {
        hasRetriedRef.current = true
        setTimeout(() => { if (mountedRef.current) connect() }, RECONNECT_DELAY_MS)
      } else {
        notifyStatus('error')
      }
    }
    ws.onerror = () => { ws.close() }
  }, [serverUrl, sessionId, dashboardToken, drawFrame, notifyStatus])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      wsRef.current?.close()
    }
  }, [])

  // Conecta só quando os 3 parâmetros de verdade chegarem — achado em
  // produção (tela preta + janela travada, sem fechar): LiveSessionWindow
  // chama este hook incondicionalmente desde o 1º render, com `session`
  // ainda null (os dados só chegam depois, por IPC — ver onLiveSessionInit)
  // — serverUrl/sessionId/dashboardToken vinham undefined, e
  // buildLiveSessionWsUrl (`undefined.replace(...)`) lançava exceção dentro
  // do efeito, derrubando a árvore React inteira antes mesmo do efeito que
  // escuta 'live-session-cleanup-and-close' chegar a rodar — por isso a
  // janela nem desenhava nada nem fechava com o X.
  //
  // hasConnectedRef garante só 1 tentativa real de conexão mesmo que o
  // efeito rode de novo (ex: mode mudando de referência) — reconectar por
  // causa desse reset quebraria a lógica de retry único (hasRetriedRef).
  const hasConnectedRef = useRef(false)
  useEffect(() => {
    if (hasConnectedRef.current) return
    if (!serverUrl || !sessionId || !dashboardToken) return
    hasConnectedRef.current = true
    connect()
  }, [serverUrl, sessionId, dashboardToken, connect])

  const sendInput = useCallback((msg) => {
    if (modeRef.current !== 'normal') return
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  const sendMouseEvent = useCallback((type, clientX, clientY, button) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const { x, y } = scaleInputCoordinate(clientX, clientY, rect, frameSizeRef.current.width, frameSizeRef.current.height)
    sendInput({ type, x, y, button })
  }, [canvasRef, sendInput])

  const sendKeyEvent = useCallback((type, keyCode) => {
    sendInput({ type, keyCode })
  }, [sendInput])

  return { sendInput, sendMouseEvent, sendKeyEvent }
}
