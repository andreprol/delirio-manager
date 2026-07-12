# Loop Autônomo — Design Spec

**Data:** 2026-07-12  
**Status:** Aprovado — aguardando implementação  
**Escopo:** Universal — todos os projetos Claude Code

---

## Problema

Duas dores simultâneas degradam produtividade:

1. **Fricção de confirmação** — prompts interrompem o fluxo. Claude já sabe a resposta certa na maioria dos casos.
2. **Bugs por falta de verificação** — sessões encerram sem loop de teste/revisão, entregando output não verificado.

A solução deve ser autônoma E confiável — não escolher entre uma ou outra.

---

## Goals

- Claude executa a maioria das operações sem interrupção
- Operações destrutivas ou irreversíveis pausam e informam antes de agir
- Toda sessão com mudanças de código passa por pipeline de verificação antes de fechar
- O sistema é auditável — cada decisão MEDIUM registrada em log
- Implementação incremental — valor imediato na Semana 1, sem dependência do stack completo

## Fora de escopo

- Respostas automáticas "em nome do usuário" no chat — Claude não responde por você
- Automação de deploys sem confirmação HIGH — deploy permanece bloqueante
- Aprovação automática de migrações de banco

---

## Arquitetura — 4 Camadas

```
┌─────────────────────────────────────────────────────────────┐
│  CAMADA 1 — CLAUDE.md Global (~/.claude/CLAUDE.md)          │
│  Árvore de decisão · Classificação de risco · Protocolo     │
│  de verificação · Perfis de contexto por projeto            │
├─────────────────────────────────────────────────────────────┤
│  CAMADA 2 — settings.json (~/.claude/settings.json)         │
│  bypassPermissions · allowedTools ampliado · Stop hook      │
├─────────────────────────────────────────────────────────────┤
│  CAMADA 3a — verify-gate.sh    CAMADA 3b — verify.sh        │
│  Hook Stop global              Script por projeto           │
│  Bloqueia encerramento         testes + build + lint        │
├─────────────────────────────────────────────────────────────┤
│  CAMADA 4 — cavecrew-reviewer (subagente independente)      │
│  Revisa diff sem viés · Findings → Claude corrige           │
└─────────────────────────────────────────────────────────────┘
```

**Fluxo de sessão:**  
Task recebida → CLAUDE.md carregado → ops classificadas (LOW/MEDIUM/HIGH) → implementação autônoma → verify-gate.sh dispara → verify.sh roda → cavecrew-reviewer revisa diff → findings corrigidos → sessão fecha.

---

## Camada 1 — CLAUDE.md Global

### Estrutura de seções

```
## Loop Autônomo — Modo Ativo
## Classificação de Risco
## Protocolo de Verificação Obrigatório
## Regras de Pausa (HIGH)
## decision.log (MEDIUM)
## Perfis de Contexto
```

### Classificação de Risco

| Operação | Nível |
|----------|-------|
| Leitura de arquivos | LOW |
| Edição/criação de arquivos de projeto | LOW |
| Bash read (ls, git log, grep, cat) | LOW |
| Bash build / testes / lint | LOW |
| git add + commit (mensagem clara) | LOW |
| npm install / pip install | MEDIUM |
| git push (branch normal) | MEDIUM |
| Edição de arquivos de config (.env, settings) | MEDIUM |
| API calls de escrita (POST/PUT externos) | MEDIUM |
| git push --force | HIGH |
| git reset --hard / git checkout -- | HIGH |
| rm -rf / delete recursivo | HIGH |
| Deploy em produção | HIGH |
| Migration de banco (ALTER/DROP) | HIGH |
| Deletar branch / tag remoto | HIGH |
| Azure run-command / VM patching | HIGH |

**Regra catch-all:** em dúvida, classificar como HIGH.

**Override por projeto:** se existir `.claude/auto-approve.json`, merge com regras globais. Projeto vence em conflito.

### Protocolo de Verificação Obrigatório

Claude executa este checklist antes de declarar tarefa concluída:

