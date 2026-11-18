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
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
  // helpers de teste
  _open() { this.readyState = 1; this.onopen?.({}) }
  _message(data) { this.onmessage?.({ data }) }
  // code default 1006 (abnormal closure) -- queda transitória de rede, a
  // mais comum na prática; testes de código terminal (4000/4001/4002/4003)
  // passam o code explicitamente.
  _closeFromServer(code = 1006) { this.readyState = 3; this.onclose?.({ code }) }
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
    // vi.restoreAllMocks() (não só getContextSpy.mockRestore()) -- achado
    // 🟠 do code-reviewer: um spy criado DENTRO de um teste (ex: Math.random
    // mockado no teste de backoff) e só restaurado na última linha do corpo
    // ficaria preso pra sempre se alguma asserção anterior lançasse — este
    // afterEach roda sempre, mesmo com o teste falhando no meio.
    vi.restoreAllMocks()
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

  // Regressão achada em produção (tela preta + janela que não fechava):
  // LiveSessionWindow chama este hook incondicionalmente desde o 1º
  // render, com session ainda null (chega depois via IPC) — serverUrl/
  // sessionId/dashboardToken vinham undefined, e o mount effect tentava
  // conectar mesmo assim, lançando exceção dentro de buildLiveSessionWsUrl
  // (`undefined.replace(...)`) que derrubava a árvore React inteira.
  it('não tenta conectar enquanto serverUrl/sessionId/dashboardToken não chegaram (undefined)', () => {
    const canvasRef = makeCanvasRef()
    renderHook(() => useLiveSession({
      serverUrl: undefined, sessionId: undefined, dashboardToken: undefined, mode: 'shadow', canvasRef,
    }))
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('conecta assim que os parâmetros chegam num re-render (simula a sessão vindo por IPC depois do mount)', () => {
    const canvasRef = makeCanvasRef()
    const { rerender } = renderHook(
      (props) => useLiveSession(props),
      { initialProps: { serverUrl: undefined, sessionId: undefined, dashboardToken: undefined, mode: 'shadow', canvasRef } }
    )
    expect(FakeWebSocket.instances).toHaveLength(0)

    rerender({ serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef })

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

  // Achado real em produção (André, 11/11/2026): um bug no relay (server)
  // fazia mensagens de texto chegarem aqui como se fossem frame de vídeo --
  // createImageBitmap lançava e virava unhandled rejection, sem nenhum
  // aviso. Já corrigido na origem (liveSessionRelay.js), mas este teste
  // garante que um frame que falha ao decodificar (corrompido, incompleto,
  // ou qualquer outra causa futura) nunca mais derruba a sessão inteira --
  // só descarta o frame e segue.
  it('frame que falha ao decodificar é descartado, sem lançar/travar a sessão', async () => {
    global.createImageBitmap = vi.fn().mockRejectedValue(new DOMException('source image could not be decoded', 'InvalidStateError'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const canvasRef = makeCanvasRef()
    renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    const corruptBlob = new Blob(['nao-e-um-jpeg-de-verdade'])

    await act(async () => {
      ws._open()
      ws._message(corruptBlob)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('frame descartado'), expect.any(String))
  })

  // Achado 🟡 do code-reviewer: o try/catch acima só cobria o decode
  // (createImageBitmap) -- se drawImage/getContext falhasse DEPOIS do
  // decode ter sucesso, a exceção escaparia sem catch (unhandled rejection
  // de novo) E bitmap.close() nunca rodaria (vazando o ImageBitmap). Este
  // teste garante que bitmap.close() roda mesmo quando o desenho falha.
  it('bitmap.close() roda mesmo quando desenhar o frame falha (ex: drawImage lança)', async () => {
    const closeSpy = vi.fn()
    global.createImageBitmap = vi.fn().mockResolvedValue({ width: 320, height: 240, close: closeSpy })
    getContextSpy.mockReturnValue({ drawImage: vi.fn(() => { throw new Error('contexto perdido') }) })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const canvasRef = makeCanvasRef()
    renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]

    await act(async () => {
      ws._open()
      ws._message(new Blob(['fake-jpeg']))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(closeSpy).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falha ao desenhar'), expect.any(String))
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

  it('sendClipboardPaste manda type=clipboard-paste com o texto, mode normal', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'normal', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    act(() => { ws._open() })

    act(() => {
      result.current.sendClipboardPaste('shutdown /s /t 300')
    })

    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'clipboard-paste', text: 'shutdown /s /t 300' })
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

  // Achado real em produção (André, 11/11/2026): a versão anterior só
  // tentava reconectar 1x e desistia pra sempre numa 2ª queda — rede de
  // loja instável deixava a sessão morta até fechar e reabrir a janela
  // manualmente. Agora reconecta indefinidamente em qualquer queda
  // transitória (qualquer code que não seja um dos TERMINAL_CLOSE_CODES do
  // próprio relay — ver liveSessionRelay.js).
  it('reconecta indefinidamente em quedas transitórias (sem código terminal do relay)', () => {
    vi.useFakeTimers()
    const canvasRef = makeCanvasRef()
    const onStatusChange = vi.fn()
    renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef, onStatusChange,
    }))
    expect(FakeWebSocket.instances).toHaveLength(1)

    // Delay cresce com backoff exponencial + jitter (0.5x-1.5x de 3s, 6s,
    // 12s, 24s, 30s-teto) -- 45000ms (teto*1.5, o pior caso possível com
    // jitter) é sempre >= qualquer delay real nessa faixa.
    for (let i = 0; i < 5; i++) {
      act(() => { FakeWebSocket.instances[i]._closeFromServer() }) // code 1006 (default), transitório
      act(() => { vi.advanceTimersByTime(45000) })
      expect(FakeWebSocket.instances).toHaveLength(i + 2) // reconectou de novo, sem desistir
    }
    expect(onStatusChange).not.toHaveBeenCalledWith('error')
  })

  // Math.random mockado em 0.5 -> jitter vira exatamente 1x (0.5 + 0.5) --
  // deixa o delay determinístico pra testar o valor exato do backoff sem
  // perder a cobertura real da multiplicação por jitter.
  it('reconexão usa backoff exponencial com teto de 30s, reseta ao conectar com sucesso', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // restaurado no afterEach global
    const canvasRef = makeCanvasRef()
    renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef,
    }))

    act(() => { FakeWebSocket.instances[0]._closeFromServer() })
    act(() => { vi.advanceTimersByTime(2999) })
    expect(FakeWebSocket.instances).toHaveLength(1) // ainda não, faltam 1ms pros 3s
    act(() => { vi.advanceTimersByTime(1) })
    expect(FakeWebSocket.instances).toHaveLength(2) // 1ª tentativa: 3s

    act(() => { FakeWebSocket.instances[1]._closeFromServer() })
    act(() => { vi.advanceTimersByTime(5999) })
    expect(FakeWebSocket.instances).toHaveLength(2) // ainda não, faltam 1ms pros 6s
    act(() => { vi.advanceTimersByTime(1) })
    expect(FakeWebSocket.instances).toHaveLength(3) // 2ª tentativa: 6s (dobrou)

    // Conecta com sucesso -- reseta o contador de tentativas.
    act(() => { FakeWebSocket.instances[2]._open() })
    act(() => { FakeWebSocket.instances[2]._closeFromServer() })
    act(() => { vi.advanceTimersByTime(2999) })
    expect(FakeWebSocket.instances).toHaveLength(3) // ainda não, voltou pro delay base de 3s
    act(() => { vi.advanceTimersByTime(1) })
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  // HARD_TERMINAL_CLOSE_CODES: nenhum resolve reconectando, seja porque o
  // relay recusou/encerrou de propósito (4002/4003/4004) ou porque a sessão
  // ainda existe com um token incompatível (4001 -- não é o que acontece
  // num reboot, ver comentário em HARD_TERMINAL_CLOSE_CODES acima). Os
  // outros 2 códigos "terminais" do relay (4000/4005) têm teste PRÓPRIO
  // logo abaixo (grupo RETRY_ELIGIBLE, comportamento diferente).
  it.each([4001, 4002, 4003, 4004])('não reconecta e vira erro de verdade quando o fechamento é terminal de verdade (código %i)', (code) => {
    vi.useFakeTimers()
    const canvasRef = makeCanvasRef()
    const onStatusChange = vi.fn()
    renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef, onStatusChange,
    }))
    expect(FakeWebSocket.instances).toHaveLength(1)

    act(() => { FakeWebSocket.instances[0]._closeFromServer(code) })
    act(() => { vi.advanceTimersByTime(60000) })

    expect(FakeWebSocket.instances).toHaveLength(1) // não tentou reconectar
    expect(onStatusChange).toHaveBeenCalledWith('error')
    expect(onStatusChange).not.toHaveBeenCalledWith('disconnected')
    expect(onStatusChange).not.toHaveBeenCalledWith('waiting-for-machine')
  })

  // 17/11/2026: 4000 (sessão não existe mais) e 4005 (companion caiu com a
  // sessão ainda registrada) viraram RETRY_ELIGIBLE -- plausivelmente a
  // MÁQUINA reiniciou, não um blip de rede nem um erro de verdade. O hook
  // em si NÃO reconecta sozinho nesse caso (reconectar no MESMO sessionId
  // não resolveria, o servidor já descartou a sessão) -- só reporta
  // 'waiting-for-machine' e deixa o chamador (LiveSessionWindow, ver
  // reconnect()) decidir o que fazer a partir daí.
  //
  // 4001 (token inválido) FICA DE FORA desse grupo de propósito (achado 🔴
  // do code-reviewer, ver HARD_TERMINAL_CLOSE_CODES acima): 4001 só é
  // emitido quando a sessão AINDA EXISTE no servidor com um token
  // diferente do apresentado -- não é o que acontece num reboot (reboot
  // leva a 4000/4005). Tratar como retry abriria uma 2ª sessão enquanto a
  // antiga (token incompatível) continua viva, mascarando um bug real.
  it.each([4000, 4005])('reporta waiting-for-machine (não error) quando o fechamento é elegível pra retry (código %i)', (code) => {
    vi.useFakeTimers()
    const canvasRef = makeCanvasRef()
    const onStatusChange = vi.fn()
    renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef, onStatusChange,
    }))
    expect(FakeWebSocket.instances).toHaveLength(1)

    act(() => { FakeWebSocket.instances[0]._closeFromServer(code) })
    act(() => { vi.advanceTimersByTime(60000) })

    expect(FakeWebSocket.instances).toHaveLength(1) // o hook em si não reconecta sozinho
    expect(onStatusChange).toHaveBeenCalledWith('waiting-for-machine')
    expect(onStatusChange).not.toHaveBeenCalledWith('error')
    expect(onStatusChange).not.toHaveBeenCalledWith('disconnected')
  })

  it('reconnect() dispara uma nova conexão usando os parâmetros ATUAIS (mesmo depois de waiting-for-machine)', () => {
    vi.useFakeTimers()
    const canvasRef = makeCanvasRef()
    const onStatusChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ sessionId, dashboardToken }) => useLiveSession({
        serverUrl: 'https://s.example.com', sessionId, dashboardToken, mode: 'shadow', canvasRef, onStatusChange,
      }),
      { initialProps: { sessionId: 's1', dashboardToken: 'tok1' } },
    )
    expect(FakeWebSocket.instances).toHaveLength(1)

    act(() => { FakeWebSocket.instances[0]._closeFromServer(4005) })
    expect(onStatusChange).toHaveBeenCalledWith('waiting-for-machine')
    expect(FakeWebSocket.instances).toHaveLength(1) // ainda não reconectou sozinho

    // simula LiveSessionWindow obtendo uma sessão NOVA (api.live.start) e
    // atualizando as props antes de chamar reconnect()
    rerender({ sessionId: 's2', dashboardToken: 'tok2' })
    act(() => { result.current.reconnect() })

    expect(FakeWebSocket.instances).toHaveLength(2) // reconnect() abriu um WS novo
    expect(FakeWebSocket.instances[1].url).toContain('sessionId=s2')
    expect(FakeWebSocket.instances[1].url).toContain('token=tok2')
  })

  it('para de reconectar quando o componente desmonta (usuário fechou a janela)', () => {
    vi.useFakeTimers()
    const canvasRef = makeCanvasRef()
    const { unmount } = renderHook(() => useLiveSession({
      serverUrl: 'https://s.example.com', sessionId: 's1', dashboardToken: 'tok', mode: 'shadow', canvasRef,
    }))
    expect(FakeWebSocket.instances).toHaveLength(1)

    act(() => { FakeWebSocket.instances[0]._closeFromServer() }) // queda transitória, agendaria reconexão
    unmount() // mas o usuário fechou a janela antes do timer disparar
    act(() => { vi.advanceTimersByTime(10000) })

    expect(FakeWebSocket.instances).toHaveLength(1) // nunca reconectou
  })

  it('mensagem de texto file-transfer-progress chama onFileTransferStatus em vez de drawFrame', () => {
    const canvasRef = makeCanvasRef()
    const onFileTransferStatus = vi.fn()
    renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef, onFileTransferStatus,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    ws._message(JSON.stringify({ type: 'file-transfer-progress', bytesReceived: 50, bytesTotal: 100 }))

    expect(onFileTransferStatus).toHaveBeenCalledWith({ type: 'file-transfer-progress', bytesReceived: 50, bytesTotal: 100 })
  })

  // companion-reconnecting/-reconnected: o relay dá uma folga antes de
  // matar a sessão de vez quando o companion cai de forma inesperada
  // (liveSessionRelay.js) -- o WS dashboard↔servidor nunca fecha nesse meio
  // tempo (por isso não é um close code, é mensagem de texto pela mesma
  // conexão), só os frames param. Sem avisar a UI, a tela ficava congelada
  // sem nenhuma explicação.
  it('companion-reconnecting muda status pra "reconnecting", companion-reconnected volta pra "connected"', () => {
    const canvasRef = makeCanvasRef()
    const onStatusChange = vi.fn()
    renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef, onStatusChange,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    onStatusChange.mockClear() // limpa a chamada de 'connected' do próprio _open()

    ws._message(JSON.stringify({ type: 'companion-reconnecting' }))
    expect(onStatusChange).toHaveBeenCalledWith('reconnecting')

    ws._message(JSON.stringify({ type: 'companion-reconnected' }))
    expect(onStatusChange).toHaveBeenCalledWith('connected')
  })

  it('sendFileTransfer manda type file-transfer com downloadUrl/fileName/destDir', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => {
      result.current.sendFileTransfer('https://blob/x?sas', 'instalador.exe', 'C:\\Users\\Loja\\Desktop')
    })

    expect(ws.sent).toContain(JSON.stringify({
      type: 'file-transfer', downloadUrl: 'https://blob/x?sas', fileName: 'instalador.exe', destDir: 'C:\\Users\\Loja\\Desktop',
    }))
  })

  // Mesma defesa em profundidade que já cobre sendInput/sendMouseEvent/
  // sendKeyEvent (mode shadow não manda nada mesmo com WS aberto) —
  // sendFileTransfer reusa sendInput, então deveria herdar o guard
  // automaticamente, mas essa classe de bug (guard de modo vazando) já
  // gerou 1 CRÍTICO real nesta base (Ctrl+V clipboard, commit 377f8c4).
  it('sendFileTransfer não manda nada em mode shadow', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'shadow', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    act(() => { ws._open() })

    act(() => {
      result.current.sendFileTransfer('https://blob/x?sas', 'instalador.exe', 'C:\\Users\\Loja\\Desktop')
    })

    expect(ws.sent).toHaveLength(0)
  })

  // Direção contrária (máquina remota -> operador) — espelho dos 2 testes
  // de sendFileTransfer acima.
  it('sendFileDownload manda type file-download com remotePath/uploadUrl', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => {
      result.current.sendFileDownload('C:\\Users\\Loja\\Desktop\\relatorio.pdf', 'https://blob/y?sas-escrita')
    })

    expect(ws.sent).toContain(JSON.stringify({
      type: 'file-download', remotePath: 'C:\\Users\\Loja\\Desktop\\relatorio.pdf', uploadUrl: 'https://blob/y?sas-escrita',
    }))
  })

  it('sendFileDownload não manda nada em mode shadow', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'shadow', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    act(() => { ws._open() })

    act(() => {
      result.current.sendFileDownload('C:\\Users\\Loja\\Desktop\\relatorio.pdf', 'https://blob/y?sas-escrita')
    })

    expect(ws.sent).toHaveLength(0)
  })

  it('mensagem de texto file-download-progress chama onFileTransferStatus (mesmo callback de file-transfer-*)', () => {
    const canvasRef = makeCanvasRef()
    const onFileTransferStatus = vi.fn()
    renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef, onFileTransferStatus,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    ws._message(JSON.stringify({ type: 'file-download-progress', bytesReceived: 30, bytesTotal: 100 }))

    expect(onFileTransferStatus).toHaveBeenCalledWith({ type: 'file-download-progress', bytesReceived: 30, bytesTotal: 100 })
  })

  // sendListRemoteDir/remote-dir-listing/-error: navegador de arquivos
  // dual-pane (FileBrowserModal.jsx) -- espelho dos testes de
  // sendFileTransfer/sendFileDownload acima.
  it('sendListRemoteDir manda type list-remote-dir com remoteDir + requestId crescente', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => {
      result.current.sendListRemoteDir('C:\\Users\\Loja\\Desktop')
    })
    expect(ws.sent).toContain(JSON.stringify({ type: 'list-remote-dir', remoteDir: 'C:\\Users\\Loja\\Desktop', requestId: 1 }))

    act(() => {
      result.current.sendListRemoteDir('C:\\Users\\Loja\\Desktop\\Projetos')
    })
    expect(ws.sent).toContain(JSON.stringify({ type: 'list-remote-dir', remoteDir: 'C:\\Users\\Loja\\Desktop\\Projetos', requestId: 2 }))
  })

  it('sendListRemoteDir não manda nada em mode shadow', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'shadow', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    act(() => { ws._open() })

    act(() => {
      result.current.sendListRemoteDir('C:\\Users\\Loja\\Desktop')
    })

    expect(ws.sent).toHaveLength(0)
  })

  it('mensagem remote-dir-listing/-error com requestId do último pedido chama onRemoteDirListing, nunca onFileTransferStatus', () => {
    const canvasRef = makeCanvasRef()
    const onRemoteDirListing = vi.fn()
    const onFileTransferStatus = vi.fn()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef, onRemoteDirListing, onFileTransferStatus,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => { result.current.sendListRemoteDir('C:\\Users\\Loja\\Desktop') }) // requestId=1
    const listing = { type: 'remote-dir-listing', path: 'C:\\Users\\Loja\\Desktop', entries: [{ name: 'a.txt', isDir: false, size: 1 }], requestId: 1 }
    ws._message(JSON.stringify(listing))

    expect(onRemoteDirListing).toHaveBeenCalledWith(listing)
    expect(onFileTransferStatus).not.toHaveBeenCalled()
  })

  // Achado 🟡 do code-reviewer: cada list-remote-dir roda numa goroutine
  // própria no companion, sem ordem garantida de conclusão -- a resposta
  // de um pedido já ABANDONADO (ex: operador entrou numa pasta de rede
  // lenta, depois "⬆" pra uma rápida) não pode chegar depois e fazer a UI
  // "voltar" sozinha pro diretório antigo.
  it('resposta de um list-remote-dir abandonado (requestId antigo) é descartada', () => {
    const canvasRef = makeCanvasRef()
    const onRemoteDirListing = vi.fn()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef, onRemoteDirListing,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => { result.current.sendListRemoteDir('C:\\pasta-lenta') }) // requestId=1
    act(() => { result.current.sendListRemoteDir('C:\\pasta-rapida') }) // requestId=2 -- abandona o 1º

    // A resposta da pasta LENTA (requestId=1) chega DEPOIS, mesmo tendo
    // sido pedida primeiro -- tem que ser ignorada.
    ws._message(JSON.stringify({ type: 'remote-dir-listing', path: 'C:\\pasta-lenta', entries: [], requestId: 1 }))
    expect(onRemoteDirListing).not.toHaveBeenCalled()

    // A resposta certa (requestId=2) chega e É aceita.
    const listingCerto = { type: 'remote-dir-listing', path: 'C:\\pasta-rapida', entries: [], requestId: 2 }
    ws._message(JSON.stringify(listingCerto))
    expect(onRemoteDirListing).toHaveBeenCalledWith(listingCerto)
  })

  // sendBrowseRemoteFolder/remote-folder-picked/-cancelled/-error: dialog
  // nativo "Procurar pasta" aberto NA TELA remota (ver
  // agent/folderpicker_windows.go) -- mesmo espelho de requestId
  // crescente/correlação/descarte de pedido abandonado já testado acima
  // pra sendListRemoteDir.
  it('sendBrowseRemoteFolder manda type browse-remote-folder com requestId crescente', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => { result.current.sendBrowseRemoteFolder() })
    expect(ws.sent).toContain(JSON.stringify({ type: 'browse-remote-folder', requestId: 1 }))

    act(() => { result.current.sendBrowseRemoteFolder() })
    expect(ws.sent).toContain(JSON.stringify({ type: 'browse-remote-folder', requestId: 2 }))
  })

  it('sendBrowseRemoteFolder não manda nada em mode shadow', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'shadow', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    act(() => { ws._open() })

    act(() => { result.current.sendBrowseRemoteFolder() })

    expect(ws.sent).toHaveLength(0)
  })

  it.each(['remote-folder-picked', 'remote-folder-pick-cancelled', 'remote-folder-pick-error'])(
    'mensagem %s com requestId do último pedido chama onRemoteFolderPickResult, nunca onFileTransferStatus/onRemoteDirListing',
    (type) => {
      const canvasRef = makeCanvasRef()
      const onRemoteFolderPickResult = vi.fn()
      const onFileTransferStatus = vi.fn()
      const onRemoteDirListing = vi.fn()
      const { result } = renderHook(() => useLiveSession({
        serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
        mode: 'normal', canvasRef, onRemoteFolderPickResult, onFileTransferStatus, onRemoteDirListing,
      }))
      const ws = FakeWebSocket.instances[0]
      ws._open()
      act(() => { result.current.sendBrowseRemoteFolder() }) // requestId=1
      const msg = { type, path: 'C:\\Users\\Loja\\Documents', requestId: 1 }
      ws._message(JSON.stringify(msg))

      expect(onRemoteFolderPickResult).toHaveBeenCalledWith(msg)
      expect(onFileTransferStatus).not.toHaveBeenCalled()
      expect(onRemoteDirListing).not.toHaveBeenCalled()
    },
  )

  // Mesmo achado 🟡 do code-reviewer de list-remote-dir acima -- 2 cliques
  // seguidos no botão "📂" (ex: fechou o 1º dialog sem querer, clicou de
  // novo) não pode deixar a resposta do pedido ABANDONADO navegar pra um
  // caminho que o operador já não está mais esperando.
  it('resposta de um browse-remote-folder abandonado (requestId antigo) é descartada', () => {
    const canvasRef = makeCanvasRef()
    const onRemoteFolderPickResult = vi.fn()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef, onRemoteFolderPickResult,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => { result.current.sendBrowseRemoteFolder() }) // requestId=1
    act(() => { result.current.sendBrowseRemoteFolder() }) // requestId=2 -- abandona o 1º

    ws._message(JSON.stringify({ type: 'remote-folder-picked', path: 'C:\\pedido-velho', requestId: 1 }))
    expect(onRemoteFolderPickResult).not.toHaveBeenCalled()

    const resultCerto = { type: 'remote-folder-picked', path: 'C:\\pedido-novo', requestId: 2 }
    ws._message(JSON.stringify(resultCerto))
    expect(onRemoteFolderPickResult).toHaveBeenCalledWith(resultCerto)
  })

  // Achado 🟠 do code-reviewer (14/11/2026): o timeout de segurança do
  // dashboard (LiveSessionWindow.jsx, browsingRemoteTimeoutMs) chama
  // abandonBrowseRemoteFolder() quando o companion nunca responde a
  // tempo -- sem isto, uma resposta REAL chegando bem depois (operador
  // demorou mais de 2min escolhendo a pasta) ainda bateria o requestId e
  // navegaria o painel remoto sozinho, bem depois do operador já ter
  // visto "não respondeu a tempo".
  it('abandonBrowseRemoteFolder descarta a resposta real que chegar depois do timeout ter desistido', () => {
    const canvasRef = makeCanvasRef()
    const onRemoteFolderPickResult = vi.fn()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef, onRemoteFolderPickResult,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => { result.current.sendBrowseRemoteFolder() }) // requestId=1

    // Timeout do dashboard dispara ANTES do operador terminar de escolher
    // a pasta -- desarma a correlação, sem mandar nada novo.
    act(() => { result.current.abandonBrowseRemoteFolder() })

    // A resposta real chega só agora, com o MESMO requestId=1 de antes --
    // tem que ser descartada, não navegar o painel remoto sozinho.
    ws._message(JSON.stringify({ type: 'remote-folder-picked', path: 'C:\\tarde-demais', requestId: 1 }))
    expect(onRemoteFolderPickResult).not.toHaveBeenCalled()
  })

  // sendClipboardGetFile/clipboard-file-result: fluxo Ctrl+C remoto->local
  // (LiveSessionWindow.jsx) -- mesmo espelho de requestId crescente/
  // correlação/descarte de pedido abandonado já testado acima pra
  // sendListRemoteDir/remote-dir-listing.
  it('sendClipboardGetFile manda type clipboard-get-file com requestId crescente', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => { result.current.sendClipboardGetFile() })
    expect(ws.sent).toContain(JSON.stringify({ type: 'clipboard-get-file', requestId: 1 }))

    act(() => { result.current.sendClipboardGetFile() })
    expect(ws.sent).toContain(JSON.stringify({ type: 'clipboard-get-file', requestId: 2 }))
  })

  it('sendClipboardGetFile não manda nada em mode shadow', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'shadow', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    act(() => { ws._open() })

    act(() => { result.current.sendClipboardGetFile() })

    expect(ws.sent).toHaveLength(0)
  })

  it('mensagem clipboard-file-result com requestId do último pedido chama onClipboardFileResult, nunca onFileTransferStatus/onRemoteDirListing', () => {
    const canvasRef = makeCanvasRef()
    const onClipboardFileResult = vi.fn()
    const onFileTransferStatus = vi.fn()
    const onRemoteDirListing = vi.fn()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef, onClipboardFileResult, onFileTransferStatus, onRemoteDirListing,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => { result.current.sendClipboardGetFile() }) // requestId=1
    const resultMsg = { type: 'clipboard-file-result', path: 'C:\\Users\\Loja\\Desktop\\nota.txt', requestId: 1 }
    ws._message(JSON.stringify(resultMsg))

    expect(onClipboardFileResult).toHaveBeenCalledWith(resultMsg)
    expect(onFileTransferStatus).not.toHaveBeenCalled()
    expect(onRemoteDirListing).not.toHaveBeenCalled()
  })

  it('resposta de um clipboard-get-file abandonado (requestId antigo) é descartada', () => {
    const canvasRef = makeCanvasRef()
    const onClipboardFileResult = vi.fn()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef, onClipboardFileResult,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => { result.current.sendClipboardGetFile() }) // requestId=1 (ex: 1º Ctrl+C)
    act(() => { result.current.sendClipboardGetFile() }) // requestId=2 (2º Ctrl+C rápido) -- abandona o 1º

    ws._message(JSON.stringify({ type: 'clipboard-file-result', path: 'C:\\arquivo-velho.txt', requestId: 1 }))
    expect(onClipboardFileResult).not.toHaveBeenCalled()

    const resultCerto = { type: 'clipboard-file-result', path: 'C:\\arquivo-novo.txt', requestId: 2 }
    ws._message(JSON.stringify(resultCerto))
    expect(onClipboardFileResult).toHaveBeenCalledWith(resultCerto)
  })

  // sendClipboardGetSequence/clipboard-sequence-result: round-trip
  // BASELINE separado (ver LiveSessionWindow.jsx, handleCtrlCFromRemote) --
  // mesmo espelho de correlação por requestId já testado acima.
  it('sendClipboardGetSequence manda type clipboard-get-sequence com requestId crescente, próprio de clipboard-get-file', () => {
    const canvasRef = makeCanvasRef()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => { result.current.sendClipboardGetFile() }) // requestId=1 (próprio de clipboard-get-file)
    act(() => { result.current.sendClipboardGetSequence() }) // requestId=1 (próprio de clipboard-get-sequence, contador separado)

    expect(ws.sent).toContain(JSON.stringify({ type: 'clipboard-get-file', requestId: 1 }))
    expect(ws.sent).toContain(JSON.stringify({ type: 'clipboard-get-sequence', requestId: 1 }))
  })

  it('mensagem clipboard-sequence-result chama onClipboardSequenceResult, nunca onClipboardFileResult', () => {
    const canvasRef = makeCanvasRef()
    const onClipboardSequenceResult = vi.fn()
    const onClipboardFileResult = vi.fn()
    const { result } = renderHook(() => useLiveSession({
      serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
      mode: 'normal', canvasRef, onClipboardSequenceResult, onClipboardFileResult,
    }))
    const ws = FakeWebSocket.instances[0]
    ws._open()
    act(() => { result.current.sendClipboardGetSequence() }) // requestId=1
    const resultMsg = { type: 'clipboard-sequence-result', sequence: 42, requestId: 1 }
    ws._message(JSON.stringify(resultMsg))

    expect(onClipboardSequenceResult).toHaveBeenCalledWith(resultMsg)
    expect(onClipboardFileResult).not.toHaveBeenCalled()
  })
})
