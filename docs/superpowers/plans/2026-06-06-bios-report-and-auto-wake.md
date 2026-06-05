# Relatório BIOS + Auto-Wake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao Delirio Manager (1) um botão "Relatório BIOS" que gera um PDF com todas as máquinas que precisam configurar WoL na BIOS, e (2) um botão toggle "Auto-Wake" que liga automaticamente máquinas offline há mais de 10 minutos.

**Architecture:**
- Feature 1: novo endpoint `GET /api/reports/bios/pdf` no servidor Node.js (pdfkit), botão no topbar do dashboard que faz fetch do PDF e abre como blob.
- Feature 2: novo `checkAutoWake()` no alertEngine (server-side), settings persiste em `config.json` via `GET/PUT /api/settings`, toggle button no topbar.
- Auto-wake usa status `wol_auto_testing` (distinto de `testing`) para não corromper o badge quando a tentativa falha — reverte para `wol_confirmed` em vez de `bios_needed`.

**Tech Stack:** Node.js 22 + Express + better-sqlite3 + pdfkit (novo), Electron 34 + React 19

---

## Mapa de Arquivos

| Arquivo | Ação | Responsabilidade |
|---------|------|-----------------|
| `server/package.json` | Modificar | Adicionar `pdfkit` |
| `server/db.js` | Modificar | `getMachinesBiosNeeded()`, `getMachinesOfflineForWake()`, `getMachinesAutoWolTesting()`, migration `wol_auto_testing` |
| `server/routes/reports.js` | Criar | `GET /api/reports/bios` (JSON) + `GET /api/reports/bios/pdf` |
| `server/routes/settings.js` | Criar | `GET /api/settings`, `PUT /api/settings` |
| `server/server.js` | Modificar | Registrar `/api/reports` e `/api/settings` |
| `server/services/alertEngine.js` | Modificar | `checkAutoWake()`, `checkWolAutoTests()`, emails/teams para auto-wake |
| `dashboard/src/api.js` | Modificar | `downloadBiosPdf()`, `getSettings()`, `updateSettings()` |
| `dashboard/src/App.jsx` | Modificar | Botão "Relatório BIOS" + toggle "Auto-Wake" no topbar |

---

