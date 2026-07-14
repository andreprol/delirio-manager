# Eng. Soft. Moderna — Gap Analysis & Plano de Qualidade
**Data:** 2026-07-14  
**Projeto:** Delirio Manager  
**Fonte:** https://engsoftmoderna.info (10 capítulos)  
**Status:** P1 concluído — P2 e P3 pendentes

---

## Resumo Executivo

| Prioridade | Total | Concluído | Pendente |
|---|---|---|---|
| P1 | 5 | 5 | 0 |
| P2 | 4 | 0 | 4 |
| P3 | 5 | 0 | 5 |
| **Total** | **14** | **5** | **9** |

---

## P1 — Concluído ✅

| # | Cap | Item | Commit |
|---|---|---|---|
| P1.1 | 8 | Coverage CI threshold Go ≥16% (meta: 70% +5%/sprint) | `f16c033` |
| P1.2 | 5+9 | SOLID + Code Smells no `code-reviewer` agent | `f16c033` |
| P1.3 | 10 | Feature Flags convention no `CLAUDE.md` | `f16c033` |
| P1.4 | 9 | Catálogo de Code Smells na skill `/simplify` | `f16c033` |
| P1.5 | 9 | Cyclomatic complexity ≤10: golangci cyclop (Go) + ESLint error (Node.js) | `f16c033` + sessão 14/07 |

**Nota P1.5:** ESLint promovido de `warn` → `error` em 14/07/2026 após eliminar 31+ violações em 15 arquivos do `server/`. Threshold `verify.sh` ajustado para 126.

---

## P2 — Pendente (Alto Impacto)

### P2.1 — ESLint + Jest no CI (Cap. 10)
**Problema:** `ci-agent.yml` roda apenas Go. `complexity: error` não bloqueia PRs no lado Node.js.  
**Consequência:** Regressões de complexidade passam em PRs sem ser detectadas.  
**Solução:** Criar `ci-server.yml` com:
- `npm ci` + `npx eslint . --max-warnings=126`
- `npm test` (Jest 124+ testes)
- Roda em: `push` e `pull_request` para `master`
- Working-directory: `server/`

### P2.2 — Coverage Node.js no CI (Cap. 8)
**Problema:** Branches 12.84%, Functions 12.29% — sem threshold no CI.  
**Linha atual:** Lines 23.65% (melhor métrica).  
**Solução:** Adicionar ao `ci-server.yml`:
- `jest --coverage --coverageReporters=json-summary`
- Gate: lines ≥20% (baseline conservador), elevar +5%/sprint → meta 70%
- Bloquear se cobertura cair abaixo do threshold

### P2.3 — 3 Test Suites Falhando (Cap. 8) ✅ FALSO POSITIVO
**Investigado em 14/07/2026:** Falso positivo — ocorria ao rodar `npx jest` da raiz, que confundia os testes Vitest do dashboard com Jest.  
**Estado real:** Server 4/4 suítes (99 testes) ✅ | Dashboard 3/3 suítes (49 testes) ✅. Rodar de diretórios corretos.

### P2.4 — Funções >40 Linhas (Cap. 9)
**Problema:** Complexity ≤10 não garante funções curtas. Função com 80 linhas de `if` simples passa.  
**Solução:** Adicionar ao ESLint `eslint.config.js`:
```js
'max-lines-per-function': ['warn', { max: 40, skipBlankLines: true, skipComments: true }],
```
Promover para `error` após limpar violações (mesmo padrão do complexity).

---

## P3 — Pendente (Valor Moderado)

### P3.1 — ADRs — Architecture Decision Records (Cap. 7)
**Problema:** Decisões arquiteturais (SQLite, Go agent, camadas routes→services→db) não documentadas.  
**Solução:** Criar `docs/adr/` com template MADR. Começar pelas 3 decisões mais críticas:
- ADR-001: Por que Go para o agente (vs Node)
- ADR-002: SQLite como banco principal (vs Postgres)
- ADR-003: Arquitetura em camadas routes→services→db

### P3.2 — Diagrama de Arquitetura (Cap. 7)
**Problema:** Nenhuma visão de alto nível do sistema.  
**Solução:** Mermaid no `README.md` ou `docs/architecture.md` mostrando:
- Componentes: Electron+React, Node.js server, Go agent, SQLite, Azure
- Fluxo de dados: Agent → heartbeat → Server → DB → Dashboard

### P3.3 — Catálogo de Padrões de Projeto (Cap. 6)
**Problema:** Padrões usados implicitamente, não documentados.  
**Solução:** Seção no `docs/` catalogando:
- Strategy: dispatcher `ACK_POST_PROCESSORS` em `agent.js`
- Observer: `alertEngine` monitorando métricas
- Template Method: `buildUserPrompt` + `callClaude` + `parseClaudeScore`
- Facade: `reportEngine` como fachada do módulo de relatório

### P3.4 — Issue Templates GitHub (Cap. 2)
**Problema:** Sem estrutura para reportar bugs ou features.  
**Solução:** Criar `.github/ISSUE_TEMPLATE/`:
- `bug_report.md`: descrição, passos para reproduzir, comportamento esperado
- `feature_request.md`: user story, critério de aceite

### P3.5 — TDD em Novos Módulos (Cap. 8)
**Problema:** TDD não praticado — testes escritos após o código.  
**Solução:** Não retroativo. Para próximas features de médio porte:
1. Escrever testes antes da implementação
2. Verificar com `/test-generate` gate após

---

## Mapeamento Completo — 10 Capítulos

| Cap | Tema | Status |
|---|---|---|
| 1 | Introdução | N/A |
| 2 | Processos (Scrum, XP, Kanban) | P3.4 (issue templates) |
| 3 | Requisitos (user stories, MVP) | ✅ specs/plans já existem |
| 4 | Modelos (UML) | Fora de escopo — não aplicável |
| 5 | Princípios SOLID | ✅ P1.2 (code-reviewer) |
| 6 | Padrões de Projeto | P3.3 (catálogo) |
| 7 | Arquitetura | P3.1 (ADRs) + P3.2 (diagrama) |
| 8 | Testes | ✅ P1.1 + P2.2 + P2.3 + P3.5 pendentes |
| 9 | Refactoring / Code Smells | ✅ P1.2 + P1.4 + P1.5 + P2.4 pendente |
| 10 | DevOps / CI-CD | ✅ P1.3 + P2.1 pendente |

---

## Histórico de Sessões

| Data | O que foi feito |
|---|---|
| 2026-07-14 | Gap analysis inicial + P1 implementado (commit f16c033) |
| 2026-07-14 | P1.5 concluído: 31+ violações complexity eliminadas, ESLint warn→error, verify.sh=126 |
| 2026-07-14 | Gap analysis refeito e documentado (esta sessão) |
