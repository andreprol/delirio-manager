# Flag "Relógio Novo" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma flag "relógio novo" por IP que faz o `dt-clock-proxy` aceitar, uma única
vez, uma leitura de funcionários muito menor que a anterior — sem isso, o guard de divergência
mascara permanentemente a troca física de um relógio Henry Hexa.

**Architecture:** Lógica pura de bypass extraída para `clock-proxy/newClockFlags.js` (testável em
isolamento, sem Playwright/Express). `clock-proxy/server.js` importa esse módulo pro guard e expõe
`POST /clock/:ip/mark-new`. `server/routes/rh.js` expõe o proxy equivalente na Azure VM. O dashboard
(`ClockStatusGrid.jsx`) ganha um botão por relógio que chama esse endpoint.

**Tech Stack:** Node.js (CommonJS) + Express + Jest (`clock-proxy/`, `server/`) · React + Vitest +
Testing Library (`dashboard/`)

Spec completa: `docs/superpowers/specs/2026-09-10-relogio-novo-flag-design.md`

---

### Task 1: Módulo puro `newClockFlags.js` (lógica de bypass, testável sem Express/Playwright)

**Files:**
- Create: `clock-proxy/newClockFlags.js`
- Test: `clock-proxy/newClockFlags.test.js`

- [ ] **Step 1: Escrever o teste (vai falhar — módulo ainda não existe)**

```js
// clock-proxy/newClockFlags.test.js
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const {
  loadFlags,
  saveFlags,
  isNewClockBypassActive,
  markAsNewClock,
  consumeNewClockFlag,
  isSuspiciousReading,
} = require('./newClockFlags');

function tmpFile() {
  return path.join(os.tmpdir(), `new-clock-flags-test-${Date.now()}-${Math.random()}.json`);
}

describe('loadFlags / saveFlags', () => {
  it('retorna Set vazio quando o arquivo não existe', () => {
    const flags = loadFlags(tmpFile());
    expect(flags).toBeInstanceOf(Set);
    expect(flags.size).toBe(0);
  });

  it('salva e recarrega os IPs marcados (sobrevive a restart)', () => {
    const file = tmpFile();
    const flags = new Set(['192.168.14.151', '192.168.20.151']);
    saveFlags(file, flags);

    const reloaded = loadFlags(file);
    expect([...reloaded].sort()).toEqual(['192.168.14.151', '192.168.20.151']);

    fs.unlinkSync(file);
  });

  it('retorna Set vazio se o arquivo estiver corrompido, sem lançar exceção', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{not valid json', 'utf8');

    const flags = loadFlags(file);
    expect(flags.size).toBe(0);

    fs.unlinkSync(file);
  });
});

describe('markAsNewClock / isNewClockBypassActive / consumeNewClockFlag', () => {
  it('marca um IP e a flag fica ativa', () => {
    const file  = tmpFile();
    const flags = new Set();

    markAsNewClock(flags, '192.168.14.151', file);

    expect(isNewClockBypassActive(flags, '192.168.14.151')).toBe(true);
    expect(isNewClockBypassActive(flags, '192.168.20.151')).toBe(false);

    fs.unlinkSync(file);
  });

  it('consumir a flag remove ela e persiste em disco', () => {
    const file  = tmpFile();
    const flags = new Set(['192.168.14.151']);
    saveFlags(file, flags);

    const consumed = consumeNewClockFlag(flags, '192.168.14.151', file);

    expect(consumed).toBe(true);
    expect(isNewClockBypassActive(flags, '192.168.14.151')).toBe(false);
    expect([...loadFlags(file)]).toEqual([]);

    fs.unlinkSync(file);
  });

  it('consumir um IP sem flag ativa não lança exceção e retorna false', () => {
    const file  = tmpFile();
    const flags = new Set();

    const consumed = consumeNewClockFlag(flags, '192.168.14.151', file);

    expect(consumed).toBe(false);
  });
});

describe('isSuspiciousReading', () => {
  it('sem bypass: novo count < 50% do anterior é suspeito', () => {
    const result = isSuspiciousReading({
      bypassGuard: false, prevSuccess: true, prevCount: 300, newCount: 10,
    });
    expect(result).toBe(true);
  });

  it('sem bypass: novo count >= 50% do anterior não é suspeito', () => {
    const result = isSuspiciousReading({
      bypassGuard: false, prevSuccess: true, prevCount: 300, newCount: 200,
    });
    expect(result).toBe(false);
  });

  it('sem bypass: sem leitura anterior bem-sucedida nunca é suspeito', () => {
    const result = isSuspiciousReading({
      bypassGuard: false, prevSuccess: false, prevCount: 0, newCount: 0,
    });
    expect(result).toBe(false);
  });

  it('COM bypass ativo: mesmo com queda >50%, nunca é suspeito', () => {
    const result = isSuspiciousReading({
      bypassGuard: true, prevSuccess: true, prevCount: 300, newCount: 0,
    });
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste pra confirmar que falha**

Run: `cd clock-proxy && npx jest newClockFlags.test.js`
Expected: FAIL — `Cannot find module './newClockFlags'`

- [ ] **Step 3: Implementar o módulo**

```js
// clock-proxy/newClockFlags.js
// Flag "relógio novo" por IP — bypass de um-tiro pro guard de divergência
// (isSuspiciousReading) em clock-proxy/server.js. Ver spec:
// docs/superpowers/specs/2026-09-10-relogio-novo-flag-design.md
'use strict';

