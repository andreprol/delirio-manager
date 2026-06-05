# WoL Status Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detectar e exibir no dashboard o status do Wake-on-LAN de cada máquina (driver Windows, teste funcional e alerta de BIOS), com tentativa automática de habilitação pelo agente.

**Architecture:** O agente coleta o status do driver WoL e o modelo da placa-mãe, enviando no heartbeat. O servidor rastreia o estado (unknown → driver_enabled/disabled → wol_confirmed/bios_needed) e dispara alertas pelos 3 canais quando o teste falha. O dashboard exibe um badge colorido por máquina.

**Tech Stack:** Go 1.26 (agente), Node.js 22 + Express + SQLite (servidor), React 19 + Electron (dashboard)

---

## Estados WoL

```
unknown          → Ainda não verificado pelo agente
driver_disabled  → Driver Windows desabilitado (agente tentou habilitar, falhou) 🔴
driver_enabled   → Driver OK, WoL não testado 🟠
testing          → Magic packet enviado, aguardando máquina ligar (transitório)
wol_confirmed    → WoL testado e funcionou ✅ 🟢
bios_needed      → WoL testado mas falhou — BIOS precisa ser configurado 🟠⚠️
```

---

## Mapa de Arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `agent/wol.go` | Modificar | Adicionar `checkAndEnableWolDriver()` e `getMotherboardInfo()` |
| `agent/agent.go` | Modificar | Adicionar `WolEnabled *bool` + `Motherboard string` ao HeartbeatPayload; coletar no start() |
| `server/db.js` | Modificar | Colunas `wol_status`, `wol_tested_at`, `motherboard`; funções `setWolStatus`, `updateMotherboard` |
| `server/routes/agent.js` | Modificar | Processar `wolEnabled` + `motherboard` do heartbeat; atualizar `wol_status` |
| `server/routes/machines.js` | Modificar | Marcar `wol_status = 'testing'` quando WoL é enviado |
| `server/services/wolBiosGuide.js` | Criar | Tabela de guias de BIOS por fabricante |
| `server/services/alertEngine.js` | Modificar | Adicionar `checkWolTests()` — detecta timeout do teste e dispara alertas |
| `dashboard/src/components/MachineCard.jsx` | Modificar | Badge WoL colorido + tooltip |

---

## Task 1: Coletar WoL driver e placa-mãe no agente

**Files:**
- Modify: `agent/wol.go`

- [ ] **Step 1: Adicionar `checkAndEnableWolDriver()` em `agent/wol.go`**

```go
// checkAndEnableWolDriver verifica se o driver WoL está habilitado no NIC principal.
// Se desabilitado, tenta habilitar automaticamente via PowerShell.
// Retorna true se habilitado após a verificação/tentativa.
func checkAndEnableWolDriver() bool {
	// Tenta habilitar (Set é no-op se já estiver enabled)
	// e verifica o estado em um único script
	script := `
$enabled = $false
try {
  $adapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue
  foreach ($a in $adapters) {
    $pm = $a | Get-NetAdapterPowerManagement -ErrorAction SilentlyContinue
    if ($pm -and $pm.WakeOnMagicPacket -ne 'Enabled') {
      $pm | Set-NetAdapterPowerManagement -WakeOnMagicPacket Enabled -ErrorAction SilentlyContinue
    }
  }
  $enabled = ($null -ne (Get-NetAdapterPowerManagement -ErrorAction SilentlyContinue |
    Where-Object { $_.WakeOnMagicPacket -eq 'Enabled' }))
} catch {}
Write-Output $(if ($enabled) { 'true' } else { 'false' })
`
	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return false
	}
	return strings.TrimSpace(out.String()) == "true"
}

// getMotherboardInfo retorna "Fabricante|Modelo" da placa-mãe via WMI.
// Fallback para Win32_ComputerSystem em PCs de marca (Dell, HP, Lenovo).
func getMotherboardInfo() string {
	script := `
try {
  $b = Get-WmiObject Win32_BaseBoard -ErrorAction SilentlyContinue
  if ($b -and $b.Manufacturer -and $b.Manufacturer -notmatch 'Not Applicable|Default') {
    Write-Output "$($b.Manufacturer.Trim())|$($b.Product.Trim())"
  } else {
    $c = Get-WmiObject Win32_ComputerSystem -ErrorAction SilentlyContinue
    Write-Output "$($c.Manufacturer.Trim())|$($c.Model.Trim())"
  }
} catch { Write-Output 'Unknown|Unknown' }
`
	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "Unknown|Unknown"
	}
	result := strings.TrimSpace(out.String())
	if result == "" {
		return "Unknown|Unknown"
	}
	return result
}
```

