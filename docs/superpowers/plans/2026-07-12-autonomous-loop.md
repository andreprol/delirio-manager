# Loop Autônomo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar o stack completo do Loop Autônomo — CLAUDE.md rules engine + Stop hook + verify.sh por projeto + cavecrew-reviewer — para operação autônoma com verificação obrigatória antes de encerrar toda sessão.

**Architecture:** CLAUDE.md global define classificação de risco e protocolo de verificação; settings.json registra Stop hook; verify-gate.sh bloqueia encerramento até verify.sh passar; cavecrew-reviewer revisa diff de forma independente. Implementação incremental em 3 fases — Fase 1 tem valor imediato, sem dependência das fases seguintes.

**Tech Stack:** Bash (Git Bash no Windows), PowerShell (referência de paths), JSON, Markdown.

---

## Estrutura de Arquivos

| Arquivo | Ação | Responsabilidade |
|---------|------|-----------------|
| `C:\Users\fileserver\.claude\CLAUDE.md` | Modificar | Adicionar seções do Loop Autônomo no topo |
| `C:\Users\fileserver\.claude\settings.json` | Modificar | Adicionar Stop hook |
| `C:\Users\fileserver\.claude\hooks\verify-gate.sh` | Criar | Hook Stop — roda verify.sh + sinaliza cavecrew |
| `F:\RichClub\verify.sh` | Criar | Verificação Delirio Manager (npm test + go test + eslint) |
| `F:\RichClub\.claude\auto-approve.json` | Criar | Overrides de risco para Delirio Manager |

---

## FASE 1 — CLAUDE.md + settings.json

### Task 1: Adicionar seções Loop Autônomo ao CLAUDE.md global

**Files:**
- Modify: `C:\Users\fileserver\.claude\CLAUDE.md` (inserir no topo, antes de `# Contexto Global`)

- [ ] **Step 1: Verificar estado atual do arquivo**

```bash
head -5 /c/Users/fileserver/.claude/CLAUDE.md
```

Expected: primeira linha é `# Contexto Global — Ambiente André`

- [ ] **Step 2: Inserir seções Loop Autônomo no topo do arquivo**

Abrir `C:\Users\fileserver\.claude\CLAUDE.md` e inserir o bloco abaixo como primeiras linhas do arquivo (antes de qualquer conteúdo existente):

```markdown
# Loop Autônomo — Modo Híbrido Ativo

Este modo está ativo em todas as sessões. Aplicar as regras abaixo sem necessidade de instrução explícita por sessão.

## Classificação de Risco — Regras de Decisão

Para cada operação antes de executar, classificar como LOW / MEDIUM / HIGH:

**LOW — executar automaticamente, sem avisar:**
- Leitura de arquivos (Read, Grep, Glob)
- Edição/criação de arquivos de projeto
- Bash read: ls, git log, git status, grep, cat
- Bash build/testes/lint: npm test, go test, tsc, eslint, pytest
- git add + git commit (mensagem descritiva)

**MEDIUM — executar mas registrar em `.claude/decision.log`:**
- npm install / pip install
- git push (branch normal, não force)
- Edição de arquivos de config (.env, settings.json, ecosystem.config.js)
- API calls de escrita (POST/PUT para serviços externos)

**HIGH — pausar, informar, aguardar confirmação explícita:**
- git push --force
- git reset --hard / git checkout --
- rm -rf / delete recursivo / Remove-Item -Recurse -Force
- Deploy em produção (qualquer método)
- Migration de banco de dados (ALTER TABLE, DROP)
- Deletar branch ou tag remoto
- Azure run-command / VM patching

**Regra catch-all:** em dúvida, classificar como HIGH.

**Override por projeto:** se existir `.claude/auto-approve.json` na raiz do projeto, fazer merge com estas regras. Projeto vence em conflito.

### Formato obrigatório ao pausar (HIGH)

```
⚠️ OPERAÇÃO DE ALTO RISCO
Operação: [descrição exata do comando]
Consequência se executar: [o que muda ou se perde]
Alternativa reversível: [opção mais segura disponível]
Confirma? (s/n)
```

### decision.log (MEDIUM)

Para cada operação MEDIUM, anexar ao `.claude/decision.log` do projeto:

```
[YYYY-MM-DD HH:MM] MEDIUM | <comando exato> | razão: <motivo da classificação>
```

## Protocolo de Verificação Obrigatório

Executar este checklist ANTES de declarar qualquer tarefa concluída:

1. Se projeto tem `verify.sh` na raiz → rodar `bash verify.sh`. Falha = corrigir e reexecutar.
2. Se sessão mudou arquivos de UI (*.tsx, *.css, *.html, componentes) → abrir dev server, navegar na funcionalidade, tirar screenshot como prova.
3. Ler o próprio diff da sessão e verificar: introduzi bug? esqueci edge case? algo fora de escopo?
4. Invocar `cavecrew-reviewer` com o diff da sessão → aplicar todos os findings CRÍTICO e ALTO antes de fechar.

**Quando NÃO invocar cavecrew-reviewer:** mudanças exclusivamente em docs, comments, ou config sem lógica; diff da sessão é zero.

**Como capturar o diff:**
- Mudanças commitadas na sessão: `git diff HEAD~N..HEAD` (N = commits desta sessão)
- Mudanças não commitadas: `git diff HEAD`

**Prompt para cavecrew-reviewer:**

```
Revisar o diff abaixo como revisor sênior independente.
Contexto: {nome_projeto} — {descrição_da_tarefa}