## Task 1: Dependência pdfkit no servidor

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Adicionar pdfkit ao package.json**

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.100.1",
    "better-sqlite3": "^11.0.0",
    "express": "^4.19.2",
    "nodemailer": "^8.0.10",
    "pdfkit": "^0.15.0",
    "ws": "^8.17.1"
  }
}
```

- [ ] **Step 2: Instalar na VM**

```bash
b64=$(base64 -w 0 "F:/RichClub/server/package.json")
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/package.json && cd /opt/dt-manager && npm install && echo PDFKIT_OK"
```

Esperado no output: `PDFKIT_OK` e linha confirmando instalação do pdfkit.

---

## Task 2: Funções DB para as novas features

**Files:**
- Modify: `server/db.js`

- [ ] **Step 1: Adicionar migration para `wol_auto_testing` (já é um valor de status, sem coluna nova)**

Não precisa de nova coluna — `wol_status` já aceita qualquer string. Apenas adicionar funções novas.

- [ ] **Step 2: Adicionar `getMachinesBiosNeeded()` após `getMachinesWolTesting`**

```javascript
function getMachinesBiosNeeded() {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE wol_status = 'bios_needed'
    ORDER BY location, display_name
  `).all();
}
```

- [ ] **Step 3: Adicionar `getMachinesOfflineForWake()` — máquinas elegíveis para auto-wake**

```javascript
function getMachinesOfflineForWake(offlineSinceCutoff) {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE status = 'offline'
      AND wol_status = 'wol_confirmed'
      AND mac != ''
      AND last_seen IS NOT NULL
      AND last_seen < ?
  `).all(offlineSinceCutoff);
}
```

- [ ] **Step 4: Adicionar `getMachinesAutoWolTesting()` — máquinas em teste auto-wake com timeout**

```javascript
function getMachinesAutoWolTesting(olderThanISO) {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE wol_status = 'wol_auto_testing'
      AND wol_tested_at IS NOT NULL
      AND wol_tested_at < ?
  `).all(olderThanISO);
}
```

- [ ] **Step 5: Exportar as novas funções no `module.exports`**

Adicionar ao bloco de exports existente (linha ~482):
```javascript
getMachinesBiosNeeded,
getMachinesOfflineForWake,
getMachinesAutoWolTesting,
```

---

## Task 3: Endpoint Relatório BIOS

**Files:**
- Create: `server/routes/reports.js`

- [ ] **Step 1: Criar o arquivo**

```javascript
'use strict';

const express        = require('express');
const router         = express.Router();
const PDFDocument    = require('pdfkit');
const db             = require('../db');
const { getBiosGuide } = require('../services/wolBiosGuide');

// GET /api/reports/bios — JSON com todas as máquinas bios_needed
router.get('/bios', (req, res) => {
  try {
    const machines = db.getMachinesBiosNeeded().map(m => {
      const guide = getBiosGuide(m.motherboard);
      return {
        id:           m.id,
        displayName:  m.display_name || m.hostname,
        location:     m.location || 'Sem localidade',
        motherboard:  m.motherboard || '',
        manufacturer: guide.manufacturer,
        model:        guide.model,
        biosPath:     guide.path,
        biosNote:     guide.note,
        mac:          m.mac || '',
        lastSeen:     m.last_seen,
      };
    });
    res.json({ total: machines.length, generatedAt: new Date().toISOString(), machines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/bios/pdf — PDF para download
router.get('/bios/pdf', (req, res) => {
  try {
    const machines = db.getMachinesBiosNeeded().map(m => {
      const guide = getBiosGuide(m.motherboard);
      return {
        displayName:  m.display_name || m.hostname,
        location:     m.location || 'Sem localidade',
        manufacturer: guide.manufacturer,
        model:        guide.model,
        biosPath:     guide.path,
        biosNote:     guide.note || '',
      };
    });

    const now    = new Date();
    const dateStr = now.toLocaleDateString('pt-BR');
    const timeStr = now.toLocaleTimeString('pt-BR');

    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="relatorio-bios-${now.toISOString().split('T')[0]}.pdf"`);
    doc.pipe(res);

    // ── Cabeçalho ──
    doc.fontSize(18).font('Helvetica-Bold').text('Delirio Manager', { align: 'center' });
    doc.fontSize(13).font('Helvetica').text('Relatório BIOS — Wake-on-LAN', { align: 'center' });
    doc.fontSize(9).fillColor('#666').text(`Gerado em: ${dateStr} às ${timeStr}`, { align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(0.5);

    if (machines.length === 0) {
      doc.fontSize(12).text('Nenhuma máquina com configuração de BIOS pendente.', { align: 'center' });
      doc.end();
      return;
    }

    doc.fontSize(10).text(`Total de máquinas pendentes: ${machines.length}`);
    doc.moveDown(0.8);

    // ── Linha separadora ──
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#ccc');
    doc.moveDown(0.5);

    // ── Uma entrada por máquina ──
    for (const m of machines) {
      // Verifica espaço restante; nova página se necessário
      if (doc.y > 700) doc.addPage();

      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a2e').text(`${m.displayName}  —  ${m.location}`);
      doc.font('Helvetica').fillColor('#000').fontSize(9);
      doc.text(`Placa-mãe: ${m.manufacturer} — ${m.model}`);
      doc.moveDown(0.2);

      // Caminho BIOS em destaque
      doc.fontSize(9).fillColor('#444').text('Caminho na BIOS:', { continued: false });
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#c0392b').text(`  ${m.biosPath}`);
      doc.font('Helvetica').fillColor('#000');

      if (m.biosNote) {
        doc.fontSize(8).fillColor('#666').text(`Obs: ${m.biosNote}`);
        doc.fillColor('#000');
      }

      doc.moveDown(0.4);
      // Linha divisória leve entre máquinas
      doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#eee');
      doc.moveDown(0.5);
    }

    // ── Rodapé ──
    doc.fontSize(8).fillColor('#999')
      .text('Delirio Manager — Sistema de Monitoramento de Máquinas Windows', 40, 790, { align: 'center' });

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

---

## Task 4: Endpoint Settings (auto-wake toggle)

**Files:**
- Create: `server/routes/settings.js`

- [ ] **Step 1: Criar o arquivo**

```javascript
'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// GET /api/settings — retorna configurações públicas (sem credenciais)
router.get('/', (req, res) => {
  try {
    const cfg = loadConfig();
    res.json({
      autoWake: {
        enabled: cfg.autoWake?.enabled === true,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings — atualiza configurações
router.put('/', (req, res) => {
  try {
    const cfg = loadConfig();
    if (req.body.autoWake !== undefined) {
      cfg.autoWake = {
        ...(cfg.autoWake || {}),
        enabled: req.body.autoWake.enabled === true,
      };
    }
    saveConfig(cfg);
    res.json({ ok: true, autoWake: cfg.autoWake });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

---

## Task 5: Registrar rotas no server.js

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Adicionar requires e app.use para as novas rotas**

Após as linhas existentes de require das rotas (após linha `const insightRoutes = require('./routes/insights');`):
```javascript
const reportRoutes   = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
```

Após a linha `app.use('/api/insights', insightRoutes);`:
```javascript
app.use('/api/reports',  reportRoutes);
app.use('/api/settings', settingsRoutes);
```

---

## Task 6: Auto-Wake no alertEngine

**Files:**
- Modify: `server/services/alertEngine.js`

- [ ] **Step 1: Adicionar `checkAutoWake()` ao `checkAll()`**

Substituir a função `checkAll()` existente:
```javascript
function checkAll() {
  checkOffline();
  checkMetricThresholds();
  checkWolTests();
  checkWolAutoTests();
  checkAutoWake();
}
```

- [ ] **Step 2: Adicionar `checkAutoWake()` — detecta offline > 10min e envia WoL**

Adicionar após a função `checkWolTests()`:
```javascript
function checkAutoWake() {
  const cfg = loadConfig();
  if (!cfg.autoWake?.enabled) return;

  const cutoff   = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const allMachines = db.getAllMachines();
  const candidates  = db.getMachinesOfflineForWake(cutoff);

  for (const machine of candidates) {
    const relay = allMachines.find(m =>
      m.id       !== machine.id &&
      m.location === machine.location &&
      m.status   === 'online'
    );
    if (!relay) {
      console.log(`[AutoWake] Sem relay para ${machine.id} em ${machine.location}`);
      continue;
    }

    const now        = new Date().toISOString();
    const offlineMin = Math.round((Date.now() - new Date(machine.last_seen).getTime()) / 60000);
    const name       = machine.display_name || machine.hostname;
    const location   = machine.location || 'Sem localidade';

    db.createCommand(relay.id, 'wol', { mac: machine.mac, targetId: machine.id });
    db.setWolStatus(machine.id, 'wol_auto_testing', now);
    db.addEvent(machine.id, 'auto_wake_sent', `Auto-Wake: magic packet enviado via ${relay.display_name || relay.hostname}`);

    fireAlert(machine.id, 'auto_wake',
      `Auto-Wake: enviando magic packet para ${name} (offline há ${offlineMin} min)`);

    sendAutoWakeEmail(name, location, offlineMin);
    sendAutoWakeTeams(name, location, offlineMin);

    console.log(`[AutoWake] Magic packet enviado para ${machine.id} via relay ${relay.id}`);
  }
}
```

- [ ] **Step 3: Adicionar `checkWolAutoTests()` — confirma ou registra falha do auto-wake**

Adicionar após `checkWolTests()`:
```javascript
function checkWolAutoTests() {
  const timeout  = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const machines = db.getMachinesAutoWolTesting(timeout);

  for (const machine of machines) {
    const name     = machine.display_name || machine.hostname;
    const location = machine.location || 'Sem localidade';

    if (machine.status === 'online') {
      db.setWolStatus(machine.id, 'wol_confirmed');
      db.addEvent(machine.id, 'auto_wake_success', 'Máquina ligada automaticamente com sucesso');
      fireAlert(machine.id, 'auto_wake_success',
        `✅ ${name}: ligada automaticamente com sucesso!`);
      sendAutoWakeResultEmail(name, location, true);
      sendAutoWakeResultTeams(name, location, true);
      console.log(`[AutoWake] Sucesso: ${machine.id}`);
    } else {
      db.setWolStatus(machine.id, 'wol_confirmed'); // reverte — não muda para bios_needed
      db.addEvent(machine.id, 'auto_wake_failed', 'Auto-Wake: sem resposta em 3 min');
      fireAlert(machine.id, 'auto_wake_failed',
        `⚠️ ${name}: Auto-Wake falhou — sem resposta em 3 min`);
      sendAutoWakeResultEmail(name, location, false);
      sendAutoWakeResultTeams(name, location, false);
      console.log(`[AutoWake] Falhou: ${machine.id}`);
    }
  }
}
```

- [ ] **Step 4: Adicionar funções de notificação de auto-wake (email)**

Adicionar após `sendWolBiosTeams`:
```javascript
async function sendAutoWakeEmail(name, location, offlineMin) {
  const cfg = loadConfig().alerts?.email;
  if (!cfg?.enabled || !cfg.to?.length) return;

  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host, port: cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  try {
    await transporter.sendMail({
      from:    `"Delirio Manager" <${cfg.user}>`,
      to:      cfg.to.join(', '),
      subject: `🔄 Auto-Wake iniciado: ${name}`,
      html: `
        <h2 style="color:#3b82f6">🔄 Auto-Wake Iniciado</h2>
        <p><strong>Máquina:</strong> ${name}</p>
        <p><strong>Localidade:</strong> ${location}</p>
        <p><strong>Offline há:</strong> ${offlineMin} minutos</p>
        <p>Magic packet enviado automaticamente.</p>
        <hr><p style="color:#888;font-size:12px">Delirio Manager — Auto-Wake</p>
      `,
    });
  } catch (err) {
    console.error('[AutoWake] Falha email init:', err.message);
  }
}

async function sendAutoWakeResultEmail(name, location, success) {
  const cfg = loadConfig().alerts?.email;
  if (!cfg?.enabled || !cfg.to?.length) return;

  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host, port: cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  const icon    = success ? '✅' : '⚠️';
  const color   = success ? '#22c55e' : '#f59e0b';
  const status  = success ? 'Ligada com sucesso' : 'Falhou — sem resposta em 3 min';

  try {
    await transporter.sendMail({
      from:    `"Delirio Manager" <${cfg.user}>`,
      to:      cfg.to.join(', '),
      subject: `${icon} Auto-Wake ${success ? 'OK' : 'Falhou'}: ${name}`,
      html: `
        <h2 style="color:${color}">${icon} Auto-Wake ${success ? 'Concluído' : 'Falhou'}</h2>
        <p><strong>Máquina:</strong> ${name}</p>
        <p><strong>Localidade:</strong> ${location}</p>
        <p><strong>Resultado:</strong> ${status}</p>
        <hr><p style="color:#888;font-size:12px">Delirio Manager — Auto-Wake</p>
      `,
    });
  } catch (err) {
    console.error('[AutoWake] Falha email result:', err.message);
  }
}
```

- [ ] **Step 5: Adicionar funções de notificação de auto-wake (Teams)**

Adicionar após as funções de email:
```javascript
async function sendAutoWakeTeams(name, location, offlineMin) {
  const cfg = loadConfig().alerts?.teams;
  if (!cfg?.enabled || !cfg.webhook_url) return;

  const body = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', text: '🔄 Auto-Wake Iniciado', weight: 'Bolder', size: 'Medium', color: 'Accent' },
          { type: 'FactSet', facts: [
            { title: 'Máquina',    value: name },
            { title: 'Localidade', value: location },
            { title: 'Offline há', value: `${offlineMin} minutos` },
          ]},
        ],
      },
    }],
  };

  try {
    await fetch(cfg.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[AutoWake] Falha Teams init:', err.message);
  }
}