- [ ] **Step 2: Adicionar import de `bytes` e `strings` em wol.go (já existem no arquivo, verificar)**

O arquivo atual tem `encoding/hex`, `fmt`, `net`, `strings`. Adicionar `bytes` e `os/exec`:

```go
import (
	"bytes"
	"encoding/hex"
	"fmt"
	"net"
	"os/exec"
	"strings"
)
```

---

## Task 2: Adicionar WoL ao heartbeat do agente

**Files:**
- Modify: `agent/agent.go`

- [ ] **Step 1: Adicionar campos ao HeartbeatPayload**

```go
// HeartbeatPayload e o JSON enviado ao servidor a cada ciclo.
type HeartbeatPayload struct {
	MachineID   string   `json:"machineId"`
	Token       string   `json:"token"`
	Hostname    string   `json:"hostname"`
	Version     string   `json:"agentVersion"`
	Metrics     *Metrics `json:"metrics"`
	WolEnabled  *bool    `json:"wolEnabled,omitempty"`
	Motherboard string   `json:"motherboard,omitempty"`
}
```

- [ ] **Step 2: Adicionar campos ao struct Agent**

```go
type Agent struct {
	cfg         *Config
	client      *http.Client
	stopCh      chan struct{}
	wolEnabled  *bool  // cached após primeira verificação
	motherboard string // cached após primeira verificação
}
```

- [ ] **Step 3: Coletar WoL status no start()**

No método `start()`, após `go a.collectAndSendBootEvents()`, adicionar:

```go
go a.collectWolStatus()
```

- [ ] **Step 4: Implementar `collectWolStatus()`**

```go
// collectWolStatus verifica o driver WoL e modelo da placa-mãe uma vez por sessão.
func (a *Agent) collectWolStatus() {
	enabled := checkAndEnableWolDriver()
	a.wolEnabled = &enabled
	a.motherboard = getMotherboardInfo()
	logInfo(fmt.Sprintf("WoL driver: %v | Placa: %s", enabled, a.motherboard))
}
```

- [ ] **Step 5: Incluir campos no sendHeartbeat()**

```go
func (a *Agent) sendHeartbeat() {
	metrics, err := collectMetrics()
	if err != nil {
		logWarn(fmt.Sprintf("Erro ao coletar metricas: %v", err))
		metrics = &Metrics{}
	}

	hostname, _ := os.Hostname()
	payload := HeartbeatPayload{
		MachineID:   a.cfg.MachineID,
		Token:       a.cfg.Token,
		Hostname:    hostname,
		Version:     Version,
		Metrics:     metrics,
		WolEnabled:  a.wolEnabled,
		Motherboard: a.motherboard,
	}
	// ... resto do método inalterado
```

---

## Task 3: Schema e funções no servidor

**Files:**
- Modify: `server/db.js`

- [ ] **Step 1: Adicionar colunas na migração incremental**

No array `migrations` (linha ~136), adicionar ao final:

```js
`ALTER TABLE machines ADD COLUMN wol_status TEXT DEFAULT 'unknown'`,
`ALTER TABLE machines ADD COLUMN wol_tested_at TEXT`,
`ALTER TABLE machines ADD COLUMN motherboard TEXT DEFAULT ''`,
```

- [ ] **Step 2: Adicionar função `setWolStatus`**

```js
function setWolStatus(machineId, status, testedAt = null) {
  const d = getDb();
  if (testedAt) {
    d.prepare(`UPDATE machines SET wol_status=?, wol_tested_at=? WHERE id=?`)
     .run(status, testedAt, machineId);
  } else {
    d.prepare(`UPDATE machines SET wol_status=? WHERE id=?`)
     .run(status, machineId);
  }
}
```

- [ ] **Step 3: Adicionar `motherboard` à lista `allowed` de `updateMachine`**

```js
function updateMachine(id, fields) {
  const allowed = ['display_name', 'location', 'critica', 'subnet', 'ip_interno',
                   'mac', 'agent_version', 'motherboard'];
  // ... resto inalterado
```

- [ ] **Step 4: Incluir novos campos em `getAllMachines`**

