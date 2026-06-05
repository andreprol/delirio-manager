# Log Translator + Alertas de Offline + Insights de IA — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar coleta e tradução de logs de boot (PT-BR), alertas de offline em 3 canais (in-app/email/Teams), insights de IA periódicos, duas temperaturas (CPU + sala), tempo online/offline no card, e correção do layout de expansão de cards.

**Architecture:** O agente Go coleta eventos do Windows Event Log no startup via PowerShell e envia ao servidor. O servidor expande o alert engine com email/Teams, cria um insight engine que chama a Claude API a cada 6h, e expõe novas rotas REST. O dashboard React adiciona abas Eventos e Insights nos cards, toast de offline, painel de alertas persistente, e painel global de insights.

**Tech Stack:** Go 1.26 (agent), Node.js 22 + Express + better-sqlite3 (server), React 19 + Vite (dashboard), nodemailer, @anthropic-ai/sdk, PowerShell (Windows Event Log)

**Spec:** `docs/superpowers/specs/2026-06-04-log-translator-alerts-insights-design.md`

---

## Fase 1 — Fundação: DB e Config do Servidor

### Task 1: Novas tabelas e colunas no banco

**Files:**
- Modify: `server/db.js`

- [ ] **1.1** Adicionar ao final do bloco `db.exec(...)` em `migrate()`, após a criação da tabela `groups`:

```js
    CREATE TABLE IF NOT EXISTS win_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      event_time   TEXT NOT NULL,
      received_at  TEXT NOT NULL DEFAULT (datetime('now')),
      event_id     INTEGER NOT NULL,
      source       TEXT NOT NULL,
      level        TEXT NOT NULL,
      translation  TEXT NOT NULL,
      raw_message  TEXT,
      is_read      INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_win_events_machine
      ON win_events(machine_id, event_time);

    CREATE TABLE IF NOT EXISTS insights (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id    TEXT REFERENCES machines(id) ON DELETE CASCADE,
      generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      severity      TEXT NOT NULL,
      pattern       TEXT NOT NULL,
      solution      TEXT,
      pattern_hash  TEXT NOT NULL,
      is_read       INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_hash
      ON insights(pattern_hash);
```

- [ ] **1.2** Ainda em `migrate()`, adicionar migração segura para colunas novas em `machines` e `metrics` (SQLite ignora `ALTER TABLE` se coluna já existe via `IF NOT EXISTS` — use try/catch):

```js
  // Migrações incrementais — seguras para rodar múltiplas vezes
  const migrations = [
    `ALTER TABLE machines ADD COLUMN online_since TEXT`,
    `ALTER TABLE metrics  ADD COLUMN room_temp_c  REAL DEFAULT -1`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* coluna já existe */ }
  }
```

- [ ] **1.3** Adicionar funções de acesso ao final de `db.js`, antes do `module.exports`:

```js
// ── Win Events ────────────────────────────────────────────────────────────────

function saveWinEvents(machineId, events) {
  const stmt = getDb().prepare(`
    INSERT INTO win_events (machine_id, event_time, event_id, source, level, translation, raw_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = getDb().transaction((evts) => {
    for (const e of evts) {
      stmt.run(machineId, e.eventTime, e.eventId, e.source, e.level, e.translation, e.rawMessage || null);
    }
  });
  insertMany(events);
}

function getWinEvents(machineId, scope = 'focused') {
  const focusedIds = [41, 6008, 1074, 1001, 19, 20, 7034, 6005, 6006];
  if (scope === 'focused') {
    const placeholders = focusedIds.map(() => '?').join(',');
    return getDb().prepare(`
      SELECT * FROM win_events
      WHERE machine_id = ? AND event_id IN (${placeholders})
      ORDER BY event_time DESC LIMIT 200
    `).all(machineId, ...focusedIds);
  }
  return getDb().prepare(`
    SELECT * FROM win_events WHERE machine_id = ?
    ORDER BY event_time DESC LIMIT 200
  `).all(machineId);
}

function markWinEventsRead(machineId) {
  getDb().prepare(`UPDATE win_events SET is_read = 1 WHERE machine_id = ?`).run(machineId);
}

function countUnreadWinEvents(machineId) {
  return getDb().prepare(`
    SELECT COUNT(*) as c FROM win_events WHERE machine_id = ? AND is_read = 0
  `).get(machineId).c;
}

// ── Insights ──────────────────────────────────────────────────────────────────

function saveInsight({ machineId, severity, pattern, solution, patternHash }) {
  getDb().prepare(`
    INSERT OR IGNORE INTO insights (machine_id, severity, pattern, solution, pattern_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(machineId || null, severity, pattern, solution || null, patternHash);
}

function getInsights({ machineId, limit = 50 } = {}) {
  if (machineId) {
    return getDb().prepare(`
      SELECT * FROM insights WHERE machine_id = ?
      ORDER BY generated_at DESC LIMIT ?
    `).all(machineId, limit);
  }
  return getDb().prepare(`
    SELECT i.*, m.display_name, m.hostname
    FROM insights i
    LEFT JOIN machines m ON i.machine_id = m.id
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      generated_at DESC
    LIMIT ?
  `).all(limit);
}

function markInsightRead(id) {
  getDb().prepare(`UPDATE insights SET is_read = 1 WHERE id = ?`).run(id);
}

function countUnreadInsights(machineId) {
  if (machineId) {
    return getDb().prepare(`
      SELECT COUNT(*) as c FROM insights WHERE machine_id = ? AND is_read = 0
    `).get(machineId).c;
  }
  return getDb().prepare(`SELECT COUNT(*) as c FROM insights WHERE is_read = 0`).get().c;
}
```

- [ ] **1.4** Adicionar as novas funções ao `module.exports`:

```js
  // win_events
  saveWinEvents, getWinEvents, markWinEventsRead, countUnreadWinEvents,
  // insights
  saveInsight, getInsights, markInsightRead, countUnreadInsights,
```

- [ ] **1.5** Reiniciar o servidor localmente e verificar que não há erros:
```
cd server && node server.js
```
Esperado: servidor sobe na porta 3847 sem erros de SQL.

---

### Task 2: Config do servidor e dependências NPM

**Files:**
- Create: `server/config.json`
- Modify: `server/package.json` (via npm install)

- [ ] **2.1** Criar `server/config.json`:

```json
{
  "alerts": {
    "email": {
      "enabled": false,
      "smtp_host": "smtp.gmail.com",
      "smtp_port": 587,
      "user": "",
      "pass": "",
      "to": []
    },
    "teams": {
      "enabled": false,
      "webhook_url": ""
    }
  },
  "insights": {
    "enabled": true,
    "interval_hours": 6,
    "claude_api_key": "",
    "lookback_days": 7
  }
}
```

- [ ] **2.2** Instalar dependências no servidor:
```
cd server && npm install nodemailer @anthropic-ai/sdk
```
Esperado: `package.json` atualizado com as duas novas dependências.

---

## Fase 2 — Correções Rápidas

### Task 3: Duas temperaturas no agente

**Files:**
- Modify: `agent/temperature.go`
- Modify: `agent/metrics.go`

- [ ] **3.1** Substituir todo o conteúdo de `agent/temperature.go`:

```go
package main

import (
	"strings"

	"github.com/shirou/gopsutil/v3/host"
)

// Temperatures contém as duas temperaturas coletadas.
type Temperatures struct {
	CPU  float64 // temperatura do processador (-1 = N/D)
	Room float64 // temperatura ambiente/sala (-1 = N/D)
}

// readTemperatures lê CPU e temperatura ambiente via sensores do sistema.
// CPU: sensores coretemp/k10temp (Intel/AMD). Room: sensor ACPI (gabinete/ambiente).
func readTemperatures() Temperatures {
	result := Temperatures{CPU: -1, Room: -1}

	temps, err := host.SensorsTemperatures()
	if err != nil || len(temps) == 0 {
		return result
	}

	// Sensores confiáveis de CPU (Intel e AMD)
	cpuPreferred := []string{
		"coretemp_core_0",
		"k10temp_tdie",
		"cpu_thermal_0",
		"cpu-thermal_0",
	}

	for _, name := range cpuPreferred {
		for _, t := range temps {
			if t.SensorKey == name && t.Temperature >= 35 && t.Temperature < 110 {
				result.CPU = round2(t.Temperature)
				break
			}
		}
		if result.CPU > 0 {
			break
		}
	}

	// Fallback CPU: qualquer sensor com "cpu" no nome (exceto acpitz)
	if result.CPU < 0 {
		for _, t := range temps {
			key := strings.ToLower(t.SensorKey)
			if strings.Contains(key, "cpu") &&
				!strings.Contains(key, "acpi") &&
				t.Temperature >= 35 && t.Temperature < 110 {
				result.CPU = round2(t.Temperature)
				break
			}
		}
	}

	// Temperatura da sala: sensor ACPI (acpitz = zona térmica do gabinete)
	for _, t := range temps {
		key := strings.ToLower(t.SensorKey)
		if strings.Contains(key, "acpi") && t.Temperature >= 10 && t.Temperature <= 50 {
			result.Room = round2(t.Temperature)
			break
		}
	}

	return result
}
```

- [ ] **3.2** Em `agent/metrics.go`, atualizar a struct `Metrics` — substituir `CPUTempC float64` por dois campos:

```go
type Metrics struct {
	CPUPct      float64  `json:"cpuPct"`
	RAMFreeMB   uint64   `json:"ramFreeMB"`
	RAMTotalMB  uint64   `json:"ramTotalMB"`
	DiskFreeGB  float64  `json:"diskFreeGB"`
	DiskTotalGB float64  `json:"diskTotalGB"`
	UptimeH     float64  `json:"uptimeH"`
	CPUTempC    float64  `json:"cpuTempC"`
	RoomTempC   float64  `json:"roomTempC"`
	IPs         []string `json:"ips"`
	MAC         string   `json:"mac"`
}
```

- [ ] **3.3** Em `collectMetrics()`, substituir a linha `m.CPUTempC = readCPUTemp()` por:

```go
	temps := readTemperatures()
	m.CPUTempC  = temps.CPU
	m.RoomTempC = temps.Room
```

- [ ] **3.4** Em `server/server.js`, no handler do heartbeat (ou em `routes/agent.js`), garantir que `roomTempC` é salvo. Encontrar onde `saveMetrics` é chamado e confirmar que o campo está sendo passado. Verificar `server/routes/agent.js`:

```js
// Em saveMetrics, o objeto já inclui roomTempC via m.roomTempC || -1
// Verificar que db.saveMetrics recebe o campo corretamente
```

- [ ] **3.5** Em `server/db.js`, atualizar `saveMetrics` para incluir `room_temp_c`:

```js
function saveMetrics(machineId, m) {
  const d   = getDb();
  const now = new Date().toISOString();

  d.prepare(`INSERT INTO metrics
    (machine_id, ts, cpu_pct, ram_free_mb, ram_total_mb,
     disk_free_gb, disk_total_gb, uptime_h, cpu_temp_c, room_temp_c, ips)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    machineId, now,
    m.cpuPct || 0, m.ramFreeMB || 0, m.ramTotalMB || 0,
    m.diskFreeGB || 0, m.diskTotalGB || 0,
    m.uptimeH || 0,
    m.cpuTempC  != null ? m.cpuTempC  : -1,
    m.roomTempC != null ? m.roomTempC : -1,
    JSON.stringify(m.ips || [])
  );

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  d.prepare('DELETE FROM metrics WHERE machine_id=? AND ts<?').run(machineId, cutoff);
}
```

- [ ] **3.6** Atualizar `getAllMachines()` em `db.js` para incluir `roomTempC` no JSON de métricas:

```js
      (SELECT json_object(
        'cpuPct', cpu_pct, 'ramFreeMB', ram_free_mb, 'ramTotalMB', ram_total_mb,
        'diskFreeGB', disk_free_gb, 'diskTotalGB', disk_total_gb,
        'uptimeH', uptime_h, 'cpuTempC', cpu_temp_c, 'roomTempC', room_temp_c, 'ips', ips
      ) FROM metrics WHERE machine_id = m.id ORDER BY ts DESC LIMIT 1) AS last_metrics
