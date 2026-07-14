# ADR-003: Arquitetura em camadas routes → services → db
**Data:** 2026-07-14
**Status:** Aceito

## Contexto

Servidor Express.js servindo API HTTP para dois consumidores: dashboard Electron (leitura intensiva) e agentes Go (escrita de métricas/heartbeats). Estrutura atual: ~15 arquivos de rotas, ~8 arquivos de serviço, 1 módulo `db.js` com acesso SQLite via `better-sqlite3`. O projeto cresceu de um protótipo flat (toda lógica nas rotas) para o estado atual.

## Decisão

Manter separação estrita em três camadas:
- **routes/**: parsing de request/response HTTP, validação de entrada, delegação ao serviço
- **services/**: lógica de negócio (cálculos, agregações, regras), sem conhecimento de HTTP
- **db.js**: único ponto de acesso ao SQLite — queries preparadas, transações

## Alternativas Rejeitadas

| Alternativa | Motivo da rejeição |
|---|---|
| Arquitetura flat (lógica nas rotas) | Estado inicial do projeto; impossível testar sem HTTP; lógica duplicada entre rotas |
| MVC com controllers separados | Camada extra sem benefício para este escopo; routes já fazem o papel de controller |
| ORM (Sequelize/Prisma) | Adiciona abstração e migrations automáticas desnecessárias; SQLite direto é mais previsível |

## Consequências

**Positivas:**
- Serviços testáveis em isolamento: `jest` pode invocar `services/machines.js` sem subir Express
- Ponto único de acesso ao banco: queries SQL visíveis e auditáveis em `db.js`
- Rotas permanecem finas: facilita leitura e revisão de código
- Mudança de banco futura (ex.: Postgres) afeta apenas `db.js` e adaptadores de query

**Negativas:**
- Disciplina manual necessária: nada impede que um dev escreva query diretamente na rota (resolvido via lint customizado e revisão de PR)
- Pequeno overhead de indireção em endpoints simples (aceitável)