A query já retorna `m.*`, então `wol_status`, `wol_tested_at` e `motherboard` são incluídos automaticamente. Verificar que o campo existe no SELECT — OK.

- [ ] **Step 5: Adicionar `setWolStatus` ao module.exports**

```js
module.exports = {
  getDb,
  // machines
  registerMachine, getMachineByToken, getMachineById,
  getAllMachines, updateMachine, setMachineStatus, getMachinesStale, setWolStatus,
  // ... restante inalterado
```

- [ ] **Step 6: Adicionar função para buscar máquinas com WoL em teste**

```js
function getMachinesWolTesting(olderThanISO) {
  return getDb().prepare(`
    SELECT * FROM machines
    WHERE wol_status = 'testing' AND wol_tested_at IS NOT NULL AND wol_tested_at < ?
  `).all(olderThanISO);
}
```

E adicionar ao `module.exports`:
```js
getMachinesWolTesting,
```

---

## Task 4: Processar WoL status no heartbeat do servidor

**Files:**
- Modify: `server/routes/agent.js`

- [ ] **Step 1: Ler `wolEnabled` e `motherboard` do body no heartbeat**

No handler `POST /api/heartbeat` (linha ~44), após a lógica de `upd`:

```js
// Atualiza WoL driver status e motherboard
const { wolEnabled, motherboard } = req.body;

if (motherboard && !machine.motherboard) {
  upd.motherboard = motherboard;
}

if (wolEnabled !== undefined) {
  // Só atualiza wol_status se ainda não confirmado/testado
  const protectedStates = ['wol_confirmed', 'testing'];
  if (!protectedStates.includes(machine.wol_status)) {
    const newStatus = wolEnabled ? 'driver_enabled' : 'driver_disabled';
    if (newStatus !== machine.wol_status) {
      db.setWolStatus(machine.id, newStatus);
    }
  }
}
```

- [ ] **Step 2: Incluir `wolStatus` no broadcast do heartbeat**

```js
broadcast('machine:update', {
  machineId:   machine.id,
  displayName: machine.display_name || machine.hostname,
  status:      'online',
  lastSeen:    new Date().toISOString(),
  metrics,
  wolStatus:   machine.wol_status,   // ← adicionar
  motherboard: machine.motherboard,  // ← adicionar
});
```

---

## Task 5: Marcar WoL como "em teste" quando magic packet é enviado

**Files:**
- Modify: `server/routes/machines.js`

- [ ] **Step 1: Após criar o comando WoL, marcar o target como 'testing'**

Na rota `POST /:id/commands`, após `db.createCommand(...)`, adicionar:

```js
if (type === 'wol') {
  const now = new Date().toISOString();
  db.setWolStatus(machine.id, 'testing', now);
  console.log(`[WoL] Teste iniciado para ${machine.id} às ${now}`);
}
```

---

## Task 6: Guia de BIOS por fabricante

**Files:**
- Create: `server/services/wolBiosGuide.js`

- [ ] **Step 1: Criar arquivo com tabela de guias**

