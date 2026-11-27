# Re-key de Máquina Trava o Banco Inteiro — Plano 4/4

> **For agentic workers:** este plano corrige um incidente de produção REAL e
> ATIVO (não hipotético) achado em 27/11/2026 enquanto se validava o
> `/api/healthz` do Plano 1. Mitigação de emergência já aplicada
> (`statement_timeout=180000` no Postgres + conexões travadas finalizadas
> + restart da app) — este plano é o conserto definitivo, pra nunca mais
> precisar repetir a mitigação manual.

**Goal:** Fazer o re-key de UUID de máquina (`_rekeyAndMergeMachine`)
parar de travar por dezenas de minutos a mais de uma hora, saturando o
pool de conexões do Postgres e derrubando o `/api/healthz` (e, por
extensão, qualquer health probe de Load Balancer no Plano 2) —
independente de quantas linhas de histórico a máquina acumulou.

**Architecture:** Hoje o re-key reescreve `machine_id` em TODAS as
tabelas filhas (10 via `ON UPDATE CASCADE`, 5 manuais) dentro da MESMA
transação que segura o advisory lock por hostname — incluindo
`activity_log`, que tem **59 milhões de linhas / 23GB** depois de só 3
meses de produção. Reescrever a fatia de uma máquina nessa tabela é
proporcional ao volume histórico dela, não a um número fixo — por isso
trava de 1 a 71+ minutos dependendo da máquina, nunca é "rápido". A
correção separa duas coisas que hoje são uma só: (1) o registro em si
(rápido, poucas linhas, pode continuar síncrono) de (2) a
reescrita do histórico em tabelas grandes (lenta, deve sair da
transação crítica e idealmente nem ser síncrona).

**Tech Stack:** `server/db-pg.js`, migração SQL (índice), Postgres
(`statement_timeout`, `pg_stat_activity`), mesmo padrão de
`deleteInBatches` já usado em `activityRetention.js`.

**Spec:** nenhuma — achado ao vivo, não fazia parte do design original
de HA. Referenciar este plano a partir de
`docs/superpowers/specs/2026-11-27-ha-watchdog-design.md` se o Plano 1/2
quiserem apontar pra ele.

## O que já foi feito (mitigação de emergência, 27/11/2026)

- `pg_terminate_backend` em 9 conexões travadas (1-71min presas em
  `UPDATE machines SET id=$1 WHERE id=$2` / `UPDATE metrics SET
  machine_id=...`), todas com rollback seguro (transação, sem corromper
  nada — o agente tenta de novo no próximo heartbeat)
- `safe-restart.sh` na VM pra limpar o pool da aplicação, que tinha
  ficado com estado interno preso mesmo depois do banco já estar livre
- `statement_timeout = 180000` (3min) aplicado no servidor Postgres
  (`psql-dt-manager-prod`), dinâmico, sem restart do banco — rede de
  segurança: nenhuma query trava mais que 3min, protege o pool mesmo
  antes do conserto definitivo

**Isso é paliativo, não solução.** Minutos depois da mitigação, o MESMO
padrão de 9 conexões travadas reapareceu sozinho, confirmando que é um
**loop ativo e contínuo**, não um acúmulo histórico pontual: um punhado
de máquinas está preso tentando re-key a cada heartbeat, nunca
termina a tempo, e tenta de novo.

## Achados da investigação ao vivo (27/11/2026)

- **Causa raiz confirmada**: `_rekeyAndMergeMachine`
  (`server/db-pg.js:1083`) reescreve `machine_id` em 5 tabelas manuais
  (`MACHINE_CHILD_TABLES_NO_FK`) + 10 via cascade, tudo dentro de uma
  transação que já segura o advisory lock do hostname inteiro
  (`db-pg.js:1036`)
- **`activity_log`: 59.040.708 linhas, 23GB** — maior de longe entre as
  tabelas envolvidas (`metrics` 45K linhas/164MB com índice OK,
  `commands` 29K linhas mas 2,3GB — bloat, ver Review Focus)
- **Confirmado que reproduz na hora**: minutos depois do restart de
  mitigação, as MESMAS ~9 máquinas já estavam de novo travadas na
  mesma linha, com idade de poucos segundos — não é histórico antigo
  reaparecendo, é um loop ativo
- **4 das 9 máquinas identificadas** (hash reverso via
  `hashtext(upper(hostname))`): `GERENTE-CITTA`, `AUXILIAR-CITTA`,
  `TERMCITTA1` (3 de 4 na loja **Città**), `DTMETROIFOOD02`
  (Metropolitano) — `last_seen` de 25/11 e 27/11, ou seja, já recorre
  há pelo menos 2 dias, não é de hoje
- **Postgres com `statement_timeout=0`** (sem teto) era o que permitia
  a query travar indefinidamente em vez de falhar rápido — já corrigido
  como mitigação, mas precisa virar parte do provisionamento oficial
  (Terraform/script/doc), não ficar só como `az` manual
