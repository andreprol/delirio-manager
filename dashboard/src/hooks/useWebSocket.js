import { useEffect, useRef, useCallback } from 'react'
import { getServerUrl } from '../api'

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
