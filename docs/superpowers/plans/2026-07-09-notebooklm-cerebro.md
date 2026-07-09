# NotebookLM Terceiro Cérebro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar NotebookLM como terceiro layer de conhecimento — conversas filtradas por projeto salvas automaticamente no `documentar` e consultadas via nova skill `pesquisar`.

**Architecture:** Modificar skill `documentar` para adicionar Passo 5 (captura + segmentação do transcript + upload ao notebook do projeto). Criar skill `pesquisar` como substituta completa de `pesquisa-projeto`, adicionando camada 4 (NotebookLM chat com citações). Criar skill `documentar-backfill` para processar sessões históricas. Feedback de memória garante invocação correta.

**Tech Stack:** Bun, NotebookLM plugin (`bun scripts/main.ts`), MCP session management (`mcp__ccd_session_mgmt__*`), Markdown skill files, PowerShell.

---

## File Map

| Ação | Arquivo |
|------|---------|
| Criar | `C:\Users\fileserver\.claude\skills\pesquisar\SKILL.md` |
| Criar | `C:\Users\fileserver\.claude\skills\documentar-backfill\SKILL.md` |
| Modificar | `C:\Users\fileserver\.claude\skills\documentar\SKILL.md` |
| Criar | `C:\Users\fileserver\.claude\projects\F--RichClub\memory\feedback_pesquisar_vs_pesquisa_projeto.md` |
| Modificar | `C:\Users\fileserver\.claude\projects\F--RichClub\memory\MEMORY.md` |

---

## Task 1: Criar feedback de memória — prioridade de invocação

**Files:**
- Create: `C:\Users\fileserver\.claude\projects\F--RichClub\memory\feedback_pesquisar_vs_pesquisa_projeto.md`
- Modify: `C:\Users\fileserver\.claude\projects\F--RichClub\memory\MEMORY.md`

- [ ] **Step 1: Criar arquivo de feedback**

Criar `C:\Users\fileserver\.claude\projects\F--RichClub\memory\feedback_pesquisar_vs_pesquisa_projeto.md` com conteúdo:

```markdown
---
name: feedback-pesquisar-vs-pesquisa-projeto
description: Skill pesquisar substitui pesquisa-projeto — sempre invocar pesquisar para pesquisa de projeto
metadata:
  type: feedback
---

Sempre invocar skill `pesquisar` quando André pedir pesquisa de projeto. Nunca invocar `pesquisa-projeto`.

**Why:** `pesquisar` é a versão completa com 4 camadas (memória + Obsidian + GitHub + NotebookLM). `pesquisa-projeto` é a versão legada sem NotebookLM. Skill local `pesquisar` substitui o plugin.

**How to apply:** Qualquer pedido de pesquisa/contexto de projeto → `Skill("pesquisar")`. Se `pesquisar` não estiver disponível por algum motivo → avisar André antes de usar `pesquisa-projeto` como fallback.
```

- [ ] **Step 2: Adicionar entrada no MEMORY.md**

Ler `C:\Users\fileserver\.claude\projects\F--RichClub\memory\MEMORY.md`, localizar seção de feedbacks e adicionar linha:

```markdown
- ⚠️ [Skill pesquisar substitui pesquisa-projeto](feedback_pesquisar_vs_pesquisa_projeto.md) — sempre invocar pesquisar (4 camadas: mem+Obsidian+GitHub+NotebookLM)
```

- [ ] **Step 3: Verificar**

Ler MEMORY.md e confirmar que entrada aparece. Ler o arquivo de feedback e confirmar conteúdo correto.

---

## Task 2: Criar skill `pesquisar`

**Files:**
- Create: `C:\Users\fileserver\.claude\skills\pesquisar\SKILL.md`

- [ ] **Step 1: Criar diretório e arquivo**

Criar `C:\Users\fileserver\.claude\skills\pesquisar\SKILL.md` com conteúdo completo:

