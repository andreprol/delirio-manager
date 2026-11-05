import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LiveSessionWindow } from '../components/LiveSessionWindow'

const sendInputMock = vi.fn()
const sendMouseEventMock = vi.fn()
const sendKeyEventMock = vi.fn()
const sendClipboardPasteMock = vi.fn()
let lastUseLiveSessionArgs = null

vi.mock('../hooks/useLiveSession', () => ({
  useLiveSession: (args) => {
    lastUseLiveSessionArgs = args
    return {
      sendInput: sendInputMock,
      sendMouseEvent: sendMouseEventMock,
      sendKeyEvent: sendKeyEventMock,
      sendClipboardPaste: sendClipboardPasteMock,
    }
  },
}))

vi.mock('../api', () => ({
  api: { live: { stop: vi.fn().mockResolvedValue({ ok: true }) } },
  setServerUrl: vi.fn(),
  setAdminSecret: vi.fn(),
}))

import { api, setServerUrl, setAdminSecret } from '../api'

function fireLiveSessionInit(data) {
  const cb = window.electronAPI.onLiveSessionInit.mock.calls[0][0]
  act(() => { cb(data) })
}

// A janela só encerra pelo X (não existe mais botão "Encerrar sessão") —
// main.js manda 'live-session-cleanup-and-close' via IPC quando o operador
// fecha a janela; os testes simulam isso chamando o callback registrado.
function fireCleanupAndClose() {
  const cb = window.electronAPI.onCleanupAndClose.mock.calls[0][0]
  return cb()
}

beforeEach(() => {
  vi.clearAllMocks()
  lastUseLiveSessionArgs = null
  window.electronAPI = {
    onLiveSessionInit: vi.fn(() => () => {}),
    onCleanupAndClose: vi.fn(() => () => {}),
    cleanupDone: vi.fn(),
    reportCleanupProgress: vi.fn(),
    reportCleanupFailed: vi.fn(),
    convertRecording: vi.fn().mockResolvedValue({ saved: true }),
    getConfig: vi.fn().mockResolvedValue({ serverUrl: 'https://s.example.com', adminSecret: 'secret-xyz' }),
    readClipboardText: vi.fn().mockResolvedValue('shutdown /s /t 300'),
  }
})