- **Pergunta em aberto do André, não respondida ainda**: por que
  `activity_log` chegou a 59 milhões de linhas em só 3 meses de
  produção — precisa de auditoria própria (ver Task 1)

## Global Constraints

- **Nenhuma migração que trave `activity_log` inteira** (23GB — um
  `CREATE INDEX` sem `CONCURRENTLY`, ou um `ALTER TABLE` que reescreva
  a tabela, trava todo mundo por muito tempo). Toda migração nesta
  tabela usa `CONCURRENTLY` ou roda em janela de baixo tráfego
  combinada com o André antes
- `statement_timeout=180000` já está em produção — qualquer mudança de
  comportamento desta task não pode depender de removê-lo; é rede de
  segurança permanente, não só temporária
- As 9 máquinas presas no loop hoje continuam tentando re-key a cada
  heartbeat — qualquer fix precisa ser validado contra ELAS
  especificamente (não só em teste sintético), já que são o caso real
  reproduzindo agora
- Esse re-key é literalmente o motivo de existir do `MACHINE_CHILD_TABLES_NO_FK`
  comment: "config.json corrompido/reinstall" — qualquer redesenho
  continua precisando resolver o mesmo problema de negócio (agente
  reinstalado, hostname igual, UUID novo), só não pode mais ser O(linhas
  históricas da máquina)

## Review Focus

- **`commands`: 29K linhas mas 2,3GB** — tamanho desproporcional ao
  número de linhas (bloat real, provavelmente payload grande por linha
  ou dead tuples não compactados) — vale um `VACUUM`/investigação
  separada, fora do escopo central deste plano mas achado no caminho
- **As 5 máquinas restantes do loop** (9 identificadas por objid, só 4
  resolvidas pro hostname atual) — as outras 5 objids não bateram com
  nenhum hostname ATUAL em `machines` — podem ser hostnames que já
  nem existem mais na tabela (duplicata já removida por uma tentativa
  anterior que completou o suficiente antes de travar) — investigar
  antes de assumir que são as mesmas 4 lojas
- **Padrão geográfico**: 3 de 4 identificadas são da loja Città — pode
  ser coincidência (Città tem várias máquinas) ou pode ser rede local
  instável lá causando reinstalls/reboots frequentes do agente — vale
  perguntar pro André se Città teve incidente de rede/hardware recente
- **O que acontece com o agente enquanto o re-key nunca completa**: ele
  争enta de novo no próximo heartbeat, criando uma NOVA tentativa
  igualmente cara, sem nunca progredir — qualquer fix precisa quebrar
  esse ciclo, não só tornar uma tentativa mais rápida
- **Replicar a correção de índice ausente da Task 3 do achado de hoje**
  (`insights.machine_id` sem índice, achado no meio da investigação de
  Plano 2 Task 3) — pequeno, mas real, incluir aqui já que é a mesma
  categoria de problema (FK sem índice)

---

## Task 1: Auditar por que `activity_log` tem 59M linhas em 3 meses

**Pergunta do André, tem que responder antes de decidir o resto**: é
taxa de escrita normal (polling de janela/processo) ou tem algo
duplicando/logando demais?

- [ ] **Step 1**: calcular a taxa esperada — `59.040.708 / 130 máquinas
  / ~90 dias = ~5.043 linhas/dia/máquina = ~3,5/min`. Comparar com o
  intervalo de captura real do agente (ler `agent/` pra achar de quanto
  em quanto tempo ele manda atividade de janela/processo)
- [ ] **Step 2**: olhar uma amostra real de `activity_log` pra uma
  máquina específica — tem linha duplicada/repetida sem mudança de
  estado? Tem ruído (ex. heartbeat de erro logado como atividade)?
- [ ] **Step 3**: confirmar se a retenção (`activityRetention.js`,
  90 dias) está realmente rodando e com o parâmetro certo — hoje só
  removeu "3 linhas" na última execução (log de hoje), o que é
  suspeito baixo pra uma tabela desse tamanho rodando há 3 meses
  (esperado: zero ainda faz sentido SE a retenção for exatamente 90
  dias e o app tiver exatamente ~90 dias de vida — confirmar a data
  real de início de produção antes de concluir)
- [ ] **Step 4**: reportar pro André o veredito — "é esperado dado o
  volume de agentes" vs "tem um bug jogando linha demais" — decisão
  sobre reduzir frequência de captura ou agregar fica pra depois desse
  veredito, não decidir sozinho

## Task 2: Parar o loop ativo das máquinas presas

- [ ] **Step 1**: reidentificar as 9 máquinas presas agora (os objids
  mudam a cada nova tentativa, repetir a query de hash reverso)
