import { useEffect, useRef, useCallback } from 'react'
import { getServerUrl } from '../api'

// Diagnóstico TEMPORÁRIO (09/11/2026) — investigando "Unexpected response
// code: 301" só no WebSocket em produção, que não reproduz em curl/Electron
// fake/Chromium real nenhum testado até agora. WebSocket não expõe headers
// de erro no handshake por design (CORS/segurança), mas fetch() sim — então
// quando o WS fecha, dispara um fetch pro MESMO endpoint e loga status,
// redirect e headers reais no console, pra ver o que o Electron real recebe.
// Throttle de 30s pra não poluir o console no loop de reconexão de 5s.
// REMOVER assim que a causa for confirmada.
let _lastWsDiagAt = 0
async function diagnoseWsFailure(wsUrl) {
  const now = Date.now()
  if (now - _lastWsDiagAt < 30000) return
  _lastWsDiagAt = now
  try {
    const httpUrl = wsUrl.replace(/^ws/, 'http')
    const res = await fetch(httpUrl, { redirect: 'follow' })
    const headers = {}
    res.headers.forEach((v, k) => { headers[k] = v })
    console.error('[WS-DIAG]', { url: httpUrl, status: res.status, redirected: res.redirected, finalUrl: res.url, headers })
  } catch (e) {
    console.error('[WS-DIAG] fetch falhou:', e.message)
  }
}

export function useWebSocket(onMessage) {
  const wsRef      = useRef(null)
  const timerRef   = useRef(null)
  const mountedRef = useRef(true)

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    const url = getServerUrl().replace(/^https?/, 'ws') + '/ws'

    try {
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        onMessage({ type: 'ws:connected' })
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }

        // Envia JSON ping a cada 25s para manter conexao viva
        // (browser WebSocket nao responde ao TCP ping do servidor)
        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          } else {
            clearInterval(pingInterval)
          }
        }, 25000)

        ws._pingInterval = pingInterval
      }

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type !== 'pong') onMessage(msg)
        } catch {}
      }

      ws.onclose = () => {
        if (ws._pingInterval) clearInterval(ws._pingInterval)
        if (!mountedRef.current) return
        onMessage({ type: 'ws:disconnected' })
        diagnoseWsFailure(url)
        timerRef.current = setTimeout(connect, 5000)
      }

      ws.onerror = () => {
        ws.close()
      }
    } catch {
      timerRef.current = setTimeout(connect, 5000)
    }
  }, [onMessage])

  useEffect(() => {
    mountedRef.current = true
    connect()
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
      if (wsRef.current) wsRef.current.close()
    }
  }, [connect])
}