```js
'use strict';

// Mapa de fabricante (lowercase, parcial) → caminho no BIOS para habilitar WoL
const BIOS_GUIDES = [
  {
    match: ['asus', 'asustek'],
    manufacturer: 'ASUS',
    path: 'Advanced → APM Configuration → Power On By PCI-E/PCI → Enabled',
    note: 'Também verificar: ErP Ready = Disabled',
  },
  {
    match: ['gigabyte', 'giga-byte'],
    manufacturer: 'Gigabyte',
    path: 'Settings → IO Ports → Wake on LAN Enable → Enabled',
    note: 'Também verificar: Power → ErP → Disabled (obrigatório para WoL)',
  },
  {
    match: ['msi', 'micro-star'],
    manufacturer: 'MSI',
    path: 'Settings → Advanced → Power Management Setup → Resume By PCI-E Device → Enabled',
    note: '',
  },
  {
    match: ['asrock'],
    manufacturer: 'ASRock',
    path: 'Advanced → ACPI Configuration → PCIE Device Power On → Enabled',
    note: '',
  },
  {
    match: ['dell'],
    manufacturer: 'Dell',
    path: 'Settings → Power Management → Wake on LAN/WLAN → LAN Only',
    note: 'Opção pode aparecer como "Deep Sleep Control → Disabled"',
  },
  {
    match: ['hp', 'hewlett'],
    manufacturer: 'HP',
    path: 'Advanced → Power-On Options → S5 Wake On LAN → Enable',
    note: 'Em alguns modelos: S4/S5 Wake On LAN',
  },
  {
    match: ['lenovo'],
    manufacturer: 'Lenovo',
    path: 'Config → Network → Wake On LAN → Enabled',
    note: 'Em desktops Lenovo: Power → Automatic Power On → Wake on LAN → Enabled',
  },
  {
    match: ['intel'],
    manufacturer: 'Intel NUC',
    path: 'Power → Secondary Power Settings → Wake on LAN from S4/S5 → Power On - Normal Boot',
    note: '',
  },
];

const GENERIC_GUIDE = {
  manufacturer: 'Genérico',
  path: 'Power Management → Wake on LAN → Enabled (ou "PCI-E Wake" / "EuP Ready: Disabled")',
  note: 'Consulte o manual da placa-mãe. Palavras-chave: Wake on LAN, WoL, PCI-E Power On, ErP',
};

/**
 * Retorna o guia de BIOS para um fabricante dado.
 * @param {string} motherboard - Formato "Fabricante|Modelo" vindo do agente
 * @returns {{ manufacturer, model, path, note }}
 */
function getBiosGuide(motherboard) {
  const [mfr = '', model = ''] = (motherboard || '').split('|');
  const mfrLower = mfr.toLowerCase();

  const guide = BIOS_GUIDES.find(g => g.match.some(m => mfrLower.includes(m)));

  return {
    manufacturer: mfr || 'Desconhecido',
    model:        model || 'Desconhecido',
    path:         guide ? guide.path : GENERIC_GUIDE.path,
    note:         guide ? guide.note : GENERIC_GUIDE.note,
  };
}

module.exports = { getBiosGuide };
```

---

## Task 7: Alert engine — detectar timeout do teste WoL

**Files:**
- Modify: `server/services/alertEngine.js`

- [ ] **Step 1: Importar `getBiosGuide` e `getMachinesWolTesting`**

No início do arquivo, após os requires existentes:

```js
const { getBiosGuide } = require('./wolBiosGuide');
```

- [ ] **Step 2: Adicionar `checkWolTests()` em `checkAll()`**

```js
function checkAll() {
  checkOffline();
  checkMetricThresholds();
  checkWolTests(); // ← adicionar
}
```

- [ ] **Step 3: Implementar `checkWolTests()`**

```js
// Detecta máquinas cujo teste de WoL expirou (3 minutos sem resposta)
function checkWolTests() {
  const timeout = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const machines = db.getMachinesWolTesting(timeout);

  for (const machine of machines) {
    const displayName = machine.display_name || machine.hostname;
    const location    = machine.location || 'Sem localidade';

    if (machine.status === 'online') {
      // Máquina voltou → WoL funcionou!
      db.setWolStatus(machine.id, 'wol_confirmed');
      fireAlert(machine.id, 'wol_confirmed',
        `${displayName}: WoL confirmado! Máquina ligou via magic packet.`);
      console.log(`[WoL] Confirmado: ${machine.id}`);
    } else {
      // Máquina não voltou → BIOS precisa ser configurado
      db.setWolStatus(machine.id, 'bios_needed');
      const guide = getBiosGuide(machine.motherboard);
      sendWolBiosAlert(machine, displayName, location, guide);
      console.log(`[WoL] BIOS needed: ${machine.id} (${guide.manufacturer})`);
    }
  }
}
```

- [ ] **Step 4: Implementar `sendWolBiosAlert(machine, displayName, location, guide)`**

