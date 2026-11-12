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
// RECONNECT_DELAY_MAX_MS limita o backoff exponencial do retry infinito —
// achado 🟡 do code-reviewer: sem teto, uma queda prolongada (deploy,
// restart de VM) faria cada janela de Acesso Remoto aberta martelar o
// servidor com 1 handshake WS a cada 3s pra sempre, bem no momento em que
// ele pode estar mais sobrecarregado. 3s→6s→12s→24s→30s (teto), reseta pra
// 3s assim que uma conexão abre com sucesso.
const RECONNECT_DELAY_MAX_MS = 30000

// TERMINAL_CLOSE_CODES são os códigos que o PRÓPRIO relay usa (ver
// liveSessionRelay.js) quando recusa a conexão ou encerra a sessão de
// propósito — sessão não existe mais (4000), token inválido (4001), role
// inválido (4002), conexão substituída por uma janela mais nova pro mesmo
// sessionId (4003), ou sessão encerrada explicitamente via POST /stop
// (4004 — achado do code-reviewer: sem isso, um /stop disparado de outro
// lugar nunca fechava o socket do dashboard, que ficava "Conectado" pra
// sempre com o último frame congelado). Nenhum desses se resolve tentando
// de novo (a sessão em si já era, não é um blip de rede) — qualquer OUTRO
// código (1006 abnormal closure, 1001 going away, etc.) é tratado como
// queda transitória e tenta reconectar, já que o relay mantém a sessão viva
// no servidor independente do socket do dashboard cair (ver
// attachDashboardSocket/scheduleUnlockOnDashboardDisconnect) — só precisa
// reabrir o WS com o mesmo sessionId/token, o servidor reataca sozinho.
const TERMINAL_CLOSE_CODES = new Set([4000, 4001, 4002, 4003, 4004])

// useLiveSession conecta no WS /live como role=dashboard, desenha cada frame
// recebido no canvas apontado por canvasRef, e expõe sendInput pra mandar
// eventos de mouse/teclado de volta. O componente (LiveSessionWindow) só
// registra os listeners de mouse/teclado em mode normal, mas isso por si só
// não é garantia estrutural — um guard esquecido no componente mandaria
// input numa sessão Shadow sem nenhuma segunda barreira do lado cliente. Por
// isso sendInput também recusa (defesa em profundidade, mesmo princípio do
// relay no servidor — liveSessionRelay.routeMessage nunca repassa input em
// Shadow mesmo que o dashboard mande por engano/bug).
export function useLiveSession({ serverUrl, sessionId, dashboardToken, mode, canvasRef, onStatusChange, onFileTransferStatus }) {
  const wsRef = useRef(null)
  const reconnectAttemptsRef = useRef(0)
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

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0
      notifyStatus('connected')
    }
    ws.onmessage = (e) => {
      // Mensagens de texto são status de transferência de arquivo (JSON) —
      // o companion manda file-transfer-progress/-done/-error pelo mesmo WS
      // que já carrega os frames binários (JPEG) de vídeo. Frames de vídeo
      // nunca são string, então esse branch não adiciona overhead ao
      // caminho binário (drawFrame).
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type?.startsWith('file-transfer-')) onFileTransferStatus?.(msg)
        } catch { /* mensagem de texto nao-JSON, ignora */ }
        return
      }
      drawFrame(e.data)
    }
    ws.onclose = (event) => {
      if (!mountedRef.current) return
      if (TERMINAL_CLOSE_CODES.has(event.code)) {
        // Achado real em produção (André, 11/11/2026): antes só tentava
        // reconectar 1x e desistia pra sempre — qualquer 2ª queda (comum em
        // rede de loja instável) deixava a sessão morta até fechar e reabrir
        // a janela manualmente. Agora só desiste de verdade quando o PRÓPRIO
        // servidor recusou de propósito (ver TERMINAL_CLOSE_CODES) — qualquer
        // outra queda tenta pra sempre, até o componente desmontar.
        notifyStatus('error')
        return
      }
      notifyStatus('disconnected')
      // Jitter (0.5x-1.5x do delay calculado) -- achado do code-reviewer:
      // sem isso, múltiplas janelas de Acesso Remoto abertas ao mesmo tempo
      // (ou reabertas juntas após um erro) recalculam o mesmo delay
      // determinístico e martelam o servidor no mesmo instante a cada
      // tentativa.
      const baseDelay = Math.min(RECONNECT_DELAY_MS * 2 ** reconnectAttemptsRef.current, RECONNECT_DELAY_MAX_MS)
      const delay = baseDelay * (0.5 + Math.random())
      reconnectAttemptsRef.current += 1
      setTimeout(() => { if (mountedRef.current) connect() }, delay)
    }
    ws.onerror = () => { ws.close() }
  }, [serverUrl, sessionId, dashboardToken, drawFrame, notifyStatus, onFileTransferStatus])

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
  // hasConnectedRef garante só 1 tentativa real de conexão inicial mesmo
  // que o efeito rode de novo (ex: mode mudando de referência) — o próprio
  // ws.onclose (ver connect acima) já cuida de toda reconexão depois disso.
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

  // sendClipboardPaste manda o texto do clipboard LOCAL do operador pro
  // companion, que seta o clipboard remoto e já injeta Ctrl+V (ver
  // agent/input_windows.go injectClipboardPaste) — usado pelo Ctrl+V
  // interceptado em LiveSessionWindow.jsx, nunca repassa o keydown/keyup cru
  // de 'V' pro companion (colaria o clipboard REMOTO em vez do local).
  const sendClipboardPaste = useCallback((text) => {
    sendInput({ type: 'clipboard-paste', text })
  }, [sendInput])

  // sendFileTransfer manda o comando leve pro companion baixar o arquivo
  // do Blob (downloadUrl ja e a SAS de leitura, gerada pelo servidor) —
  // ver agent/filetransfer_windows.go (branch separada, ja mergeada/revisada).
  const sendFileTransfer = useCallback((downloadUrl, fileName, destDir) => {
    sendInput({ type: 'file-transfer', downloadUrl, fileName, destDir })
  }, [sendInput])

  return { sendInput, sendMouseEvent, sendKeyEvent, sendClipboardPaste, sendFileTransfer }
}
