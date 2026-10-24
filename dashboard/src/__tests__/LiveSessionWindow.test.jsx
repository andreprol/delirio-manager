import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LiveSessionWindow } from '../components/LiveSessionWindow'

const sendInputMock = vi.fn()
const sendMouseEventMock = vi.fn()
const sendKeyEventMock = vi.fn()
let lastUseLiveSessionArgs = null

vi.mock('../hooks/useLiveSession', () => ({
  useLiveSession: (args) => {
    lastUseLiveSessionArgs = args
    return { sendInput: sendInputMock, sendMouseEvent: sendMouseEventMock, sendKeyEvent: sendKeyEventMock }
  },
}))

vi.mock('../api', () => ({
  api: { live: { stop: vi.fn().mockResolvedValue({ ok: true }) } },
}))

import { api } from '../api'

function fireLiveSessionInit(data) {
  const cb = window.electronAPI.onLiveSessionInit.mock.calls[0][0]
  act(() => { cb(data) })
}

beforeEach(() => {
  vi.clearAllMocks()
  lastUseLiveSessionArgs = null
  window.electronAPI = {
    onLiveSessionInit: vi.fn(() => () => {}),
    onCleanupAndClose: vi.fn(() => () => {}),
    cleanupDone: vi.fn(),
    reportCleanupProgress: vi.fn(),
    convertRecording: vi.fn().mockResolvedValue({ saved: true }),
  }
})

describe('LiveSessionWindow', () => {
  it('mostra "conectando" até receber os parâmetros da sessão via IPC', () => {
    render(<LiveSessionWindow />)
    expect(screen.getByText(/conectando/i)).toBeInTheDocument()
  })

  it('depois do init, passa mode/sessionId certos pro useLiveSession', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    expect(lastUseLiveSessionArgs.sessionId).toBe('s1')
    expect(lastUseLiveSessionArgs.mode).toBe('normal')
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

  it('botão Encerrar sessão chama api.live.stop e depois cleanupDone (fecha a janela)', async () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    await act(async () => {
      fireEvent.click(screen.getByText('Encerrar sessão'))
    })
    expect(api.live.stop).toHaveBeenCalledWith('s1', false)
    expect(window.electronAPI.cleanupDone).toHaveBeenCalled()
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
  // travava endSession pra sempre — "Encerrar sessão" com gravação ativa
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

    await act(async () => {
      fireEvent.click(screen.getByText('Encerrar sessão'))
    })

    expect(recorderInstance.stop).toHaveBeenCalled()
    expect(window.electronAPI.convertRecording).toHaveBeenCalled()
    expect(api.live.stop).toHaveBeenCalledWith('s1', true)
    expect(window.electronAPI.cleanupDone).toHaveBeenCalled()
  })

  // Regressão achada na revisão cross-cutting: clicar "Encerrar sessão" e,
  // antes dessa chamada terminar, o X da janela também disparar o cleanup
  // (ou vice-versa) chamava api.live.stop 2x pra mesma sessão — os dois
  // caminhos agora compartilham a mesma promise de endSession.
  it('botão Encerrar + X da janela quase juntos só chamam api.live.stop 1x', async () => {
    let resolveStop
    api.live.stop.mockImplementation(() => new Promise((resolve) => { resolveStop = resolve }))

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    const cleanupCb = window.electronAPI.onCleanupAndClose.mock.calls[0][0]

    let cleanupPromise
    await act(async () => {
      fireEvent.click(screen.getByText('Encerrar sessão')) // dispara endSession, ainda não resolveu
      cleanupPromise = cleanupCb() // X da janela, enquanto o 1º ainda está em voo
      // deixa o microtask chain de endSession (await stopRecordingIfActive)
      // avançar até de fato chamar api.live.stop, pra resolveStop existir.
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      resolveStop({ ok: true })
      await cleanupPromise
    })

    expect(api.live.stop).toHaveBeenCalledTimes(1)
    api.live.stop.mockResolvedValue({ ok: true }) // restaura o default pros próximos testes
  })

  // Regressão achada na VERIFICAÇÃO do fix anterior (não no fix original):
  // sem resetar endSessionPromiseRef/ending em caso de falha, uma rejeição
  // de api.live.stop (erro de rede) deixava a promise compartilhada
  // cacheada pra sempre — "Encerrar sessão" ficava travado em
  // "Encerrando..." permanentemente, sem nenhuma tentativa nova possível.
  it('falha ao encerrar mostra erro, reabilita o botão, e uma 2ª tentativa funciona', async () => {
    api.live.stop.mockRejectedValueOnce(new Error('rede indisponível'))

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    await act(async () => {
      fireEvent.click(screen.getByText('Encerrar sessão'))
    })

    expect(screen.getByText(/rede indisponível/)).toBeInTheDocument()
    expect(screen.getByText('Encerrar sessão')).not.toBeDisabled()
    expect(window.electronAPI.cleanupDone).not.toHaveBeenCalled()

    api.live.stop.mockResolvedValueOnce({ ok: true })
    await act(async () => {
      fireEvent.click(screen.getByText('Encerrar sessão'))
    })

    expect(api.live.stop).toHaveBeenCalledTimes(2)
    expect(window.electronAPI.cleanupDone).toHaveBeenCalled()
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

    await act(async () => {
      fireEvent.click(screen.getByText('Encerrar sessão')) // 1ª tentativa, falha
    })
    expect(screen.getByText(/rede indisponível/)).toBeInTheDocument()

    api.live.stop.mockResolvedValueOnce({ ok: true })
    await act(async () => {
      fireEvent.click(screen.getByText('Encerrar sessão')) // 2ª tentativa, sucesso
    })

    expect(api.live.stop).toHaveBeenNthCalledWith(2, 's1', true)
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

    await act(async () => {
      fireEvent.click(screen.getByText('Encerrar sessão')) // sem gravar de novo
    })

    expect(api.live.stop).toHaveBeenCalledWith('s1', true)
  })

  // Regressão achada na 5ª rodada de verificação (🔴 CRÍTICO): parar a
  // gravação manualmente e clicar "Encerrar sessão" em seguida, ANTES da
  // conversão (ffmpeg + dialog de salvar) terminar, fazia endSession ver
  // mediaRecorderRef já null (zerado sincronamente pela parada manual) e
  // seguir direto pra api.live.stop/cleanupDone — fechando a janela com a
  // conversão da 1ª chamada ainda rodando contra ela. stopRecordingIfActive
  // agora compartilha a mesma promise entre as 2 chamadas.
  it('parar manualmente + Encerrar sessão rápido espera a conversão terminar antes de api.live.stop', async () => {
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
      fireEvent.click(screen.getByText('Encerrar sessão')) // quase junto, antes da conversão terminar
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