```

- [ ] **3.7** Compilar o agente para confirmar sem erros:
```powershell
cd F:\RichClub\agent
go build -o delirio-agent.exe .
```
Esperado: compilação sem erros.

---

### Task 4: Correção do layout de expansão de cards

**Files:**
- Modify: `dashboard/src/styles.css`

- [ ] **4.1** Localizar a regra `.group-machines` em `styles.css` e adicionar `align-items: flex-start`:

```css
.group-machines {
  /* ... propriedades existentes ... */
  align-items: flex-start;   /* ← ADICIONAR: impede cards vizinhos de esticar */
}
```

Se `.group-machines` não tiver regra ainda, adicionar após as regras de `.location-group`:

```css
.group-machines {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px 12px;
  align-items: flex-start;
}
```

- [ ] **4.2** Abrir o dashboard localmente (`cd dashboard && npm run dev`) e expandir um card. Verificar que os cards vizinhos não crescem junto.

---

### Task 5: Tempo online/offline e `online_since` no servidor

**Files:**
- Modify: `server/db.js`
- Modify: `server/services/alertEngine.js`
- Modify: `dashboard/src/components/MachineCard.jsx`

- [ ] **5.1** Em `db.js`, modificar `setMachineStatus` para gravar `online_since` quando status muda para `online`:

```js
function setMachineStatus(id, status) {
  const now = new Date().toISOString();
  if (status === 'online') {
    getDb().prepare(`
      UPDATE machines SET status=?, last_seen=?, online_since=? WHERE id=?
    `).run(status, now, now, id);
  } else {
    getDb().prepare(`
      UPDATE machines SET status=?, last_seen=? WHERE id=?
    `).run(status, now, id);
  }
}
```

- [ ] **5.2** Em `db.js`, modificar `registerMachine` para também gravar `online_since` no INSERT:

```js
  d.prepare(`INSERT INTO machines
    (id, hostname, display_name, location, token, agent_version, status, last_seen, online_since, registered_at)
    VALUES (?, ?, ?, 'temporário', ?, ?, 'online', ?, ?, ?)`
  ).run(machineId, hostname, hostname, token, agentVersion || '', now, now, now);
```

- [ ] **5.3** Em `alertEngine.js`, no início de `checkOffline()`, quando a máquina é marcada offline, garantir que o broadcast já inclui `onlineSince` para o dashboard calcular quanto tempo ficou online antes de cair:

```js
  for (const machine of stale) {
    db.setMachineStatus(machine.id, 'offline');
    db.addEvent(machine.id, 'offline', 'Sem heartbeat por mais de 3 minutos');

    broadcast('machine:offline', {
      machineId:   machine.id,
      displayName: machine.display_name || machine.hostname,
      location:    machine.location || '',
      lastSeen:    machine.last_seen,
      onlineSince: machine.online_since,
    });
    // ...resto do código existente
  }
```

- [ ] **5.4** Em `MachineCard.jsx`, adicionar a função auxiliar `formatDuration` e exibir o tempo no lugar do campo "Visto":

Adicionar acima do `return`:
```jsx
  function formatDuration(fromIso) {
    if (!fromIso) return null
    const diffMs  = Date.now() - new Date(fromIso).getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 60) return `${diffMin}min`
    const h = Math.floor(diffMin / 60)
    const d = Math.floor(h / 24)
    if (d > 0) return `${d}d ${h % 24}h`
    return `${h}h ${diffMin % 60}min`
  }

  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 60000)
    return () => clearInterval(t)
  }, [])

  const onlineDuration  = machine.onlineSince ? formatDuration(machine.onlineSince) : null
  const offlineDuration = status === 'offline' && machine.lastSeen
    ? formatDuration(machine.lastSeen) : null
```

- [ ] **5.5** No bloco `mc-info-grid` do card expandido, substituir a linha "Visto" por duas linhas informativas:

```jsx
            {status === 'online' && onlineDuration && (
              <>
                <span className="mc-info-label">Online há</span>
                <span style={{ color: 'var(--green)' }}>{onlineDuration}</span>
              </>
            )}
            {status === 'offline' && offlineDuration && (
              <>
                <span className="mc-info-label">Offline há</span>
                <span style={{ color: 'var(--red)' }}>{offlineDuration}</span>
              </>
            )}
```

- [ ] **5.6** Adicionar `onlineSince` e `lastSeen` ao mapeamento de máquinas em `useMachines.js`. Verificar o hook e garantir que o campo é repassado ao componente:
```
dashboard/src/hooks/useMachines.js
```
Confirmar que a propriedade `onlineSince` (camelCase) está sendo mapeada do campo `online_since` (snake_case) da API.

- [ ] **5.7** Atualizar as duas temperaturas no card expandido. Em `MachineCard.jsx`, localizar o bloco:
```jsx
          {m.cpuTempC > 0 && (
            <div className="mc-temp">
              TMP <span ...>{Math.round(m.cpuTempC)}°C</span>
            </div>
          )}
```
Substituir por:
```jsx
          <div className="mc-temps">
            {m.cpuTempC > 0 && (
              <span className="mc-temp-item">
                CPU <span style={{ color: m.cpuTempC > 80 ? 'var(--red)' : 'var(--text)' }}>
                  {Math.round(m.cpuTempC)}°C
                </span>
              </span>
            )}
            {m.roomTempC > 0 && (
              <span className="mc-temp-item">
                Sala <span style={{ color: m.roomTempC > 35 ? 'var(--yellow)' : 'var(--text)' }}>
                  {Math.round(m.roomTempC)}°C
                </span>
              </span>
            )}
          </div>