Formato obrigatório por finding:
path:line: 🔴 CRÍTICO: problema. fix.
path:line: 🟠 ALTO: problema. fix.
path:line: 🟡 MÉDIO: problema. fix.
path:line: 🔵 BAIXO: problema. fix.

Se nenhum finding real: responder "LGTM".

--- DIFF ---
{diff_da_sessão}
```

Aplicar: 🔴 CRÍTICO obrigatório · 🟠 ALTO obrigatório · 🟡 MÉDIO avaliar · 🔵 BAIXO ignorar.

## Perfis de Contexto (Lições Codificadas)

Regras ativas automaticamente por presença de arquivos no projeto:

- `ecosystem.config.js` presente → PM2 restart via `bash /opt/dt-manager/infra/safe-restart.sh` — NUNCA `pm2 restart` direto (gera ghosts → EADDRINUSE → 502)
- Projeto com Azure run-command → usar V2 async (create+show+delete) — NUNCA `pm2 logs` em run-command (trava VM 90min)
- Projeto com SQLite → verificar via `sqlite3` direto — NUNCA via HTTP
- `requireQaGate: true` no auto-approve.json → `/qa-before-code` obrigatório antes de qualquer nova feature

---

```

- [ ] **Step 3: Verificar que o arquivo está correto**

```bash
head -20 /c/Users/fileserver/.claude/CLAUDE.md
```

Expected: primeiras linhas são `# Loop Autônomo — Modo Híbrido Ativo` seguido das seções acima.

- [ ] **Step 4: Verificar que o conteúdo original foi preservado**

```bash
grep -n "Contexto Global" /c/Users/fileserver/.claude/CLAUDE.md
```

Expected: linha encontrada (número > 1, não linha 1).

---

### Task 2: Adicionar Stop hook ao settings.json

**Files:**
- Modify: `C:\Users\fileserver\.claude\settings.json`

- [ ] **Step 1: Verificar conteúdo atual da chave `hooks`**

```bash
python3 -c "import json; d=json.load(open('/c/Users/fileserver/.claude/settings.json')); print(list(d.get('hooks',{}).keys()))"
```

Expected: `['PreToolUse', 'SessionStart']` — confirmar que não existe `Stop` ainda.

- [ ] **Step 2: Adicionar Stop hook ao bloco `hooks` existente**