1. Rodar `verify.sh` se existir no projeto — falha = corrigir e reexecutar
2. Se mudança de UI → abrir dev server + navegar + screenshot como prova
3. Ler próprio diff — checklist: bug? edge case? fora de escopo? regressão?
4. Invocar `cavecrew-reviewer` com o diff → aplicar findings CRÍTICO e ALTO antes de fechar

### Regras de Pausa (HIGH)

Formato obrigatório ao pausar:

```
⚠️ OPERAÇÃO DE ALTO RISCO
Operação: [descrição exata]
Consequência se executar: [o que muda/perde]
Alternativa reversível: [opção mais segura]
Confirma? (s/n)
```

### decision.log (MEDIUM)

Para cada operação MEDIUM, Claude anexa ao `.claude/decision.log` do projeto:

```
[2026-07-12 14:23] MEDIUM | git push origin feature/fix | razão: push normal, não force
```

### Perfis de Contexto

Regras específicas detectadas automaticamente por presença de arquivos:

- `ecosystem.config.js` presente → PM2 restart via `safe-restart.sh` — nunca `pm2 restart` direto
- Projeto com Azure → `run-command` async V2 obrigatório — nunca `pm2 logs` em run-command
- Projeto com SQLite → verificar via `sqlite3` direto — nunca HTTP
- Projeto com cliente pagante (`requireQaGate: true` no auto-approve.json) → `/qa-before-code` obrigatório antes de feature

---

## Camada 2 — settings.json

```json
{
  "defaultMode": "bypassPermissions",
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(npm *)",
      "Bash(node *)",
      "Bash(python *)",
      "Bash(pwsh *)",
      "Read(*)",
      "Edit(*)",
      "Write(*)",
      "WebSearch(*)",
      "WebFetch(*)"
    ]
  },
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "bash ~/.claude/hooks/verify-gate.sh"
      }]
    }]
  }
}
```

**Nota:** Replicar `"defaultMode": "bypassPermissions"` em `settings.local.json` para evitar perda ao reiniciar.

---

## Camada 3a — verify-gate.sh

Arquivo: `~/.claude/hooks/verify-gate.sh`

```bash
#!/usr/bin/env bash
# Roda antes de Claude encerrar. Exit 1 = Claude vê o output e continua.

PROJECT_DIR="$(pwd)"
VERIFY="$PROJECT_DIR/verify.sh"
LOG="$PROJECT_DIR/.claude/decision.log"

# 1. verify.sh do projeto (testes + build + lint)
if [[ -f "$VERIFY" ]]; then
  echo "[verify-gate] Rodando verify.sh..."
  bash "$VERIFY"
  if [[ $? -ne 0 ]]; then
    echo "[verify-gate] FALHA — corrigir antes de fechar"
    exit 1
  fi
fi

# 2. Log de sessão
mkdir -p "$(dirname "$LOG")"
echo "[$(date '+%Y-%m-%d %H:%M')] verify-gate OK" >> "$LOG"

# 3. Sinaliza Claude para rodar cavecrew-reviewer
echo "[verify-gate] OK — agora rode cavecrew-reviewer no diff antes de fechar"
exit 0
```

---

## Camada 3b — verify.sh (contrato por projeto)

Arquivo: `./verify.sh` na raiz de cada projeto.  
Projetos sem `verify.sh` pulam a etapa sem erro.

```bash
#!/usr/bin/env bash
# Contrato padrão do Loop Autônomo
set -e

ERRORS=0

# Testes Node.js
if [[ -f "package.json" ]] && grep -q '"test"' package.json; then
  echo "▶ npm test"
  npm test --silent || { echo "✗ testes falharam"; ERRORS=$((ERRORS+1)); }
fi

# Testes Go
if [[ -f "go.mod" ]]; then
  echo "▶ go test ./..."
  go test ./... 2>&1 || { echo "✗ go test falhou"; ERRORS=$((ERRORS+1)); }
fi

# Typecheck TypeScript
if [[ -f "tsconfig.json" ]]; then
  echo "▶ tsc --noEmit"
  npx tsc --noEmit 2>&1 || { echo "✗ typecheck falhou"; ERRORS=$((ERRORS+1)); }
fi

# Lint ESLint
if [[ -f "eslint.config.js" ]] || [[ -f ".eslintrc.js" ]]; then
  echo "▶ eslint"
  npx eslint . --max-warnings=0 2>&1 || { echo "✗ lint falhou"; ERRORS=$((ERRORS+1)); }
fi

if [[ $ERRORS -gt 0 ]]; then
  echo "[verify] $ERRORS verificação(ões) falharam — corrigir antes de fechar"
  exit 1
fi
echo "[verify] ✓ tudo OK"
```

