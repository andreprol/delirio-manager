# Liberar Tecla Windows na Sessão Remota — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar de bloquear a tecla Windows (keyCode 91/92) no modo Normal da sessão ao vivo, confiando nas redes de segurança já existentes (`heldKeysRef` + release em blur/visibilitychange + botão "Liberar teclas travadas").

**Architecture:** Mudança de 1 arquivo, zero protocolo novo — remove o early-return que descarta 91/92 antes de `sendKeyEvent`, em `dashboard/src/components/LiveSessionWindow.jsx`.

**Tech Stack:** React (Electron renderer), Vitest + Testing Library (suíte já existente do dashboard).

---

### Task 1: Remover o bloqueio da tecla Windows

**Files:**
- Modify: `dashboard/src/components/LiveSessionWindow.jsx:7-16,345,382`
- Test: `dashboard/src/__tests__/LiveSessionWindow.test.jsx:119-135`

- [ ] **Step 1: Substituir o teste que trava o comportamento ANTIGO por um que trava o NOVO**

Em `dashboard/src/__tests__/LiveSessionWindow.test.jsx`, substituir o bloco das linhas 119-135
(comentário + teste `'mode normal: tecla Windows (keyCode 91/92) NUNCA é encaminhada'`) por:

```javascript
  // 04/11/2026: tecla Windows era bloqueada de propósito (abria o Menu
  // Iniciar LOCAL e roubava o foco antes do keyup, travando a tecla
  // "pressionada" na máquina remota). 11/11/2026: André pediu de volta —
  // as redes de segurança que já existem (heldKeysRef solta tudo em
  // blur/visibilitychange + botão "Liberar teclas travadas") cobrem o
  // mesmo risco pra QUALQUER tecla, Windows incluída. Agora é encaminhada
  // como qualquer outra.
  it('mode normal: tecla Windows (keyCode 91/92) é encaminhada normalmente', () => {
    render(<LiveSessionWindow />)
    fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

    fireEvent.keyDown(window, { keyCode: 91 })
    fireEvent.keyUp(window, { keyCode: 91 })
    fireEvent.keyDown(window, { keyCode: 92 })
    fireEvent.keyUp(window, { keyCode: 92 })

    expect(sendKeyEventMock).toHaveBeenCalledWith('keydown', 91)
    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 91)
    expect(sendKeyEventMock).toHaveBeenCalledWith('keydown', 92)
    expect(sendKeyEventMock).toHaveBeenCalledWith('keyup', 92)
  })
```

- [ ] **Step 2: Rodar o teste e confirmar que falha contra o código atual**

Run: `cd dashboard && npx vitest run src/__tests__/LiveSessionWindow.test.jsx -t "tecla Windows"`
Expected: FAIL — `sendKeyEventMock` não foi chamado com `91`/`92` (código atual ainda bloqueia).

- [ ] **Step 3: Remover o bloqueio no componente**

Em `dashboard/src/components/LiveSessionWindow.jsx`, remover as linhas 7-16 inteiras (comentário +
`const BLOCKED_KEYCODES = new Set([91, 92])`), deixando o arquivo começar assim:

```javascript
import { useState, useEffect, useRef, useCallback } from 'react'
import { useLiveSession } from '../hooks/useLiveSession'
import { api, setServerUrl, setAdminSecret } from '../api'

const MOUSE_BUTTON = { 0: 'left', 2: 'right' }

// Ctrl (esquerdo) + 'V' — mesmos VKs de EMERGENCY_RELEASE_KEYCODES/onKeyDown.
const VK_CONTROL = 17
const VK_V = 86
```

Depois, remover as 2 linhas que checam `BLOCKED_KEYCODES`:
- linha (hoje 345) dentro de `onKeyDown`: `if (BLOCKED_KEYCODES.has(e.keyCode)) return`
- linha (hoje 382) dentro de `onKeyUp`: `if (BLOCKED_KEYCODES.has(e.keyCode)) return`

`onKeyDown` passa a começar direto pela checagem de Ctrl+V; `onKeyUp` passa a começar direto pela
checagem do keyup órfão de 'V'. `EMERGENCY_RELEASE_KEYCODES` (lista do botão "Liberar teclas
travadas") **não muda** — continua incluindo 91/92, agora fazendo ainda mais sentido (tecla real
que pode ficar presa).

- [ ] **Step 4: Rodar o teste de novo e confirmar que passa**

Run: `cd dashboard && npx vitest run src/__tests__/LiveSessionWindow.test.jsx`
Expected: PASS — todos os testes do arquivo, incluindo o novo.

- [ ] **Step 5: Rodar a suíte inteira do dashboard pra garantir zero regressão**

Run: `cd dashboard && npm test`
Expected: PASS — mesma contagem de testes de antes, menos 0 (1 teste substituído, não removido).

- [ ] **Step 6: Commit**

```bash
cd dashboard
git add src/components/LiveSessionWindow.jsx src/__tests__/LiveSessionWindow.test.jsx
git commit -m "feat(dashboard): libera tecla Windows na sessao Normal

Remove o bloqueio de 04/11 (BLOCKED_KEYCODES). As redes de seguranca ja
existentes (heldKeysRef solta tudo em blur/visibilitychange + botao
'Liberar teclas travadas') cobrem o mesmo risco de tecla presa pra
qualquer tecla, Windows incluida. Pedido do Andre, spec em
docs/superpowers/specs/2026-11-11-acesso-remoto-winkey-file-transfer-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Rollout

Dashboard-only — cai na regra fixa do projeto (`release:auto` após verificação). Testar ao vivo em
1 máquina (BOH) antes de considerar fechado: abrir sessão Normal, apertar tecla Windows, confirmar
que o Menu Iniciar remoto abre e que soltar/trocar de janela não trava nada (rede de segurança já
testada em 04/11, só confirmar que ainda se aplica com a tecla liberada).
