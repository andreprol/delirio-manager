# Liberar Tecla Windows na Sessão Remota — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encaminhar a tecla Windows (keyCode 91/92) no modo Normal, mas só quando exatamente 1
janela de sessão ao vivo em modo Normal está visível (não minimizada) no momento — mouse e demais
teclas continuam sem essa restrição.

**Architecture:** `main.js` mantém um registro das janelas de sessão ao vivo abertas, recalcula e
transmite (IPC) quantas estão em modo Normal e visíveis sempre que esse número muda; cada
`LiveSessionWindow.jsx` guarda esse número e só encaminha keyCode 91/92 quando ele é exatamente 1.
As redes de segurança já existentes (`heldKeysRef` + blur/visibilitychange + botão "Liberar teclas
travadas") continuam cobrindo qualquer tecla presa, Windows incluída.

**Tech Stack:** Electron (main + preload + renderer), React, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-11-acesso-remoto-winkey-file-transfer-design.md` (seção
"Feature 1", revisada 11/11/2026).

---

### Task 1: Registro de janelas + broadcast de visibilidade (`main.js`)

**Files:**
- Modify: `dashboard/electron/main.js:82-167`
- Test: `dashboard/electron/__tests__/main.test.js` (checar primeiro se existe algum teste de
  `main.js` hoje — `ls dashboard/electron/__tests__/` — se não existir, este módulo não tem suíte
  própria ainda; seguir pro Step 1 mesmo assim, cobrindo só as funções puras extraídas, testáveis
  sem Electron real)

- [ ] **Step 1: Extrair a lógica de contagem como função pura testável**

Electron (`BrowserWindow` real) não roda em Jest/Vitest sem mock pesado — extrair a parte que
IMPORTA (contar janelas Normal visíveis a partir de uma lista de objetos simples) numa função pura,
sem depender da classe `BrowserWindow` de verdade. Criar `dashboard/electron/liveSessionRegistry.js`:

```javascript
// dashboard/electron/liveSessionRegistry.js
'use strict';

// Registro das janelas de sessão ao vivo abertas no processo principal.
// countVisibleNormalWindows é a parte PURA (testável sem Electron real) da
// regra 3 de André (11/11/2026): tecla Windows só funciona quando
// EXATAMENTE 1 janela em modo Normal está visivel (nao minimizada) ao
// mesmo tempo.
function countVisibleNormalWindows(windows) {
  return windows.filter((w) => w.mode === 'normal' && !w.minimized && !w.destroyed).length;
}

module.exports = { countVisibleNormalWindows };
```

- [ ] **Step 2: Escrever o teste que falha**

```javascript
// dashboard/electron/__tests__/liveSessionRegistry.test.js
import { describe, it, expect } from 'vitest'
import { countVisibleNormalWindows } from '../liveSessionRegistry'

describe('countVisibleNormalWindows', () => {
  it('conta 0 quando não há janelas', () => {
    expect(countVisibleNormalWindows([])).toBe(0)
  })

  it('conta 1 janela Normal visível', () => {
    expect(countVisibleNormalWindows([{ mode: 'normal', minimized: false, destroyed: false }])).toBe(1)
  })

  it('não conta janela minimizada', () => {
    expect(countVisibleNormalWindows([
      { mode: 'normal', minimized: true, destroyed: false },
      { mode: 'normal', minimized: false, destroyed: false },
    ])).toBe(1)
  })

  it('não conta janela Shadow', () => {
    expect(countVisibleNormalWindows([
      { mode: 'shadow', minimized: false, destroyed: false },
      { mode: 'normal', minimized: false, destroyed: false },
    ])).toBe(1)
  })

  it('não conta janela já destruída', () => {
    expect(countVisibleNormalWindows([
      { mode: 'normal', minimized: false, destroyed: true },
    ])).toBe(0)
  })

  it('conta 2 quando 2 janelas Normal estão visíveis ao mesmo tempo', () => {
    expect(countVisibleNormalWindows([
      { mode: 'normal', minimized: false, destroyed: false },
      { mode: 'normal', minimized: false, destroyed: false },
    ])).toBe(2)
  })
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `cd dashboard && npx vitest run electron/__tests__/liveSessionRegistry.test.js`
Expected: FAIL — `Cannot find module '../liveSessionRegistry'`.

- [ ] **Step 4: Confirmar que o arquivo do Step 1 já faz passar**

Run: `cd dashboard && npx vitest run electron/__tests__/liveSessionRegistry.test.js`
Expected: PASS — 6 testes.

- [ ] **Step 5: Plugar o registro em `main.js`**

Em `dashboard/electron/main.js`, perto do topo do arquivo (junto de outros `require`):

```javascript
const { countVisibleNormalWindows } = require('./liveSessionRegistry')
```

Adicionar, antes de `function createLiveSessionWindow(params)` (linha 102 hoje):

```javascript
// liveSessionWindows: todas as janelas de sessão ao vivo abertas (Normal ou
// Shadow). Cada BrowserWindow ganha __liveSessionMode pra countVisibleNormalWindows
// saber quais contam. broadcastNormalWindowVisibility recalcula e manda pra
// TODAS (inclusive a que acabou de mudar) sempre que algo relevante muda —
// regra 3 de André (11/11/2026): tecla Windows só funciona quando
// exatamente 1 janela Normal está visível ao mesmo tempo.
const liveSessionWindows = new Set()

function broadcastNormalWindowVisibility() {
  const snapshot = [...liveSessionWindows].map((w) => ({
    mode: w.__liveSessionMode,
    minimized: w.isDestroyed() ? false : w.isMinimized(),
    destroyed: w.isDestroyed(),
  }))
  const visibleNormalCount = countVisibleNormalWindows(snapshot)
  for (const w of liveSessionWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send('live-session:normal-window-visibility', { visibleNormalCount })
    }
  }
}
```

Dentro de `createLiveSessionWindow(params)`, logo após `const liveWin = new BrowserWindow({...})`
(linha 116 hoje):

```javascript
  liveWin.__liveSessionMode = params.mode
  liveSessionWindows.add(liveWin)
  liveWin.on('minimize', broadcastNormalWindowVisibility)
  liveWin.on('restore', broadcastNormalWindowVisibility)
  liveWin.on('show', broadcastNormalWindowVisibility)
```

Dentro do `liveWin.webContents.once('did-finish-load', ...)` (linha 137-139 hoje), depois de mandar
`live-session-init`:

```javascript
  liveWin.webContents.once('did-finish-load', () => {
    liveWin.webContents.send('live-session-init', params)
    broadcastNormalWindowVisibility()
  })
```

E dentro de `liveWin.on('close', ...)` (linha 151 hoje), **dentro do callback, só quando o cleanup
realmente fecha a janela** — como o fechamento de verdade só acontece depois do cleanup assíncrono
(ver `armCleanupSafetyTimer`/`__cleanupDone`), adicionar o `closed` separado (dispara só quando a
janela É DESTRUÍDA de verdade, depois de todo o fluxo de cleanup):

```javascript
  liveWin.on('closed', () => {
    liveSessionWindows.delete(liveWin)
    broadcastNormalWindowVisibility()
  })
```

(Adicionar este novo `liveWin.on('closed', ...)` logo depois do bloco existente `liveWin.on('close', ...)`
— `'close'` é cancelável/usado pro fluxo de cleanup já existente, `'closed'` é o evento que só
dispara quando a janela já foi destruída de verdade, sem conflito com a lógica de cleanup atual.)

- [ ] **Step 6: Rodar a suíte inteira do dashboard**

Run: `cd dashboard && npm test`
Expected: PASS, zero regressão (nenhum teste de `main.js` existia antes tocando este trecho,
`liveSessionRegistry.test.js` novo passa).

- [ ] **Step 7: Commit**

```bash
cd dashboard
git add electron/liveSessionRegistry.js electron/__tests__/liveSessionRegistry.test.js electron/main.js
git commit -m "feat(dashboard): registro de janelas de sessao ao vivo + broadcast de visibilidade Normal

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 2: Expor no preload

**Files:**
- Modify: `dashboard/electron/preload.js:62-66`

- [ ] **Step 1: Adicionar o listener, mesmo padrão de `onCleanupAndClose`**

Em `dashboard/electron/preload.js`, logo após o bloco de `onCleanupAndClose` (linhas 62-66 hoje):

```javascript
  onNormalWindowVisibilityChange: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('live-session:normal-window-visibility', handler)
    return () => ipcRenderer.removeListener('live-session:normal-window-visibility', handler)
  },
```

- [ ] **Step 2: Commit**

```bash
cd dashboard
git add electron/preload.js
git commit -m "feat(dashboard): expoe onNormalWindowVisibilityChange no preload

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 3: Encaminhar a tecla Windows só quando a contagem é 1

**Files:**
- Modify: `dashboard/src/components/LiveSessionWindow.jsx`
- Test: `dashboard/src/__tests__/LiveSessionWindow.test.jsx`

- [ ] **Step 1: Adicionar o mock de `onNormalWindowVisibilityChange` no topo do arquivo de teste**

Em `dashboard/src/__tests__/LiveSessionWindow.test.jsx`, achar onde `window.electronAPI` é montado
pro teste (provavelmente num `beforeEach` perto do topo, junto de `onLiveSessionInit`/
`onCleanupAndClose`/`readClipboardText` — ler esse bloco primeiro com
`grep -n "window.electronAPI" dashboard/src/__tests__/LiveSessionWindow.test.jsx` antes de editar)
e adicionar, no mesmo objeto:

```javascript
    onNormalWindowVisibilityChange: vi.fn((cb) => {
      window.electronAPI.__fireNormalWindowVisibility = (data) => cb(data)
      return () => {}
    }),
```

(`__fireNormalWindowVisibility` é um hook de teste pra simular o IPC chegando — chamar
`window.electronAPI.__fireNormalWindowVisibility({ visibleNormalCount: N })` dentro de um teste
simula o main process mandando a contagem.)

- [ ] **Step 2: Escrever os testes que falham**

```javascript
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

  expect(sendKeyEventMock).not.toHaveBeenCalled()
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

it('mode normal: tecla Windows NAO encaminhada antes de qualquer mensagem de visibilidade chegar (default seguro)', () => {
  render(<LiveSessionWindow />)
  fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

  // nenhum __fireNormalWindowVisibility chamado ainda
  fireEvent.keyDown(window, { keyCode: 91 })

  expect(sendKeyEventMock).not.toHaveBeenCalled()
})
```

Substituir o teste antigo (`'mode normal: tecla Windows (keyCode 91/92) NUNCA é encaminhada'`, hoje
nas linhas 119-135) pelos 4 testes acima — o comportamento mudou de "nunca" pra "só quando a
contagem é 1".

- [ ] **Step 3: Rodar e confirmar que falham**

Run: `cd dashboard && npx vitest run src/__tests__/LiveSessionWindow.test.jsx -t "tecla Windows"`
Expected: FAIL — hoje a tecla Windows é SEMPRE bloqueada (`BLOCKED_KEYCODES`), nenhum teste novo
passa ainda.

- [ ] **Step 4: Implementar no componente**

Remover `BLOCKED_KEYCODES` (linhas 7-16 hoje) e as 2 checagens que o usavam (dentro de `onKeyDown`
e `onKeyUp`), igual ao plano anterior. No lugar, adicionar:

```javascript
const VK_LWIN = 91
const VK_RWIN = 92
```

Dentro do componente, perto de `heldKeysRef`:

```javascript
  const visibleNormalCountRef = useRef(0) // 0 = nenhuma mensagem de visibilidade recebida ainda — default seguro, nunca encaminha Win

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onNormalWindowVisibilityChange((data) => {
      visibleNormalCountRef.current = data.visibleNormalCount
    })
    return unsubscribe
  }, [])
```

Em `onKeyDown`, logo no início (antes de `heldKeysRef.current.add(e.keyCode)`):

```javascript
      if ((e.keyCode === VK_LWIN || e.keyCode === VK_RWIN) && visibleNormalCountRef.current !== 1) {
        return
      }
```

Em `onKeyUp`, mesma checagem logo no início:

```javascript
      if ((e.keyCode === VK_LWIN || e.keyCode === VK_RWIN) && visibleNormalCountRef.current !== 1) {
        return
      }
```

`EMERGENCY_RELEASE_KEYCODES` não muda — continua soltando Win/Ctrl/Alt/Shift incondicionalmente no
botão manual, independente da contagem de janelas (rede de segurança não deve ter a mesma
restrição da regra 3 — ela existe justamente pra destravar, não pra ficar mais restrita ainda).

- [ ] **Step 5: Rodar e confirmar que passam**

Run: `cd dashboard && npx vitest run src/__tests__/LiveSessionWindow.test.jsx`
Expected: PASS — suíte inteira do arquivo.

- [ ] **Step 6: Rodar a suíte inteira do dashboard**

Run: `cd dashboard && npm test`
Expected: PASS, zero regressão.

- [ ] **Step 7: Commit**

```bash
cd dashboard
git add src/components/LiveSessionWindow.jsx src/__tests__/LiveSessionWindow.test.jsx
git commit -m "feat(dashboard): tecla Windows encaminhada so quando 1 janela Normal esta visivel

Implementa as 3 regras do Andre (11/11/2026): nunca em Shadow (ja garantido
pelo relay), minimizada = so afeta a maquina local (ja garantido pelo SO,
janela sem foco nao recebe keydown), 2+ janelas Normal visiveis ao mesmo
tempo = Windows nao funciona em nenhuma (novo: broadcast de contagem via
IPC do main process). So a tecla Windows tem essa restricao extra -- mouse
e demais teclas continuam normais.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Rollout

Dashboard-only — cai na regra fixa do projeto (`release:auto` após verificação). Testar ao vivo
antes de considerar fechado: abrir 1 sessão Normal, Windows funciona; abrir uma 2ª sessão Normal
(ambas visíveis), Windows para de funcionar nas duas; minimizar uma, volta a funcionar na outra;
fechar a 2ª, volta a funcionar na que restou.