**Exemplos por projeto:**

| Projeto | Checks |
|---------|--------|
| Delirio Manager | npm test + go test ./... + eslint flat config |
| Portal MM / Consolidado Refresh | npm test + eslint |
| Site Pessoal (Next.js) | next build |
| Emissor NF-e (.NET) | dotnet build + dotnet test |
| SEO Burial Agent | pytest + ruff check |

---

## auto-approve.json (override por projeto)

Arquivo: `.claude/auto-approve.json` na raiz do projeto.

```json
{
  "elevate": [],
  "restrict": [
    "az vm run-command",
    "pm2 restart"
  ],
  "requireBrowserCheck": false,
  "skipVerify": false,
  "requireQaGate": true
}
```

- `elevate`: mover operações HIGH → MEDIUM neste projeto
- `restrict`: mover operações LOW/MEDIUM → HIGH neste projeto
- `requireBrowserCheck`: forçar verificação no browser mesmo sem UI
- `skipVerify`: pular verify.sh (ex: lib sem testes)
- `requireQaGate`: exigir `/qa-before-code` antes de qualquer feature

---

## Camada 4 — cavecrew-reviewer

### Quando invocar

- Após verify-gate.sh retornar OK
- Diff da sessão tem mudanças de lógica (não só docs/comments/config)
- Diff não é zero (algo foi modificado na sessão)

### Prompt template

```
Revisar o diff abaixo como revisor sênior independente.
Contexto do projeto: {nome_projeto}
Tarefa executada: {descrição_da_tarefa}

Reportar APENAS findings reais — sem elogios, sem comentários de estilo.
Formato por linha:

path:line: 🔴 CRÍTICO: problema. fix.
path:line: 🟠 ALTO: problema. fix.
path:line: 🟡 MÉDIO: problema. fix.
path:line: 🔵 BAIXO: problema. fix.

Se nada encontrar: responder "LGTM".

--- DIFF ---
{diff_da_sessão}
```

**Como capturar o diff:**
- Mudanças commitadas na sessão: `git diff HEAD~N..HEAD` (N = commits da sessão)
- Mudanças ainda não commitadas: `git diff HEAD`
- Ambas: `git diff HEAD~N` (inclui staged + unstaged do período)

### Protocolo de resposta

| Severidade | Ação Claude |
|-----------|-------------|
| 🔴 CRÍTICO | Aplicar obrigatório antes de fechar |
| 🟠 ALTO | Aplicar antes de fechar |
| 🟡 MÉDIO | Avaliar — aplicar se contexto confirmar |
| 🔵 BAIXO | Ignorar |

**Custo esperado:** 800–2000 tokens por invocação (diff pequeno-médio). Para diffs >500 linhas, limitar ao subconjunto de arquivos modificados na sessão.

---

## Implementação Incremental

### Semana 1 — Valor imediato, zero scripts
- Atualizar `~/.claude/CLAUDE.md` com todas as 6 seções
- Atualizar `~/.claude/settings.json` com permissões ampliadas
- Valor: autonomia + classificação de risco funcionando imediatamente

### Semana 2 — Enforcement real
- Criar `~/.claude/hooks/verify-gate.sh`
- Criar `verify.sh` no Delirio Manager (projeto com mais testes)
- Criar `.claude/auto-approve.json` no Delirio Manager
- Valor: verificação automática no projeto mais crítico

### Semana 3+ — Rollout
- `verify.sh` nos demais projetos (15 min cada)
- `auto-approve.json` por projeto conforme necessidade
- `.gitignore` atualizado: adicionar `.claude/decision.log` ou commitá-lo conforme preferência