```js
async function sendWolBiosAlert(machine, displayName, location, guide) {
  const subject = `⚠️ WoL — Configurar BIOS: ${displayName}`;
  const bodyText = [
    `Máquina: ${displayName}`,
    `Localidade: ${location}`,
    `Placa-mãe: ${guide.manufacturer} — ${guide.model}`,
    ``,
    `O magic packet foi enviado mas a máquina não respondeu.`,
    `O driver Windows está configurado corretamente.`,
    `É necessário habilitar Wake-on-LAN na BIOS:`,
    ``,
    `  Caminho: ${guide.path}`,
    guide.note ? `  Obs: ${guide.note}` : '',
  ].filter(Boolean).join('\n');

  // 1. In-app via WebSocket
  fireAlert(machine.id, 'wol_bios_needed',
    `${displayName}: WoL falhou — configurar BIOS (${guide.manufacturer})`);

  // 2. Email
  await sendWolBiosEmail(subject, bodyText, guide, displayName, location);

  // 3. Teams
  await sendWolBiosTeams(displayName, location, guide);
}

async function sendWolBiosEmail(subject, bodyText, guide, displayName, location) {
  const cfg = loadConfig().alerts?.email;
  if (!cfg?.enabled || !cfg.to?.length) return;

  const transporter = nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth:   { user: cfg.user, pass: cfg.pass },
  });

  try {
    await transporter.sendMail({
      from:    `"Delirio Manager" <${cfg.user}>`,
      to:      cfg.to.join(', '),
      subject,
      html: `
        <h2 style="color:#f59e0b">⚠️ Wake-on-LAN — Configuração de BIOS Necessária</h2>
        <p><strong>Máquina:</strong> ${displayName}</p>
        <p><strong>Localidade:</strong> ${location}</p>
        <p><strong>Placa-mãe:</strong> ${guide.manufacturer} — ${guide.model}</p>
        <hr>
        <p>O <strong>driver Windows</strong> está corretamente configurado, mas a máquina não respondeu ao magic packet.</p>
        <p>É necessário habilitar Wake-on-LAN na BIOS:</p>
        <div style="background:#1e1e1e;color:#fff;padding:12px;border-radius:6px;font-family:monospace">
          ${guide.path}
        </div>
        ${guide.note ? `<p style="color:#888"><em>Obs: ${guide.note}</em></p>` : ''}
        <hr>
        <p style="color:#888;font-size:12px">Delirio Manager — Sistema de Monitoramento</p>
      `,
    });
    console.log(`[AlertEngine] Email WoL BIOS enviado: ${displayName}`);
  } catch (err) {
    console.error('[AlertEngine] Falha email WoL BIOS:', err.message);
  }
}

async function sendWolBiosTeams(displayName, location, guide) {
  const cfg = loadConfig().alerts?.teams;
  if (!cfg?.enabled || !cfg.webhook_url) return;

  const body = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: '⚠️ WoL — Configurar BIOS', weight: 'Bolder', size: 'Medium', color: 'Warning' },
          { type: 'FactSet', facts: [
            { title: 'Máquina',     value: displayName },
            { title: 'Localidade', value: location },
            { title: 'Placa-mãe', value: `${guide.manufacturer} — ${guide.model}` },
            { title: 'Caminho BIOS', value: guide.path },
            ...(guide.note ? [{ title: 'Obs', value: guide.note }] : []),
          ]},
        ],
      },
    }],
  };

  try {
    await fetch(cfg.webhook_url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    console.log(`[AlertEngine] Teams WoL BIOS enviado: ${displayName}`);
  } catch (err) {
    console.error('[AlertEngine] Falha Teams WoL BIOS:', err.message);
  }
}
```

---

## Task 8: Badge WoL no dashboard

**Files:**
- Modify: `dashboard/src/components/MachineCard.jsx`

- [ ] **Step 1: Definir constantes de WoL badge**

No início do componente, após as constantes `STATUS_COLOR` e `STATUS_LABEL`:

```js
const WOL_BADGE = {
  unknown:        null,
  driver_disabled: { color: '#ef4444', label: 'WoL ✗ driver', title: 'Driver Windows desabilitado' },
  driver_enabled:  { color: '#f59e0b', label: 'WoL ○',        title: 'Driver OK — WoL não testado. Clique em Desligar e depois Ligar para testar.' },
  testing:         { color: '#f59e0b', label: 'WoL …',         title: 'Teste em andamento' },
  wol_confirmed:   { color: '#22c55e', label: 'WoL ✓',         title: 'Wake-on-LAN confirmado e funcionando' },
  bios_needed:     { color: '#f59e0b', label: 'WoL ⚠ BIOS',   title: 'Driver OK mas BIOS precisa ser configurado. Verifique alertas.' },
}
```

- [ ] **Step 2: Adicionar badge WoL na linha compacta do card**

Na seção `mc-row` (linha compacta, sempre visível), após `{machine.pendingCommand && ...}`:

```jsx
{/* Badge WoL — visível na linha compacta */}
{(() => {
  const badge = WOL_BADGE[machine.wolStatus]
  if (!badge) return null
  return (
    <span
      style={{
        fontSize: '10px',
        padding: '1px 5px',
        borderRadius: '4px',
        background: badge.color + '22',
        color: badge.color,
        border: `1px solid ${badge.color}55`,
        cursor: 'default',
      }}
      title={badge.title}
    >
      {badge.label}
    </span>
  )
})()}
```

