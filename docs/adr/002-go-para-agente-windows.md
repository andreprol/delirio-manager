# ADR-002: Go para o agente Windows
**Data:** 2026-07-14
**Status:** Aceito

## Contexto

O agente roda como serviço Windows (via NSSM) em 120+ PCs heterogêneos — diferentes versões de Windows 10/11, hardware variado. Responsabilidades: coletar métricas de CPU/RAM/disco/temperatura, detectar estado WoL, enviar heartbeats horários ao servidor, realizar auto-update de binário. O deploy é gerenciado centralmente pelo servidor Delirio Manager.

## Decisão

Implementar o agente em Go, compilando um único binário estático (`delirio-agent.exe`) por release.

## Alternativas Rejeitadas

| Alternativa | Motivo da rejeição |
|---|---|
| Node.js | Exige runtime instalado em todos os 120 PCs; versão do Node pode conflitar com software existente |
| Python | Mesmo problema de runtime; `pyinstaller` gera binários pesados (~50 MB) e lentos para iniciar |
| PowerShell | Sem distribuição de binário; auto-update de script `.ps1` é inseguro e frágil; sem controle de versão de runtime |

## Consequências

**Positivas:**
- Binário único (~8 MB): deploy = download + substituição de arquivo
- Cross-compile trivial no CI (Linux `ubuntu-latest` → `GOOS=windows GOARCH=amd64`)
- Footprint de memória baixo (~10–15 MB RSS em idle)
- Acesso nativo a WMI/syscall para métricas de hardware sem dependências externas
- Auto-update implementável com atomicidade: download `.new` → rename → restart serviço

**Negativas:**
- Compilação necessária a cada release (mitigado pelo CI/CD automatizado)
- Debug em produção mais complexo (sem REPL); mitigado por logs estruturados e `get_agent_log`
- Crash panics precisam de recovery explícito (implementado via `defer recover()` no loop principal)
