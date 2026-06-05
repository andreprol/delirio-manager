# Spec: Log Translator + Alertas de Offline + Insights de IA

**Data:** 2026-06-04
**Projeto:** Delirio Manager
**Status:** Aprovado

---

## Visão Geral

Duas funcionalidades complementares que transformam o Delirio Manager de um monitor passivo em um sistema diagnóstico ativo:

1. **Log Translator** — quando uma máquina volta online após um período offline, o agente coleta os eventos do Windows Event Log do período ausente e os exibe no dashboard em português claro, com filtro Focado/Amplo e detalhe técnico expansível.

2. **Alertas de Offline + Insights de IA** — quando uma máquina cai, dispara alertas em 3 canais (in-app, email, Teams). A IA analisa periodicamente os logs acumulados e gera diagnósticos com soluções realistas.

---

## Arquitetura

```
[Máquina volta online]
    → Agente lê Windows Event Log (do último heartbeat até agora)
    → Traduz Event IDs → PT-BR localmente
    → POST /api/events → SQLite (machine_events)
    → Dashboard: aba "Eventos" com badge "novo"

[Alert Engine detecta timeout de heartbeat]
    → In-app: toast imediato (8s) + painel de alertas persistente + badge no card
    → Email: nodemailer SMTP com último estado de saúde (CPU/RAM/temp)
    → Teams: POST webhook com card formatado

[Insight Engine — a cada 6h]
    → Lê machine_events + alerts dos últimos 7 dias
    → Chama Claude API (Haiku) com contexto compacto
    → Salva insights em machine_insights
    → Dashboard: aba "Insights" por máquina + painel global
```

---

## Seção 1: Agente Go — `agent/events.go`

### Trigger
Executado uma única vez na inicialização do agente, antes do primeiro heartbeat.

### Janela de coleta
Do timestamp salvo em `last_heartbeat` no `config.json` até `time.Now()`. Se `last_heartbeat` não existir (primeira instalação), coleta as últimas 2 horas.

### Canais do Windows Event Log
- `System`
- `Application`

### Event IDs traduzidos

| Categoria | Event ID | Tradução PT-BR |
|---|---|---|
| **Inicialização** | 6005 | Sistema iniciado normalmente |
| | 6009 | Windows [versão] inicializado |
| | 6013 | Sistema ativo há [X] dias/horas |
| **Desligamento** | 6006 | Desligamento limpo do sistema |
| | 1074 | Desligamento/reinício por [processo] — motivo: [razão] |
| | 1076 | Motivo do último desligamento registrado |
| **Crash / Inesperado** | 41 | Reinicialização inesperada — possível queda de energia ou travamento |
| | 6008 | Desligamento inesperado anterior detectado |
| | 1001 | Tela azul da morte (BSOD) — código: [BugCheck] |
| **Windows Update** | 19 | Update instalado com sucesso: [KB/pacote] |
| | 20 | Falha na instalação do update: [KB/pacote] |
| | 43 | Instalação de updates iniciada |
| | 44 | Download de updates iniciado |
| **Serviços** | 7034 | Serviço "[nome]" encerrou inesperadamente |
| | 7036 | Serviço "[nome]" [iniciado/parado] |
| | 7040 | Tipo de inicialização do serviço "[nome]" alterado |
| | 7045 | Novo serviço instalado: "[nome]" |
| **Hardware / Disco** | 7 (disk) | Erro de leitura/escrita no disco |
| | 51 | Aviso de erro no dispositivo de armazenamento |
| | 129 | Timeout de reset no controlador de armazenamento |
| **Rede** | 10000 | Adaptador de rede conectado |
| | 10001 | Adaptador de rede desconectado |
| **Energia** | 42 | Sistema entrando em modo de suspensão |
| | 107 | Sistema saindo de modo de suspensão |
| | 109 | Kernel iniciou energia |
| **Segurança** | 4624 | Login bem-sucedido — usuário: [nome] |
| | 4625 | Falha de login — usuário: [nome] |
| | 4800 | Estação de trabalho bloqueada |
| | 4801 | Estação de trabalho desbloqueada |

Event ID desconhecido: `"Evento do sistema — ID [X], Fonte: [nome]"`

### Filtros
- **Focado:** IDs 41, 6008, 1074, 1001, 19, 20, 7034, 6005, 6006
- **Amplo:** todos os 30 acima

O filtro é aplicado no **dashboard**, não no agente. O agente envia todos os eventos — o dashboard filtra na exibição.

### Payload enviado
`POST /api/events`
```json
{
  "machine_id": 42,
  "events": [
    {
      "event_time": "2026-06-04T10:32:14Z",
      "event_id": 41,
      "source": "Kernel-Power",
      "level": "critical",
      "translation": "Reinicialização inesperada — possível queda de energia ou travamento",
      "raw_message": "The system has rebooted without cleanly shutting down first..."
    }
  ]
}
```

