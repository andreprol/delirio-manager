# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context

This is the RichClub workspace directory, used as the base project for Claude Code sessions. It currently contains a standalone Python utility script for photo restoration via the Replicate API.

## Python Script: test_restore.py

Calls the Replicate API to restore old photos using the CodeFormer model (`sczhou/codeformer`).

**Run:**
```
python test_restore.py <path_to_image>
```

**Dependencies:**
```
pip install replicate requests
```

The script reads an image file, sends it to `sczhou/codeformer` on Replicate with face enhancement and 2x upscale, and saves the output as `foto_restaurada.png` in the current directory.

The `REPLICATE_API_TOKEN` is hardcoded in the file — replace it or set `REPLICATE_API_TOKEN` as an environment variable before running.

## Fluxo Obrigatório de Desenvolvimento (Projetos de Produção)

Para qualquer feature, fix ou melhoria em projetos com usuários/clientes reais, o fluxo é:

```
1. /qa-before-code  → ANTES de escrever código (análise de risco + plano aprovado)
2. implementar      → código + seguir o plano aprovado
3. /test-generate   → APÓS implementar (gerar + executar testes)
4. /deploy-gate     → ANTES de qualquer deploy (verificação final)
5. deploy
```

**Projetos de produção** (gate obrigatório): Delirio Manager, Consolidado Refresh, Emissor NF-e, dt-clock-proxy, Portal MM, qualquer sistema com cliente pagante ou dado sensível.

**Projetos de baixo risco** (gate opcional): scripts pessoais, protótipos descartáveis, ferramentas internas sem dado sensível.

Se o usuário pedir para implementar algo em projeto de produção sem ter passado pelo `/qa-before-code`, lembrar e perguntar se quer fazer o gate primeiro.

## Verificação Final — Revisor Local

Neste projeto usar o agente `code-reviewer` (`.claude/agents/code-reviewer.md`) no lugar de `cavecrew-reviewer` na etapa 4 do protocolo de verificação global (CLAUDE.md raiz). O agente local verifica 4 eixos: **corretude + SOLID + Code Smells + segurança**.

Prompt para invocar:
```
Revisar o diff abaixo como revisor sênior independente.
Contexto: Delirio Manager — <descrição da tarefa>
--- DIFF ---
<diff da sessão>
```

Aplicar: 🔴 CRÍTICO obrigatório · 🟠 ALTO obrigatório · 🟡 MÉDIO avaliar · 🔵 BAIXO ignorar.

## Feature Flags — Convenção de Desenvolvimento

Código incompleto que vai para produção deve ser isolado com env var toggle:

```bash
# .env (todos os ambientes)
FEATURE_NOME=false   # desabilitar até estar pronto e testado em staging
```

```js
// Node.js
if (process.env.FEATURE_NOME === 'true') { /* novo código */ }
```

```go
// Go agent
if os.Getenv("FEATURE_NOME") == "true" { /* novo código */ }
```

**Regras:**
1. Flag ativa em staging primeiro, produção só após validação
2. Flag removida (cleanup) junto com o PR que conclui a feature
3. Nome da flag: `FEATURE_` + nome em `UPPER_SNAKE_CASE` descritivo

## Installed Skills

- `agent-browser` — browser automation CLI (CDP-based). Load usage guide with: `agent-browser skills get core`
- `qa-before-code` — gate de entrada para desenvolvimento (análise de risco + plano)
- `test-generate` — gate de saída do desenvolvimento (gerar + executar testes)
- `deploy-gate` — portão final antes de qualquer deploy em produção