No arquivo `C:\Users\fileserver\.claude\settings.json`, localizar o bloco `"hooks"` e adicionar a chave `"Stop"` após `"SessionStart"`. O resultado deve ser:

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "bash $HOME/.claude/skills/gstack/careful/bin/check-careful.sh",
          "statusMessage": "Checking for destructive commands..."
        }
      ]
    }
  ],
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "Start-Process 'C:\\Users\\fileserver\\AppData\\Local\\Programs\\Obsidian\\Obsidian.exe' -WindowStyle Normal",
          "shell": "powershell",
          "statusMessage": "Iniciando Obsidian...",
          "async": true
        }
      ]
    }
  ],
  "Stop": [
    {
      "matcher": "",
      "hooks": [
        {
          "type": "command",
          "command": "bash $HOME/.claude/hooks/verify-gate.sh",
          "statusMessage": "Rodando verificação do loop autônomo..."
        }
      ]
    }
  ]
}
```

- [ ] **Step 3: Validar JSON**

```bash
python3 -c "import json; json.load(open('/c/Users/fileserver/.claude/settings.json')); print('JSON válido')"
```

Expected: `JSON válido`

- [ ] **Step 4: Confirmar Stop hook presente**

```bash
python3 -c "import json; d=json.load(open('/c/Users/fileserver/.claude/settings.json')); print(list(d['hooks'].keys()))"
```

Expected: `['PreToolUse', 'SessionStart', 'Stop']`

---

## FASE 2 — verify-gate.sh + Delirio Manager

### Task 3: Criar ~/.claude/hooks/verify-gate.sh

**Files:**
- Create: `C:\Users\fileserver\.claude\hooks\verify-gate.sh`

- [ ] **Step 1: Criar diretório hooks**

```bash
mkdir -p /c/Users/fileserver/.claude/hooks
```

Expected: sem erro.

- [ ] **Step 2: Criar o script verify-gate.sh**

```bash
cat > /c/Users/fileserver/.claude/hooks/verify-gate.sh << 'EOF'
#!/usr/bin/env bash
# verify-gate.sh — Stop hook do Loop Autônomo
# Exit 1 = Claude vê o output e continua trabalhando.
# Exit 0 = pode encerrar (após sinalizar cavecrew-reviewer).

PROJECT_DIR="$(pwd)"
VERIFY="$PROJECT_DIR/verify.sh"
LOG_DIR="$PROJECT_DIR/.claude"
LOG="$LOG_DIR/decision.log"

# 1. Rodar verify.sh do projeto (se existir)
if [[ -f "$VERIFY" ]]; then
  echo "[verify-gate] Rodando verify.sh em $PROJECT_DIR..."
  bash "$VERIFY"
  EXIT_CODE=$?
  if [[ $EXIT_CODE -ne 0 ]]; then
    echo "[verify-gate] FALHA (exit $EXIT_CODE) — corrigir antes de fechar sessão"
    exit 1
  fi
  echo "[verify-gate] verify.sh OK"
else
  echo "[verify-gate] Sem verify.sh em $PROJECT_DIR — pulando verificação de projeto"
fi

# 2. Registrar sessão no decision.log
if [[ -d "$PROJECT_DIR" ]] && [[ "$PROJECT_DIR" != "/" ]]; then
  mkdir -p "$LOG_DIR"
  echo "[$(date '+%Y-%m-%d %H:%M')] verify-gate OK | projeto: $PROJECT_DIR" >> "$LOG" 2>/dev/null || true
fi