- [ ] **Step 3: Adicionar linha WoL no info-grid (painel expandido, aba Métricas)**

Após a linha de MAC no `mc-info-grid`:

```jsx
<span className="mc-info-label">MAC</span>
<span>{machine.mac || '—'}</span>
{machine.wolStatus && machine.wolStatus !== 'unknown' && (() => {
  const badge = WOL_BADGE[machine.wolStatus]
  return badge ? (
    <>
      <span className="mc-info-label">WoL</span>
      <span style={{ color: badge.color }} title={badge.title}>
        {badge.label}
        {machine.wolStatus === 'bios_needed' && machine.motherboard && (
          <span style={{ color: '#6b7280', fontSize: '11px', marginLeft: '4px' }}>
            ({machine.motherboard.split('|')[0]})
          </span>
        )}
      </span>
    </>
  ) : null
})()}
```

- [ ] **Step 4: Atualizar `useMachines` para mapear `wolStatus` do servidor**

Em `dashboard/src/hooks/useMachines.js`, na função que mapeia máquinas, garantir que `wolStatus` e `motherboard` são passados:

```js
// Na função de normalização de máquina (onde outros campos como displayName são mapeados)
// Adicionar:
wolStatus:   m.wol_status   || 'unknown',
motherboard: m.motherboard  || '',
```

Localizar onde `winEventsUnread` é mapeado e adicionar os campos próximos:
```js
winEventsUnread: m.winEventsUnread || 0,
wolStatus:       m.wol_status      || 'unknown',
motherboard:     m.motherboard     || '',
```

---

## Task 9: Build e deploy v1.5.0

**Files:**
- Modify: `agent/main.go` — Version = "1.5.0"

- [ ] **Step 1: Atualizar versão**

```go
Version = "1.5.0"
```

- [ ] **Step 2: Build**

```powershell
cd F:\RichClub\agent
$env:GOOS='windows'; $env:GOARCH='amd64'
go build -ldflags="-s -w" -o delirio-agent.exe .
```

Esperado: sem erros.

- [ ] **Step 3: Publicar**

```powershell
$bytes = [IO.File]::ReadAllBytes("F:\RichClub\agent\delirio-agent.exe")
Invoke-RestMethod -Uri "https://dt-manager.brazilsouth.cloudapp.azure.com/api/update/publish" `
  -Method Post -Body $bytes -ContentType "application/octet-stream" `
  -Headers @{"X-Agent-Version"="1.5.0"} -TimeoutSec 120
```

- [ ] **Step 4: Deploy servidor na VM**

```powershell
# Upload alertEngine.js (modificado)
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("F:\RichClub\server\services\alertEngine.js"))
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/server/services/alertEngine.js"

# Upload wolBiosGuide.js (novo)
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("F:\RichClub\server\services\wolBiosGuide.js"))
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/server/services/wolBiosGuide.js"

# Upload db.js, routes/agent.js, routes/machines.js
# (repetir para cada arquivo)

# Reiniciar PM2
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager `
  --command-id RunShellScript `
  --scripts "cd /opt/dt-manager && pm2 restart dt-manager"
```

- [ ] **Step 5: Broadcast update para todas as máquinas**

```powershell
Invoke-RestMethod -Uri "https://dt-manager.brazilsouth.cloudapp.azure.com/api/update/broadcast" `
  -Method Post -ContentType "application/json"
```

- [ ] **Step 6: Build dashboard e verificar badge**

```powershell
cd F:\RichClub\dashboard
npm run build
# Reiniciar app Electron para carregar novo build
```

---

## Verificação Final

Após deploy completo, verificar:

1. **Agent log** em qualquer máquina: deve mostrar `WoL driver: true | Placa: ASUS|...`
2. **Dashboard** cards: badge laranja "WoL ○" aparece em todas as máquinas com driver habilitado
3. **Teste WoL**:
   - Desligar TERMBSHOP6 via dashboard
   - Aguardar ficar offline
   - Clicar Ligar → badge muda para "WoL …"
   - Se máquina ligar → badge vira verde "WoL ✓"
   - Se não ligar em 3min → alerta disparado nos 3 canais com guia de BIOS