describe('LiveSessionWindow', () => {
  it('mostra "conectando" até receber os parâmetros da sessão via IPC', () => {
    render(<LiveSessionWindow />)
    expect(screen.getByText(/conectando/i)).toBeInTheDocument()
  })

  // Regressão achada em produção: esta janela é um BrowserWindow/processo
  // separado da janela principal, com sua PRÓPRIA instância do módulo
  // api.js (serverUrl/adminSecret nascem vazios aqui, mesmo configurados
  // na janela principal) — api.live.stop sempre dava 401 ao encerrar,
  // mesmo logo depois de Shadow/Normal terem funcionado (esses passam pelo
  // MachineCard, na janela principal).
  it('carrega serverUrl/adminSecret do config.json ao montar, mesmo antes da sessão chegar', async () => {
    await act(async () => {
      render(<LiveSessionWindow />)
      await Promise.resolve()
    })
    expect(window.electronAPI.getConfig).toHaveBeenCalled()
    expect(setServerUrl).toHaveBeenCalledWith('https://s.example.com')
    expect(setAdminSecret).toHaveBeenCalledWith('secret-xyz')
  })

  it('depois do init, passa mode/sessionId certos pro useLiveSession', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    expect(lastUseLiveSessionArgs.sessionId).toBe('s1')
    expect(lastUseLiveSessionArgs.mode).toBe('normal')
  })

  it('mostra o nome da máquina (não o UUID) no cabeçalho, quando recebido', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', machineName: 'PC-CAIXA-02', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    expect(screen.getByText(/PC-CAIXA-02/)).toBeInTheDocument()
    expect(screen.queryByText(/m1/)).not.toBeInTheDocument()
  })

  it('sem machineName (ex: sessão iniciada antes do rollout), cai pro machineId', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    expect(screen.getByText(/m1/)).toBeInTheDocument()
  })

  it('mode normal: mousedown no canvas chama sendMouseEvent', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    const canvas = screen.getByTestId('live-canvas')
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 20, button: 0 })
    expect(sendMouseEventMock).toHaveBeenCalledWith('mousedown', 10, 20, 'left')
  })

  it('mode shadow: mousedown no canvas NÃO chama sendMouseEvent nem sendKeyEvent', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    const canvas = screen.getByTestId('live-canvas')
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 20, button: 0 })
    fireEvent.keyDown(window, { key: 'a', keyCode: 65 })
    expect(sendMouseEventMock).not.toHaveBeenCalled()
    expect(sendKeyEventMock).not.toHaveBeenCalled()
  })

  // Achado ao vivo 04/11/2026 (ASSBOH): apertar a tecla Windows abre o
  // Menu Iniciar LOCAL e rouba o foco da janela antes do keyup disparar —
  // o navegador nunca vê o keyup, a máquina remota fica com a tecla
  // Windows logicamente travada, e toda tecla seguinte vira atalho (Win+E
  // abre Explorer etc). Sem uso legítimo pra abrir o Menu Iniciar remoto
  // num suporte de loja — nunca encaminhar essa tecla.
  it('mode normal: tecla Windows (keyCode 91/92) NUNCA é encaminhada', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    fireEvent.keyDown(window, { keyCode: 91 })
    fireEvent.keyUp(window, { keyCode: 91 })
    fireEvent.keyDown(window, { keyCode: 92 })
    fireEvent.keyUp(window, { keyCode: 92 })

    expect(sendKeyEventMock).not.toHaveBeenCalled()
  })

  it('mode normal: tecla normal (ex: "a") ainda é encaminhada normalmente', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    fireEvent.keyDown(window, { keyCode: 65 })
    fireEvent.keyUp(window, { keyCode: 65 })

    expect(sendKeyEventMock).toHaveBeenCalledWith('keydown', 65)
    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 65)
  })

  // Ctrl+V é interceptado: nunca encaminha o keydown cru de 'V' (colaria o
  // clipboard da máquina REMOTA) — lê o clipboard LOCAL via electronAPI e
  // manda clipboard-paste, que o companion resolve numa chamada só.
  it('mode normal: Ctrl+V lê o clipboard local e manda sendClipboardPaste, sem encaminhar "V" cru', async () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    await act(async () => {
      fireEvent.keyDown(window, { keyCode: 86, ctrlKey: true })
      await Promise.resolve()
    })

    expect(window.electronAPI.readClipboardText).toHaveBeenCalled()
    expect(sendClipboardPasteMock).toHaveBeenCalledWith('shutdown /s /t 300')
    expect(sendKeyEventMock).not.toHaveBeenCalledWith('keydown', 86)
  })

  it('Ctrl+V com clipboard local vazio não manda clipboard-paste', async () => {
    window.electronAPI.readClipboardText = vi.fn().mockResolvedValue('')
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    await act(async () => {
      fireEvent.keyDown(window, { keyCode: 86, ctrlKey: true })
      await Promise.resolve()
    })

    expect(sendClipboardPasteMock).not.toHaveBeenCalled()
  })

  // injectClipboardPaste (agent) solta Ctrl no remoto ao final da sequência
  // sintética — se o operador ainda segura Ctrl fisicamente (Ctrl desceu
  // antes de V, keydown já foi mandado), reafirma o keydown de Ctrl pro
  // remoto não ficar dessincronizado do estado local.
  it('Ctrl ainda pressionado localmente ao colar: reafirma keydown de Ctrl depois do paste', async () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    fireEvent.keyDown(window, { keyCode: 17 }) // Ctrl desce primeiro
    sendKeyEventMock.mockClear()

    await act(async () => {
      fireEvent.keyDown(window, { keyCode: 86, ctrlKey: true })
      await Promise.resolve()
    })

    expect(sendKeyEventMock).toHaveBeenCalledWith('keydown', 17)
  })

  // 🔴 bug real achado pelo code-reviewer: a versão anterior checava
  // `!e.repeat` DENTRO da condição do if — um evento repeat caía no `if`
  // como falso e seguia pro fluxo normal, encaminhando o keydown cru de 'V'
  // pro remoto (com Ctrl já down lá, isso disparava um Ctrl+V de verdade,
  // colando o clipboard REMOTO — o exato vetor que a interceptação existe
  // pra bloquear). Preventivo: cobre os 2 sintomas, não só "não chamou
  // sendClipboardPaste de novo".
  it('auto-repeat do SO segurando Ctrl+V não dispara paste de novo NEM encaminha o "V" cru', async () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    await act(async () => {
      fireEvent.keyDown(window, { keyCode: 86, ctrlKey: true, repeat: true })
      await Promise.resolve()
    })

    expect(sendClipboardPasteMock).not.toHaveBeenCalled()
    expect(sendKeyEventMock).not.toHaveBeenCalledWith('keydown', 86)
  })

  // 🟡 achado do code-reviewer: keyup de 'V' nunca foi registrado em
  // heldKeysRef (o keydown foi interceptado) — sem este guard, soltar a
  // tecla física mandaria um keyup órfão pro remoto, sem keydown
  // correspondente nesse canal.
  it('soltar "V" depois de um Ctrl+V interceptado não manda keyup órfão', async () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    await act(async () => {
      fireEvent.keyDown(window, { keyCode: 86, ctrlKey: true })
      await Promise.resolve()
    })
    sendKeyEventMock.mockClear()

    fireEvent.keyUp(window, { keyCode: 86 })

    expect(sendKeyEventMock).not.toHaveBeenCalledWith('keyup', 86)
  })

  // Defesa em profundidade pro mesmo problema: QUALQUER tecla cujo keyup
  // se perca (não só Windows — perder o foco por qualquer motivo) não
  // pode ficar travada na máquina remota pra sempre. blur/aba escondida
  // soltam tudo que ainda está marcado como pressionado.
  it('perder o foco da janela (blur) solta automaticamente teclas que ainda estavam pressionadas', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    fireEvent.keyDown(window, { keyCode: 17 }) // Ctrl pressionado, keyup nunca chega
    sendKeyEventMock.mockClear()

    fireEvent.blur(window)

    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 17)
  })

  it('aba escondida (visibilitychange) também solta teclas pressionadas', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    fireEvent.keyDown(window, { keyCode: 18 }) // Alt pressionado
    sendKeyEventMock.mockClear()

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    fireEvent(document, new Event('visibilitychange'))

    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 18)
  })

  // Botão manual (⌨️ Liberar teclas travadas): rede de segurança separada
  // do rastreamento automático — cobre qualquer tecla travada que o
  // rastreamento não previu (ex: ficou presa antes desta janela abrir).
  it('mode normal: botão "Liberar teclas travadas" manda keyup pra Win/Ctrl/Alt/Shift', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })

    fireEvent.click(screen.getByText('⌨️ Liberar teclas travadas'))

    ;[91, 92, 17, 162, 163, 18, 164, 165, 16, 160, 161].forEach((code) => {
      expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', code)
    })
  })

  it('desmontar o componente com tecla ainda pressionada também solta ela', () => {
    const { unmount } = render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    fireEvent.keyDown(window, { keyCode: 16 }) // Shift pressionado, nunca solto
    sendKeyEventMock.mockClear()

    unmount()

    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 16)
  })

  it('mode shadow: botão "Liberar teclas travadas" não aparece', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    expect(screen.queryByText('⌨️ Liberar teclas travadas')).not.toBeInTheDocument()
  })

  it('mode normal: botão de bloqueio aparece e manda lock-local-input/unlock-local-input', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })

    const button = screen.getByText('🔒 Travar usuário')
    fireEvent.click(button)
    expect(sendInputMock).toHaveBeenCalledWith({ type: 'lock-local-input' })
    expect(screen.getByText('🔓 Destravar usuário')).toBeInTheDocument()

    fireEvent.click(screen.getByText('🔓 Destravar usuário'))
    expect(sendInputMock).toHaveBeenCalledWith({ type: 'unlock-local-input' })
    expect(screen.getByText('🔒 Travar usuário')).toBeInTheDocument()
  })

  // Achado 🟠 do code-reviewer: sendInput (useLiveSession.js) já é no-op se
  // a conexão não estiver aberta, mas o botão continuava clicável e a UI
  // mentia (dizia "travado" sem ter mandado nada de verdade pro companion).
  it('sem conexão (status != connected), o botão de bloqueio fica desabilitado', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    const button = screen.getByText('🔒 Travar usuário')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(sendInputMock).not.toHaveBeenCalled()
  })

  it('mode shadow: botão de bloqueio de input não aparece (não há controle remoto pra travar)', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    expect(screen.queryByText('🔒 Travar usuário')).not.toBeInTheDocument()
  })

  it('ao receber live-session-cleanup-and-close, para, avisa o servidor e chama cleanupDone', async () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    const cleanupCb = window.electronAPI.onCleanupAndClose.mock.calls[0][0]
    await act(async () => { await cleanupCb() })
    expect(api.live.stop).toHaveBeenCalledWith('s1', false)
    expect(window.electronAPI.cleanupDone).toHaveBeenCalled()
  })

  // Regressão achada na revisão cross-cutting: sem o try/catch em
  // stopRecordingIfActive, uma falha do ffmpeg (convertRecording rejeitado)
  // travava endSession pra sempre — fechar a janela com gravação ativa
  // parecia simplesmente não fazer nada.
  it('se converter a gravação falhar, ainda chama api.live.stop e cleanupDone (não trava o encerramento)', async () => {
    let recorderInstance
    HTMLCanvasElement.prototype.captureStream = vi.fn(() => ({}))
    global.MediaRecorder = vi.fn(function FakeMediaRecorder() {
      recorderInstance = this
      this.start = vi.fn()
      this.stop = vi.fn(() => { this.onstop?.() })
    })
    window.electronAPI.convertRecording = vi.fn().mockRejectedValue(new Error('ffmpeg falhou'))

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    act(() => { fireEvent.click(screen.getByText('⏺ Gravar')) })
    expect(recorderInstance.start).toHaveBeenCalled()

    await act(async () => { await fireCleanupAndClose() })

    expect(recorderInstance.stop).toHaveBeenCalled()
    expect(window.electronAPI.convertRecording).toHaveBeenCalled()
    expect(api.live.stop).toHaveBeenCalledWith('s1', true)
    expect(window.electronAPI.cleanupDone).toHaveBeenCalled()
  })

  // Regressão achada na revisão cross-cutting: 2 chamadas de cleanup quase
  // juntas (ex: o IPC de cleanup disparando de novo antes da 1ª terminar)
  // chamavam api.live.stop 2x pra mesma sessão — compartilham a mesma
  // promise de endSession.
  it('2 chamadas de cleanup quase juntas só chamam api.live.stop 1x', async () => {
    let resolveStop
    api.live.stop.mockImplementation(() => new Promise((resolve) => { resolveStop = resolve }))

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    let cleanupPromise1, cleanupPromise2
    await act(async () => {
      cleanupPromise1 = fireCleanupAndClose() // dispara endSession, ainda não resolveu
      cleanupPromise2 = fireCleanupAndClose() // chamada concorrente, enquanto a 1ª ainda está em voo
      // deixa o microtask chain de endSession (await stopRecordingIfActive)
      // avançar até de fato chamar api.live.stop, pra resolveStop existir.
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      resolveStop({ ok: true })
      await cleanupPromise1
      await cleanupPromise2
    })

    expect(api.live.stop).toHaveBeenCalledTimes(1)
    api.live.stop.mockResolvedValue({ ok: true }) // restaura o default pros próximos testes
  })

  // Regressão achada na VERIFICAÇÃO do fix anterior (não no fix original):
  // sem resetar endSessionPromiseRef/ending em caso de falha, uma rejeição
  // de api.live.stop (erro de rede) deixava a promise compartilhada
  // cacheada pra sempre — o encerramento ficava travado permanentemente,
  // sem nenhuma tentativa nova possível.
  // reportCleanupFailed avisa o main process pra resetar __cleanupStarted —
  // sem isso, um 2º X da janela não reenviaria 'live-session-cleanup-and-close'
  // (achado 🔴 na revisão: a única tentativa real ficava a única, a janela
  // travava até o timeout de 15s fechar sem nunca avisar o servidor).
  it('falha ao encerrar mostra o erro, não fecha a janela, avisa o main process, e uma 2ª tentativa funciona', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.live.stop.mockRejectedValueOnce(new Error('rede indisponível'))

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    await act(async () => { await fireCleanupAndClose() })

    expect(consoleErrorSpy).toHaveBeenCalledWith('Falha ao encerrar sessão ao vivo:', expect.any(Error))
    expect(screen.getByText(/rede indisponível/)).toBeInTheDocument()
    expect(window.electronAPI.reportCleanupFailed).toHaveBeenCalled()
    expect(screen.getByText('⏺ Gravar')).not.toBeDisabled()
    expect(window.electronAPI.cleanupDone).not.toHaveBeenCalled()

    api.live.stop.mockResolvedValueOnce({ ok: true })
    await act(async () => { await fireCleanupAndClose() })

    expect(api.live.stop).toHaveBeenCalledTimes(2)
    expect(window.electronAPI.cleanupDone).toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  // Regressão achada na 3ª rodada de verificação (não na 2ª): wasRecording
  // era recalculado de mediaRecorderRef.current em cada tentativa, mas
  // stopRecordingIfActive já zera essa ref antes de api.live.stop poder
  // falhar — numa 2ª tentativa (depois de uma 1ª falha de rede), o
  // `recorded` mandado ao servidor vinha errado (false), mesmo com a
  // gravação de verdade feita e salva no disco do operador.
  it('retry depois de falha de rede ainda manda recorded=true se gravou', async () => {
    let recorderInstance
    HTMLCanvasElement.prototype.captureStream = vi.fn(() => ({}))
    global.MediaRecorder = vi.fn(function FakeMediaRecorder() {
      recorderInstance = this
      this.start = vi.fn()
      this.stop = vi.fn(() => { this.onstop?.() })
    })
    api.live.stop.mockRejectedValueOnce(new Error('rede indisponível'))

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    act(() => { fireEvent.click(screen.getByText('⏺ Gravar')) })
    expect(recorderInstance.start).toHaveBeenCalled()

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { await fireCleanupAndClose() }) // 1ª tentativa, falha
    expect(consoleErrorSpy).toHaveBeenCalled()

    api.live.stop.mockResolvedValueOnce({ ok: true })
    await act(async () => { await fireCleanupAndClose() }) // 2ª tentativa, sucesso

    expect(api.live.stop).toHaveBeenNthCalledWith(2, 's1', true)
    consoleErrorSpy.mockRestore()
  })

  // Regressão achada na 4ª rodada de verificação: wasRecordingRef só era
  // setado dentro de endSession (derivado de mediaRecorderRef.current) — se
  // o operador parasse a gravação manualmente (⏹) ANTES de clicar "Encerrar
  // sessão", mediaRecorderRef já estaria null quando endSession rodasse, e
  // recorded=false seria mandado ao servidor mesmo com o .mp4 real já salvo.
  it('parar a gravação manualmente antes de encerrar ainda manda recorded=true', async () => {
    let recorderInstance
    HTMLCanvasElement.prototype.captureStream = vi.fn(() => ({}))
    global.MediaRecorder = vi.fn(function FakeMediaRecorder() {
      recorderInstance = this
      this.start = vi.fn()
      this.stop = vi.fn(() => { this.onstop?.() })
    })

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    act(() => { fireEvent.click(screen.getByText('⏺ Gravar')) })
    expect(recorderInstance.start).toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByText('⏹ Parar gravação')) // para ANTES de encerrar
    })
    expect(recorderInstance.stop).toHaveBeenCalled()

    await act(async () => { await fireCleanupAndClose() }) // sem gravar de novo

    expect(api.live.stop).toHaveBeenCalledWith('s1', true)
  })

  // Regressão achada na 5ª rodada de verificação (🔴 CRÍTICO): parar a
  // gravação manualmente e fechar a janela em seguida, ANTES da conversão
  // (ffmpeg + dialog de salvar) terminar, fazia endSession ver
  // mediaRecorderRef já null (zerado sincronamente pela parada manual) e
  // seguir direto pra api.live.stop/cleanupDone — fechando a janela com a
  // conversão da 1ª chamada ainda rodando contra ela. stopRecordingIfActive
  // agora compartilha a mesma promise entre as 2 chamadas.
  it('parar manualmente + fechar a janela rápido espera a conversão terminar antes de api.live.stop', async () => {
    HTMLCanvasElement.prototype.captureStream = vi.fn(() => ({}))
    global.MediaRecorder = vi.fn(function FakeMediaRecorder() {
      this.start = vi.fn()
      this.stop = vi.fn(() => { this.onstop?.() })
    })
    let resolveConvert
    window.electronAPI.convertRecording = vi.fn(() => new Promise((resolve) => { resolveConvert = resolve }))

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    act(() => { fireEvent.click(screen.getByText('⏺ Gravar')) })

    await act(async () => {
      fireEvent.click(screen.getByText('⏹ Parar gravação')) // dispara a conversão, ainda não resolveu
      fireCleanupAndClose() // fecha a janela quase junto, antes da conversão terminar
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.live.stop).not.toHaveBeenCalled() // ainda esperando a mesma conversão
    expect(window.electronAPI.cleanupDone).not.toHaveBeenCalled()

    await act(async () => {
      resolveConvert({ saved: true })
    })

    expect(api.live.stop).toHaveBeenCalledWith('s1', true)
    expect(window.electronAPI.cleanupDone).toHaveBeenCalled()
  })

  // Regressão achada na 6ª rodada de verificação (🔴 CRÍTICO): checar
  // stoppingRef.current ANTES de mediaRecorderRef.current fazia uma 2ª
  // gravação (B), começada enquanto a conversão de uma 1ª (A) ainda está
  // rodando, nunca ser parada de verdade — stopRecordingIfActive devolvia
  // a promise velha de A sem nunca chamar recorder.stop() em B, perdendo B
  // em silêncio. A ordem certa: recorder.stop() de quem está ativo agora
  // roda na hora; só a conversão é que fica na fila atrás da anterior.
  it('gravação B não é perdida se começar enquanto a conversão de A ainda está rodando', async () => {
    const recorders = []
    HTMLCanvasElement.prototype.captureStream = vi.fn(() => ({}))
    global.MediaRecorder = vi.fn(function FakeMediaRecorder() {
      recorders.push(this)
      this.start = vi.fn()
      this.stop = vi.fn(() => { this.onstop?.() })
    })
    let resolveConvertA
    window.electronAPI.convertRecording = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveConvertA = resolve }))
      .mockResolvedValueOnce({ saved: true })

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    // Grava e para A — conversão de A fica pendente (resolveConvertA nunca chamado ainda)
    act(() => { fireEvent.click(screen.getByText('⏺ Gravar')) })
    await act(async () => {
      fireEvent.click(screen.getByText('⏹ Parar gravação'))
    })
    expect(recorders).toHaveLength(1)
    expect(recorders[0].stop).toHaveBeenCalled()

    // Grava B enquanto a conversão de A ainda está em voo, e para B também
    act(() => { fireEvent.click(screen.getByText('⏺ Gravar')) })
    expect(recorders).toHaveLength(2)
    await act(async () => {
      fireEvent.click(screen.getByText('⏹ Parar gravação'))
    })

    // B precisa ter sido parado DE VERDADE, não ignorado por causa da fila de A
    expect(recorders[1].stop).toHaveBeenCalled()

    // Resolve a conversão de A — a de B deve rodar em seguida, sequencial
    await act(async () => {
      resolveConvertA({ saved: true })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.electronAPI.convertRecording).toHaveBeenCalledTimes(2)
  })

  // Regressão achada na 7ª rodada de verificação (🟠 ALTO): o try/catch
  // dentro de convertThisRecording cobria só convertRecording, não
  // new Blob(...)/blob.arrayBuffer() — uma falha ali rejeitava a promise
  // encadeada sem handler, envenenando a fila inteira (qualquer gravação
  // enfileirada atrás nunca rodava).
  it('falha ao ler o blob da gravação A não envenena a fila — gravação B seguinte ainda roda', async () => {
    const recorders = []
    HTMLCanvasElement.prototype.captureStream = vi.fn(() => ({}))
    global.MediaRecorder = vi.fn(function FakeMediaRecorder() {
      recorders.push(this)
      this.start = vi.fn()
      this.stop = vi.fn(() => { this.onstop?.() })
    })
    const originalArrayBuffer = Blob.prototype.arrayBuffer
    let blobCallCount = 0
    Blob.prototype.arrayBuffer = vi.fn(function () {
      blobCallCount++
      if (blobCallCount === 1) return Promise.reject(new Error('falha ao ler blob'))
      return originalArrayBuffer.call(this)
    })

    try {
      render(<LiveSessionWindow />)
      fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

      // Grava e para A — blob.arrayBuffer() falha, antes de chegar em convertRecording
      act(() => { fireEvent.click(screen.getByText('⏺ Gravar')) })
      await act(async () => {
        fireEvent.click(screen.getByText('⏹ Parar gravação'))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByText(/falha ao ler blob/)).toBeInTheDocument()

      // Grava e para B — tem que rodar normal, não travado pela falha de A
      act(() => { fireEvent.click(screen.getByText('⏺ Gravar')) })
      await act(async () => {
        fireEvent.click(screen.getByText('⏹ Parar gravação'))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(recorders).toHaveLength(2)
      // A nunca chegou em convertRecording (falhou antes, em arrayBuffer);
      // B chegou — só 1 chamada no total.
      expect(window.electronAPI.convertRecording).toHaveBeenCalledTimes(1)
    } finally {
      Blob.prototype.arrayBuffer = originalArrayBuffer
    }
  })

  // Regressão: sem o heartbeat, a rede de segurança de timeout fixo do
  // main.js forçaria o fechamento da janela com o cleanup ainda em
  // andamento (ex: dialog de salvar a gravação aberto), perdendo a
  // gravação em silêncio.
  it('cleanup via X da janela manda reportCleanupProgress (heartbeat pro main process)', async () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    const cleanupCb = window.electronAPI.onCleanupAndClose.mock.calls[0][0]

    await act(async () => { await cleanupCb() })

    expect(window.electronAPI.reportCleanupProgress).toHaveBeenCalled()
  })
})