const fs = require('fs');

// Carrega o Set de IPs marcados a partir do disco. Retorna Set vazio se o
// arquivo não existir ou estiver corrompido — nunca lança exceção.
function loadFlags(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return new Set(arr);
    }
  } catch (_) {
    // arquivo corrompido — começa do zero, não trava o boot do processo
  }
  return new Set();
}

function saveFlags(filePath, flags) {
  fs.writeFileSync(filePath, JSON.stringify([...flags]), 'utf8');
}

function isNewClockBypassActive(flags, ip) {
  return flags.has(ip);
}

// Marca um IP para bypass na próxima leitura. Persiste imediatamente —
// sobrevive a um restart do processo entre o "Marcar" e o "Atualizar".
function markAsNewClock(flags, ip, filePath) {
  flags.add(ip);
  saveFlags(filePath, flags);
}

// Remove a flag após seu uso (sucesso ou falha da leitura). Retorna true se
// havia flag ativa para esse IP, false caso contrário.
function consumeNewClockFlag(flags, ip, filePath) {
  if (!flags.has(ip)) return false;
  flags.delete(ip);
  saveFlags(filePath, flags);
  return true;
}

// Guard de divergência do clock-proxy — extraído para função pura testável.
// bypassGuard=true (flag "relógio novo" ativa) ignora a checagem por completo.
function isSuspiciousReading({ bypassGuard, prevSuccess, prevCount, newCount }) {
  if (bypassGuard) return false;
  return !!prevSuccess && prevCount > 0 && newCount < Math.ceil(prevCount * 0.5);
}

module.exports = {
  loadFlags,
  saveFlags,
  isNewClockBypassActive,
  markAsNewClock,
  consumeNewClockFlag,
  isSuspiciousReading,
};
```

- [ ] **Step 4: Rodar o teste de novo, confirmar que passa**

Run: `cd clock-proxy && npx jest newClockFlags.test.js`
Expected: PASS — 10 testes

- [ ] **Step 5: Commit**

```bash
git add clock-proxy/newClockFlags.js clock-proxy/newClockFlags.test.js
git commit -m "feat(clock-proxy): módulo newClockFlags — bypass de um-tiro pro guard de divergência"
```

---

### Task 2: Ligar `newClockFlags.js` no `clock-proxy/server.js` (guard + endpoint)

**Files:**
- Modify: `clock-proxy/server.js:420-496` (declaração de estado + guard)
- Modify: `clock-proxy/server.js` (novo endpoint, perto de `/rh/clocks/status`)

Este arquivo não tem suíte Jest própria (acopla Express + Playwright, sem export do `app` —
mudar isso é um refactor maior, fora de escopo desta feature). A verificação deste Task é manual,
ver Task 5.

- [ ] **Step 1: Importar o módulo e inicializar o estado**

Editar o topo do bloco de funcionários em `clock-proxy/server.js` (perto de onde `_clockResults`
é declarado, linha ~420):

```js
const {
  isNewClockBypassActive,
  markAsNewClock,
  consumeNewClockFlag,
  isSuspiciousReading,
} = require('./newClockFlags');

