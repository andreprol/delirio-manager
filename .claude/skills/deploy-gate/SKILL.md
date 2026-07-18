---
name: deploy-gate
description: Gate obrigatório ANTES de qualquer deploy para produção. Verifica testes, segredos, versão, rollback e pitfalls específicos de cada projeto. BLOQUEIA o deploy se qualquer verificação falhar. Use antes de fazer deploy, push para main, ou atualizar agente/servidor em produção.
---

# Deploy Gate — Portão Final Antes de Produção

**Regra absoluta:** Deploy bloqueado se qualquer item CRÍTICO falhar.

Severidade:
- 🔴 **CRÍTICO** — bloqueia deploy, sem exceção
- 🟡 **AVISO** — documentar e decidir conscientemente se continua
- 🟢 **INFO** — registrar

## Verificação 1 — Testes passando 🔴

Execute todos os testes do projeto:

```bash
# Go
go test ./... -v

# Node.js
npm test

# Go + Node.js (monorepo)
go test ./... && npm test
```

Se **qualquer teste falhar** → deploy bloqueado.

Se **não existem testes** para o código que será deployado → deploy bloqueado. Rodar `/test-generate` primeiro.

## Verificação 2 — Segredos hardcoded 🔴

Buscar no diff atual:

```bash
git diff HEAD | grep -iE "(password|secret|token|api_key|apikey|passwd|pwd)\s*=\s*['\"][^'\"]{6,}"
git diff HEAD | grep -iE "sk-[a-zA-Z0-9]{20,}"
git diff HEAD | grep -iE "['\"][a-f0-9]{32,}['\"]"
```

Também verificar se `.env` está acidentalmente staged:

```bash
git diff --cached --name-only | grep -E "\.env$|\.env\."
```

Se encontrar qualquer segredo hardcoded → **deploy bloqueado imediatamente.**

## Verificação 3 — Logs de debug em código de produção 🟡

```bash
# Node.js
git diff HEAD | grep -E "console\.(log|debug|dir)\("

# Go
git diff HEAD | grep -E "fmt\.Print(ln|f)?\("
```

`console.error` e `console.warn` são aceitáveis. `console.log` em caminhos de produção é aviso.

## Verificação 4 — Específico Delirio Manager Agent (Go) 🔴

**Só execute se o deploy inclui novo binário do agente.**

### 4a. Version bumped?

```bash
grep 'Version\s*=' delirio-agent/main.go
git log --oneline -3
```

Se `Version` não foi bumped em relação ao último deploy → 🔴 **bloqueado.** Agentes em campo verificam `X-Agent-Version`; versão igual = loop de download infinito.

### 4b. AGENT_EXE aponta para o diretório certo?

```bash
grep 'AGENT_EXE' server/update.js server/routes/*.js 2>/dev/null
grep 'express.static' server/app.js server/index.js 2>/dev/null
```

`AGENT_EXE` deve ser `path.join(MESMO_DIRETORIO_DO_EXPRESS_STATIC, 'nome-do-exe')`. Se apontarem para diretórios diferentes → 🔴 SHA256 mismatch nos BOHs.

### 4c. SHA256 foi recalculado?

Confirmar com o usuário: "O SHA256 do novo binário foi recalculado no servidor?" Se não → 🔴 bloqueado.

## Verificação 5 — Específico deploy Node.js / PM2 (Azure VM) 🔴

**Só execute se o deploy vai reiniciar o servidor.**

### Método de restart correto?

```bash
# CORRETO
bash /opt/dt-manager/infra/safe-restart.sh

# ERRADO — nunca usar
pm2 restart dt-manager
```

Se o plano de deploy usa `pm2 restart` direto → 🔴 bloqueado. Ghost workers causam EADDRINUSE → 502.

### Após restart, checar logs:

```bash
# CORRETO
tail -20 /home/delirioadmin/.pm2/logs/dt-manager-out.log

# ERRADO — trava o run-command por 90min
pm2 logs dt-manager
```

## Verificação 6 — Rollback definido 🔴

O usuário deve confirmar:

```
Pergunta: "Como você reverte se o deploy quebrar?"

Resposta esperada inclui:
- Para agent: versão anterior do .exe disponível? Update URL aponta para versão anterior?
- Para server: git revert ou deploy da versão anterior?
- Para DB: backup SQLite feito antes da migração?
```

Se não há resposta clara → 🟡 aviso + documentar no commit message.

## Verificação 7 — Checklist geral 🟡

```
[ ] Branch principal (main/master) está atualizada antes do deploy?
[ ] Variáveis de ambiente de produção conferidas (não as do .env local)?
[ ] Migração de banco necessária? Se sim, foi testada em staging?
[ ] Funcionalidade testada manualmente no ambiente que mais se aproxima de produção?
[ ] Alguém (ou você mesmo em 10 minutos) vai monitorar após o deploy?
```

## Verificação 8 — Smoke test pós-deploy 🔴

**Todo deploy em produção só é considerado concluído após o smoke test passar.**

Se o projeto tem `scripts/smoke-test.js` (ou equivalente): executar logo após o processo subir.

```bash
# Portal MM Solutions / Node.js com health endpoint
node scripts/smoke-test.js

# Com host/port customizados (deploy em VM)
HEALTH_HOST=<ip-da-vm> HEALTH_PORT=3849 node scripts/smoke-test.js

# Via npm script (se configurado)
npm run test:smoke
```

Se o projeto **não tem smoke test** → 🔴 bloqueado. Criar antes de deployar:

```
Scripts mínimos obrigatórios:
- GET /health → { status: "ok", [driver/db/conexão]: <valor não-null> }
- node scripts/smoke-test.js → exit 0 se ok, exit 1 se falha
```

**Projeto novo sem health endpoint:** criar o endpoint primeiro, depois criar o smoke test.

Se smoke test **falhar** após deploy → rollback imediato (Verificação 6).

## Resultado final

### Tudo passou:

```
✅ DEPLOY GATE — APROVADO

Verificações:
✓ Testes passando (N testes)
✓ Sem segredos hardcoded
✓ Sem logs de debug críticos
✓ [Verificações específicas do projeto]
✓ Rollback definido: [método]

Deploy pode prosseguir.
```

### Falha crítica:

```
🚫 DEPLOY GATE — BLOQUEADO

Motivo(s):
🔴 [motivo 1] — [o que precisa ser corrigido]
🔴 [motivo 2] — [o que precisa ser corrigido]

Corrija os itens acima e rode /deploy-gate novamente.
```

### Apenas avisos:

```
⚠️ DEPLOY GATE — APROVADO COM RESSALVAS

Avisos:
🟡 [aviso 1] — decisão consciente necessária
🟡 [aviso 2] — decisão consciente necessária

Você decide se continua. Documente a decisão no commit message.
```
