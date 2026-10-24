import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveSession, buildLiveSessionWsUrl, scaleInputCoordinate } from '../hooks/useLiveSession'

describe('buildLiveSessionWsUrl', () => {
  it('troca https por wss e http por ws, monta query string', () => {
    const url = buildLiveSessionWsUrl('https://dt-manager.example.com', 'sess-1', 'tok-abc')
    expect(url).toBe('wss://dt-manager.example.com/live?sessionId=sess-1&role=dashboard&token=tok-abc')
  })

  it('funciona com http simples (dev local)', () => {
    const url = buildLiveSessionWsUrl('http://localhost:3000', 's2', 't2')
    expect(url).toBe('ws://localhost:3000/live?sessionId=s2&role=dashboard&token=t2')
  })
})

describe('scaleInputCoordinate', () => {
  it('escala 1:1 quando canvas exibido no mesmo tamanho do frame', () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 }
    const result = scaleInputCoordinate(400, 300, rect, 800, 600)
    expect(result).toEqual({ x: 400, y: 300 })
  })

  it('escala quando canvas exibido menor que o frame real', () => {
    // canvas exibido em 400x300 na tela do operador, frame real é 1920x1080
    const rect = { left: 0, top: 0, width: 400, height: 300 }
    const result = scaleInputCoordinate(200, 150, rect, 1920, 1080)
    expect(result).toEqual({ x: 960, y: 540 })
  })

  it('subtrai o offset do canvas (left/top) antes de escalar', () => {
    const rect = { left: 50, top: 20, width: 200, height: 100 }
    const result = scaleInputCoordinate(150, 70, rect, 400, 200)
    // (150-50)/200*400=200 ; (70-20)/100*200=100
    expect(result).toEqual({ x: 200, y: 100 })
  })
})

class FakeWebSocket {
  static instances = []
  constructor(url) {
    this.url = url
    this.readyState = 0 // CONNECTING
    this.sent = []
    FakeWebSocket.instances.push(this)
  }
  send(data) { this.sent.push(data) }
  close() { this.readyState = 3; this.onclose?.({}) }
  // helpers de teste
  _open() { this.readyState = 1; this.onopen?.({}) }
  _message(data) { this.onmessage?.({ data }) }
  _closeFromServer() { this.readyState = 3; this.onclose?.({}) }
}
FakeWebSocket.OPEN = 1

describe('useLiveSession', () => {
  let originalWebSocket
  let originalCreateImageBitmap
  let getContextSpy

  beforeEach(() => {
    originalWebSocket = global.WebSocket
    originalCreateImageBitmap = global.createImageBitmap
    FakeWebSocket.instances = []
    global.WebSocket = FakeWebSocket
    global.createImageBitmap = vi.fn().mockResolvedValue({ width: 320, height: 240, close: vi.fn() })
    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage: vi.fn() })
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    global.createImageBitmap = originalCreateImageBitmap
    getContextSpy.mockRestore()
    vi.useRealTimers()
  })

  function makeCanvasRef() {
    const canvas = document.createElement('canvas')
    return { current: canvas }
  }

  it('conecta no WS com a URL/role/token certos', () => {
    const canvasRef = makeCanvasRef()
    renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef,
    }))
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toBe(
      'wss://servidor.example.com/live?sessionId=s1&role=dashboard&token=tok'
    )
  })

  it('desenha o frame recebido no canvas via createImageBitmap', async () => {
    const canvasRef = makeCanvasRef()
    renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    const fakeBlob = new Blob(['fake-jpeg'])

    await act(async () => {
      ws._open()
      ws._message(fakeBlob)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(global.createImageBitmap).toHaveBeenCalledWith(fakeBlob)
    expect(canvasRef.current.width).toBe(320)
    expect(canvasRef.current.height).toBe(240)
  })

  it('sendInput manda JSON pelo WS quando mode normal e conexão aberta', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'normal', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    act(() => { ws._open() })

    act(() => {
      result.current.sendInput({ type: 'mousedown', x: 10, y: 20, button: 'left' })
    })

    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'mousedown', x: 10, y: 20, button: 'left' })
  })

  // Regressão achada na revisão cross-cutting: antes, o filtro por mode
  // existia só no componente (LiveSessionWindow) — o hook mandava qualquer
  // coisa, de qualquer mode. Defesa em profundidade: mesmo chamando
  // sendInput/sendMouseEvent/sendKeyEvent direto, numa sessão Shadow nada
  // sai pelo WS, igual ao servidor nunca repassar input numa sessão Shadow
  // mesmo que o dashboard mande por engano/bug.
  it('mode shadow: sendInput/sendMouseEvent/sendKeyEvent não mandam nada mesmo com WS aberto', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    act(() => { ws._open() })

    act(() => {
      result.current.sendInput({ type: 'mousedown', x: 10, y: 20, button: 'left' })
      result.current.sendMouseEvent('mousemove', 5, 5)
      result.current.sendKeyEvent('keydown', 65)
    })

    expect(ws.sent).toHaveLength(0)
  })

  it('sendInput não manda nada se o WS ainda não abriu', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'normal', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    // não chama ws._open() — readyState continua 0 (CONNECTING)

    act(() => {
      result.current.sendInput({ type: 'mousemove', x: 1, y: 1 })
    })

    expect(ws.sent).toHaveLength(0)
  })

  it('reconecta 1x, 3s depois de cair, e não tenta de novo numa 2ª queda', () => {
    vi.useFakeTimers()
    const canvasRef = makeCanvasRef()
    renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef,
    }))
    expect(FakeWebSocket.instances).toHaveLength(1)

    act(() => { FakeWebSocket.instances[0]._closeFromServer() })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(FakeWebSocket.instances).toHaveLength(2) // reconectou 1x

    act(() => { FakeWebSocket.instances[1]._closeFromServer() })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(FakeWebSocket.instances).toHaveLength(2) // não tentou de novo
  })
})
