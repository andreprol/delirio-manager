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
})
