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
// eventos de mouse/teclado de volta (quem decide SE deve capturar e chamar
// sendInput, com base no mode, é o componente — ver LiveSessionWindow — este
// hook só transporta, não filtra por mode).
export function useLiveSession({ serverUrl, sessionId, dashboardToken, mode, canvasRef, onStatusChange }) {
  const wsRef = useRef(null)
  const hasRetriedRef = useRef(false)
  const frameSizeRef = useRef({ width: 0, height: 0 })
  const mountedRef = useRef(true)

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
    connect()
    return () => {
      mountedRef.current = false
      wsRef.current?.close()
    }
    // Deps vazias de propósito: serverUrl/sessionId/dashboardToken nunca
    // mudam depois do mount (a janela de sessão recebe esses dados 1x via
    // IPC, ver LiveSessionWindow) — reconectar a cada render por causa do
    // callback `connect` mudar de identidade quebraria a lógica de retry
    // único (hasRetriedRef reiniciaria a cada conexão nova).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendInput = useCallback((msg) => {
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