// ... (código existente de _empJobState, _empCache etc.) ...

const NEW_CLOCK_FLAGS_FILE = path.join(process.cwd(), 'new-clock-flags.json');
let _newClockFlags = loadFlags(NEW_CLOCK_FLAGS_FILE);
```

Adicionar `loadFlags` à lista de imports do `require('./newClockFlags')` acima (ficou de fora por
engano no primeiro bloco — import final deve ter as 5 funções: `loadFlags`,
`isNewClockBypassActive`, `markAsNewClock`, `consumeNewClockFlag`, `isSuspiciousReading`).

- [ ] **Step 2: Trocar a expressão do guard pela função pura**

Localizar em `clock-proxy/server.js` (dentro de `runEmployeesInBackground`, linha ~494-496):

```js
        // Guard: resultado suspeito = novo count < 50% do count anterior com dados válidos.
        // Cobre tanto lista vazia (firmware bug) quanto fetch parcial (paginação truncada).
        const isSuspicious = prevEntry?.success && prevCount > 0 && newCount < Math.ceil(prevCount * 0.5);
```

Substituir por:

```js
        // Guard: resultado suspeito = novo count < 50% do count anterior com dados válidos.
        // Cobre tanto lista vazia (firmware bug) quanto fetch parcial (paginação truncada).
        // Bypass de um-tiro: se o IP foi marcado como "relógio novo", aceita a leitura mesmo
        // que caia >50% (troca física de hardware, não glitch de firmware).
        const bypassGuard = isNewClockBypassActive(_newClockFlags, ip);
        const isSuspicious = isSuspiciousReading({
          bypassGuard,
          prevSuccess: prevEntry?.success,
          prevCount,
          newCount,
        });
        if (bypassGuard) {
          consumeNewClockFlag(_newClockFlags, ip, NEW_CLOCK_FLAGS_FILE);
          console.log(`[/rh/employees] ${ip}: flag "relógio novo" consumida — aceitando ${newCount} funcionário(s) sem checagem de divergência`);
        }