# 3. Sinalizar Claude para rodar cavecrew-reviewer
echo "[verify-gate] OK — PRÓXIMO PASSO OBRIGATÓRIO: invocar cavecrew-reviewer com o diff da sessão antes de encerrar"
exit 0
EOF
chmod +x /c/Users/fileserver/.claude/hooks/verify-gate.sh
```

- [ ] **Step 3: Testar exit 0 (sem verify.sh no diretório)**

```bash
cd /c/Users/fileserver && bash /c/Users/fileserver/.claude/hooks/verify-gate.sh
echo "Exit code: $?"
```

Expected: mensagem `Sem verify.sh` + `OK — PRÓXIMO PASSO OBRIGATÓRIO` + `Exit code: 0`

- [ ] **Step 4: Testar exit 1 (verify.sh que falha)**

```bash
mkdir -p /tmp/test-loop
echo '#!/usr/bin/env bash
echo "simulando falha de teste"
exit 1' > /tmp/test-loop/verify.sh
chmod +x /tmp/test-loop/verify.sh
cd /tmp/test-loop && bash /c/Users/fileserver/.claude/hooks/verify-gate.sh
echo "Exit code: $?"
```

Expected: `FALHA (exit 1) — corrigir antes de fechar sessão` + `Exit code: 1`

- [ ] **Step 5: Testar exit 0 (verify.sh que passa)**

```bash
echo '#!/usr/bin/env bash
echo "testes OK"
exit 0' > /tmp/test-loop/verify.sh
cd /tmp/test-loop && bash /c/Users/fileserver/.claude/hooks/verify-gate.sh
echo "Exit code: $?"
```

Expected: `verify.sh OK` + `OK — PRÓXIMO PASSO OBRIGATÓRIO` + `Exit code: 0`

- [ ] **Step 6: Limpar diretório de teste**

```bash
rm -rf /tmp/test-loop
```

---

### Task 4: Criar verify.sh no Delirio Manager (F:\RichClub)

**Files:**
- Create: `F:\RichClub\verify.sh`

- [ ] **Step 1: Checar quais verificações estão disponíveis no projeto**

```bash
cd /f/RichClub
echo "=== package.json test ===" && grep '"test"' package.json || echo "sem test script"
echo "=== go.mod ===" && ls go.mod 2>/dev/null || echo "sem go.mod"
echo "=== tsconfig ===" && ls tsconfig*.json 2>/dev/null || echo "sem tsconfig"
echo "=== eslint ===" && ls eslint.config.* .eslintrc.* 2>/dev/null || echo "sem eslint config"
```

- [ ] **Step 2: Criar verify.sh baseado no resultado do Step 1**

```bash
cat > /f/RichClub/verify.sh << 'EOF'
#!/usr/bin/env bash
# verify.sh — Delirio Manager
# Contrato: exit 0 = tudo OK, exit 1 = Claude vê e corrige.
set -euo pipefail

ERRORS=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "[verify] Iniciando verificação — Delirio Manager"

# ── Testes Node.js ────────────────────────────────────────────
if grep -q '"test"' package.json 2>/dev/null; then
  echo "[verify] ▶ npm test"
  npm test --silent 2>&1 || { echo "[verify] ✗ npm test falhou"; ERRORS=$((ERRORS+1)); }
fi

# ── Testes Go ─────────────────────────────────────────────────
if [[ -f "go.mod" ]]; then
  echo "[verify] ▶ go test ./..."
  go test ./... 2>&1 || { echo "[verify] ✗ go test falhou"; ERRORS=$((ERRORS+1)); }
fi

# ── TypeScript ────────────────────────────────────────────────
if ls tsconfig*.json >/dev/null 2>&1; then
  echo "[verify] ▶ tsc --noEmit"
  npx tsc --noEmit 2>&1 || { echo "[verify] ✗ typecheck falhou"; ERRORS=$((ERRORS+1)); }
fi

# ── ESLint ────────────────────────────────────────────────────
if ls eslint.config.* .eslintrc.* >/dev/null 2>&1; then
  echo "[verify] ▶ eslint"
  npx eslint . --max-warnings=0 2>&1 || { echo "[verify] ✗ lint falhou"; ERRORS=$((ERRORS+1)); }
fi

# ── Resultado ─────────────────────────────────────────────────
if [[ $ERRORS -gt 0 ]]; then
  echo "[verify] ✗ $ERRORS verificação(ões) falharam — corrigir antes de fechar"
  exit 1