```

- [ ] **5.8** Adicionar CSS para `.mc-temps` e `.mc-temp-item` em `styles.css`:
```css
.mc-temps      { display: flex; gap: 12px; margin-top: 6px; font-size: 12px; }
.mc-temp-item  { color: var(--text-muted); }
.mc-temp-item span { color: var(--text); font-weight: 600; }
```

---

## Fase 3 — Log Translator (Agente + Servidor + Dashboard)

### Task 6: `LastHeartbeatAt` no config do agente

**Files:**
- Modify: `agent/config.go`
- Modify: `agent/agent.go`

- [ ] **6.1** Em `agent/config.go`, adicionar campo à struct `Config`:

```go
type Config struct {
	ServerURL         string `json:"serverUrl"`
	MachineID         string `json:"machineId"`
	Token             string `json:"token"`
	IntervalSecs      int    `json:"intervalSecs"`
	PollSecs          int    `json:"pollSecs"`
	LastHeartbeatAt   string `json:"lastHeartbeatAt"` // RFC3339, zerado = primeira vez
}
```

- [ ] **6.2** Em `agent/agent.go`, no método `sendHeartbeat()`, logo após a verificação de `resp.StatusCode == http.StatusOK`, gravar o timestamp:

```go
	if resp.StatusCode == http.StatusOK {
		// Salva timestamp do heartbeat bem-sucedido (usado na coleta de eventos no próximo boot)
		a.cfg.LastHeartbeatAt = time.Now().UTC().Format(time.RFC3339)
		_ = saveConfig(a.cfg)

		var hbResp HeartbeatResponse
		// ...resto do código existente
	}
```

---

### Task 7: Coleta de eventos do Windows — `agent/events.go`

**Files:**
- Create: `agent/events.go`

- [ ] **7.1** Criar `agent/events.go` com a lógica completa de coleta e tradução:

```go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// WinEvent representa um evento coletado do Windows Event Log.
type WinEvent struct {
	EventTime   string `json:"eventTime"`
	EventID     int    `json:"eventId"`
	Source      string `json:"source"`
	Level       string `json:"level"`
	Translation string `json:"translation"`
	RawMessage  string `json:"rawMessage"`
}

// EventsPayload é o JSON enviado a POST /api/win-events.
type EventsPayload struct {
	MachineID string     `json:"machineId"`
	Token     string     `json:"token"`
	Events    []WinEvent `json:"events"`
}

// eventTranslations mapeia Event ID → tradução PT-BR.
var eventTranslations = map[int]string{
	41:    "Reinicialização inesperada — possível queda de energia ou travamento",
	6008:  "Desligamento inesperado anterior detectado pelo sistema",
	1074:  "Desligamento ou reinício programado registrado",
	1076:  "Motivo do último desligamento registrado pelo operador",
	6005:  "Sistema iniciado normalmente",
	6006:  "Desligamento limpo do sistema",
	6009:  "Versão do Windows registrada na inicialização",
	6013:  "Tempo de atividade do sistema registrado",
	19:    "Windows Update: atualização instalada com sucesso",
	20:    "Windows Update: falha na instalação de atualização",
	43:    "Windows Update: instalação de atualizações iniciada",
	44:    "Windows Update: download de atualizações iniciado",
	7034:  "Serviço do sistema encerrou inesperadamente",
	7036:  "Status de serviço do sistema alterado",
	7040:  "Tipo de inicialização de serviço alterado",
	7045:  "Novo serviço instalado no sistema",
	7:     "Erro de leitura ou escrita detectado no disco",
	51:    "Aviso de erro em dispositivo de armazenamento",
	129:   "Timeout de reset no controlador de armazenamento",
	10000: "Adaptador de rede conectado",
	10001: "Adaptador de rede desconectado",
	42:    "Sistema entrando em modo de suspensão",
	107:   "Sistema saindo de modo de suspensão",
	109:   "Kernel iniciou sequência de energia",
	4624:  "Login bem-sucedido no sistema",
	4625:  "Tentativa de login falhou",
	4800:  "Estação de trabalho bloqueada",
	4801:  "Estação de trabalho desbloqueada",
	1001:  "Falha crítica do sistema (BSOD) detectada",
}

var levelMap = map[string]string{
	"Critical":    "critical",
	"Error":       "error",
	"Warning":     "warning",
	"Information": "info",
	"Verbose":     "info",
}

func translateEvent(id int, source, rawMsg string) string {
	if t, ok := eventTranslations[id]; ok {
		return t
	}
	return fmt.Sprintf("Evento do sistema — ID %d, Fonte: %s", id, source)
}

func normalizeLevel(lvl string) string {
	if l, ok := levelMap[lvl]; ok {
		return l
	}
	return "info"
}

