# ADR-001: SQLite como banco principal
**Data:** 2026-07-14
**Status:** Aceito

## Contexto

Aplicação single-tenant: servidor Node.js rodando em VM Azure, ~120 máquinas enviando métricas horárias, dashboard Electron lendo dados via HTTP local. Apenas o processo Node.js escreve no banco — o agente Go escreve somente em `config.json` local. Volume de escrita estimado: ~120 INSERTs/hora de métricas + operações administrativas pontuais.

## Decisão

Usar SQLite como único banco de dados, acessado pelo módulo `db.js` via `better-sqlite3`.

## Alternativas Rejeitadas

| Alternativa | Motivo da rejeição |
|---|---|
| PostgreSQL | Overhead operacional (servidor separado, backups, tuning); overkill para single-tenant |
| Azure SQL | Custo mensal, latência de rede adicionada a cada query, dependência de conectividade |
| MySQL/MariaDB | Mesmo overhead do Postgres sem benefício adicional para o caso de uso |

## Consequências

**Positivas:**
- Zero operações de banco (sem servidor para gerenciar, atualizar ou monitorar)
- Backup = cópia do arquivo `.db` (Azure Blob, cron, Veeam)
- Throughput suficiente: SQLite suporta centenas de escritas/segundo com WAL mode
- Sem pool de conexões, sem credenciais de banco para rotacionar

**Negativas:**
- Sem suporte a múltiplos escritores concorrentes (mitigado: único processo Node.js escreve)
- Migração futura para multi-tenant exigiria troca de banco
- Ferramentas de BI externas precisam acessar o arquivo diretamente (via `sqlite3` CLI)