fi
echo "[verify] ✓ tudo OK"
EOF
chmod +x /f/RichClub/verify.sh
```

- [ ] **Step 3: Rodar verify.sh e confirmar que passa no estado atual do repo**

```bash
cd /f/RichClub && bash verify.sh
echo "Exit code: $?"
```

Expected: `✓ tudo OK` + `Exit code: 0`. Se alguma verificação falhar, corrigir o problema antes de continuar.

- [ ] **Step 4: Testar via verify-gate.sh (integração)**

```bash
cd /f/RichClub && bash /c/Users/fileserver/.claude/hooks/verify-gate.sh
echo "Exit code: $?"
```

Expected: `verify.sh OK` + `OK — PRÓXIMO PASSO OBRIGATÓRIO` + `Exit code: 0`

---

### Task 5: Criar .claude/auto-approve.json no Delirio Manager

**Files:**
- Create: `F:\RichClub\.claude\auto-approve.json`

- [ ] **Step 1: Criar diretório .claude se não existir**

```bash
mkdir -p /f/RichClub/.claude
```

- [ ] **Step 2: Criar auto-approve.json**

```bash
cat > /f/RichClub/.claude/auto-approve.json << 'EOF'
{
  "restrict": [
    "az vm run-command",
    "pm2 restart",
    "pm2 delete",
    "pkill"
  ],
  "elevate": [],
  "requireBrowserCheck": false,
  "skipVerify": false,
  "requireQaGate": true
}
EOF
```

- [ ] **Step 3: Validar JSON**

```bash
python3 -c "import json; json.load(open('/f/RichClub/.claude/auto-approve.json')); print('JSON válido')"
```

Expected: `JSON válido`

- [ ] **Step 4: Adicionar .claude/decision.log ao .gitignore**

```bash
echo ".claude/decision.log" >> /f/RichClub/.gitignore
echo ".claude/auto-approve.json" >> /f/RichClub/.gitignore
git -C /f/RichClub diff .gitignore
```

Expected: duas linhas adicionadas ao .gitignore.

- [ ] **Step 5: Commit da Fase 2**

```bash
cd /f/RichClub
git add verify.sh .gitignore
git commit -m "feat(loop): verify.sh + auto-approve.json — Delirio Manager"
```

---

## FASE 3 — Rollout para outros projetos

### Task 6: verify.sh template para demais projetos

Para cada projeto adicional, criar `verify.sh` adaptado. Template base:

```bash
cat > verify.sh << 'EOF'
#!/usr/bin/env bash
# verify.sh — [NOME DO PROJETO]
set -euo pipefail
ERRORS=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
echo "[verify] Iniciando — [NOME DO PROJETO]"

# ADAPTAR: adicionar checks relevantes abaixo

# Node.js / npm test
# grep -q '"test"' package.json && { npm test --silent || { ERRORS=$((ERRORS+1)); }; }

# .NET
# dotnet build --no-restore 2>&1 || ERRORS=$((ERRORS+1))
# dotnet test --no-build 2>&1 || ERRORS=$((ERRORS+1))

# Python
# pytest --tb=short 2>&1 || ERRORS=$((ERRORS+1))
# ruff check . 2>&1 || ERRORS=$((ERRORS+1))

# Next.js
# npm run build 2>&1 || ERRORS=$((ERRORS+1))

[[ $ERRORS -gt 0 ]] && { echo "[verify] ✗ $ERRORS falha(s)"; exit 1; }
echo "[verify] ✓ OK"
EOF
chmod +x verify.sh
```

**Projetos e checks:**

| Projeto | Path local | Checks |
|---------|-----------|--------|
| Portal MM | `F:\<portal-mm-path>` | npm test + eslint |
| Consolidado Refresh | `F:\<consolidado-path>` | npm test + eslint |
| Site Pessoal | `F:\<site-path>` | npm run build |
| Emissor NF-e | `F:\<emissor-path>` | dotnet build + dotnet test |
| SEO Burial Agent | `F:\Arquivos Acadêmicos\seo-burial-agent` | pytest + ruff check |

Para cada projeto:
- [ ] Criar verify.sh adaptado com os checks da tabela acima
- [ ] Rodar `bash verify.sh` e confirmar exit 0 no estado atual
- [ ] Criar `.claude/auto-approve.json` se houver overrides específicos
- [ ] Adicionar `.claude/decision.log` ao `.gitignore` do projeto
- [ ] Commit: `feat(loop): verify.sh — [nome do projeto]`

---

## Verificação Final do Sistema

- [ ] Abrir nova sessão Claude Code em F:\RichClub
- [ ] Fazer uma edição pequena em qualquer arquivo
- [ ] Verificar que ao término da sessão o Stop hook dispara (`Rodando verificação do loop autônomo...` aparece no status)
- [ ] Verificar que verify.sh roda automaticamente
- [ ] Verificar que `[verify-gate] OK — PRÓXIMO PASSO OBRIGATÓRIO` aparece no output
- [ ] Confirmar que Claude invoca cavecrew-reviewer com o diff antes de fechar