---

## Seção 2: Servidor Node.js

### Novas tabelas SQLite

```sql
CREATE TABLE IF NOT EXISTS machine_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id   INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  event_time   TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  event_id     INTEGER NOT NULL,
  source       TEXT NOT NULL,
  level        TEXT NOT NULL,
  translation  TEXT NOT NULL,
  raw_message  TEXT,
  is_read      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS machine_insights (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id    INTEGER REFERENCES machines(id) ON DELETE CASCADE,
  generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  severity      TEXT NOT NULL,
  pattern       TEXT NOT NULL,
  solution      TEXT,
  pattern_hash  TEXT NOT NULL,
  is_read       INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_hash ON machine_insights(pattern_hash);
```

`machine_id NULL` em `machine_insights` = insight global (padrão detectado em múltiplas máquinas).

### Novos arquivos

**`server/routes/events.js`**
- `POST /api/events` — salva array de eventos, marca `is_read = 0`, emite WS `new_events`
- `GET /api/machines/:id/events` — retorna eventos, aceita `?scope=focused|broad`
- `PUT /api/machines/:id/events/read` — marca todos como lidos

**`server/routes/insights.js`**
- `GET /api/insights` — todos os insights, aceita `?machine_id=X`
- `PUT /api/insights/:id/read` — marca como lido
- `POST /api/insights/generate` — força geração manual (útil para testes)

**`server/services/insightEngine.js`**
- Intervalo: 6 horas (configurável via `config.json`)
- Contexto enviado à Claude API: eventos + alertas dos últimos 7 dias, agrupados por máquina, truncados a 8.000 tokens
- Modelo: `claude-haiku-4-5-20251001` (rápido, barato para análise recorrente)
- Prompt instrui explicitamente: *"Se não tiver alta confiança na solução, retorne solution como null. Nunca invente soluções."*
- Deduplicação: `SHA256(machine_id + pattern)` → não insere se hash já existir

### Expansão do `alertEngine.js`

Quando `status` muda para `offline`:
1. Busca último registro de métricas (`cpu_usage`, `ram_usage`, `temperature`) da tabela `metrics`
2. Emite WebSocket `machine_offline` com `{ machine, lastMetrics }`
3. Se `alerts.email.enabled`: envia email via nodemailer
4. Se `alerts.teams.enabled`: POST no webhook

