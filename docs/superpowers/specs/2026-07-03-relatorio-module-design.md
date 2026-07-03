# Módulo Relatório — Design Spec
**Data:** 2026-07-03  
**Projeto:** Delirio Manager  
**Status:** Aprovado — pronto para implementação

---

## 1. Visão Geral

Novo módulo **Relatório** no Delirio Manager (Electron + React + Node.js) que permite à equipe de TI registrar incidentes por loja, sincronizar chamados do Freshdesk, cruzar dados de saúde das máquinas já coletados pelo DM, e gerar relatórios mensais em .docx + .pdf com score de risco calculado por IA (Claude API). O primeiro relatório definitivo será gerado ao final de julho 2026.

---

## 2. Fontes de Dados

| Fonte | O que fornece | Status |
|---|---|---|
| DM SQLite (já existe) | machines, metrics, events, win_events | ✅ Existente |
| Tópicos manuais (novo) | Problemas registrados pela TI via módulo | 🆕 Novo |
| Freshdesk API | Chamados TI da loja (cache 4h) | 🆕 Integração |
| Zamak | Relatórios de segurança / tentativas de invasão | ⏳ Pendente (antes de jul/2026) |

**Freshdesk — filtro TI:** incluir apenas chamados onde campo `Setor` OU `Grupo` = "TI". Campo `Nome de Loja` identifica a loja. Todos os status incluídos (aberto, pendente, fechado). Chamados sem classificação (Geral ou vazio) são ignorados.

---

## 3. Regra Crítica de Severidade

Qualquer incidente — manual, métrica de sistema ou chamado Freshdesk — em máquina cujo nome começa com **TERM*** (terminais Aloha) ou **BOH*** (servidores Aloha) é classificado automaticamente como **severidade máxima** no cálculo do score, independente da natureza do problema.

Essas máquinas são responsáveis pelo faturamento da empresa. Qualquer parada = impacto direto em receita.

---

## 4. Modelo de Dados — Novas Tabelas SQLite

### `report_topics`
Tópicos abertos por loja. Persistem entre meses até serem resolvidos (soft-delete).

```sql
CREATE TABLE report_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_name TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('baixa','media','alta','critica')),
  machine_mention TEXT,           -- ex: "METROBOH", "TERMBSHOP6" (livre)
  is_critical_machine INTEGER DEFAULT 0,  -- 1 se machine_mention contém TERM* ou BOH*
  photo_path TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
```

### `report_topics_history`
Tópicos resolvidos (deletados). Preserva histórico para detecção de recorrência.

```sql
CREATE TABLE report_topics_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_topic_id INTEGER,
  store_name TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL,
  machine_mention TEXT,
  is_critical_machine INTEGER DEFAULT 0,
  photo_path TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
```

### `freshdesk_cache`
Tickets Freshdesk sincronizados com cache de 4 horas.

```sql
CREATE TABLE freshdesk_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER UNIQUE NOT NULL,
  store_name TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT,
  created_at TEXT,
  resolved_at TEXT,
  cached_at TEXT NOT NULL
);
```

### `report_runs`
Relatórios gerados — histórico para comparativos.

```sql
CREATE TABLE report_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_name TEXT NOT NULL,
  month TEXT NOT NULL,           -- formato YYYY-MM
  generated_at TEXT NOT NULL,
  score_total INTEGER,
  score_hardware INTEGER,
  score_software INTEGER,
  score_connectivity INTEGER,
  score_security INTEGER,
  score_incidents INTEGER,
  ai_narrative TEXT,
  ai_recommendations TEXT,       -- JSON array
  docx_path TEXT,
  pdf_path TEXT
);
```

### `report_feedback`
Opiniões do gestor sobre relatórios gerados. Injetadas nos prompts futuros.

```sql
CREATE TABLE report_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_run_id INTEGER,
  store_name TEXT NOT NULL,
  month TEXT NOT NULL,
  feedback_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

---

## 5. Arquitetura — Opção C (Hybrid)

- **Tópicos e histórico:** sempre local SQLite
- **Freshdesk:** sincronizado ao abrir o módulo + cache 4h no SQLite
- **Dados DM:** já disponíveis no SQLite existente
- **Claude API:** chamada única no momento de geração do relatório

### Novos arquivos no servidor

```
server/
  routes/report.js          # endpoints REST
  services/freshdesk.js     # sync Freshdesk + cache
  services/reportEngine.js  # buildContext, callClaude, generate
  templates/
    template-relatorio.docx # template Word com logo DT e placeholders
