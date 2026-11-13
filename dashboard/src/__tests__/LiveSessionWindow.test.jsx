import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LiveSessionWindow } from '../components/LiveSessionWindow'

const sendInputMock = vi.fn()
const sendMouseEventMock = vi.fn()
const sendKeyEventMock = vi.fn()
const sendClipboardPasteMock = vi.fn()
const sendFileTransferMock = vi.fn()
const sendFileDownloadMock = vi.fn()
let lastUseLiveSessionArgs = null

vi.mock('../hooks/useLiveSession', () => ({
  useLiveSession: (args) => {
    lastUseLiveSessionArgs = args
    return {
      sendInput: sendInputMock,
      sendMouseEvent: sendMouseEventMock,
      sendKeyEvent: sendKeyEventMock,
      sendClipboardPaste: sendClipboardPasteMock,
      sendFileTransfer: sendFileTransferMock,
      sendFileDownload: sendFileDownloadMock,
    }
  },
}))

vi.mock('../api', () => ({
  api: {
    live: {
      stop: vi.fn().mockResolvedValue({ ok: true }),
      getFileUploadUrl: vi.fn().mockResolvedValue({ uploadUrl: 'https://blob/x?sas-up', downloadUrl: 'https://blob/x?sas-down' }),
      getFileDownloadUrl: vi.fn().mockResolvedValue({ uploadUrl: 'https://blob/y?sas-up', downloadUrl: 'https://blob/y?sas-down' }),
    },
  },
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
    readClipboardFilePath: vi.fn().mockResolvedValue(null),
    pickFile: vi.fn().mockResolvedValue(null),
    readLocalFile: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    getPathForFile: vi.fn().mockResolvedValue('C:\\Users\\Andre\\Downloads\\driver.exe'),
    downloadFile: vi.fn().mockResolvedValue(true),
    onNormalWindowVisibilityChange: vi.fn((cb) => {
      window.electronAPI.__fireNormalWindowVisibility = (data) => cb(data)
      return () => {}
    }),
    getNormalWindowVisibility: vi.fn().mockResolvedValue({ visibleNormalCount: 0 }),
    onWinKeyCombo: vi.fn((cb) => {
      window.electronAPI.__fireWinKeyCombo = (combo) => cb(combo)
      return () => {}
    }),
  }
})

