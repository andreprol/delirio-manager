#!/usr/bin/env bash
# check-single-project-repo.sh — PreToolUse hook (Bash + PowerShell matchers)
#
# Blocks (asks for confirmation on) git add/commit/push into the
# delirio-manager repo when the change looks like it belongs to a
# DIFFERENT project — new doc under docs/superpowers/specs|plans/, or a
# brand new top-level path outside the known Delirio Manager allowlist.
#
# Why this exists: the same mistake happened 3 times (14/09, 18/09,
# 28/10/2026) despite the documentar skill's Passo 2.0 text check — see
# feedback_delirio_manager_repo_contaminado in memory. Text instructions
# alone proved unreliable; this makes the check mechanical.
#
# Reads stdin JSON {"tool_input":{"command":"..."}}, prints {} to allow or
# {"hookSpecificOutput":{"permissionDecision":"ask",...}} to force a
# confirmation.
set -uo pipefail

INPUT=$(cat)

CMD=$(printf '%s' "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//' || true)
if [ -z "$CMD" ]; then
  CMD=$(printf '%s' "$INPUT" | python3 -c 'import sys,json; print(json.loads(sys.stdin.read()).get("tool_input",{}).get("command",""))' 2>/dev/null || true)
fi
if [ -z "$CMD" ]; then
  echo '{}'
  exit 0
fi

# Only care about git commit / push (git add alone is harmless/reversible —
# nothing is committed yet, and checking it would mean flagging whatever
# untracked clutter happens to sit in the working tree, not what's actually
# about to be committed)
if ! printf '%s' "$CMD" | grep -qE 'git[[:space:]]+(commit|push)\b'; then
  echo '{}'
  exit 0
fi

REMOTE=$(git remote get-url origin 2>/dev/null || true)
if ! printf '%s' "$REMOTE" | grep -qi 'delirio-manager'; then
  echo '{}'
  exit 0
fi

TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$TOPLEVEL" ]; then
  echo '{}'
  exit 0
fi

ALLOWLIST=".claude .github .husky .gitignore CHANGELOG.md CLAUDE.md README.md agent clock-proxy dashboard deploy docs infra package.json package-lock.json server skills-lock.json tasks verify.sh"

is_allowed() {
  case "$1" in
    delirio-agent*.exe) return 0 ;;
  esac
  for a in $ALLOWLIST; do
    [ "$1" = "$a" ] && return 0
  done
  return 1
}

FLAG=""

# Build the list of NEW files actually about to land in history:
# - for `git commit`: staged new files (diff-filter=A against the index)
# - for `git push`: new files in commits ahead of upstream, not yet pushed
NEWFILES=""
if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+commit\b'; then
  NEWFILES=$(git -C "$TOPLEVEL" diff --cached --name-only --diff-filter=A 2>/dev/null || true)
fi
if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+push\b'; then
  PUSH_NEW=$(git -C "$TOPLEVEL" diff '@{u}...HEAD' --name-only --diff-filter=A 2>/dev/null || true)
  if [ -n "$PUSH_NEW" ]; then
    NEWFILES="${NEWFILES}${NEWFILES:+$'\n'}${PUSH_NEW}"
  fi
fi

if [ -n "$NEWFILES" ]; then
  while IFS= read -r path; do
    [ -z "$path" ] && continue

    # Check 1: new file under docs/superpowers/specs or plans
    case "$path" in
      docs/superpowers/specs/*|docs/superpowers/plans/*)
        FLAG="Novo arquivo em docs/superpowers/specs ou plans/ ($path) -- confirmar que e do Delirio Manager mesmo, nao de outro projeto (ja aconteceu 3x: 14/09, 18/09, 28/10/2026 -- ver feedback_delirio_manager_repo_contaminado na memoria)."
        break
        ;;
    esac

    # Check 2: new top-level path outside the allowlist
    top="${path%%/*}"
    if ! is_allowed "$top"; then
      FLAG="Novo caminho de topo '$top' fora da allowlist do Delirio Manager -- possivel projeto misturado (checagem 2.0 da skill documentar)."
      break
    fi
  done <<EOF
$NEWFILES
EOF
fi

if [ -n "$FLAG" ]; then
  FLAG_ESCAPED=$(printf '%s' "$FLAG" | sed 's/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[delirio-scope] %s"}}\n' "$FLAG_ESCAPED"
else
  echo '{}'
fi