- [ ] **Step 2**: pra cada uma, investigar POR QUE elas têm um UUID
  "novo" tentando re-key contra um hostname conhecido — checar
  `agent/config.go`/logs locais dessas máquinas (via Acesso Remoto ou
  pedir pro André olhar fisicamente) — reinstall genuíno? bug gerando
  UUID novo a cada boot? `config.json` não persistindo?
- [ ] **Step 3**: se for um bug local do agente (não persiste UUID),
  esse é o fix de verdade que quebra o loop — corrigir lá, não só no
  servidor
- [ ] **Step 4**: enquanto isso não é corrigido, considerar um
  circuit-breaker simples no agente ou no servidor: depois de N
  tentativas de re-key fracassadas/sem resposta a tempo pro mesmo
  hostname numa janela curta, parar de tentar e alertar (em vez de
  martelar o banco a cada heartbeat)

## Task 3: Tornar o re-key rápido independente do volume histórico

**A correção estrutural de verdade** — sem isso, qualquer máquina
antiga/ativa vai travar de novo no dia que precisar re-key, não importa
o que a Task 2 resolva.

- [ ] **Step 1**: separar `_rekeyAndMergeMachine` em duas fases —
  **Fase A (síncrona, na transação com o lock)**: só atualiza
  `machines` em si + tabelas pequenas (`metrics`, `commands`, `events`,
  `nfce_auto_email_log`, `service_status` — confirmar tamanho real de
  cada uma antes de assumir "pequena"). Responde sucesso pro agente
  assim que Fase A termina (deve ser questão de milissegundos).
  **Fase B (assíncrona, fora da transação crítica)**: reescreve
  `machine_id` nas tabelas grandes (`activity_log` em primeiro lugar)
  em BATCHES pequenos (mesmo padrão de `deleteInBatches` já usado em
  `activityRetention.js`), sem seguir o advisory lock do hostname
  (já não precisa mais — o re-key "oficial" já aconteceu na Fase A)
- [ ] **Step 2**: escrever teste provando que Fase A completa em
  milissegundos mesmo com uma tabela `activity_log` de teste com
  centenas de milhares de linhas simuladas pra aquela máquina
- [ ] **Step 3**: escrever teste provando que Fase B eventualmente
  migra todas as linhas (idempotente, retomável se o processo cair no
  meio)
- [ ] **Step 4**: decidir e documentar: enquanto a Fase B não termina
  pra uma máquina, uma leitura de `activity_log` filtrando pelo UUID
  NOVO não vai achar o histórico antigo (ele ainda está com o UUID
  velho) — se isso importa pra alguma tela do dashboard, precisa de um
  `UNION`/fallback temporário ou aceitar a janela de inconsistência
  (builder decide com base no uso real da tela de atividade)

## Task 4: Índice ausente + teto de timeout oficializado

- [ ] **Step 1**: `CREATE INDEX CONCURRENTLY idx_insights_machine_id ON
  insights (machine_id);` (achado na investigação do Plano 2 Task 3,
  mesma categoria de problema — FK sem índice)
- [ ] **Step 2**: documentar `statement_timeout=180000` como parte do
  provisionamento oficial do Postgres (script/README do projeto, não só
  um `az` rodado manualmente hoje) — pra sobreviver a um rebuild do
  servidor
- [ ] **Step 3**: considerar `idle_in_transaction_session_timeout`
  também (mesma categoria de proteção, pra transação que abre e nunca
  faz nada)

## Task 5: Monitoramento — nunca mais descobrir isso por acidente

- [ ] **Step 1**: um alerta (reaproveitar `resendAlert.js`, mesmo
  padrão do `rhHealthMonitor`) quando alguma transação ficar "active"
  por mais de N minutos (`pg_stat_activity` + `now()-xact_start`) —
  teria avisado sobre isso há dias, não só quando o healthz do Plano 1
  por acaso expôs o sintoma
- [ ] **Step 2**: o `/api/healthz` (Plano 1) já detecta o sintoma
  (timeout) — considerar enriquecer o corpo da resposta com o motivo
  quando for especificamente timeout de query vs banco genuinamente
  fora do ar (nice-to-have, não bloqueia o resto)

## Self-Review

**Cobertura**: a pergunta do André ("por que 59M linhas em 3 meses")
tem task própria (Task 1), não foi varrida pra debaixo do tapete. O
loop ativo das 9 máquinas tem task própria (Task 2, fix na origem, não
só sintoma). A correção estrutural que evita recorrência em QUALQUER
máquina futura (não só as 9 de hoje) é a Task 3 — essa é a que garante
"nunca mais aconteça de novo" que o André pediu, não só tratar o
sintoma de hoje.

**Proporção**: plano nasceu de investigação ao vivo, não de spec
prévia — tasks refletem exatamente o que foi encontrado, sem
especulação além do que os dados mostraram.