```markdown
---
name: pesquisar
description: Pesquisa completa de projeto — memória + Obsidian + GitHub + NotebookLM (sessões passadas). SUBSTITUI pesquisa-projeto — sempre invocar esta.
---

# Pesquisar Projeto

**Esta skill substitui `pesquisa-projeto`.** Sempre invocar `pesquisar` quando pesquisa de projeto for solicitada.

Execute etapas 1-4 em paralelo, depois sintetize na etapa 5.

## 1. Memória Persistente

Leia `C:\Users\fileserver\.claude\projects\F--RichClub\memory\MEMORY.md` e identifique entradas relacionadas ao projeto. Em seguida, leia os arquivos `.md` relevantes nesse diretório.

## 2. Vault Obsidian

Busque no vault `F:\Cérebro de IA\Cérebro do André\` por pastas ou arquivos com o nome do projeto. Use Glob com padrão `**/*{nome}*` (case-insensitive). Leia os arquivos encontrados.

Subpastas comuns: `QA\`, `API\`, `WebServices\`, `Azure\`, `LGPD\`, `Web3\`, `Perícia Judicial\`, `Perícia Financeira\`

## 3. Repositório GitHub

Busque no perfil `andreprol` por repositório com nome similar ao projeto. Estratégia:
- Grep em arquivos de memória por menção de repo (ex: "andreprol/nome-repo")
- Se não encontrado, informar que repo pode não existir ou nome pode diferir

## 4. NotebookLM — Sessões Passadas

```powershell
$env:Path += ";$env:USERPROFILE\.bun\bin"
$NLM = "C:\Users\fileserver\.claude\skills\notebooklm-ai-plugin\skills\notebooklm"
```

1. Identificar `notebooklm_id` no `project_*.md` do projeto em contexto (campo `notebooklm_id:` no body do arquivo)
2. Se encontrado:
   ```powershell
   Set-Location $NLM
   bun scripts/main.ts chat --question "[query do usuário sobre o projeto]" --notebook [notebooklm_id] --json
   ```
3. Extrair do JSON: campo `answer` (resposta) e campo `sources` (citações com título e data da sessão)
4. Incluir citações na síntese com formato: `"[trecho]" ↳ Sessão: [título da fonte]`
5. Se `notebooklm_id` não encontrado no project_*.md: informar "Sem histórico NotebookLM para este projeto ainda"
6. Se erro de cota (50 chats/dia excedido) ou timeout: informar e continuar sem esta camada

## 5. Síntese

Apresente contexto consolidado:
- **Estado atual** — o que está feito, o que está pendente
- **Stack técnica** — tecnologias, infraestrutura
- **Acesso/credenciais** — URLs, usuários (sem expor senhas)
- **Próximos passos** — pendências marcadas nas memórias
- **Repositório** — link se encontrado
- **Notas Obsidian** — resumo do que existe no vault
- **NotebookLM — Sessões passadas** — citações relevantes de conversas anteriores, ou "Sem histórico ainda" se não houver

Se não houver informação em alguma fonte, informe explicitamente em vez de omitir.
```

- [ ] **Step 2: Verificar arquivo criado**

Ler `C:\Users\fileserver\.claude\skills\pesquisar\SKILL.md` e confirmar conteúdo correto, especialmente:
- Frontmatter com name e description corretos
- Seção 4 NotebookLM com path correto do plugin
- Seção 5 inclui NotebookLM na síntese

---

## Task 3: Modificar `documentar` — adicionar Passo 5

**Files:**
- Modify: `C:\Users\fileserver\.claude\skills\documentar\SKILL.md`

- [ ] **Step 1: Ler arquivo atual**

Ler `C:\Users\fileserver\.claude\skills\documentar\SKILL.md` para entender estrutura exata antes de editar.

- [ ] **Step 2: Adicionar Passo 5 antes das Regras Gerais**

Localizar a seção `## Passo 4 — Vault scan` e inserir após ela (antes de `## Regras gerais`) o novo passo:

```markdown
## Passo 5 — NotebookLM

### Setup
```powershell
$env:Path += ";$env:USERPROFILE\.bun\bin"
$NLM = "C:\Users\fileserver\.claude\skills\notebooklm-ai-plugin\skills\notebooklm"
```

### Limpeza de temp antigos
Delete arquivos `F:\Temp\session_*.md` se existirem (limpeza de crashes anteriores).

### Capturar transcript da sessão
Use `mcp__ccd_session_mgmt__list_sessions` para obter ID da sessão atual. Leia o transcript completo via `mcp__ccd_session_mgmt__search_session_transcripts`.

### Segmentar por projeto
Analise o transcript completo e identifique blocos de mensagens por projeto. Critérios:
- Nomes de projeto mencionados explicitamente (ex: "Delirio Manager", "Perícia Digital", "JARVIS")
- Arquivos e repos acessados (ex: `F:\RichClub\delirio-manager\`, `andreprol/seo-burial-agent`)
- Keywords de domínio (ex: "NF-e", "SAP", "BOH", "agente" → Delirio; "laudo", "NBC TP 01" → Perícia; "Stellar", "Solidity" → Web3)
- Descarte blocos sem projeto identificável (meta-conversa de sessão, caveman mode setup, system reminders)
- Formato de cada bloco: apenas texto legível de mensagens human/assistant, sem tool call internals

### Para cada projeto identificado:

**a) Buscar ou criar notebook:**

Leia o `project_*.md` correspondente ao projeto → procure campo `notebooklm_id:` no body.

Se não existe:
```powershell
Set-Location $NLM
bun scripts/main.ts notebooks create "[NomeProjeto] — Sessões Claude"
```
Anote o ID retornado. Adicione no body do `project_*.md`:
```
notebooklm_id: <id-retornado>
```

**b) Verificar limite de fontes (rotação automática):**
```powershell
Set-Location $NLM
bun scripts/main.ts sources list --notebook [id] --json
```
Se count >= 48 (margem de segurança): criar notebook `[Projeto] — Sessões Claude 2`, atualizar `notebooklm_id` no `project_*.md`.

**c) Montar arquivo de sessão filtrado:**

Salve em `F:\Temp\session_YYYY-MM-DD_[projeto-slug].md`:
```markdown
# Sessão YYYY-MM-DD — [Nome do Projeto]
_Projeto: [Nome] | Sessão filtrada_

## André
[mensagem do usuário]

## Claude
[resposta do assistente]

...
```
Onde `[projeto-slug]` é o nome do projeto em lowercase sem espaços (ex: `delirio-manager`, `pericia-digital`).

**d) Upload para NotebookLM:**
```powershell
Set-Location $NLM
bun scripts/main.ts sources add-file "F:\Temp\session_YYYY-MM-DD_[slug].md" --notebook [id]
```

**e) Limpar arquivo temp:**
Delete `F:\Temp\session_YYYY-MM-DD_[slug].md`

### Tratamento de erro
Se qualquer etapa do Passo 5 falhar (timeout, offline, erro de API): exibir warning mas NÃO interromper o `documentar`. O passo 5 é best-effort.

### Relatório do Passo 5
Ao final: `"NotebookLM: [N] projetos salvos ([lista de nomes]), [M] fontes criadas"` ou `"NotebookLM: skipped ([motivo do erro])"`
```

- [ ] **Step 3: Verificar edição**

Ler `documentar/SKILL.md` e confirmar:
- Passo 5 aparece após Passo 4 e antes de Regras Gerais
- Path do plugin correto
- Lógica de rotação presente
- Tratamento de erro presente

---

## Task 4: Criar skill `documentar-backfill`

**Files:**
- Create: `C:\Users\fileserver\.claude\skills\documentar-backfill\SKILL.md`

- [ ] **Step 1: Criar arquivo**

Criar `C:\Users\fileserver\.claude\skills\documentar-backfill\SKILL.md`:

```markdown
---
name: documentar-backfill
description: Processa todas as sessões históricas do Claude e distribui conversas filtradas por projeto nos notebooks NotebookLM correspondentes. Executar uma vez após setup inicial do sistema NotebookLM.
---

# Documentar Backfill — NotebookLM

**Operação de longa duração.** Processa todas as sessões históricas. Executar uma única vez após Task 5 do plano de implementação estar completa.

## Setup

```powershell
$env:Path += ";$env:USERPROFILE\.bun\bin"
$NLM = "C:\Users\fileserver\.claude\skills\notebooklm-ai-plugin\skills\notebooklm"
```

## Fluxo

### 1. Listar todas as sessões históricas

Use `mcp__ccd_session_mgmt__list_sessions` para obter lista completa de sessões. Anote total para acompanhamento de progresso.

### 2. Para cada sessão (processar sequencialmente para evitar rate limit):

**a) Ler transcript**
Use `mcp__ccd_session_mgmt__search_session_transcripts` com o ID da sessão.

**b) Verificar se tem conteúdo útil**
- Pular sessões com < 5 mensagens trocadas
- Pular sessões que são só de configuração/setup sem projeto identificável

**c) Segmentar por projeto** (mesma lógica do Passo 5 do documentar):
- Identificar blocos de mensagens por projeto via nomes, repos, keywords de domínio
- Descartar blocos sem projeto identificável

**d) Para cada projeto identificado:**

1. Buscar `notebooklm_id` em `project_*.md` (ou criar notebook se não existe)
2. Checar duplicata — listar fontes do notebook e verificar se título `Sessao_YYYY-MM-DD_[slug]` já existe:
   ```powershell
   Set-Location $NLM
   bun scripts/main.ts sources list --notebook [id] --json
   ```
3. Se título já existe: pular esta sessão/projeto (já foi processada)
4. Se nova: montar arquivo `F:\Temp\session_YYYY-MM-DD_[slug].md`, fazer upload, limpar temp

**e) Verificar rotação** antes de cada upload (>= 48 fontes → criar notebook 2)

**f) Log de progresso** a cada 10 sessões processadas: `"[N/Total] sessões — [X] fontes criadas até agora"`

### 3. Relatório final

```
Backfill concluído:
- Sessões analisadas: X
- Sessões com conteúdo de projeto: Y
- Sessões puladas (sem projeto / duplicata): Z
- Projetos cobertos: [lista]
- Fontes criadas: W
- Notebooks criados: V (lista de nomes)
```

## Tratamento de erros

- Erro em sessão individual: log warning, continue para próxima sessão
- Rate limit NotebookLM: aguardar 30s e tentar novamente (max 3 tentativas)
- Após 3 falhas consecutivas: pausar e reportar ao André
```

- [ ] **Step 2: Verificar arquivo**

Ler `C:\Users\fileserver\.claude\skills\documentar-backfill\SKILL.md` e confirmar conteúdo correto.

---

## Task 5: Commit de todos os arquivos

- [ ] **Step 1: Verificar status**

```bash
git -C "F:\RichClub" status
```

Confirmar que os seguintes arquivos aparecem como modificados/novos:
- `docs/superpowers/specs/2026-07-09-notebooklm-cerebro-design.md` (já commitado)

Verificar também arquivos em `~/.claude/`:
```powershell
git -C "C:\Users\fileserver\.claude" status
```

- [ ] **Step 2: Commit em `~/.claude`**

```powershell
git -C "C:\Users\fileserver\.claude" add skills/pesquisar/ skills/documentar/ skills/documentar-backfill/ projects/F--RichClub/memory/feedback_pesquisar_vs_pesquisa_projeto.md projects/F--RichClub/memory/MEMORY.md
git -C "C:\Users\fileserver\.claude" commit -m "feat: NotebookLM terceiro cérebro — skills pesquisar, documentar+passo5, documentar-backfill

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

- [ ] **Step 3: Commit em `F:\RichClub` (plano)**

```bash
git -C "F:\RichClub" add docs/superpowers/plans/2026-07-09-notebooklm-cerebro.md
git -C "F:\RichClub" commit -m "docs: plano de implementação NotebookLM terceiro cérebro

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git -C "F:\RichClub" push
```

---

## Task 6: Verificação manual

- [ ] **Step 1: Testar skill `pesquisar`**

Invocar: `Skill("pesquisar")` com contexto "Delirio Manager"

Verificar que:
- Etapas 1-3 retornam resultados (memória, Obsidian, GitHub)
- Etapa 4 informa "Sem histórico NotebookLM para este projeto ainda" (notebook ainda não criado pelo documentar)
- Síntese inclui seção NotebookLM

- [ ] **Step 2: Testar passo 5 do `documentar`**

Invocar `Skill("documentar")` ao final desta sessão de implementação.

Verificar que:
- Passo 5 executa sem erro
- Notebook criado para o(s) projeto(s) desta sessão
- `notebooklm_id` salvo no `project_*.md` correspondente
- Arquivo temp em `F:\Temp` foi limpo
- Relatório mostra "NotebookLM: 1 projeto salvo, 1 fonte criada"

- [ ] **Step 3: Verificar notebook no NotebookLM**

Abrir `https://notebooklm.google.com` no browser e confirmar que o notebook do projeto aparece com a fonte da sessão.

---

## Task 7: Executar backfill histórico

> **Executar após Task 6 estar completa e verificada.**

- [ ] **Step 1: Invocar skill de backfill**

Invocar: `Skill("documentar-backfill")`

Acompanhar progresso pelos logs a cada 10 sessões.

- [ ] **Step 2: Verificar resultado**

Confirmar relatório final com lista de projetos cobertos e fontes criadas.

- [ ] **Step 3: Testar pesquisar com histórico**

Invocar `Skill("pesquisar")` com contexto de projeto que teve muitas sessões (ex: Delirio Manager).

Verificar que NotebookLM retorna citações de sessões anteriores com referência ao título da sessão.