### Configuração (`server/config.json`)
```json
{
  "alerts": {
    "email": {
      "enabled": false,
      "smtp_host": "",
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

---

## Seção 3: Dashboard React

### Componentes novos

**`EventsTab.jsx`**
- Toggle Focado/Amplo no topo
- Lista cronológica reversa (mais recente primeiro)
- Linha: ícone severidade + horário (HH:MM:SS) + tradução PT-BR + seta ▶/▼
- Expandido: Event ID, Source, `raw_message` em fonte monospace
- Chama `PUT .../events/read` ao abrir a aba

**`InsightsTab.jsx`**
- Lista de insights da máquina
- Cada item: badge de severidade colorido + descrição do padrão
- Solução (quando presente): bloco verde destacado com prefixo 💡
- Quando `solution` é null: exibe só o padrão, sem seção de solução

**`AlertsPanel.jsx`**
- Painel lateral deslizante (direita), abre pelo sino no topbar
- Contador no sino: alertas `is_read = 0`
- Botão "Marcar todos como lidos"
- Estado persistido no `localStorage`

**`OfflineToast.jsx`**
- Posição: canto inferior direito
- Duração: 8 segundos, com barra de progresso
- Conteúdo: nome da máquina + localidade + "offline há Xs"
- Clique: fecha toast e scrolla/expande o card da máquina

**`GlobalInsightsPanel.jsx`**
- Seção colapsável no topo do dashboard (abaixo da busca)
- Mostra até 10 insights mais recentes/críticos
- Ordenação: `critical` → `warning` → `info`, depois por `generated_at` desc
- Clique no insight: expande o card da máquina e abre aba Insights

### Mudanças em arquivos existentes

**`MachineCard.jsx`**
- Abas expandidas: Métricas · Eventos · Insights (cada uma com badge numérico)
- Badge vermelho piscando na borda do card quando offline + alerta não lido

**`App.jsx`**
- Listener WS `machine_offline` → enfileira toast + adiciona ao painel de alertas
- Listener WS `new_events` → incrementa badge da aba Eventos do card afetado
- Listener WS `new_insight` → incrementa badge da aba Insights + painel global

---

## Arquivos a criar/modificar

| Arquivo | Ação |
|---|---|
| `agent/events.go` | Criar |
| `agent/config.go` | Modificar — salvar/ler `last_heartbeat` |
| `agent/agent.go` | Modificar — chamar `collectAndSendEvents()` no startup |
| `server/routes/events.js` | Criar |
| `server/routes/insights.js` | Criar |
| `server/services/insightEngine.js` | Criar |
| `server/services/alertEngine.js` | Modificar — adicionar email, Teams, WS offline |
| `server/server.js` | Modificar — registrar novas rotas, iniciar insightEngine |
| `server/db.js` | Modificar — criar novas tabelas no setup |
| `server/config.json` | Criar |
| `dashboard/src/components/EventsTab.jsx` | Criar |
| `dashboard/src/components/InsightsTab.jsx` | Criar |
| `dashboard/src/components/AlertsPanel.jsx` | Criar |
| `dashboard/src/components/OfflineToast.jsx` | Criar |
| `dashboard/src/components/GlobalInsightsPanel.jsx` | Criar |
| `dashboard/src/components/MachineCard.jsx` | Modificar |
| `dashboard/src/App.jsx` | Modificar |
| `dashboard/src/styles.css` | Modificar — fix align-items cards container |
| `server/db.js` | Modificar — adicionar coluna `online_since` em `machines` |
| `server/services/alertEngine.js` | Modificar — gravar `online_since` na transição offline→online |
| `agent/temperature.go` | Modificar — fix sensor ACPI, threshold 35°C, retorna -1 se N/D |

---

## Dependências Novas

| Pacote | Onde | Motivo |
|---|---|---|
| `nodemailer` | `server/` | Envio de email via SMTP |
| `@anthropic-ai/sdk` | `server/` | Chamadas à Claude API no insightEngine |

Ambas adicionadas ao `server/package.json` e instaladas na VM via `npm install`.

---

---

## Seção 5: Correções e Melhorias no Dashboard/Agente Existente

### 5.1 Tempo Online/Offline no card

**Servidor — tabela `machines`:**
Adicionar coluna `online_since TEXT` — atualizada para `datetime('now')` quando status muda de `offline` → `online`. Já existe `last_seen` para o cálculo de tempo offline.

**Dashboard — `MachineCard.jsx`:**
- Máquina online: exibir "Online há Xd Xh Xmin" calculado em tempo real (`now - online_since`)
- Máquina offline: exibir "Offline há Xh Xmin" calculado em tempo real (`now - last_seen`)
- Atualizar a cada 60s via `setInterval` local no componente

### 5.2 Leitura de Duas Temperaturas: CPU + Sala

O agente passa a coletar e reportar **duas temperaturas distintas**:

| Campo | Fonte | Descrição |
|---|---|---|
| `cpuTempC` | `coretemp_*`, `k10temp_*`, `cpu_thermal_*` | Temperatura do processador |
| `roomTempC` | `acpitz_thermal_0` | Temperatura ambiente/sala (sensor ACPI do gabinete) |

**Mudanças em `agent/temperature.go`:**
- Nova função `readTemperatures() (cpuTemp, roomTemp float64)`
- CPU: busca sensores `coretemp_*` / `k10temp_*` / `cpu_thermal_*` ≥ 35°C; retorna -1 se não encontrar
- Sala: busca sensor `acpitz_*` com temperatura plausível (10°C–50°C); retorna -1 se não encontrar

**Mudanças em `agent/metrics.go`:**
- `Metrics` struct: substituir `CPUTempC float64` por `CPUTempC float64` + `RoomTempC float64`

**Mudanças no servidor `db.js`:**
- Tabela `metrics`: adicionar coluna `room_temp_c REAL DEFAULT -1`

**Mudanças no dashboard `MachineCard.jsx`:**
- Exibir duas linhas de temperatura quando disponíveis:
  - `CPU 65°C` (vermelho se > 80°C)
  - `Sala 28°C` (amarelo se > 35°C)

### 5.3 Correção do Layout de Expansão de Cards

**Problema:** Cards ficam em container `display: flex` com `align-items: stretch` (padrão CSS). Quando um card expande, todos os cards da linha crescem junto.

**Correção em `dashboard/src/styles.css` (ou no componente do container):**
```css
/* Container de cards dentro de cada grupo */
.cards-container {
  align-items: flex-start; /* era stretch */
}
```
Cada card passa a ter só a sua altura natural — cards não expandidos não são afetados.

---

## Arquivos a criar/modificar (atualizado)

- Histórico de métricas com gráficos (Fase 5 futura)
- Manual do operador
- App mobile
- Suporte a outros sistemas operacionais além de Windows