// collectWindowsEvents busca eventos do Event Log entre `since` e agora via PowerShell.
func collectWindowsEvents(since time.Time) ([]WinEvent, error) {
	sinceStr := since.UTC().Format("2006-01-02T15:04:05")
	ids := "41,6008,1074,1076,6005,6006,6009,6013,19,20,43,44,7034,7036,7040,7045,7,51,129,10000,10001,42,107,109,4624,4625,4800,4801,1001"

	script := fmt.Sprintf(`
$since = [datetime]::ParseExact('%s', 'yyyy-MM-ddTHH:mm:ss', $null).ToLocalTime()
$ids   = @(%s)
$evts  = @()
foreach ($log in @('System','Application')) {
  try {
    $e = Get-WinEvent -FilterHashtable @{LogName=$log; StartTime=$since; Id=$ids} -ErrorAction SilentlyContinue
    if ($e) { $evts += $e }
  } catch {}
}
if ($evts.Count -eq 0) { Write-Output '[]'; exit }
$evts | Sort-Object TimeCreated | Select-Object -Last 200 |
  Select-Object @{n='t';e={$_.TimeCreated.ToUniversalTime().ToString('o')}},
               @{n='id';e={$_.Id}},
               @{n='src';e={$_.ProviderName}},
               @{n='lvl';e={$_.LevelDisplayName}},
               @{n='msg';e={($_.Message -split "`n")[0..1] -join ' '}} |
  ConvertTo-Json -Compress`, sinceStr, ids)

	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-Command", script)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("powershell event log: %w", err)
	}

	raw := strings.TrimSpace(out.String())
	if raw == "" || raw == "[]" {
		return []WinEvent{}, nil
	}

	var rows []struct {
		T   string `json:"t"`
		ID  int    `json:"id"`
		Src string `json:"src"`
		Lvl string `json:"lvl"`
		Msg string `json:"msg"`
	}
	if err := json.Unmarshal([]byte(raw), &rows); err != nil {
		// PowerShell pode retornar objeto único (não array) quando há 1 resultado
		var single struct {
			T   string `json:"t"`
			ID  int    `json:"id"`
			Src string `json:"src"`
			Lvl string `json:"lvl"`
			Msg string `json:"msg"`
		}
		if err2 := json.Unmarshal([]byte(raw), &single); err2 != nil {
			return nil, fmt.Errorf("parse json: %w", err)
		}
		rows = append(rows, single)
	}

	events := make([]WinEvent, 0, len(rows))
	for _, r := range rows {
		events = append(events, WinEvent{
			EventTime:   r.T,
			EventID:     r.ID,
			Source:      r.Src,
			Level:       normalizeLevel(r.Lvl),
			Translation: translateEvent(r.ID, r.Src, r.Msg),
			RawMessage:  r.Msg,
		})
	}
	return events, nil
}

// sendEvents envia os eventos coletados ao servidor.
func (a *Agent) sendEvents(events []WinEvent) error {
	if len(events) == 0 {
		return nil
	}
	payload := EventsPayload{
		MachineID: a.cfg.MachineID,
		Token:     a.cfg.Token,
		Events:    events,
	}
	resp, err := a.post("/api/win-events", payload)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}
```

- [ ] **7.2** Compilar para verificar sem erros:
```powershell
cd F:\RichClub\agent && go build -o delirio-agent.exe .
```

---

### Task 8: Chamar coleta de eventos no startup do agente

**Files:**
- Modify: `agent/agent.go`

- [ ] **8.1** Em `agent.go`, no método `start()`, após `go a.heartbeatLoop()`, adicionar a coleta de eventos em goroutine separada que aguarda o primeiro heartbeat bem-sucedido:

```go
func (a *Agent) start() error {
	if a.cfg.ServerURL == "" {
		return fmt.Errorf("ServerURL nao configurado. Execute: agent.exe -server URL")
	}

	cleanOldExe()

	if a.cfg.Token == "" {
		if err := a.register(); err != nil {
			logWarn(fmt.Sprintf("Registro falhou: %v. Tentando sem token.", err))
		}
	}

	go a.heartbeatLoop()
	go a.commandLoop()
	go a.collectAndSendBootEvents() // ← NOVO

	return nil
}

// collectAndSendBootEvents aguarda o primeiro heartbeat e então coleta eventos do boot.
func (a *Agent) collectAndSendBootEvents() {
	// Aguarda até ter token (garantia de que o servidor nos conhece)
	for i := 0; i < 10; i++ {
		if a.cfg.Token != "" {
			break
		}
		time.Sleep(3 * time.Second)
	}
	if a.cfg.Token == "" {
		logWarn("collectBootEvents: sem token após 30s, abortando coleta.")
		return
	}

	// Determina janela de coleta
	since := time.Now().Add(-2 * time.Hour) // padrão: últimas 2h
	if a.cfg.LastHeartbeatAt != "" {
		if t, err := time.Parse(time.RFC3339, a.cfg.LastHeartbeatAt); err == nil {
			since = t
		}
	}

	logInfo(fmt.Sprintf("Coletando eventos do Windows desde %s...", since.Format(time.RFC3339)))

	events, err := collectWindowsEvents(since)
	if err != nil {
		logWarn(fmt.Sprintf("Erro ao coletar eventos: %v", err))
		return
	}

	if err := a.sendEvents(events); err != nil {
		logWarn(fmt.Sprintf("Erro ao enviar eventos: %v", err))
		return
	}

	logInfo(fmt.Sprintf("Eventos enviados ao servidor: %d", len(events)))
}
```

- [ ] **8.2** Compilar e verificar:
```powershell
cd F:\RichClub\agent && go build -o delirio-agent.exe .
```

---

### Task 9: Rota de eventos no servidor

**Files:**
- Create: `server/routes/winEvents.js`

- [ ] **9.1** Criar `server/routes/winEvents.js`:

```js
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { broadcast } = require('../services/websocket');
const { getMachineByToken } = require('../db');

// POST /api/win-events  — recebe eventos do agente
router.post('/', (req, res) => {
  const { machineId, token, events } = req.body;

  if (!machineId || !token || !Array.isArray(events)) {
    return res.status(400).json({ error: 'machineId, token e events são obrigatórios' });
  }

  const machine = getMachineByToken(token);
  if (!machine || machine.id !== machineId) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  if (events.length === 0) {
    return res.json({ saved: 0 });
  }

  try {
    db.saveWinEvents(machineId, events);

    const unread = db.countUnreadWinEvents(machineId);
    broadcast('new_win_events', {
      machineId,
      count: unread,
    });

    res.json({ saved: events.length });
  } catch (err) {
    console.error('[WinEvents] Erro ao salvar:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/machines/:id/win-events?scope=focused|broad
router.get('/machines/:id/win-events', (req, res) => {
  const { id }    = req.params;
  const { scope } = req.query;
  try {
    const events = db.getWinEvents(id, scope || 'focused');
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/machines/:id/win-events/read
router.put('/machines/:id/win-events/read', (req, res) => {
  db.markWinEventsRead(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **9.2** Registrar as rotas em `server/server.js`. Adicionar após os `require` das rotas existentes:

```js
const winEventsRouter = require('./routes/winEvents');
```

E no bloco de rotas, adicionar (montar em `/api` cobre os três endpoints do router):
```js
app.use('/api', winEventsRouter);
// Cobre: POST /api/win-events
//        GET  /api/machines/:id/win-events
//        PUT  /api/machines/:id/win-events/read
```

- [ ] **9.3** Reiniciar o servidor e testar:
```
curl -X GET http://localhost:3847/health
```
Esperado: `{"status":"ok",...}` sem erros no console.

---

### Task 10: Aba Eventos no dashboard — `EventsTab.jsx`

**Files:**
- Create: `dashboard/src/components/EventsTab.jsx`
- Modify: `dashboard/src/api.js`
- Modify: `dashboard/src/components/MachineCard.jsx`

- [ ] **10.1** Adicionar métodos à API client em `dashboard/src/api.js`:

```js
  // Win Events
  getWinEvents:      (id, scope = 'focused') => request('GET', `/api/machines/${id}/win-events?scope=${scope}`),
  markWinEventsRead: (id)                    => request('PUT', `/api/machines/${id}/win-events/read`),
```

- [ ] **10.2** Criar `dashboard/src/components/EventsTab.jsx`:

```jsx
import { useState, useEffect } from 'react'
import { api } from '../api'

const LEVEL_ICON  = { critical: '🔴', error: '🔴', warning: '🟡', info: '🟢' }
const LEVEL_COLOR = { critical: '#ef4444', error: '#ef4444', warning: '#f59e0b', info: '#94a3b8' }

export function EventsTab({ machineId, onRead }) {
  const [scope,    setScope]    = useState('focused')
  const [events,   setEvents]   = useState([])
  const [loading,  setLoading]  = useState(true)
  const [expanded, setExpanded] = useState(null) // id do evento expandido

  useEffect(() => {
    setLoading(true)
    api.getWinEvents(machineId, scope)
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoading(false))
  }, [machineId, scope])

  useEffect(() => {
    api.markWinEventsRead(machineId).catch(() => {})
    onRead?.()
  }, [machineId])

  if (loading) return <div className="tab-loading">Carregando eventos...</div>

  if (events.length === 0) return (
    <div className="tab-empty">
      Nenhum evento registrado neste período.{' '}
      {scope === 'focused' && (
        <button className="link-btn" onClick={() => setScope('broad')}>
          Ver modo Amplo
        </button>
      )}
    </div>
  )

  return (
    <div className="events-tab">
      <div className="events-scope-toggle">
        <button
          className={`scope-btn ${scope === 'focused' ? 'scope-active' : ''}`}
          onClick={() => setScope('focused')}
        >🎯 Focado</button>
        <button
          className={`scope-btn ${scope === 'broad' ? 'scope-active' : ''}`}
          onClick={() => setScope('broad')}
        >📋 Amplo</button>
      </div>

      <div className="events-list">
        {events.map(ev => (
          <div key={ev.id} className="event-row">
            <div
              className="event-summary"
              onClick={() => setExpanded(expanded === ev.id ? null : ev.id)}
            >
              <span className="event-icon">{LEVEL_ICON[ev.level] || '⚪'}</span>
              <span className="event-time">
                {new Date(ev.event_time).toLocaleTimeString('pt-BR', {
                  hour: '2-digit', minute: '2-digit', second: '2-digit'
                })}
              </span>
              <span className="event-translation">{ev.translation}</span>
              <span className="event-arrow">{expanded === ev.id ? '▼' : '▶'}</span>
            </div>
            {expanded === ev.id && (
              <div className="event-detail">
                <span className="event-detail-label">Event ID:</span> {ev.event_id}
                {' · '}
                <span className="event-detail-label">Fonte:</span> {ev.source}
                {ev.raw_message && (
                  <pre className="event-raw">{ev.raw_message}</pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **10.3** Adicionar CSS para os componentes de eventos em `styles.css`:

```css
/* ── Events Tab ─────────────────────────────────────────────────────────────── */
.events-tab        { padding: 4px 0; }
.events-scope-toggle { display: flex; gap: 4px; margin-bottom: 8px; }
.scope-btn  {
  padding: 3px 10px; border-radius: 12px; font-size: 11px; cursor: pointer;
  background: var(--bg-3); border: 1px solid var(--border); color: var(--text-muted);
}
.scope-active { background: var(--purple); border-color: var(--purple); color: #fff; }
.events-list   { display: flex; flex-direction: column; gap: 2px; }
.event-row     { border-radius: 4px; overflow: hidden; }
.event-summary {
  display: flex; align-items: center; gap: 6px; padding: 5px 6px;
  cursor: pointer; border-radius: 4px;
}
.event-summary:hover { background: var(--bg-3); }
.event-icon    { font-size: 11px; flex-shrink: 0; }
.event-time    { color: var(--text-muted); font-size: 11px; white-space: nowrap; min-width: 62px; }
.event-translation { flex: 1; font-size: 12px; color: var(--text); }
.event-arrow   { color: var(--text-muted); font-size: 10px; flex-shrink: 0; }
.event-detail  {
  background: var(--bg); border-top: 1px solid var(--border);
  padding: 6px 10px; font-size: 11px; color: var(--text-muted);
}
.event-detail-label { color: var(--text-muted); font-weight: 600; }
.event-raw  {
  margin-top: 4px; font-family: monospace; font-size: 10px;
  color: #6b7280; white-space: pre-wrap; word-break: break-all;
  max-height: 80px; overflow-y: auto;
}
.tab-loading { padding: 12px; color: var(--text-muted); font-size: 12px; }
.tab-empty   { padding: 12px; color: var(--text-muted); font-size: 12px; }
.link-btn    { background: none; border: none; color: var(--purple); cursor: pointer; text-decoration: underline; font-size: 12px; }
```

- [ ] **10.4** Modificar `MachineCard.jsx` para adicionar sistema de abas (Métricas / Eventos). No topo do componente, adicionar estado:

```jsx
  const [activeTab, setActiveTab] = useState('metrics') // 'metrics' | 'events' | 'insights'
  const [eventsUnread, setEventsUnread] = useState(machine.winEventsUnread || 0)
```

- [ ] **10.5** No painel expandido (`mc-detail`), adicionar o seletor de abas antes do `mc-info-grid`:

```jsx
          <div className="mc-tabs">
            <button
              className={`mc-tab ${activeTab === 'metrics' ? 'mc-tab-active' : ''}`}
              onClick={() => setActiveTab('metrics')}
            >Métricas</button>
            <button
              className={`mc-tab ${activeTab === 'events' ? 'mc-tab-active' : ''}`}
              onClick={() => setActiveTab('events')}
            >
              Eventos
              {eventsUnread > 0 && (
                <span className="tab-badge">{eventsUnread}</span>
              )}
            </button>
          </div>
```

- [ ] **10.6** Envolver o conteúdo existente de métricas em `{activeTab === 'metrics' && (...)}` e adicionar a aba de eventos:

```jsx
          {activeTab === 'metrics' && (
            <>
              <div className="mc-info-grid">
                {/* ... conteúdo existente do mc-info-grid ... */}
              </div>
              <div className="mc-metrics">
                {/* ... MetricBars e temperaturas ... */}
              </div>
            </>
          )}

          {activeTab === 'events' && (
            <EventsTab
              machineId={machine.id}
              onRead={() => setEventsUnread(0)}
            />
          )}
```

- [ ] **10.7** Adicionar import de `EventsTab` no topo de `MachineCard.jsx`:
```jsx
import { EventsTab } from './EventsTab'
```

- [ ] **10.8** Adicionar CSS das abas em `styles.css`:
```css
/* ── Machine Card Tabs ───────────────────────────────────────────────────────── */
.mc-tabs     { display: flex; gap: 2px; margin-bottom: 10px; border-bottom: 1px solid var(--border); }
.mc-tab      {
  padding: 5px 12px; font-size: 12px; cursor: pointer; background: none;
  border: none; color: var(--text-muted); border-bottom: 2px solid transparent;
  margin-bottom: -1px; display: flex; align-items: center; gap: 5px;
}
.mc-tab:hover     { color: var(--text); }
.mc-tab-active    { color: var(--purple); border-bottom-color: var(--purple); }
.tab-badge {
  background: var(--red); color: #fff; border-radius: 10px;
  padding: 0 5px; font-size: 10px; font-weight: 700;
}
```

- [ ] **10.9** Testar no dashboard: expandir um card, clicar na aba "Eventos". Verificar que a aba aparece corretamente (estará vazia até o agente enviar eventos reais).

---

## Fase 4 — Alertas de Offline (3 Canais + Toast + Painel)

### Task 11: Expandir `alertEngine.js` com email e Teams

**Files:**
- Modify: `server/services/alertEngine.js`

- [ ] **11.1** No topo de `alertEngine.js`, adicionar os requires e carregar config:

```js
'use strict';

const path       = require('path');
const nodemailer = require('nodemailer');
const db         = require('../db');
const { broadcast } = require('./websocket');

const CHECK_INTERVAL_MS = 60 * 1000;
const cpuAlertStart = new Map();
let timer;

function loadConfig() {
  try {
    const cfgPath = path.join(__dirname, '..', 'config.json');
    return JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
  } catch {
    return { alerts: { email: { enabled: false }, teams: { enabled: false } } };
  }
}
```

- [ ] **11.2** Substituir a função `checkOffline()` existente pela versão expandida:

```js
function checkOffline() {
  const threshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const stale     = db.getMachinesStale(threshold);

  for (const machine of stale) {
    db.setMachineStatus(machine.id, 'offline');
    db.addEvent(machine.id, 'offline', 'Sem heartbeat por mais de 3 minutos');

    // Busca último estado de saúde
    let lastMetrics = null;
    try {
      const raw = db.getMetrics(machine.id, 1);
      if (raw.length > 0) lastMetrics = raw[raw.length - 1];
    } catch {}

    const displayName = machine.display_name || machine.hostname;
    const location    = machine.location || 'Sem localidade';

    // 1. In-app via WebSocket
    broadcast('machine:offline', {
      machineId: machine.id,
      displayName,
      location,
      lastSeen:    machine.last_seen,
      onlineSince: machine.online_since,
      lastMetrics,
    });

    // 2. Email
    sendOfflineEmail(displayName, location, machine.last_seen, lastMetrics);

    // 3. Teams
    sendOfflineTeams(displayName, location, machine.last_seen, lastMetrics);

    console.log(`[AlertEngine] Offline: ${machine.id}`);
  }
}
```

- [ ] **11.3** Adicionar as funções de envio de email e Teams após `checkOffline`:

```js
function formatMetricsText(m) {
  if (!m) return 'Métricas não disponíveis';
  const ram = m.ram_total_mb > 0
    ? `${Math.round((1 - m.ram_free_mb / m.ram_total_mb) * 100)}%`
    : 'N/D';
  const cpu  = m.cpu_pct   != null ? `${m.cpu_pct}%`   : 'N/D';
  const temp = m.cpu_temp_c > 0    ? `${Math.round(m.cpu_temp_c)}°C` : 'N/D';
  const sala = m.room_temp_c > 0   ? `${Math.round(m.room_temp_c)}°C` : 'N/D';
  return `CPU: ${cpu} | RAM: ${ram} | Temp CPU: ${temp} | Temp Sala: ${sala}`;
}

async function sendOfflineEmail(displayName, location, lastSeen, lastMetrics) {
  const cfg = loadConfig().alerts?.email;
  if (!cfg?.enabled || !cfg.to?.length) return;

  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  const when    = lastSeen ? new Date(lastSeen).toLocaleString('pt-BR') : 'desconhecido';
  const metrics = formatMetricsText(lastMetrics);

  try {
    await transporter.sendMail({
      from:    `"Delirio Manager" <${cfg.user}>`,
      to:      cfg.to.join(', '),
      subject: `🔴 Máquina Offline: ${displayName}`,
      html: `
        <h2 style="color:#ef4444">🔴 Máquina Offline</h2>
        <p><strong>Máquina:</strong> ${displayName}</p>
        <p><strong>Localidade:</strong> ${location}</p>
        <p><strong>Último contato:</strong> ${when}</p>
        <hr>
        <p><strong>Último estado de saúde:</strong><br>${metrics}</p>
        <hr>
        <p style="color:#888;font-size:12px">Delirio Manager — Sistema de Monitoramento</p>
      `,
    });
  } catch (err) {
    console.error('[AlertEngine] Falha ao enviar email:', err.message);
  }
}

async function sendOfflineTeams(displayName, location, lastSeen, lastMetrics) {
  const cfg = loadConfig().alerts?.teams;
  if (!cfg?.enabled || !cfg.webhook_url) return;

  const when    = lastSeen ? new Date(lastSeen).toLocaleString('pt-BR') : 'desconhecido';
  const metrics = formatMetricsText(lastMetrics);

  const body = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: '🔴 Máquina Offline', weight: 'Bolder', size: 'Medium', color: 'Attention' },
          { type: 'FactSet', facts: [
            { title: 'Máquina',        value: displayName },
            { title: 'Localidade',     value: location    },
            { title: 'Último contato', value: when        },
            { title: 'Saúde',          value: metrics     },
          ]},
        ],
      },
    }],
  };

  try {
    const { default: fetch } = await import('node-fetch').catch(() => ({ default: global.fetch }));
    await fetch(cfg.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[AlertEngine] Falha Teams webhook:', err.message);
  }
}
```

**Nota:** Node.js 22 tem `fetch` nativo — a linha `import('node-fetch')` usa ele como fallback. Não é necessário instalar `node-fetch`.

- [ ] **11.4** Reiniciar o servidor e verificar que não há erros ao iniciar:
```
cd server && node server.js
```

---

### Task 12: Toast de offline e painel de alertas no dashboard

**Files:**
- Create: `dashboard/src/components/OfflineToast.jsx`
- Create: `dashboard/src/components/AlertsPanel.jsx`
- Modify: `dashboard/src/App.jsx`
- Modify: `dashboard/src/styles.css`
- Modify: `dashboard/src/hooks/useWebSocket.js`

- [ ] **12.1** Verificar `dashboard/src/hooks/useWebSocket.js` e garantir que o hook expõe uma forma de receber eventos arbitrários. Se o hook só ouve eventos específicos, adicionar suporte a listener genérico. Caso o hook use `onmessage`, confirmar que o evento `machine:offline` chega ao App.

- [ ] **12.2** Criar `dashboard/src/components/OfflineToast.jsx`:

```jsx
import { useEffect, useState } from 'react'

export function OfflineToast({ toast, onDismiss }) {
  const [progress, setProgress] = useState(100)

  useEffect(() => {
    if (!toast) return
    const start  = Date.now()
    const duration = 8000
    const timer  = setInterval(() => {
      const elapsed = Date.now() - start
      const pct     = Math.max(0, 100 - (elapsed / duration) * 100)
      setProgress(pct)
      if (pct === 0) { clearInterval(timer); onDismiss() }
    }, 100)
    return () => clearInterval(timer)
  }, [toast])

  if (!toast) return null

  return (
    <div className="offline-toast" onClick={onDismiss}>
      <div className="offline-toast-header">
        <span style={{ color: 'var(--red)', fontWeight: 700, fontSize: 11, textTransform: 'uppercase' }}>
          🔴 Máquina Offline
        </span>
        <span style={{ color: '#555', fontSize: 10 }}>clique para fechar</span>
      </div>
      <div className="offline-toast-name">{toast.displayName}</div>
      <div className="offline-toast-loc">{toast.location}</div>
      <div className="offline-toast-progress">
        <div className="offline-toast-bar" style={{ width: `${progress}%` }} />
      </div>
    </div>
  )
}
```

- [ ] **12.3** Criar `dashboard/src/components/AlertsPanel.jsx`:

```jsx
import { useState, useEffect } from 'react'

const STORAGE_KEY = 'dt_alerts'

function loadAlerts() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}
function saveAlertsToStorage(alerts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts.slice(0, 100)))
}

export function AlertsPanel({ newOfflineAlert, onClose }) {
  const [alerts, setAlerts] = useState(loadAlerts)

  useEffect(() => {
    if (!newOfflineAlert) return
    setAlerts(prev => {
      const updated = [{ ...newOfflineAlert, id: Date.now(), read: false }, ...prev]
      saveAlertsToStorage(updated)
      return updated
    })
  }, [newOfflineAlert])

  function markAllRead() {
    setAlerts(prev => {
      const updated = prev.map(a => ({ ...a, read: true }))
      saveAlertsToStorage(updated)
      return updated
    })
  }

  const unread = alerts.filter(a => !a.read).length

  return (
    <div className="alerts-panel">
      <div className="alerts-panel-header">
        <span>🔔 Alertas {unread > 0 && <span className="tab-badge">{unread}</span>}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {unread > 0 && (
            <button className="link-btn" onClick={markAllRead}>Marcar todos lidos</button>
          )}
          <button className="link-btn" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="alerts-panel-list">
        {alerts.length === 0 && (
          <div className="tab-empty">Nenhum alerta registrado.</div>
        )}
        {alerts.map(a => (
          <div key={a.id} className={`alert-item ${a.read ? 'alert-read' : ''}`}>
            <div className="alert-item-title">
              <span style={{ color: 'var(--red)', fontWeight: 700 }}>{a.displayName}</span>
              {!a.read && <span className="alert-new-dot" />}
            </div>
            <div className="alert-item-sub">{a.location}</div>
            <div className="alert-item-time">
              {new Date(a.lastSeen || a.id).toLocaleString('pt-BR')}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function useAlertsCount() {
  const [count, setCount] = useState(() => loadAlerts().filter(a => !a.read).length)
  useEffect(() => {
    const onStorage = () => setCount(loadAlerts().filter(a => !a.read).length)
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  return [count, setCount]
}
```

- [ ] **12.4** Adicionar CSS dos componentes de alerta em `styles.css`:

```css
/* ── Offline Toast ───────────────────────────────────────────────────────────── */
.offline-toast {
  position: fixed; bottom: 20px; right: 20px; z-index: 9999;
  background: var(--bg-2); border: 1px solid var(--border);
  border-left: 3px solid var(--red); border-radius: var(--radius);
  padding: 12px 14px; width: 260px; cursor: pointer;
  box-shadow: var(--shadow);
}
.offline-toast-header { display: flex; justify-content: space-between; margin-bottom: 4px; }
.offline-toast-name   { color: var(--text); font-weight: 700; font-size: 14px; }
.offline-toast-loc    { color: var(--text-muted); font-size: 12px; margin-top: 2px; }
.offline-toast-progress { height: 3px; background: var(--bg-3); border-radius: 2px; margin-top: 10px; }
.offline-toast-bar    { height: 100%; background: var(--red); border-radius: 2px; transition: width .1s linear; }

/* ── Alerts Panel ────────────────────────────────────────────────────────────── */
.alerts-panel {
  position: fixed; top: 52px; right: 0; width: 300px; height: calc(100vh - 52px);
  background: var(--bg-2); border-left: 1px solid var(--border);
  z-index: 100; display: flex; flex-direction: column;
  box-shadow: -4px 0 16px rgba(0,0,0,0.3);
}
.alerts-panel-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
  font-weight: 600; flex-shrink: 0;
}
.alerts-panel-list   { flex: 1; overflow-y: auto; padding: 8px; }
.alert-item          {
  padding: 10px; border-radius: var(--radius); margin-bottom: 6px;
  background: var(--bg-3); border-left: 3px solid var(--red);
}
.alert-read          { opacity: 0.5; border-left-color: var(--border); }
.alert-item-title    { display: flex; justify-content: space-between; align-items: center; }
.alert-item-sub      { color: var(--text-muted); font-size: 11px; margin-top: 2px; }
.alert-item-time     { color: #555; font-size: 10px; margin-top: 4px; }
.alert-new-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--red); flex-shrink: 0;
}

/* ── Bell button ────────────────────────────────────────────────────────────── */
.bell-btn {
  position: relative; padding: 5px 10px; border-radius: var(--radius); cursor: pointer;
  background: var(--bg-3); border: 1px solid var(--border);
  color: var(--text-muted); font-size: 16px; line-height: 1;
}
.bell-badge {
  position: absolute; top: -4px; right: -4px;
  background: var(--red); color: #fff;
  border-radius: 10px; padding: 0 5px; font-size: 9px; font-weight: 700;
}
```

- [ ] **12.5** Integrar toast e painel em `App.jsx`. Adicionar imports no topo:

```jsx
import { OfflineToast }             from './components/OfflineToast'
import { AlertsPanel, useAlertsCount } from './components/AlertsPanel'
```

- [ ] **12.6** No corpo do `App()`, adicionar estados:

```jsx
  const [offlineToast,    setOfflineToast]    = useState(null)
  const [showAlertsPanel, setShowAlertsPanel] = useState(false)
  const [newOfflineAlert, setNewOfflineAlert] = useState(null)
  const [alertsCount,     setAlertsCount]     = useAlertsCount()
```

- [ ] **12.7** Em `App.jsx`, adicionar listener de WebSocket para `machine:offline`. Localizar onde o WebSocket é consumido (provavelmente em `useMachines`) e adicionar, ou usar o hook diretamente com `useWebSocket`:

```jsx
  const { onMessage } = useWebSocket?.() || {}
  useEffect(() => {
    // O hook useMachines já processa WebSocket internamente.
    // Aqui interceptamos o evento 'machine:offline' para toast e painel.
    // Verificar implementação de useWebSocket para adicionar listener.
  }, [])
```

**Nota:** Verificar `dashboard/src/hooks/useWebSocket.js`. Se o hook não expõe `onMessage`, modificar `useMachines.js` para chamar um callback externo ao receber `machine:offline`. A abordagem mais simples: em `useMachines.js`, adicionar um callback `onOffline` recebido como prop.

Solução alternativa — em `useMachines.js`, exportar os alertas offline diretamente:
```js
// No hook, quando receber machine:offline via WS:
if (msg.type === 'machine:offline') {
  setLastOffline(msg.data) // novo estado exportado pelo hook
}
```
E consumir `lastOffline` no `App.jsx` em um `useEffect`.

- [ ] **12.8** Adicionar o sino com badge e o painel no JSX de `App.jsx`:

No `topbar-right`, adicionar antes do botão "Config":
```jsx
          <button className="bell-btn" onClick={() => { setShowAlertsPanel(v => !v); setAlertsCount(0) }}>
            🔔
            {alertsCount > 0 && <span className="bell-badge">{alertsCount}</span>}
          </button>
```

No final do JSX, antes de `</div>` do `app`, adicionar:
```jsx
      <OfflineToast toast={offlineToast} onDismiss={() => setOfflineToast(null)} />
      {showAlertsPanel && (
        <AlertsPanel
          newOfflineAlert={newOfflineAlert}
          onClose={() => setShowAlertsPanel(false)}
        />
      )}
```

- [ ] **12.9** Testar: desligar a ESTOQUE-BSHOP (ou simular enviando evento offline via `broadcast` no servidor). Verificar que o toast aparece e o painel de alertas recebe o item.

---

## Fase 5 — Insights de IA

### Task 13: Rotas de insights no servidor

**Files:**
- Create: `server/routes/insights.js`

- [ ] **13.1** Criar `server/routes/insights.js`:

```js
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const insightEngine = require('../services/insightEngine');

// GET /api/insights?machine_id=X&limit=50
router.get('/', (req, res) => {
  const { machine_id, limit } = req.query;
  try {
    const insights = db.getInsights({
      machineId: machine_id || null,
      limit: parseInt(limit) || 50,
    });
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/insights/:id/read
router.put('/:id/read', (req, res) => {
  db.markInsightRead(parseInt(req.params.id));
  res.json({ ok: true });
});

// POST /api/insights/generate  — força geração manual (debug)
router.post('/generate', async (req, res) => {
  try {
    const result = await insightEngine.runNow();
    res.json({ generated: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **13.2** Registrar a rota em `server/server.js`:

```js
const insightRoutes = require('./routes/insights');
// ...
app.use('/api/insights', insightRoutes);
```

---

### Task 14: Insight Engine com Claude API

**Files:**
- Create: `server/services/insightEngine.js`

- [ ] **14.1** Criar `server/services/insightEngine.js`:

```js
'use strict';

const path   = require('path');
const crypto = require('crypto');
const db     = require('../db');
const { broadcast } = require('./websocket');

function loadConfig() {
  try {
    const cfgPath = path.join(__dirname, '..', 'config.json');
    return JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
  } catch {
    return { insights: { enabled: false } };
  }
}

let timer;

function start() {
  const cfg = loadConfig().insights || {};
  if (!cfg.enabled || !cfg.claude_api_key) {
    console.log('[InsightEngine] Desabilitado ou sem API key.');
    return;
  }

  const intervalMs = (cfg.interval_hours || 6) * 60 * 60 * 1000;
  timer = setInterval(runNow, intervalMs);
  console.log(`[InsightEngine] Iniciado — intervalo: ${cfg.interval_hours || 6}h`);
}

function stop() {
  if (timer) clearInterval(timer);
}

async function runNow() {
  const cfg = loadConfig().insights || {};
  if (!cfg.claude_api_key) return 0;

  const machines = db.getAllMachines();
  let totalGenerated = 0;

  for (const machine of machines) {
    try {
      const generated = await analyzesMachine(machine, cfg);
      totalGenerated += generated;
    } catch (err) {
      console.error(`[InsightEngine] Erro em ${machine.id}: ${err.message}`);
    }
  }

  console.log(`[InsightEngine] Ciclo concluído — ${totalGenerated} insights gerados.`);
  return totalGenerated;
}

async function analyzesMachine(machine, cfg) {
  const lookbackDays = cfg.lookback_days || 7;
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  // Busca eventos do Windows dos últimos N dias
  const events = db.getDb().prepare(`
    SELECT event_id, source, level, translation, event_time
    FROM win_events WHERE machine_id = ? AND event_time >= ?
    ORDER BY event_time DESC LIMIT 150
  `).all(machine.id, since);

  // Busca alertas de offline dos últimos N dias
  const offlineEvents = db.getDb().prepare(`
    SELECT ts, type, details FROM events
    WHERE machine_id = ? AND type = 'offline' AND ts >= ?
    ORDER BY ts DESC LIMIT 30
  `).all(machine.id, since);

  if (events.length === 0 && offlineEvents.length === 0) return 0;

  const name = machine.display_name || machine.hostname;
  const context = buildContext(name, events, offlineEvents);

  const prompt = `Você é um especialista em suporte técnico Windows. Analise os eventos abaixo da máquina "${name}" e identifique padrões problemáticos.

REGRAS CRÍTICAS:
1. Só aponte padrões com evidência clara nos dados (mínimo 2 ocorrências ou 1 evento crítico grave).
2. Para "solution": SOMENTE sugira se tiver alta confiança na solução. Se não souber com certeza, retorne null. Nunca invente soluções.
3. Retorne JSON válido, sem texto extra.

DADOS:
${context}

Responda SOMENTE com JSON neste formato exato:
{
  "insights": [
    {
      "severity": "critical|warning|info",
      "pattern": "Descrição clara do padrão em português (máx 200 chars)",
      "solution": "Solução realista e específica em português (máx 300 chars) ou null"
    }
  ]
}

Se não houver padrões relevantes, retorne: {"insights":[]}`;

  let responseText;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic.default({ apiKey: cfg.claude_api_key });

    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });
    responseText = msg.content[0]?.text || '{"insights":[]}';
  } catch (err) {
    console.error(`[InsightEngine] Claude API error: ${err.message}`);
    return 0;
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    console.warn(`[InsightEngine] Resposta inválida da API para ${machine.id}`);
    return 0;
  }

  const machineInsights = parsed.insights || [];
  let saved = 0;

  for (const insight of machineInsights) {
    if (!insight.pattern || !insight.severity) continue;

    const hash = crypto
      .createHash('sha256')
      .update(`${machine.id}:${insight.pattern.slice(0, 80)}`)
      .digest('hex');

    db.saveInsight({
      machineId:   machine.id,
      severity:    insight.severity,
      pattern:     insight.pattern,
      solution:    insight.solution || null,
      patternHash: hash,
    });
    saved++;
  }

  if (saved > 0) {
    broadcast('new_insight', {
      machineId: machine.id,
      count: saved,
    });
  }

  return saved;
}

function buildContext(name, events, offlineEvents) {
  const lines = [];

  if (offlineEvents.length > 0) {
    lines.push(`=== QUEDAS OFFLINE (últimas ${offlineEvents.length}) ===`);
    offlineEvents.forEach(e => lines.push(`${e.ts}: ${e.details}`));
  }

  if (events.length > 0) {
    lines.push(`=== EVENTOS DO WINDOWS (últimos ${events.length}) ===`);
    events.forEach(e =>
      lines.push(`${e.event_time} [${e.level.toUpperCase()}] ID:${e.event_id} ${e.translation}`)
    );
  }

  // Truncar para não exceder contexto (~8000 chars)
  const full = lines.join('\n');
  return full.length > 8000 ? full.slice(0, 8000) + '\n[... truncado ...]' : full;
}

module.exports = { start, stop, runNow };
```

- [ ] **14.2** Em `server/server.js`, importar e iniciar o insight engine:

```js
const insightEngine = require('./services/insightEngine');
// ...
server.listen(PORT, () => {
  // ...logs existentes...
  alertEngine.start();
  insightEngine.start(); // ← NOVO
});

process.on('SIGTERM', () => {
  alertEngine.stop();
  insightEngine.stop(); // ← NOVO
  server.close(() => process.exit(0));
});
```

- [ ] **14.3** Testar a geração manual de insights:
```
curl -X POST http://localhost:3847/api/insights/generate
```
Esperado: `{"generated":0}` (0 porque não há eventos ainda — correto).

---

### Task 15: Aba Insights e painel global no dashboard

**Files:**
- Create: `dashboard/src/components/InsightsTab.jsx`
- Create: `dashboard/src/components/GlobalInsightsPanel.jsx`
- Modify: `dashboard/src/api.js`
- Modify: `dashboard/src/components/MachineCard.jsx`
- Modify: `dashboard/src/App.jsx`
- Modify: `dashboard/src/styles.css`

- [ ] **15.1** Adicionar métodos à API client em `api.js`:

```js
  // Insights
  getInsights:     (machineId)  => request('GET', `/api/insights${machineId ? `?machine_id=${machineId}` : ''}`),
  markInsightRead: (id)         => request('PUT', `/api/insights/${id}/read`),
  generateInsights: ()          => request('POST', '/api/insights/generate'),
```

- [ ] **15.2** Criar `dashboard/src/components/InsightsTab.jsx`:

```jsx
import { useState, useEffect } from 'react'
import { api } from '../api'

const SEV_ICON  = { critical: '🔴', warning: '🟡', info: '🔵' }
const SEV_COLOR = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' }

export function InsightsTab({ machineId, onRead }) {
  const [insights, setInsights] = useState([])
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    setLoading(true)
    api.getInsights(machineId)
      .then(setInsights)
      .catch(() => setInsights([]))
      .finally(() => setLoading(false))
  }, [machineId])

  useEffect(() => {
    insights.filter(i => !i.is_read).forEach(i => {
      api.markInsightRead(i.id).catch(() => {})
    })
    onRead?.()
  }, [insights])

  if (loading) return <div className="tab-loading">Analisando padrões...</div>

  if (insights.length === 0) return (
    <div className="tab-empty">
      Nenhum padrão detectado ainda. A IA analisa os logs automaticamente a cada 6h.
    </div>
  )

  return (
    <div className="insights-tab">
      {insights.map(ins => (
        <div key={ins.id} className={`insight-item sev-${ins.severity}`}>
          <div className="insight-header">
            <span style={{ color: SEV_COLOR[ins.severity] }}>
              {SEV_ICON[ins.severity]} {ins.severity === 'critical' ? 'Crítico' : ins.severity === 'warning' ? 'Atenção' : 'Info'}
            </span>
            <span className="insight-date">
              {new Date(ins.generated_at).toLocaleDateString('pt-BR')}
            </span>
          </div>
          <p className="insight-pattern">{ins.pattern}</p>
          {ins.solution && (
            <div className="insight-solution">
              <span className="insight-solution-label">💡 Solução sugerida</span>
              <p>{ins.solution}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **15.3** Criar `dashboard/src/components/GlobalInsightsPanel.jsx`:

```jsx
import { useState, useEffect } from 'react'
import { api } from '../api'

const SEV_COLOR = { critical: 'var(--red)', warning: 'var(--yellow)', info: 'var(--blue)' }
const SEV_ICON  = { critical: '🔴', warning: '🟡', info: '🔵' }

export function GlobalInsightsPanel() {
  const [insights,  setInsights]  = useState([])
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    api.getInsights().then(setInsights).catch(() => {})
  }, [])

  const unread = insights.filter(i => !i.is_read).length

  if (insights.length === 0) return null

  return (
    <div className="global-insights">
      <div className="global-insights-header" onClick={() => setCollapsed(c => !c)}>
        <span>
          ✨ Insights de IA
          {unread > 0 && <span className="tab-badge" style={{ marginLeft: 6 }}>{unread}</span>}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {collapsed ? '▶' : '▼'} {insights.length} padrão{insights.length !== 1 ? 'ões' : ''}
        </span>
      </div>

      {!collapsed && (
        <div className="global-insights-list">
          {insights.slice(0, 10).map(ins => (
            <div key={ins.id} className="global-insight-row">
              <span style={{ color: SEV_COLOR[ins.severity], flexShrink: 0 }}>
                {SEV_ICON[ins.severity]}
              </span>
              <div style={{ flex: 1 }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  {ins.display_name || ins.hostname || 'Global'}
                </span>
                {' — '}
                <span style={{ fontSize: 12 }}>{ins.pattern}</span>
              </div>
              {ins.solution && (
                <span title={ins.solution} style={{ color: '#2ecc71', fontSize: 12, cursor: 'help' }}>💡</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **15.4** Adicionar CSS para insights em `styles.css`:

```css
/* ── Insights Tab ────────────────────────────────────────────────────────────── */
.insights-tab          { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
.insight-item          {
  border-radius: var(--radius); padding: 10px;
  background: var(--bg-3); border-left: 3px solid var(--border);
}
.insight-item.sev-critical { border-left-color: var(--red); }
.insight-item.sev-warning  { border-left-color: var(--yellow); }
.insight-item.sev-info     { border-left-color: var(--blue); }
.insight-header        { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 11px; }
.insight-date          { color: var(--text-muted); }
.insight-pattern       { font-size: 12px; color: var(--text); margin: 0; }
.insight-solution      {
  margin-top: 8px; background: rgba(46,204,113,.08);
  border-radius: 4px; padding: 6px 8px;
}
.insight-solution-label { color: #2ecc71; font-size: 11px; font-weight: 600; display: block; margin-bottom: 3px; }
.insight-solution p    { margin: 0; font-size: 11px; color: #94a3b8; }

/* ── Global Insights Panel ───────────────────────────────────────────────────── */
.global-insights         {
  background: var(--bg-2); border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.global-insights-header  {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 16px; cursor: pointer; font-size: 13px; font-weight: 600;
}
.global-insights-header:hover { background: var(--bg-3); }
.global-insights-list    { padding: 4px 16px 10px; display: flex; flex-direction: column; gap: 4px; }
.global-insight-row {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 5px 6px; border-radius: 4px; font-size: 12px;
}
.global-insight-row:hover { background: var(--bg-3); }
```

- [ ] **15.5** Adicionar aba "Insights" ao `MachineCard.jsx` — no `mc-tabs`, adicionar:

```jsx
            <button
              className={`mc-tab ${activeTab === 'insights' ? 'mc-tab-active' : ''}`}
              onClick={() => setActiveTab('insights')}
            >
              ✨ Insights
              {insightsUnread > 0 && <span className="tab-badge">{insightsUnread}</span>}
            </button>
```

E adicionar o estado e o painel no corpo:
```jsx
  const [insightsUnread, setInsightsUnread] = useState(0)

  // No painel expandido:
  {activeTab === 'insights' && (
    <InsightsTab
      machineId={machine.id}
      onRead={() => setInsightsUnread(0)}
    />
  )}
```

- [ ] **15.6** Adicionar import de `InsightsTab` em `MachineCard.jsx`:
```jsx
import { InsightsTab } from './InsightsTab'
```

- [ ] **15.7** Em `App.jsx`, adicionar o `GlobalInsightsPanel` entre o `alerts-bar` e o conteúdo principal:

```jsx
import { GlobalInsightsPanel } from './components/GlobalInsightsPanel'

// No JSX, após o bloco de alertas existentes:
<GlobalInsightsPanel />
```

- [ ] **15.8** Testar o painel global: abrir o dashboard, verificar que o painel de insights aparece (inicialmente oculto pois não há insights). Chamar `POST /api/insights/generate` e recarregar para confirmar que insights aparecem quando disponíveis.

---

## Fase 6 — Build e Deploy

### Task 16: Compilar agente v1.3.0 e publicar

**Files:**
- Modify: `agent/main.go` (bump version)
- Modify: `agent/build.ps1`

- [ ] **16.1** Em `agent/main.go`, atualizar a constante de versão:
```go
const Version = "1.3.0"
```

- [ ] **16.2** Compilar o agente para Windows (64-bit):
```powershell
cd F:\RichClub\agent
$env:GOOS = "windows"; $env:GOARCH = "amd64"
go build -ldflags="-s -w" -o delirio-agent.exe .
```
Esperado: `delirio-agent.exe` gerado sem erros.

- [ ] **16.3** Verificar SHA256 do novo binário:
```powershell
Get-FileHash .\delirio-agent.exe -Algorithm SHA256
```
Guardar o hash para atualizar a memória do projeto.

- [ ] **16.4** Copiar o binário para a VM via `az vm run-command`:
```powershell
$exe = [Convert]::ToBase64String([IO.File]::ReadAllBytes("F:\RichClub\agent\delirio-agent.exe"))
# (upload em partes se necessário — binário ~9MB)
```
**Nota:** Para arquivos grandes, usar o endpoint `PUT /api/update/upload` existente no servidor, ou fazer upload via `Invoke-WebRequest` diretamente para a VM.

- [ ] **16.5** Atualizar o hash no servidor (endpoint `/api/update/version`) para que o auto-update das máquinas seja disparado.

---

### Task 17: Deploy do servidor na VM Azure

- [ ] **17.1** Empacotar os arquivos novos/modificados do servidor para envio:
```
server/routes/winEvents.js   ← novo
server/routes/insights.js    ← novo
server/services/insightEngine.js ← novo
server/services/alertEngine.js   ← modificado
server/db.js                     ← modificado
server/server.js                 ← modificado
server/config.json               ← novo (configurar antes de enviar)
```

- [ ] **17.2** Usar `az vm run-command` para instalar as novas dependências na VM:
```powershell
& "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd" vm run-command invoke `
  --resource-group rg-delirio `
  --name dt-manager `
  --command-id RunShellScript `
  --scripts "cd /srv/dt-manager/server && npm install nodemailer @anthropic-ai/sdk && pm2 restart dt-manager"
```

- [ ] **17.3** Enviar os arquivos modificados para a VM e reiniciar PM2:
```powershell
# Usar upload-servidor.ps1 existente ou az vm run-command com base64
# Ver procedimento em Projetos/Remote Manager/Overview.md (Obsidian)
```

- [ ] **17.4** Verificar que o servidor subiu corretamente:
```powershell
Invoke-RestMethod "https://dt-manager.brazilsouth.cloudapp.azure.com/health"
```
Esperado: `status: ok` com a versão atualizada.

- [ ] **17.5** Configurar `server/config.json` na VM com as credenciais reais de email e/ou webhook do Teams.

---

## Resumo dos arquivos modificados/criados

| Arquivo | Ação |
|---|---|
| `agent/temperature.go` | Modificar — duas temperaturas (CPU + sala) |
| `agent/metrics.go` | Modificar — campo `RoomTempC` |
| `agent/config.go` | Modificar — campo `LastHeartbeatAt` |
| `agent/agent.go` | Modificar — `collectAndSendBootEvents()` |
| `agent/events.go` | **Criar** — coleta e tradução de eventos |
| `agent/main.go` | Modificar — versão 1.3.0 |
| `server/db.js` | Modificar — tabelas win_events, insights, colunas online_since e room_temp_c |
| `server/server.js` | Modificar — novas rotas + insightEngine |
| `server/config.json` | **Criar** — config de alertas e insights |
| `server/routes/winEvents.js` | **Criar** |
| `server/routes/insights.js` | **Criar** |
| `server/services/alertEngine.js` | Modificar — email + Teams |
| `server/services/insightEngine.js` | **Criar** — análise periódica via Claude API |
| `dashboard/src/api.js` | Modificar — novos endpoints |
| `dashboard/src/styles.css` | Modificar — CSS de abas, eventos, insights, toast, painel |
| `dashboard/src/App.jsx` | Modificar — GlobalInsightsPanel, toast, sino |
| `dashboard/src/components/MachineCard.jsx` | Modificar — abas + temperaturas + tempo online/offline |
| `dashboard/src/components/EventsTab.jsx` | **Criar** |
| `dashboard/src/components/InsightsTab.jsx` | **Criar** |
| `dashboard/src/components/OfflineToast.jsx` | **Criar** |
| `dashboard/src/components/AlertsPanel.jsx` | **Criar** |
| `dashboard/src/components/GlobalInsightsPanel.jsx` | **Criar** |