```

A flag é consumida **antes** de qualquer ramificação de retry, porque a decisão de bypass já foi
tomada nesse tick — mesmo que o retry (bloco existente logo abaixo, só roda quando
`isSuspicious=true`) nunca dispare, por causa do bypass.

- [ ] **Step 3: Adicionar o endpoint `POST /clock/:ip/mark-new`**

Adicionar perto da rota `GET /rh/clocks/status` já existente em `clock-proxy/server.js`:

```js
// POST /clock/:ip/mark-new
// Marca um IP para bypass do guard de divergência na próxima leitura de funcionários —
// usar quando o relógio físico foi substituído por um novo (mesmo IP, zerado).
// Flag de um-tiro: some sozinha após a próxima leitura desse IP.
app.post('/clock/:ip/mark-new', (req, res) => {
  const { ip } = req.params;
  if (!CLOCK_IPS.includes(ip)) {
    return res.status(400).json({ error: `IP ${ip} nao esta em CLOCK_IPS` });
  }
  markAsNewClock(_newClockFlags, ip, NEW_CLOCK_FLAGS_FILE);
  console.log(`[dt-clock-proxy] ${ip} marcado como relógio novo — próxima leitura vai ignorar o guard de divergência`);
  res.json({ ok: true, ip });
});
```

- [ ] **Step 4: Verificação de sintaxe**

Run: `cd clock-proxy && node -c server.js`
Expected: sem output (sintaxe válida)

- [ ] **Step 5: Commit**

```bash
git add clock-proxy/server.js
git commit -m "feat(clock-proxy): endpoint /clock/:ip/mark-new + guard usa bypass de um-tiro"
```

---

### Task 3: Proxy na Azure VM (`server/routes/rh.js`) + cliente do dashboard (`api.js`)

**Files:**
- Modify: `server/routes/rh.js` (nova rota, perto de `GET /clocks/status`)
- Modify: `dashboard/src/api.js:121-144` (novo método em `api.rh`)
- Modify: `server/app.test.js` (novo describe block + 2 linhas de setup de env no topo)

- [ ] **Step 1: Escrever o teste da rota de proxy (vai falhar — rota ainda não existe)**

No topo de `server/app.test.js`, **antes** da linha `const app = require('./app');` (linha 82),
adicionar (a rota `rh.js` lê `CLOCK_PROXY_TOKEN`/`CLOCK_PROXY_URL` uma vez no `require`, então
precisam existir antes do primeiro `require('./app')` do arquivo):

```js
// CLOCK_PROXY_* precisam estar definidas ANTES do require('./app') abaixo — rh.js lê
// process.env uma única vez, no load do módulo.
process.env.CLOCK_PROXY_TOKEN = 'test-clock-proxy-token';
process.env.CLOCK_PROXY_URL   = 'http://127.0.0.1:34521';
```

No final de `server/app.test.js` (depois do último `describe`, ex: depois do bloco `describe('404', ...)`), adicionar:

```js
// ── POST /api/rh/clock/:ip/mark-new ──────────────────────────────────────────
// Sobe um clock-proxy fake real (não mock de módulo) na porta fixa acima —
// CLOCK_PROXY_URL já foi resolvida no require('./app') do topo do arquivo.
describe('POST /api/rh/clock/:ip/mark-new', () => {
  const http = require('http');
  let fakeClockProxy;

  beforeAll((done) => {
    fakeClockProxy = http.createServer((req, res) => {
      if (req.url === '/clock/192.168.14.151/mark-new') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ip: '192.168.14.151' }));
      }
      if (req.url === '/clock/999.999.999.999/mark-new') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'IP 999.999.999.999 nao esta em CLOCK_IPS' }));
      }
      res.writeHead(404);
      res.end();
    });
    fakeClockProxy.listen(34521, done);
  });

  afterAll((done) => { fakeClockProxy.close(done); });

  it('proxeia a marcação e retorna ok:true', async () => {
    const res = await request(app).post('/api/rh/clock/192.168.14.151/mark-new');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ip: '192.168.14.151' });
  });

  it('repassa falha do clock-proxy como 502 com detalhe do erro', async () => {
    const res = await request(app).post('/api/rh/clock/999.999.999.999/mark-new');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Falha ao conectar com o clock-proxy');
    expect(res.body.detail).toBe('IP 999.999.999.999 nao esta em CLOCK_IPS');
  });
});
```

- [ ] **Step 2: Rodar o teste, confirmar que falha**

Run: `cd server && npx jest app.test.js -t "mark-new"`
Expected: FAIL — primeiro teste recebe 404 (rota `/api/rh/clock/:ip/mark-new` não existe ainda)

- [ ] **Step 3: Implementar a rota de proxy**

Adicionar em `server/routes/rh.js`, logo após a rota `GET /clocks/status` existente (linha ~148):

```js
// POST /api/rh/clock/:ip/mark-new
// Marca um relógio como "recém-substituído" — a próxima leitura de funcionários desse IP
// vai ignorar o guard de divergência (queda >50% no count) por uma leitura, uma única vez.
// Usar depois de trocar fisicamente o hardware de um relógio (mesmo IP, funcionários zerados).
router.post('/clock/:ip/mark-new', async (req, res) => {
  if (!CLOCK_PROXY_TOKEN) {
    return res.status(500).json({ error: 'CLOCK_PROXY_TOKEN nao configurado' });
  }
  try {
    const result = await callClockProxy(`/clock/${req.params.ip}/mark-new`, {}, 'POST');
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error:  'Falha ao conectar com o clock-proxy',
      detail: err.message,
      hint:   `Verifique se o Servidor Skill esta acessivel em ${CLOCK_PROXY_URL}`,
    });
  }
});
```

- [ ] **Step 4: Rodar o teste de novo, confirmar que passa**

Run: `cd server && npx jest app.test.js -t "mark-new"`
Expected: PASS — 2 testes

- [ ] **Step 5: Rodar a suíte completa do server pra garantir zero regressão**

Run: `cd server && npx jest --forceExit`
Expected: todos os testes passam (baseline antes desta feature: 188 testes — 175 da sessão
anterior + 13 já existentes de outras áreas não tocadas aqui; conferir o número exato impresso
pelo Jest e usar como novo baseline)

- [ ] **Step 6: Adicionar o método no cliente do dashboard**

Em `dashboard/src/api.js`, dentro do objeto `rh: { ... }` (linha ~121-144), adicionar:

```js
    markClockNew: (ip) =>
      request('POST', `/api/rh/clock/${ip}/mark-new`),