describe('LiveSessionWindow', () => {
  it('mostra "conectando" até receber os parâmetros da sessão via IPC', () => {
    render(<LiveSessionWindow />)
    expect(screen.getByText(/conectando/i)).toBeInTheDocument()
  })

  // status 'reconnecting' (companion caiu, mas o relay dá uma folga antes
  // de matar a sessão de vez, ver liveSessionRelay.js) precisa de um texto
  // PRÓPRIO -- sem isso caía no mesmo "Conectando..." genérico da conexão
  // inicial, indistinguível de uma sessão nova, em vez de avisar que é uma
  // reconexão de uma sessão já em andamento.
  it('status "reconnecting" mostra "Reconectando à máquina remota...", distinto de "Conectando..."', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('reconnecting') })
    expect(screen.getByText(/Reconectando à máquina remota/i)).toBeInTheDocument()
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

  // Achado 🟡 do code-reviewer (13/11/2026): durante 'reconnecting'
  // (companion caiu, relay dá uma folga antes de matar a sessão — ver
  // liveSessionRelay.js) o socket dashboard↔servidor continua aberto, só
  // os frames param. Sem este guard, clique/tecla eram mandados de verdade
  // e descartados em silêncio no servidor (companionWs null), sem nenhum
  // feedback ao operador.
  it('mode normal, status "reconnecting": mousedown/keydown NÃO chamam sendMouseEvent/sendKeyEvent', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })
    act(() => { lastUseLiveSessionArgs.onStatusChange('reconnecting') })

    const canvas = screen.getByTestId('live-canvas')
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 20, button: 0 })
    fireEvent.mouseMove(canvas, { clientX: 15, clientY: 25 })
    fireEvent.mouseUp(canvas, { clientX: 10, clientY: 20, button: 0 })
    fireEvent.keyDown(window, { key: 'a', keyCode: 65 })

    expect(sendMouseEventMock).not.toHaveBeenCalled()
    expect(sendKeyEventMock).not.toHaveBeenCalledWith('keydown', 65)

    // Volta a 'connected' -- confirma que o guard é só temporário, não
    // trava o input pro resto da sessão.
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })
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

  // 04/11/2026: tecla Windows era bloqueada de propósito (abria o Menu
  // Iniciar LOCAL e roubava o foco antes do keyup, travando a tecla
  // "pressionada" na máquina remota). 11/11/2026: André especificou 3
  // regras mais finas — (1) nunca em Shadow (já garantido pelo relay,
  // sem mudança aqui), (2) janela minimizada só afeta a máquina local (já
  // garantido pelo SO — janela sem foco não recebe keydown), (3) 2+
  // janelas Normal visíveis ao mesmo tempo = Windows não funciona em
  // NENHUMA, mesmo na que tem foco. Só a tecla Windows tem essa 3ª
  // restrição extra (mouse e demais teclas continuam normais
  // independente de quantas janelas estão abertas).
  it('mode normal: tecla Windows encaminhada quando so 1 janela Normal esta visivel', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    act(() => { window.electronAPI.__fireNormalWindowVisibility({ visibleNormalCount: 1 }) })

    fireEvent.keyDown(window, { keyCode: 91 })
    fireEvent.keyUp(window, { keyCode: 91 })

    expect(sendKeyEventMock).toHaveBeenCalledWith('keydown', 91)
    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 91)
  })

  it('mode normal: tecla Windows NAO encaminhada quando 2+ janelas Normal estao visiveis', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    act(() => { window.electronAPI.__fireNormalWindowVisibility({ visibleNormalCount: 2 }) })

    fireEvent.keyDown(window, { keyCode: 91 })
    fireEvent.keyUp(window, { keyCode: 91 })
    fireEvent.keyDown(window, { keyCode: 92 })
    fireEvent.keyUp(window, { keyCode: 92 })

    expect(sendKeyEventMock).not.toHaveBeenCalled()
  })

  it('mode normal: segurar tecla Windows durante mudanca de contagem ainda manda o keyup (nao trava a tecla remota)', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    // count=1: keydown e forwardado e registrado em heldKeysRef
    act(() => { window.electronAPI.__fireNormalWindowVisibility({ visibleNormalCount: 1 }) })
    fireEvent.keyDown(window, { keyCode: 91 })
    expect(sendKeyEventMock).toHaveBeenCalledWith('keydown', 91)

    // outra janela Normal abre enquanto a tecla ainda esta fisicamente pressionada
    act(() => { window.electronAPI.__fireNormalWindowVisibility({ visibleNormalCount: 2 }) })

    // soltar a tecla agora -- o keyup TEM que ser mandado mesmo com count=2,
    // porque o keydown correspondente ja foi mandado (fonte da verdade: heldKeysRef)
    fireEvent.keyUp(window, { keyCode: 91 })
    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 91)
  })

  it('mode normal: tecla normal (ex: "a") continua encaminhada mesmo com 2+ janelas Normal visiveis', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    act(() => { window.electronAPI.__fireNormalWindowVisibility({ visibleNormalCount: 2 }) })

    fireEvent.keyDown(window, { keyCode: 65 })
    fireEvent.keyUp(window, { keyCode: 65 })

    expect(sendKeyEventMock).toHaveBeenCalledWith('keydown', 65)
    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 65)
  })

  it('mode normal: tecla Windows NAO encaminhada antes de qualquer dado de visibilidade chegar (default seguro)', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    // nem __fireNormalWindowVisibility foi chamado, nem o pull (mockResolvedValue 0) teve tempo de resolver
    fireEvent.keyDown(window, { keyCode: 91 })

    expect(sendKeyEventMock).not.toHaveBeenCalled()
  })

  it('mode normal: tecla Windows funciona so com o pull resolvido, sem nenhum push', async () => {
    window.electronAPI.getNormalWindowVisibility = vi.fn().mockResolvedValue({ visibleNormalCount: 1 })
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    fireEvent.keyDown(window, { keyCode: 91 })
    expect(sendKeyEventMock).toHaveBeenCalledWith('keydown', 91)
  })

  it('mode normal: tecla normal (ex: "a") ainda é encaminhada normalmente', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    fireEvent.keyDown(window, { keyCode: 65 })
    fireEvent.keyUp(window, { keyCode: 65 })

    expect(sendKeyEventMock).toHaveBeenCalledWith('keydown', 65)
    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 65)
  })

  // winkeyhook (processo nativo separado, ver electron/main.js) manda 1
  // evento por combo detectado -- aditivo ao onKeyDown/regra 3 acima, não
  // depende de visibleNormalCount (o hook só roda com foco, já resolve
  // ambiguidade de janela por construção).
  it('mode normal: winkeyhook "win-tap" manda keydown+keyup de Win pro remoto', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    act(() => { window.electronAPI.__fireWinKeyCombo('win-tap') })

    expect(sendKeyEventMock).toHaveBeenCalledWith('keydown', 91)
    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 91)
  })

  it.each([
    ['win+r', 82],
    ['win+e', 69],
    ['win+d', 68],
  ])('mode normal: winkeyhook "%s" manda a sequência Win+tecla completa pro remoto', (combo, vk) => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    act(() => { window.electronAPI.__fireWinKeyCombo(combo) })

    expect(sendKeyEventMock.mock.calls).toEqual([
      ['keydown', 91],
      ['keydown', vk],
      ['keyup', vk],
      ['keyup', 91],
    ])
  })

  it('mode shadow: winkeyhook nunca é escutado (sem controle remoto pra travar)', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    expect(window.electronAPI.onWinKeyCombo).not.toHaveBeenCalled()
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

  // 3ª via de transferência de arquivo: Ctrl+C num arquivo no Explorer,
  // Ctrl+V na sessão ao vivo -- mesmo caminho do botão/drag (upload pro
  // Blob + sendFileTransfer), NUNCA um paste de teclado no remoto.
  it('Ctrl+V com arquivo copiado no clipboard local sobe o arquivo pro remoto, não chama sendClipboardPaste', async () => {
    window.electronAPI.readClipboardFilePath = vi.fn().mockResolvedValue('C:\\Users\\Andre\\Downloads\\driver.exe')
    window.electronAPI.readLocalFile = vi.fn().mockResolvedValue(new ArrayBuffer(4))
    global.fetch = vi.fn().mockResolvedValue({ ok: true })

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })
    act(() => { lastUseLiveSessionArgs.onSessionInfo({ remoteUser: 'Loja' }) })

    await act(async () => {
      fireEvent.keyDown(window, { keyCode: 86, ctrlKey: true })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.electronAPI.readLocalFile).toHaveBeenCalledWith('C:\\Users\\Andre\\Downloads\\driver.exe')
    expect(sendFileTransferMock).toHaveBeenCalled()
    expect(window.electronAPI.readClipboardText).not.toHaveBeenCalled()
    expect(sendClipboardPasteMock).not.toHaveBeenCalled()
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

  it('mode normal: botao Enviar arquivo pede upload-url, sobe pro blob e manda sendFileTransfer', async () => {
    window.electronAPI.pickFile = vi.fn().mockResolvedValue('C:\\Users\\Andre\\Downloads\\instalador.exe')
    window.electronAPI.readLocalFile = vi.fn().mockResolvedValue(new ArrayBuffer(8))
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) // PUT pro blob

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })
    // session-info (username real, mandado 1x pelo companion) -- sem isso
    // defaultDestDir fica vazio e o novo guard de destino recusa o envio.
    act(() => { lastUseLiveSessionArgs.onSessionInfo({ remoteUser: 'Loja' }) })

    await act(async () => {
      fireEvent.click(screen.getByText(/Enviar arquivo/i))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.live.getFileUploadUrl).toHaveBeenCalledWith('s1', 'instalador.exe', 8)
    expect(global.fetch).toHaveBeenCalledWith('https://blob/x?sas-up', expect.objectContaining({ method: 'PUT' }))
    expect(sendFileTransferMock).toHaveBeenCalledWith('https://blob/x?sas-down', 'instalador.exe', expect.any(String))
  })

  // Direção contrária (máquina remota -> operador) -- espelho do teste
  // acima, mas sem upload do lado do dashboard: o companion é quem sobe pro
  // Blob (simulado aqui só pela chegada de file-download-done via WS), e
  // quem baixa de fato é o Electron (window.electronAPI.downloadFile).
  it('mode normal: botão Baixar arquivo pede download-url, manda sendFileDownload, e baixa via Electron quando o companion termina', async () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })

    const input = screen.getByPlaceholderText(/Caminho do arquivo no remoto/i)
    fireEvent.change(input, { target: { value: 'C:\\Users\\Loja\\Desktop\\relatorio.pdf' } })

    await act(async () => {
      fireEvent.click(screen.getByText(/Baixar arquivo/i))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.live.getFileDownloadUrl).toHaveBeenCalledWith('s1', 'relatorio.pdf')
    expect(sendFileDownloadMock).toHaveBeenCalledWith('C:\\Users\\Loja\\Desktop\\relatorio.pdf', 'https://blob/y?sas-up')
    expect(window.electronAPI.downloadFile).not.toHaveBeenCalled() // só depois do companion avisar, não antes

    // Companion termina de subir pro Blob -- só AGORA o Electron baixa de fato.
    await act(async () => {
      lastUseLiveSessionArgs.onFileTransferStatus({ type: 'file-download-done' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.electronAPI.downloadFile).toHaveBeenCalledWith('https://blob/y?sas-down')
    expect(screen.getByText(/Arquivo baixado/i)).toBeInTheDocument()
  })

  it('mode normal: Baixar arquivo sem caminho informado recusa, sem chamar getFileDownloadUrl', async () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })

    await act(async () => {
      fireEvent.click(screen.getByText(/Baixar arquivo/i))
      await Promise.resolve()
    })

    expect(api.live.getFileDownloadUrl).not.toHaveBeenCalled()
    expect(screen.getByText(/informe o caminho/i)).toBeInTheDocument()
  })

  // Achado 🔴 ALTO do code-reviewer (13/11/2026): `window.electronAPI?.downloadFile(url).then()...`
  // encadeado a partir do optional chaining -- se electronAPI faltar
  // (ex: preload ainda não rodou, versão antiga), a cadeia INTEIRA
  // (then/catch/finally) vira undefined e NENHUM callback roda, travando
  // isTransferring=true pra sempre, sem erro visível. Este teste prova que
  // o guard explícito evita exatamente isso.
  it('file-download-done sem window.electronAPI.downloadFile mostra erro e destrava, não trava pra sempre', async () => {
    delete window.electronAPI.downloadFile // simula electronAPI sem esse método

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })

    const input = screen.getByPlaceholderText(/Caminho do arquivo no remoto/i)
    fireEvent.change(input, { target: { value: 'C:\\Users\\Loja\\Desktop\\relatorio.pdf' } })
    await act(async () => {
      fireEvent.click(screen.getByText(/Baixar arquivo/i))
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      lastUseLiveSessionArgs.onFileTransferStatus({ type: 'file-download-done' })
      await Promise.resolve()
    })

    expect(screen.getByText(/error:/i)).toBeInTheDocument()
    // Destravado -- um 2º "Baixar arquivo" (agora com electronAPI de volta)
    // funciona normalmente, não fica preso em isTransferring pra sempre.
    window.electronAPI.downloadFile = vi.fn().mockResolvedValue(true)
    await act(async () => {
      fireEvent.click(screen.getByText(/Baixar arquivo/i))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.live.getFileDownloadUrl).toHaveBeenCalledTimes(2)
  })

  it('mode shadow: botao Baixar arquivo nao aparece', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    expect(screen.queryByText(/Baixar arquivo/i)).not.toBeInTheDocument()
  })

  it('mode shadow: botao Enviar arquivo nao aparece', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    expect(screen.queryByText(/Enviar arquivo/i)).not.toBeInTheDocument()
  })

  // Achado real (13/11/2026): preventDefault() sozinho no dragover não é
  // suficiente pra um arquivo vindo do Explorer (drag OLE nativo do SO,
  // diferente de um drag interno da página) -- sem setar dropEffect, o
  // Windows nunca deixa o 'drop' nem disparar, cursor mostra bloqueado
  // sobre a janela inteira. André relatou exatamente isso ("nem consegue
  // entrar no frame", nas duas direções).
  it('dragover e dragenter setam dataTransfer.dropEffect = "copy" quando o drag carrega arquivo (drag OLE do Explorer precisa disso)', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    const dropZone = screen.getByTestId('live-session-dropzone')
    const dataTransferOver = { dropEffect: 'none', types: ['Files'] }
    fireEvent.dragOver(dropZone, { dataTransfer: dataTransferOver })
    expect(dataTransferOver.dropEffect).toBe('copy')

    const dataTransferEnter = { dropEffect: 'none', types: ['Files'] }
    fireEvent.dragEnter(dropZone, { dataTransfer: dataTransferEnter })
    expect(dataTransferEnter.dropEffect).toBe('copy')
  })

  // Achado do code-reviewer: setar dropEffect incondicionalmente faria
  // QUALQUER drag sobre a janela (texto selecionado, imagem de outra
  // página) mostrar o cursor de "copiar", mesmo sem ser um arquivo —
  // handleDrop só lê e.dataTransfer.files, nunca faz nada com esse drag.
  it('dragover NÃO seta dropEffect quando o drag não é de arquivo (ex: texto selecionado)', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    const dropZone = screen.getByTestId('live-session-dropzone')
    const dataTransferOver = { dropEffect: 'none', types: ['text/plain'] }
    fireEvent.dragOver(dropZone, { dataTransfer: dataTransferOver })
    expect(dataTransferOver.dropEffect).toBe('none')
  })

  it('mode normal: soltar arquivo na janela usa webUtils.getPathForFile e chama sendLocalFileToRemote', async () => {
    window.electronAPI.getPathForFile = vi.fn().mockResolvedValue('C:\\Users\\Andre\\Downloads\\driver.exe')
    window.electronAPI.readLocalFile = vi.fn().mockResolvedValue(new ArrayBuffer(4))
    global.fetch = vi.fn().mockResolvedValue({ ok: true })

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })
    act(() => { lastUseLiveSessionArgs.onSessionInfo({ remoteUser: 'Loja' }) })

    const dropZone = screen.getByTestId('live-session-dropzone')
    const file = new File(['conteudo'], 'driver.exe', { type: 'application/octet-stream' })

    await act(async () => {
      fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.electronAPI.getPathForFile).toHaveBeenCalledWith(file)
    expect(window.electronAPI.pickFile).not.toHaveBeenCalled() // drop nao usa o dialog
    expect(window.electronAPI.readLocalFile).toHaveBeenCalledWith('C:\\Users\\Andre\\Downloads\\driver.exe')
  })

  // Achado pelo code-reviewer: sem isso, um drop com a sessao desconectada
  // subia o arquivo pro Blob, chamava sendFileTransfer (que vira no-op
  // silencioso no WS fechado) e nunca recebia file-transfer-done/-error --
  // isTransferring ficava travado em true pra sempre, sem nenhum jeito de
  // tentar de novo exceto fechando a janela inteira.
  it('mode normal, sessao desconectada: soltar arquivo nao sobe pro blob nem trava isTransferring', async () => {
    window.electronAPI.getPathForFile = vi.fn().mockResolvedValue('C:\\Users\\Andre\\Downloads\\driver.exe')
    window.electronAPI.readLocalFile = vi.fn().mockResolvedValue(new ArrayBuffer(4))
    global.fetch = vi.fn().mockResolvedValue({ ok: true })

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    // nunca chama onStatusChange('connected') -- status fica 'connecting'

    const dropZone = screen.getByTestId('live-session-dropzone')
    const file = new File(['conteudo'], 'driver.exe', { type: 'application/octet-stream' })

    await act(async () => {
      fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.electronAPI.readLocalFile).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(sendFileTransferMock).not.toHaveBeenCalled()
    expect(screen.getByText(/sem conexão/i)).toBeInTheDocument()

    // confirma que nao travou: uma 2a tentativa, agora conectada, funciona
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })
    act(() => { lastUseLiveSessionArgs.onSessionInfo({ remoteUser: 'Loja' }) })
    await act(async () => {
      fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(window.electronAPI.readLocalFile).toHaveBeenCalledWith('C:\\Users\\Andre\\Downloads\\driver.exe')
  })

  // Achado real em produção (12/11/2026): session.remoteUser nunca era
  // setado em lugar nenhum (nem MachineCard manda, nem o IPC aceita esse
  // campo) -- defaultDestDir caía sempre no literal "Loja", que quase nunca
  // batia com o usuário de verdade logado na loja. session-info (mandado
  // pelo companion, 1x, via WS) substitui esse fallback morto.
  it('mode normal: session-info (username real do companion) vira o destino default da transferência', async () => {
    window.electronAPI.pickFile = vi.fn().mockResolvedValue('C:\\x\\a.txt')
    window.electronAPI.readLocalFile = vi.fn().mockResolvedValue(new ArrayBuffer(1))
    global.fetch = vi.fn().mockResolvedValue({ ok: true })

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })
    act(() => { lastUseLiveSessionArgs.onSessionInfo({ remoteUser: 'ASS AUXILIAR01' }) })

    await act(async () => {
      fireEvent.click(screen.getByText(/Enviar arquivo/i))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(sendFileTransferMock).toHaveBeenCalledWith(expect.any(String), 'a.txt', 'C:\\Users\\ASS AUXILIAR01\\Desktop')
  })

  // Antes desta sessão, destino sem resposta nenhuma (nem digitado, nem
  // session-info chegado) virava silenciosamente "C:\Users\Loja\Desktop" --
  // agora recusa o envio em vez de mandar um caminho provavelmente errado
  // sem o operador saber.
  it('mode normal: sem session-info nem destino digitado, recusa o envio em vez de adivinhar o caminho', async () => {
    window.electronAPI.pickFile = vi.fn().mockResolvedValue('C:\\x\\a.txt')
    window.electronAPI.readLocalFile = vi.fn().mockResolvedValue(new ArrayBuffer(1))
    global.fetch = vi.fn().mockResolvedValue({ ok: true })

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })
    // nunca chama onSessionInfo

    await act(async () => {
      fireEvent.click(screen.getByText(/Enviar arquivo/i))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.electronAPI.readLocalFile).not.toHaveBeenCalled()
    expect(sendFileTransferMock).not.toHaveBeenCalled()
    expect(screen.getByText(/confirme o caminho/i)).toBeInTheDocument()
  })

  // Achado do code-reviewer (12/11/2026): string só com espaço(s) é truthy
  // em JS -- sem .trim(), passava o guard de destino vazio como se fosse um
  // caminho válido e ia pro companion, que criaria o diretório " " em vez
  // de recusar (mesmo risco de "enviado ✓ mas não está lá" que este fix
  // existe pra evitar).
  it('mode normal: destino só com espaços é tratado como vazio, recusa o envio', async () => {
    window.electronAPI.pickFile = vi.fn().mockResolvedValue('C:\\x\\a.txt')
    window.electronAPI.readLocalFile = vi.fn().mockResolvedValue(new ArrayBuffer(1))
    global.fetch = vi.fn().mockResolvedValue({ ok: true })

    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
    act(() => { lastUseLiveSessionArgs.onStatusChange('connected') })
    // nunca chama onSessionInfo -- defaultDestDir fica vazio, só o campo digitado importa aqui

    const destInput = screen.getByPlaceholderText(/confirme o caminho/i)
    fireEvent.change(destInput, { target: { value: '   ' } })

    await act(async () => {
      fireEvent.click(screen.getByText(/Enviar arquivo/i))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.electronAPI.readLocalFile).not.toHaveBeenCalled()
    expect(sendFileTransferMock).not.toHaveBeenCalled()
    expect(screen.getByText(/confirme o caminho/i)).toBeInTheDocument()
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