```

### Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | /api/report/stores | Lista lojas com score atual e tópicos abertos |
| GET | /api/report/topics/:store | Tópicos abertos de uma loja |
| POST | /api/report/topics | Criar novo tópico |
| DELETE | /api/report/topics/:id | Resolver (soft-delete → history) |
| POST | /api/report/generate | Gerar relatório (dispara Claude + download) |
| POST | /api/report/feedback | Salvar feedback do gestor |
| GET | /api/report/history/:store | Histórico de relatórios gerados |

---

## 6. Layout do Módulo (ReportModule)

Pill **📊 Relatório** no topbar, mesmo padrão dos módulos RH e Aloha. Overlay full-screen com:

**Sidebar esquerda (220px):** lista todas as lojas com semáforo de risco (🔴 ≥60 / 🟠 30–59 / 🟢 <30) e contagem de tópicos abertos. Score cinza = sem dados.

**Área principal (ao selecionar loja):**
- Header com nome da loja + último sync Freshdesk + botões `+ Novo Tópico` e `📄 Gerar Relatório`
- Score circular 0–100 com classificação textual (RISCO ALTO / MÉDIO / BAIXO)
- 5 barras de dimensão com valor numérico
- Lista de tópicos abertos com badge de severidade + indicador 🔴 BOH/TERM quando máquina crítica
- 3 contadores no rodapé: chamados TI do mês, máquinas críticas, máquinas Windows 10

**Novos arquivos no dashboard:**

```
dashboard/src/components/
  ReportModule.jsx            # componente principal (overlay)
  report/
    StoreList.jsx             # sidebar de lojas
    StoreDashboard.jsx        # área principal
    TopicList.jsx             # tópicos abertos
    TopicForm.jsx             # modal novo tópico
    ScoreWidget.jsx           # score circular + barras
    GenerateModal.jsx         # seleção mês + botão gerar + feedback
```

**Adições em App.jsx:** pill `📊 Relatório` + estado `showReport`.  
**Adições em api.js:** namespace `api.report.*`.

---

## 7. IA — Scoring e Loop de Feedback

### Chamada ao Claude

Uma única chamada por geração de relatório. O servidor monta um prompt com:

1. Tópicos abertos da loja (com flag de máquina crítica)
2. Tópicos resolvidos no mês (evidência de trabalho)
3. Problemas recorrentes detectados via `report_topics_history` (mesmo problema em ≥2 meses)
4. Chamados Freshdesk do mês (título, status, datas)
5. Métricas DM: CPU média, RAM média, uso de disco, temperatura, tempo offline por máquina
6. Alertas de OS: máquinas com Windows 10 / sem updates recentes
7. **Últimos 3–5 feedbacks do gestor** para aquela loja (calibração progressiva)
8. Regra crítica TERM*/BOH*

**Resposta esperada (JSON):**
```json
{
  "score": 74,
  "hardware": 35,
  "software": 80,
  "conectividade": 20,
  "seguranca": 55,
  "incidentes": 70,
  "narrativa": "A loja Metropolitano apresenta risco alto...",
  "recomendacoes": ["Substituir gabinete do METROBOH com urgência", "..."]
}
```

**Modelo:** `claude-haiku-4-5` (custo baixo, chamadas frequentes por loja).

### Loop de Feedback

Após receber o relatório, o gestor escreve livremente sua avaliação. Esse texto é salvo em `report_feedback`. No próximo relatório da mesma loja, os últimos feedbacks são injetados no prompt com a instrução de calibrar o tom e os pesos de acordo com as opiniões passadas.

### Detecção de Recorrência

Antes de gerar, o servidor consulta `report_topics_history` da loja e agrupa por similaridade de descrição (match de keywords). Se o mesmo tipo de problema apareceu em ≥2 meses distintos nos últimos 6 meses, entra no prompt como "problema recorrente" e contribui para o score de incidentes.

---

## 8. Geração dos Documentos

### Fluxo

1. Dashboard chama `POST /api/report/generate` com `{ store, month }`
2. Servidor: sincroniza Freshdesk se cache > 4h
3. Servidor: monta contexto completo (`buildStoreContext()`)
4. Servidor: chama Claude API (`callClaude()`) → JSON com scores + narrativa
5. Servidor: salva em `report_runs`
6. Servidor: preenche `template-relatorio.docx` via `docx-templates` → `report_LOJA_YYYY-MM.docx`
7. Servidor: converte para PDF via `LibreOffice headless` (`soffice --headless --convert-to pdf`)
8. Dashboard: recebe URL de download dos dois arquivos e dispara download simultâneo

### Template Word

Arquivo `server/templates/template-relatorio.docx` com:
- Logo Delírio Tropical na capa (arquivo fornecido pelo cliente: verde #28a745, acento vermelho)
- Placeholders `{score}`, `{narrativa}`, tabelas de chamados, fotos embutidas em base64
- Seções numeradas conforme estrutura aprovada (9 seções)
- Seção 8 (Zamak) como placeholder até integração ser definida

### Estrutura do Relatório (9 seções)

1. Capa + Resumo Executivo (score em destaque, parágrafo síntese da IA)
2. Score de Risco Completo (0–100 + 5 dimensões + narrativa)
3. Tópicos Abertos (problemas pendentes, com fotos)
4. Tópicos Resolvidos no Mês (evidência de trabalho)
5. Chamados TI — Freshdesk (tabela por status)
6. Saúde das Máquinas (métricas DM, destaque TERM*/BOH*)
7. Alertas de Sistema Operacional (Windows 10, updates)
8. Segurança — Zamak *(placeholder pendente)*
9. Recomendações e Próximos Passos (lista priorizada pela IA)

---

## 9. Pendências

| Item | Responsável | Prazo |
|---|---|---|
| Arquivo do logo DT em alta resolução (PNG/SVG) | André | Antes da implementação do template |
| Chave API Freshdesk (token de acesso) | André | Antes do início |
| Definição da integração Zamak (API ou upload manual) | André + Zamak | Antes de jul/2026 |
| LibreOffice instalado na Azure VM | Verificar | Sprint 1 |

---

## 10. Fora do Escopo

- App mobile ou acesso web externo ao módulo
- Envio automático do relatório por e-mail (download manual por ora)
- Dashboard comparativo entre lojas (v2 futura)
- Integração Zamak (pendente — placeholder reservado)