```

- [ ] **Step 7: Commit**

```bash
git add server/routes/rh.js server/app.test.js dashboard/src/api.js
git commit -m "feat(delirio-manager): proxy POST /api/rh/clock/:ip/mark-new + cliente do dashboard"
```

---

### Task 4: Botão no dashboard (`ClockStatusGrid.jsx`)

**Files:**
- Modify: `dashboard/src/components/ClockStatusGrid.jsx`
- Test: `dashboard/src/__tests__/ClockStatusGrid.test.jsx`

- [ ] **Step 1: Escrever o teste (vai falhar — botão ainda não existe)**

```jsx
// dashboard/src/__tests__/ClockStatusGrid.test.jsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api', () => ({
  api: {
    rh: {
      getClockStatus: vi.fn(),
      markClockNew:   vi.fn(),
    },
  },
}))

import { api } from '../api'
import { ClockStatusGrid } from '../components/ClockStatusGrid'

const SAMPLE_STATUS = {
  total: 2,
  reachable: 2,
  timestamp: '2026-09-10T12:00:00.000Z',
  clocks: [
    { ip: '192.168.14.151', reachable: true,  responseTimeMs: 40 },
    { ip: '192.168.15.151', reachable: true,  responseTimeMs: 55 },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  api.rh.getClockStatus.mockResolvedValue(SAMPLE_STATUS)
})

