# Design: NotebookLM como Terceiro Cérebro

**Data:** 2026-07-09  
**Status:** Aprovado  
**Autor:** André + Claude

---

## Problema

O sistema atual de conhecimento tem dois layers:
- **Memória** (`~/.claude/projects/.../memory/`) — fatos rápidos, feedback, configurações
- **Obsidian** (`Cérebro do André`) — notas estruturadas por projeto/sessão

Nenhum dos dois preserva o contexto completo das conversas. Resumos perdem nuances. Decisões técnicas com o raciocínio completo ficam inacessíveis em pesquisas futuras.

---

## Solução

Adicionar **NotebookLM** como terceiro layer — repositório de conversas completas filtradas por projeto, consultável via AI com citações.

---

## Arquitetura

```
documentar (skill) — passo 5 novo
  ├── Lê transcript da sessão atual (mcp__ccd_session_mgmt)
  ├── Segmenta por projeto (Claude analisa e filtra blocos)
  ├── Para cada projeto identificado:
  │     ├── Busca notebooklm_id em project_*.md
  │     ├── Se não existe → cria notebook → salva ID
  │     └── sources add-file [bloco filtrado] --notebook [id]
  └── Limpa arquivos temp em F:\Temp

pesquisar (nova skill local — substitui pesquisa-projeto)
  ├── Camada 1: Memória (project_*.md + MEMORY.md)
  ├── Camada 2: Obsidian (vault Cérebro do André)
  ├── Camada 3: GitHub (commits, código, specs)
  └── Camada 4: NotebookLM
        ├── Lê notebooklm_id do project_*.md do projeto em contexto
        └── chat --question "[query]" --notebook [id] --json → citações

project_*.md (arquivos de memória)
  └── Campo novo no body: notebooklm_id: <uuid-do-notebook>
```

---

## Estrutura de Notebooks

- **Um notebook por projeto**
- Nome: `[NomeProjeto] — Sessões Claude`
- Exemplos: `Delirio Manager — Sessões Claude`, `Perícia Digital — Sessões Claude`
- Auto-rotação quando 50 fontes atingidas: `[Projeto] — Sessões Claude 2`
- ID armazenado em `project_*.md` do projeto

---

## Passo 5 do `documentar` — Detalhado

### Fluxo
```
1. mcp__ccd_session_mgmt__list_sessions → ID da sessão atual
2. Lê transcript completo
3. Claude analisa e segmenta por projeto:
   - Identifica projetos via nomes, repos, arquivos, keywords
   - Cria blocos de mensagens [André] / [Claude] por projeto
   - Descarta blocos sem projeto identificável
4. Para cada projeto:
   a. Busca notebooklm_id em project_*.md
   b. Se não existe → notebooks create "[Projeto] — Sessões Claude"
                    → salva notebooklm_id no project_*.md
   c. Salva F:\Temp\session_YYYY-MM-DD_[projeto].md
   d. sources add-file ./session_*.md --notebook [id]
   e. Apaga arquivo temp
5. Reporta: X projetos salvos, Y fontes criadas
```

### Formato do arquivo gerado
```markdown
# Sessão 2026-07-09 — [Nome do Projeto]
_Projeto: [Nome] | Sessão filtrada_

## André
[mensagem]

## Claude
[resposta]
...
```

### O que é filtrado/descartado
- Blocos sem projeto identificável
- Mensagens de meta-configuração de sessão (ex: caveman mode, system reminders)
- Internals de tool calls (só texto legível de human/assistant)

---

## Modo Backfill

**Trigger:** `/documentar backfill`

**Fluxo:**
```
1. mcp__ccd_session_mgmt__list_sessions → todas as sessões históricas
2. Para cada sessão (processamento paralelo, limitado):
   a. Lê transcript
   b. Segmenta por projeto
   c. Para cada projeto:
      → Busca/cria notebook
      → Checa duplicata pelo título antes de upload
      → Se nova: sources add-file
3. Reporta: X sessões processadas, Y fontes criadas, Z projetos cobertos
```

**Tratamento de duplicatas:** título da fonte = `Sessao_YYYY-MM-DD_[projeto]` — lista fontes existentes antes de cada upload, pula se título já existe.

---

## Skill `pesquisar` — Nova (substitui `pesquisa-projeto`)

**Localização:** `~/.claude/skills/pesquisar/SKILL.md`

**Description:** `"Pesquisa completa: memória + Obsidian + GitHub + NotebookLM. SUBSTITUI pesquisa-projeto — sempre usar esta."`

**Prioridade sobre plugin:** skill local tem prioridade sobre `pesquisa-projeto` (plugin). Memória também registra esta regra.

### Output da pesquisa com NotebookLM
```markdown
## Fontes encontradas

### Memória
- [fato relevante]

### Obsidian
- [nota relevante]

### GitHub
- [commit/arquivo relevante]

### NotebookLM — Sessões passadas
- "Em 2026-06-15, decidimos usar blob storage por causa da allowlist de IP do NSG..."
  ↳ Sessão: Sessao_2026-06-15_DeployDM.md
```

---

## Tratamento de Erros

| Situação | Comportamento |
|----------|---------------|
| NotebookLM offline/timeout | Log warning → pula passo 5 → documentar continua |
| Notebook atinge 50 fontes | Auto-cria `[Projeto] — Sessões Claude 2` → atualiza notebooklm_id |
| Sessão já existe (duplicata backfill) | Checa título antes → pula |
| Projeto não identificado no transcript | Descarta bloco silenciosamente |
| notebooklm_id ausente na pesquisa | Avisa: "Sem histórico NotebookLM para este projeto" — não falha |
| Arquivo temp não apagado (crash) | documentar limpa session_*.md antigos em F:\Temp no início |
| Sessão histórica corrompida/vazia | Pula silenciosamente no backfill |
| Cota diária de chat esgotada (50/dia) | Pesquisa retorna resultado sem camada 4 + avisa |

---

## Deliverables de Implementação

1. **Skill `documentar`** — adicionar Passo 5 (NotebookLM) ao `~/.claude/skills/documentar/SKILL.md`
2. **Skill `pesquisar`** — criar `~/.claude/skills/pesquisar/SKILL.md` (substitui pesquisa-projeto)
3. **Memória** — `feedback_pesquisar_vs_pesquisa_projeto.md`: regra de invocar `pesquisar`, nunca `pesquisa-projeto`
4. **Backfill** — executar `/documentar backfill` uma vez após implementação

---

## Dependência Técnica

- Plugin NotebookLM: `~/.claude/skills/notebooklm-ai-plugin/`
- MCP session management: `mcp__ccd_session_mgmt__list_sessions`, `mcp__ccd_session_mgmt__search_session_transcripts`
- Notebook ativo atual: `e20b65f4-8aa0-47d7-aef8-810b9dcd5bde` ("Meu Notebook Principal") — manter como legado, não usar para novos projetos
- Autenticação NotebookLM: cookies em `C:\Users\fileserver\AppData\Roaming\notebooklm-ai\cookies.json`
