#!/usr/bin/env bash
# verify.sh — Delirio Manager
# Contrato: exit 0 = OK, exit 1 = Claude vê e corrige.

ERRORS=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || { echo "[verify] Erro: não consigo acessar $ROOT"; exit 1; }

echo "[verify] Iniciando — Delirio Manager"

# Testes Node.js — server
if grep -qE '"test"\s*:' "$ROOT/server/package.json" 2>/dev/null; then
  echo "[verify] ▶ npm test (server)"
  (cd "$ROOT/server" && npm test --silent 2>&1) || { echo "[verify] ✗ npm test (server) falhou"; ERRORS=$((ERRORS+1)); }
fi

# Testes Node.js — dashboard
if grep -qE '"test"\s*:' "$ROOT/dashboard/package.json" 2>/dev/null; then
  echo "[verify] ▶ npm test (dashboard)"
  (cd "$ROOT/dashboard" && npm test 2>&1) || { echo "[verify] ✗ npm test (dashboard) falhou"; ERRORS=$((ERRORS+1)); }
fi

# Testes Go — agent
if [[ -f "$ROOT/agent/go.mod" ]]; then
  echo "[verify] ▶ go test ./... (agent)"
  (cd "$ROOT/agent" && go test ./... 2>&1) || { echo "[verify] ✗ go test falhou"; ERRORS=$((ERRORS+1)); }
fi

# ESLint — server
# 124 = count atual de warnings pré-existentes no-console/no-unused-vars. Qualquer novo warning falha.
if [[ -f "$ROOT/server/eslint.config.js" ]]; then
  echo "[verify] ▶ eslint (server)"
  (cd "$ROOT/server" && npx eslint . --max-warnings=124 2>&1) || { echo "[verify] ✗ lint falhou"; ERRORS=$((ERRORS+1)); }
fi

if [[ $ERRORS -gt 0 ]]; then
  echo "[verify] ✗ $ERRORS verificação(ões) falharam"
  exit 1
fi
echo "[verify] ✓ tudo OK"