describe('ClockStatusGrid — botão "Marcar como relógio novo"', () => {
  it('exibe o botão em cada card de relógio após carregar', async () => {
    render(<ClockStatusGrid />)
    await waitFor(() => expect(screen.getAllByText(/marcar como relógio novo/i)).toHaveLength(2))
  })

  it('pede confirmação e chama api.rh.markClockNew com o IP correto', async () => {
    window.confirm = vi.fn(() => true)
    api.rh.markClockNew.mockResolvedValue({ ok: true, ip: '192.168.14.151' })

    render(<ClockStatusGrid />)
    await waitFor(() => screen.getAllByText(/marcar como relógio novo/i))

    fireEvent.click(screen.getAllByText(/marcar como relógio novo/i)[0])

    expect(window.confirm).toHaveBeenCalled()
    await waitFor(() => expect(api.rh.markClockNew).toHaveBeenCalledWith('192.168.14.151'))
  })

  it('não chama a API se o usuário cancelar a confirmação', async () => {
    window.confirm = vi.fn(() => false)

    render(<ClockStatusGrid />)
    await waitFor(() => screen.getAllByText(/marcar como relógio novo/i))

    fireEvent.click(screen.getAllByText(/marcar como relógio novo/i)[0])

    expect(window.confirm).toHaveBeenCalled()
    expect(api.rh.markClockNew).not.toHaveBeenCalled()
  })

  it('troca o botão por um badge "aguardando releitura" após marcar com sucesso', async () => {
    window.confirm = vi.fn(() => true)
    api.rh.markClockNew.mockResolvedValue({ ok: true, ip: '192.168.14.151' })

    render(<ClockStatusGrid />)
    await waitFor(() => screen.getAllByText(/marcar como relógio novo/i))

    fireEvent.click(screen.getAllByText(/marcar como relógio novo/i)[0])

    await waitFor(() => expect(screen.getByText(/aguardando releitura/i)).toBeInTheDocument())
    // o outro relógio (não marcado) continua com o botão normal
    expect(screen.getAllByText(/marcar como relógio novo/i)).toHaveLength(1)
  })

  it('mostra erro se a chamada de marcar falhar, sem trocar pelo badge', async () => {
    window.confirm = vi.fn(() => true)
    api.rh.markClockNew.mockRejectedValue(new Error('clock-proxy indisponível'))

    render(<ClockStatusGrid />)
    await waitFor(() => screen.getAllByText(/marcar como relógio novo/i))

    fireEvent.click(screen.getAllByText(/marcar como relógio novo/i)[0])

    await waitFor(() => expect(screen.getByText(/clock-proxy indisponível/i)).toBeInTheDocument())
    expect(screen.queryByText(/aguardando releitura/i)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Rodar o teste, confirmar que falha**

Run: `cd dashboard && npx vitest run ClockStatusGrid.test.jsx`
Expected: FAIL — texto "marcar como relógio novo" não encontrado (botão não existe ainda)

- [ ] **Step 3: Implementar o botão + badge**

Em `dashboard/src/components/ClockStatusGrid.jsx`, adicionar aos `styles` (perto de
`styles.errorMsg`, linha ~159):

```js
  markNewBtn: {
    marginTop: '4px',
    padding: '4px 8px',
    background: 'transparent',
    color: 'var(--text-muted, #94a3b8)',
    border: '1px solid var(--border, #2d3748)',
    borderRadius: '6px',
    fontSize: '11px',
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
  armedBadge: {
    marginTop: '4px',
    fontSize: '11px',
    color: 'var(--accent, #3b82f6)',
    fontWeight: 600,
  },
  markNewError: {
    fontSize: '10px',
    color: 'var(--red, #f87171)',
    marginTop: '2px',
  },
```

Trocar a função `ClockCard` (linha 175-195) por:

```jsx
function ClockCard({ clock, isArmed, markError, onMarkNew }) {
  const storeName = IP_TO_STORE[clock.ip] || clock.ip
  const cardStyle = {
    ...styles.card,
    ...(clock.reachable ? styles.cardReachable : styles.cardUnreachable),
  }

  function handleMarkNew() {
    const confirmed = window.confirm(
      `Confirma que o relógio ${storeName} (${clock.ip}) foi fisicamente substituído?\n\n` +
      'Isso faz a próxima leitura de funcionários ignorar a checagem de segurança contra ' +
      'queda repentina — use só depois de trocar o hardware.'
    )
    if (confirmed) onMarkNew(clock.ip)
  }

  return (
    <div style={cardStyle}>
      <div style={styles.cardHeader}>
        <span style={styles.storeName}>{storeName}</span>
        <span style={styles.statusIcon}>{clock.reachable ? '✅' : '❌'}</span>
      </div>
      <span style={styles.ip}>{clock.ip}</span>
      {clock.reachable
        ? <span style={styles.responseTime}>{clock.responseTimeMs}ms</span>
        : <span style={styles.errorMsg} title={clock.error}>{clock.error || 'Sem resposta'}</span>
      }
      {isArmed
        ? <span style={styles.armedBadge}>🆕 aguardando releitura</span>
        : <button style={styles.markNewBtn} onClick={handleMarkNew}>🆕 Marcar como relógio novo</button>
      }
      {markError && <span style={styles.markNewError}>{markError}</span>}
    </div>
  )
}
```

Trocar a função `ClockStatusGrid` (linha 197+) adicionando o estado e o handler — no topo do
corpo da função, junto aos outros `useState`:

```jsx
  const [armedIps, setArmedIps]     = useState(new Set())
  const [markErrors, setMarkErrors] = useState({})
```

Adicionar o handler (perto de `fetchStatus`):

```jsx
  async function handleMarkNew(ip) {
    setMarkErrors(prev => ({ ...prev, [ip]: null }))
    try {
      await api.rh.markClockNew(ip)
      setArmedIps(prev => new Set(prev).add(ip))
    } catch (err) {
      setMarkErrors(prev => ({ ...prev, [ip]: err.message || 'Falha ao marcar relógio como novo.' }))
    }
  }
```

E no JSX, trocar a linha que renderiza os cards (`fullClocks.map(clock => <ClockCard key={clock.ip} clock={clock} />)`) por:

```jsx
          : fullClocks.map(clock => (
              <ClockCard
                key={clock.ip}
                clock={clock}
                isArmed={armedIps.has(clock.ip)}
                markError={markErrors[clock.ip]}
                onMarkNew={handleMarkNew}
              />
            ))
```

- [ ] **Step 4: Rodar o teste de novo, confirmar que passa**

Run: `cd dashboard && npx vitest run ClockStatusGrid.test.jsx`
Expected: PASS — 5 testes

- [ ] **Step 5: Rodar a suíte completa do dashboard pra garantir zero regressão**

Run: `cd dashboard && npx vitest run`
Expected: todos os testes passam (nenhum teste existente toca `ClockStatusGrid.jsx`, então zero
risco de regressão nos 3 arquivos de teste já existentes)

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/ClockStatusGrid.jsx dashboard/src/__tests__/ClockStatusGrid.test.jsx
git commit -m "feat(dashboard): botão 'Marcar como relógio novo' no grid de relógios"
```

---

### Task 5: Verificação manual do `clock-proxy/server.js` (não coberto por Jest)

`clock-proxy/server.js` não exporta o `app` Express nem tem suíte de testes própria (arquitetura
atual acopla Playwright + `app.listen()` direto — mudar isso é um refactor maior, fora do escopo
desta feature). A Task 2 mudou esse arquivo; validar manualmente antes do deploy:

- [ ] **Step 1: Rodar localmente com `.env` de teste (sem relógios reais)**

```bash
cd clock-proxy
node -e "
const http = require('http');
require('dotenv').config();
process.env.CLOCK_IPS = '127.0.0.1:9';
" 2>&1
```

Mais simples: só confirmar que o processo sobe sem exceção com o código real, usando o `.env` de
desenvolvimento já existente (com pelo menos 1 IP configurado, real ou não):

```bash
cd clock-proxy
timeout 3 node server.js
```

Expected: sem stack trace de erro de sintaxe/import — só os logs normais de boot (`Rodando em
0.0.0.0:4321`, cache carregado etc.)

- [ ] **Step 2: Testar o endpoint novo manualmente**

Com o processo rodando (passo anterior, sem o `timeout`):

```bash
curl -s -X POST http://localhost:4321/clock/192.168.14.151/mark-new
```

Expected: `{"ok":true,"ip":"192.168.14.151"}` se `192.168.14.151` estiver em `CLOCK_IPS`, ou
`{"error":"IP 192.168.14.151 nao esta em CLOCK_IPS"}` (400) caso contrário — ajustar o IP do
teste pra um que exista no `.env` local.

- [ ] **Step 3: Confirmar que o arquivo de flags foi criado**

```bash
cat clock-proxy/new-clock-flags.json
```

Expected: `["192.168.14.151"]` (ou o IP testado)

- [ ] **Step 4: Simular a releitura e confirmar que a flag é consumida**

Isso exige um relógio real ou um mock do `henry-hexa.js` — deferir para o momento real da troca
de hardware em produção. Documentar no PR/commit que este passo específico (consumo da flag numa
leitura real) só é validável em produção, e que o comportamento da função pura
`isSuspiciousReading`/`consumeNewClockFlag` já está 100% coberto pelos testes da Task 1.

---

## Self-Review

**Cobertura da spec:**
- ✅ Flag por IP, persistida em disco → Task 1 (`newClockFlags.js`) + Task 2 (wiring)
- ✅ Um-tiro, consumida após a leitura → Task 1 (`consumeNewClockFlag`) + Task 2 (chamada no guard)
- ✅ Endpoint `POST /clock/:ip/mark-new` no clock-proxy → Task 2
- ✅ Proxy `POST /api/rh/clock/:ip/mark-new` na Azure VM → Task 3
- ✅ Botão + confirmação + badge no dashboard → Task 4
- ✅ Guard ignora checagem só pro IP com flag ativa, comportamento normal pros demais → testado
  explicitamente em `newClockFlags.test.js` (`isSuspiciousReading`)
- ✅ Risco conhecido (flag consumida cedo) → documentado na spec, sem mitigação de código (decisão
  consciente do design, não requer task)
- ⚠️ Teste automatizado do endpoint dentro de `clock-proxy/server.js` diretamente (Express) não
  existe — mesma limitação estrutural que já existia antes desta feature (sem `app` exportado).
  Coberto por verificação manual na Task 5, e a lógica que importa (guard + persistência) está
  100% testada via `newClockFlags.js` isolado.

**Placeholders:** nenhum "TBD"/"implementar depois" — todo código está completo em cada step.

**Consistência de tipos/nomes:** `loadFlags`, `saveFlags`, `isNewClockBypassActive`,
`markAsNewClock`, `consumeNewClockFlag`, `isSuspiciousReading` usados de forma idêntica em Task 1
(definição), Task 2 (uso em `server.js`) e nos testes — conferido.