async function sendAutoWakeResultTeams(name, location, success) {
  const cfg = loadConfig().alerts?.teams;
  if (!cfg?.enabled || !cfg.webhook_url) return;

  const body = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard', version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: success ? '✅ Auto-Wake Concluído' : '⚠️ Auto-Wake Falhou',
            weight: 'Bolder', size: 'Medium',
            color: success ? 'Good' : 'Warning',
          },
          { type: 'FactSet', facts: [
            { title: 'Máquina',    value: name },
            { title: 'Localidade', value: location },
            { title: 'Resultado',  value: success ? 'Ligada com sucesso' : 'Sem resposta em 3 min' },
          ]},
        ],
      },
    }],
  };

  try {
    await fetch(cfg.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[AutoWake] Falha Teams result:', err.message);
  }
}
```

---

## Task 7: API client no dashboard

**Files:**
- Modify: `dashboard/src/api.js`

- [ ] **Step 1: Adicionar `downloadBiosPdf()`, `getBiosReport()`, `getSettings()`, `updateSettings()`**

Adicionar no objeto `api` (após a linha `health: () => ...`):
```javascript
  // Reports
  getBiosReport: () => request('GET', '/api/reports/bios'),
  downloadBiosPdf: async () => {
    const res = await fetch(`${serverUrl}/api/reports/bios/pdf`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.blob()
  },

  // Settings
  getSettings:    ()       => request('GET', '/api/settings'),
  updateSettings: (data)   => request('PUT', '/api/settings', data),
```

---

## Task 8: Botões no topbar do dashboard

**Files:**
- Modify: `dashboard/src/App.jsx`

- [ ] **Step 1: Adicionar state para auto-wake no início do componente `App()`**

Após a linha `const [configLoaded, setConfigLoaded] = useState(false)`:
```javascript
  const [autoWakeEnabled, setAutoWakeEnabled] = useState(false)
  const [autoWakeLoading, setAutoWakeLoading] = useState(false)
```

- [ ] **Step 2: Carregar settings do servidor junto com a config existente**

Dentro do `useEffect` que chama `load()` (função `load` interna), após `setConfigLoaded(true)`:
```javascript
      // Carrega setting de auto-wake do servidor
      try {
        const settings = await api.getSettings()
        setAutoWakeEnabled(settings.autoWake?.enabled === true)
      } catch {}
```

- [ ] **Step 3: Adicionar handler `toggleAutoWake()`**

Após a função `saveServerUrl`:
```javascript
  async function toggleAutoWake() {
    setAutoWakeLoading(true)
    try {
      const newVal = !autoWakeEnabled
      await api.updateSettings({ autoWake: { enabled: newVal } })
      setAutoWakeEnabled(newVal)
    } catch (err) {
      alert(`Erro ao alterar Auto-Wake: ${err.message}`)
    } finally {
      setAutoWakeLoading(false)
    }
  }
```

- [ ] **Step 4: Adicionar handler `handleBiosReport()` para download do PDF**

Após `toggleAutoWake`:
```javascript
  async function handleBiosReport() {
    try {
      const blob = await api.downloadBiosPdf()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `relatorio-bios-${new Date().toISOString().split('T')[0]}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert(`Erro ao gerar relatório: ${err.message}`)
    }
  }
```

- [ ] **Step 5: Adicionar os botões no topbar (bloco `topbar-right`)**

Adicionar os dois botões imediatamente antes do botão existente `+ Grupo`:
```jsx
          <button
            className="icon-btn"
            onClick={handleBiosReport}
            title="Gerar PDF com máquinas aguardando configuração de BIOS"
          >
            📋 Relatório BIOS
          </button>
          <button
            className={`icon-btn ${autoWakeEnabled ? 'icon-btn-active' : ''}`}
            onClick={toggleAutoWake}
            disabled={autoWakeLoading}
            title={autoWakeEnabled ? 'Auto-Wake ativado — clique para desativar' : 'Auto-Wake desativado — clique para ativar'}
          >
            {autoWakeLoading ? '...' : (autoWakeEnabled ? '🔄 Auto-Wake ON' : '⏻ Auto-Wake OFF')}
          </button>
```

- [ ] **Step 6: Adicionar estilo para `icon-btn-active` no CSS**

Procurar pelo arquivo de estilos do dashboard para adicionar:
```css
.icon-btn-active {
  background: var(--green, #22c55e);
  color: #000;
}
```

---

## Task 9: Build e Deploy

- [ ] **Step 1: Build do dashboard Electron**

```powershell
cd F:\RichClub\dashboard
npm run build
```

Esperado: pasta `dist/` atualizada sem erros.

- [ ] **Step 2: Deploy dos arquivos do servidor na VM**

Usar o método base64 para cada arquivo modificado:

```bash
# db.js
b64=$(base64 -w 0 "F:/RichClub/server/db.js")
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/db.js && echo OK_DB"

# server.js
b64=$(base64 -w 0 "F:/RichClub/server/server.js")
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/server.js && echo OK_SERVER"

# alertEngine.js
b64=$(base64 -w 0 "F:/RichClub/server/services/alertEngine.js")
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/services/alertEngine.js && echo OK_ALERT"

# routes/reports.js (novo)
b64=$(base64 -w 0 "F:/RichClub/server/routes/reports.js")
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/routes/reports.js && echo OK_REPORTS"

# routes/settings.js (novo)
b64=$(base64 -w 0 "F:/RichClub/server/routes/settings.js")
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/routes/settings.js && echo OK_SETTINGS"
```

- [ ] **Step 3: Reiniciar PM2 na VM**

```bash
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "cd /opt/dt-manager && pm2 restart dt-manager && sleep 3 && pm2 logs dt-manager --lines 20 --nostream"
```

Verificar: sem erros de `require`, linha `[AlertEngine] Iniciado` no log.

- [ ] **Step 4: Reiniciar Electron para carregar o novo build**

Fechar e reabrir o Delirio Manager (ou pressionar Ctrl+R no app).

---

## Task 10: Verificação manual

- [ ] **Relatório BIOS:**
  1. Clicar em "📋 Relatório BIOS" no topbar
  2. PDF deve ser baixado automaticamente
  3. Abrir PDF e confirmar: título correto, tabela com máquinas `bios_needed`, caminho BIOS por fabricante
  4. Testar com 0 máquinas bios_needed: PDF deve mostrar "Nenhuma máquina pendente"

- [ ] **Auto-Wake:**
  1. Clicar em "⏻ Auto-Wake OFF" → botão deve mudar para "🔄 Auto-Wake ON" (verde)
  2. Verificar via API: `curl https://dt-manager.brazilsouth.cloudapp.azure.com/api/settings` → `{"autoWake":{"enabled":true}}`
  3. Clicar novamente → botão volta para "⏻ Auto-Wake OFF"
  4. Com a feature ativada, aguardar uma máquina ficar offline por 10+ min → confirmar alerta no dashboard, email e Teams

---

## Notas de Implementação

- **`wol_auto_testing` vs `bios_needed`:** Auto-wake nunca seta `bios_needed` — reverte para `wol_confirmed` em falha. Isso preserva a regra de negócio: `bios_needed` só vem de testes manuais (botão "Ligar").
- **Sem relay disponível:** `checkAutoWake()` apenas loga e pula a máquina — sem alerta para não gerar ruído desnecessário.
- **Evitar spam de auto-wake:** A query `getMachinesOfflineForWake()` exclui máquinas com `wol_status != 'wol_confirmed'` — enquanto estiver em `wol_auto_testing`, não tentará novamente.
- **PDF sem pdfkit instalado:** Se o `npm install` na VM falhar, o endpoint retorna 500. Verificar output do Step 2 da Task 1.
- **Config.json na VM:** O arquivo está em `/opt/dt-manager/config.json` e o `settings.js` usa o path relativo `../config.json` a partir de `routes/`, que resolve corretamente para `/opt/dt-manager/config.json`.
