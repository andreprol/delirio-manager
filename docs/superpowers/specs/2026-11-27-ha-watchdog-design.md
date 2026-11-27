# Delirio Manager — Alta disponibilidade + Agente de Vigilância com IA

Status: aguardando aprovação do André
Data: 2026-11-27

## Intenção e por quê

O Delirio Manager está assumindo o papel que hoje é da Zamak (N-sight,
RMM usado pra monitorar/gerenciar a frota de ~130 máquinas das lojas) —
e ganhando responsabilidades que a Zamak nunca teve (módulo de RH,
relógios de ponto Henry Hexa). Por ser o substituto de um sistema
crítico, downtime deixou de ser tolerável.

O gatilho direto: em 27/11/2026 o servidor (`vm-dt-manager`, VM única)
entrou num crash-loop real (512 restarts, confirmado ao vivo) porque um
túnel IPsec de uma loja caiu e uma chamada de rede sem timeout de conexão
ficou prendendo o processo até derrubar tudo — ninguém percebeu até o
dashboard mostrar "Sem conexão". Esse incidente específico já foi
corrigido (connect-timeout + circuit breaker, commit `727392b`), mas ele
expôs o problema de fundo: **uma VM única é um ponto único de falha**, e
**nada vigia o sistema de fora** — se o processo trava de um jeito que o
PM2 não resolve sozinho, ninguém sabe até alguém notar manualmente.

Este documento cobre duas frentes que o André decidiu tocar juntas:

- **A) Arquitetura de alta disponibilidade** — elimina a VM única como
  ponto de falha, pra uma queda de aplicação num nó não interromper
  ninguém.
- **B) Agente de vigilância externo com IA** — roda fora da própria
  infraestrutura do app, confirma conectividade de verdade (não só um
  health-check raso), recupera um nó doente sozinho, investiga a causa
  com IA usando uma base de conhecimento de incidentes que só cresce, e
  manda e-mail com o diagnóstico e um fix proposto — pro André trazer
  pra uma sessão do Claude Code e implementar.

## Objetivos

- Eliminar a VM de app como ponto único de falha (HTTP + WebSocket)
- Detectar uma queda real (não ser enganado pelo nginx respondendo
  `/health` sem nunca repassar pro Node — confirmado que isso acontece
  hoje) em até ~1 minuto
- Recuperar um nó doente sem precisar de um humano acordar pra isso
- Desacoplar os túneis VPN de loja da VM de app, pra qualquer uma das
  réplicas poder servir qualquer requisição
- Nenhum efeito colateral duplicado ao rodar 2 instâncias ativas (jobs
  de fundo continuam rodando exatamente uma vez)
- Todo incidente real produz 3 coisas: recuperação automática,
  diagnóstico por IA mandado por e-mail, e uma entrada na base de
  conhecimento de incidentes (arquivo no repo) que tanto a próxima
  rodada de diagnóstico da IA quanto futuras sessões do Claude Code vão
  ler — pra nunca mais cair do mesmo jeito duas vezes
- Custo transparente e aprovado antes de qualquer gasto (ver tabela)

## Não-objetivos (nesta fase)

- Disaster recovery multi-região (uma queda da região Brazil South
  inteira continua sendo um risco aceito, não resolvido aqui)
- O agente abrir PR ou aplicar código sozinho — André foi explícito:
  só e-mail com a análise; ele chama uma sessão aqui pra implementar
- Migrar a VPN cliente (`deliriotropical`, OpenVPN, uso pessoal do André
  pra acesso ad hoc tipo SAP HANA) pro novo Gateway — fica como está
- Alta disponibilidade do Postgres em si (hoje é 1 instância gerenciada
  única) — as duas VMs de app vão apontar pra essa mesma instância;
  vira o novo ponto único de falha depois deste projeto, documentado
  como próxima fase, não resolvido agora
- Continuidade de uma conexão WebSocket já aberta durante um failover —
  ela cai e reconecta (o cliente, seja agente de loja ou dashboard, já
  tem lógica de reconexão); o que se ganha é que a reconexão cai na
  réplica saudável automaticamente, não que a conexão em si sobrevive

## Anti-objetivos

(o que faria isso ser um fracasso mesmo "funcionando" no papel)

- Reduzir confiabilidade em outro lugar sem perceber — ex.: 2 instâncias
  ativas disparando o mesmo job de fundo 2x, bombardeando as 130
  máquinas com comando duplicado
- O próprio vigilante virar fonte de instabilidade — reiniciar um nó
  saudável por causa de uma checagem instável, ou custo de IA explodindo
  sem controle
- Um desenho que exija reconfigurar o roteador de cada loja a cada
  failover (foi exatamente por isso que IP flutuante foi descartado)

## Restrições

- Hoje existe só 1 túnel IPsec site-to-site de verdade
  (`azure-to-metro`, loja Metro, `192.168.14.0/24`) — e está caído
  agora mesmo (peer remoto, fora do nosso controle). Isso é uma janela
  de baixo risco pra migrar sem interromper nada que esteja funcionando.
- O Postgres gerenciado (`psql-dt-manager-prod`) continua sendo 1
  instância só — ambas as VMs de app apontam pra ela.
- Vários jobs de fundo hoje assumem instância única: `ZamakDaily` sync,
  `dbSizeMonitor` (01:30 diário), `rhHealthMonitor` (5 em 5min),
  `ncrMonitor`, indexação de NFCe (dispara pra todas as BOH a cada
  15min), refresh de scan Aloha (4 em 4h). Todos precisam virar
  "só o líder roda".
- A frota de 130+ máquinas e os clientes do dashboard já reconectam
  sozinhos quando o WebSocket cai — reaproveitar essa lógica existente,
  não reescrever.
- Teto de custo: ~$375/mês adicionais, confirmado contra o preço real
  da Azure (API `prices.azure.com`, não estimativa de terceiro) —
  aprovado pelo André nessa faixa.

## Abordagens consideradas

1. **IP público flutuante entre 2 VMs** (mais rápido, mais barato) —
   **descartada**: todo failover dependeria de uma chamada de API da
   Azure realocando o IP, exatamente o tipo de peça frágil que falha na
   hora que mais importa.
2. **Desacoplar a VPN num Azure VPN Gateway (VpnGw1AZ) + 2 VMs de app
   sem estado de rede + Load Balancer Standard** — **escolhida**. O
   roteador de cada loja é configurado uma vez (aponta pro IP fixo do
   Gateway) e nunca mais precisa mudar, não importa qual VM de app está
   ativa.
3. **Onde hospedar o vigilante**: 3ª VM dedicada vs. Azure Function
   (timer trigger) — **escolhida Function**: custo ~zero nessa escala,
   sem servidor próprio pra manter (seria irônico uma ferramenta de
   confiabilidade precisar da própria história de confiabilidade),
   gerenciada pela Azure.

## Desenho decidido

### A. Camada de rede — migração pro VPN Gateway

- Criar `Azure VPN Gateway`, SKU **VpnGw1AZ** (zone-redundant — é
  justamente o ponto que não pode cair sozinho). IP público Standard
  fixo.
- Migrar a conexão `azure-to-metro` (hoje definida em
  `/etc/ipsec.conf` na VM, via strongSwan) pra uma conexão site-to-site
  no Gateway, com o mesmo `rightsubnet=192.168.14.0/24` e a mesma chave
  pré-compartilhada.
- Coordenar com a loja Metro (ou quem administra o roteador de lá) a
  troca do peer IP de `20.226.33.21` (VM) pro IP do novo Gateway — feita
  **uma única vez**. Janela de baixo risco: o túnel já está caído agora,
  então não há nada "funcionando" sendo interrompido.
- O strongSwan + `ipsec-watchdog-metro.service/timer` saem da VM depois
  da migração confirmada (deixam de fazer sentido).
- Qualquer túnel novo que a casa precisar no futuro (mais lojas com
  clock-proxy, por exemplo) nasce direto no Gateway, nunca mais numa VM.

### B. Camada de computação — 2 VMs de app + Load Balancer

- 2ª VM, mesma SKU da atual (`Standard_D2s_v3`), mesmo disco
  (`Premium SSD P15 LRS`, 256GB), mesma imagem/deploy (`ecosystem.config.js`
  idêntico, aponta pro mesmo `DATABASE_URL`).
- `Azure Load Balancer Standard` na frente das duas, com **health probe
  num endpoint "profundo"** — não pode ser só `/health` do nginx (hoje
  confirmado que ele responde 200 mesmo com o Node morto por dentro).
  Precisa de um endpoint novo, ex. `GET /api/healthz`, que faça um
  `SELECT 1` real no Postgres e confirme que o servidor WS está
  aceitando conexão, antes de responder 200.
- **`/api/healthz` tem que distinguir "app travado" de "Postgres com
  problema"** (achado no builder-check: como as duas VMs usam o mesmo
  Postgres, um Postgres degradado derrubaria as duas de uma vez — e o
  vigilante não pode reagir a isso reiniciando processos de app
  saudáveis, que não resolveria nada). Regra: se o endpoint RESPONDE
  (mesmo um 503 com corpo tipo `{"db": false}`), o processo Node está
  vivo — o problema é o banco, não o app; o vigilante só alerta, nunca
  reinicia app nem VM nesse caso. Só escala pra restart/reboot quando a
  VM **não responde nada** (timeout/conexão recusada) — aí sim é sinal
  de app/processo morto.
- Dashboard e o agente das 130 máquinas passam a apontar pro
  IP/hostname do Load Balancer (`dt-manager.brazilsouth.cloudapp.azure.com`
  continua sendo o nome público — só muda o que está por trás dele).
  **Confirmado no código** (`agent/config.go:302`, `dashboard/src/api.js:3`)
  que tanto o agent quanto o dashboard usam só esse hostname, nunca IP
  fixo — o agent ainda tem resolução de DNS resiliente própria
  (`agent/resilient_dns.go`, fallback pra `8.8.8.8`/`1.1.1.1`). Corte de
  DNS é transparente pra frota inteira, sem precisar atualizar nenhuma
  máquina.
- **Atenção renovação de certificado TLS** (achado ao verificar o ponto
  acima): hoje o certificado deve ser renovado (Let's Encrypt ou
  equivalente) na própria VM. Com 2 VMs atrás do LB, se a renovação usar
  desafio HTTP-01, o LB pode mandar a validação pra VM "errada" e a
  renovação falha silenciosamente. Usar desafio **DNS-01** (plugin do
  certbot pra Azure DNS) resolve isso — não depende de qual VM responde.
- Deploy continua pelo mesmo `ci-server.yml`/`safe-restart.sh` de hoje,
  rodando nas duas VMs (builder decide se sequencial com validação de
  saúde entre uma e outra, ou paralelo — ver "o que fica pro builder").

### C. Sem efeito duplicado — eleição de líder

- Mecanismo: **advisory lock do Postgres** (`pg_try_advisory_lock`),
  renovado periodicamente por quem o detém. Quem conseguir o lock é o
  líder; só ele roda os jobs de fundo listados em "Restrições". A
  réplica que não é líder continua servindo requisição HTTP/WS
  normalmente — só não dispara os jobs agendados.
- Se o líder cair, o lock libera (ou expira, dependendo da
  implementação escolhida pelo builder) e a outra réplica assume os
  jobs automaticamente — sem intervenção humana.

### D. Agente de vigilância externo (Azure Function)

- **Azure Function, plano Consumption, timer trigger a cada ~20s**
  (ajustado no builder-check: com debounce de N≥2 falhas seguidas, um
  timer de 1min dava N minutos até agir, contradizendo o objetivo de
  "~1min pra detectar" — 20s com debounce de 3 fecha em ~1min de
  verdade).
- Bate no Load Balancer (visão de fora, "o sistema como um cliente
  vê") **e** em cada VM individualmente (visão de dentro, pra
  distinguir "uma réplica caiu mas o LB já desviou o tráfego — tudo
  bem, só precisa consertar essa réplica em paralelo" de "as duas
  caíram, isso é incidente de verdade").
- **Acesso às VMs sem IP público nelas** (achado no builder-check: uma
  Function em plano Consumption não está na VNet por padrão — dar IP
  público a cada VM só pra isso reabriria exatamente o tipo de exposição
  direta que a migração pro VPN Gateway existe pra fechar). Decisão:
  **Regional VNet Integration** (saída) na própria Function, mesma VNet
  das VMs — sem custo adicional de plano, só confirmar na hora da
  implementação que a região ainda suporta isso no plano Consumption
  (feature evolui, builder confere na documentação atual da Azure antes
  de montar).
- Checagem real: `GET /api/healthz` (o mesmo endpoint profundo do
  health probe do LB) — nunca confiar só no nginx.
- Debounce: só age depois de N falhas seguidas (evita reagir a um
  soluço de rede de 1 checagem) — mesmo princípio que faltava no
  `useMachines.js` do dashboard (ver "o que fica pro builder").
- Ação de recuperação, em ordem de escalonamento:
  1. `safe-restart.sh` via Azure Run Command na VM doente (mesmo
     mecanismo usado manualmente no incidente de hoje)
  2. Se a VM não responder nem a isso (Run Command falhando), reiniciar
     a VM inteira via API da Azure
  3. Se a VM estiver desalocada/não existir, ligar ela de novo
- Autenticação: **Managed Identity** da própria Function, com uma
  role/escopo customizado que só permite Run Command + restart/start
  nas 2 VMs deste resource group — nunca uma credencial de
  subscription inteira.

### E. Diagnóstico com IA + base de conhecimento crescente

- Quando o agente detecta e age, ele reúne o mesmo tipo de diagnóstico
  que foi feito manualmente hoje: `pm2 describe`, logs de erro recentes,
  `ps`/estado do processo, status do IPsec, uso de disco — via Run
  Command, os mesmos comandos.
- Esse diagnóstico + a base de conhecimento de incidentes (arquivo(s)
  versionados no repo, ex. `docs/incidentes/` — um arquivo por padrão
  de falha já visto: EADDRINUSE/processo fantasma, túnel IPsec caído,
  contenção de I/O do banco, disco cheio, memória) vão como contexto
  pra uma chamada da API da Claude, pedindo diagnóstico da causa raiz +
  um fix proposto em texto.
- **Toda vez que um incidente novo é corrigido de verdade** (numa sessão
  aqui, como hoje), a correção entra nessa base de conhecimento — é
  assim que "nunca mais cai do mesmo jeito" se concretiza: da próxima
  vez, a IA do agente já reconhece o padrão e o e-mail já cita a causa
  com mais confiança (e eventualmente nem precisa esperar o André, se
  o padrão já tiver uma ação automática conhecida — mas isso é decisão
  de uma fase futura, não desta).
- Custo controlado: a chamada de IA só acontece quando o agente já
  decidiu que é um incidente real (depois do debounce), não a cada
  checagem.
- **Teto de chamadas de IA** (achado no builder-check: um nó
  "piscando" — caindo e voltando várias vezes no mesmo dia, tipo um
  IPsec instável — dispararia uma chamada de IA nova a cada ciclo,
  fugindo da estimativa de custo). Limite: **máximo 20 diagnósticos de
  IA por dia**; depois disso, o e-mail continua saindo (recuperação
  automática nunca para), mas sem a chamada de IA — texto fixo tipo "N
  quedas nas últimas 24h, diagnóstico de IA pausado por hoje, ver
  `docs/incidentes/` manualmente". Isso é o teto do PIOR caso, não o
  esperado — a estimativa de $5–15/mês continua sendo o caso normal.
- **Base de conhecimento lida ao vivo, não embutida no deploy da
  Function** (achado no builder-check: se os arquivos de
  `docs/incidentes/` fossem empacotados no deploy da Function, toda
  correção nova exigiria lembrar de reimplantar a Function também —
  fácil de esquecer, deixaria o diagnóstico desatualizado em silêncio).
  A Function busca os arquivos direto do GitHub (API, token read-only
  com escopo só nesse repo) a cada diagnóstico — nunca fica
  desatualizada, e corrigir um incidente aqui (como hoje) já basta,
  sem passo extra de deploy da Function.

### F. E-mail

- Reaproveita o `resendAlert.js` existente (mesma conta Resend, mesmo
  destinatário já configurado) — sem nova integração.
- Conteúdo: o que caiu, quando, o que o agente já fez pra recuperar, o
  diagnóstico da IA, e o fix proposto em texto. Sem link de PR, sem
  ação automática de código — só a análise, como o André pediu.

### Custo (preço real, API `prices.azure.com`, região Brazil South)

| Item | Mensal |
|---|---|
| 2ª VM (Standard_D2s_v3, Linux) | $116,07 |
| Disco da 2ª VM (Premium SSD P15 LRS) | $65,67 |
| VPN Gateway VpnGw1AZ | $153,30 |
| IP público do Gateway (Standard) | $3,65 |
| Load Balancer Standard | ~$20 (base + dado processado) |
| Azure Function (vigilante) | ~$0 (dentro da cota grátis) |
| Chamadas de IA (só em incidente real) | ~$5–15 |
| **Total novo** | **~$365–375/mês** |

Isso é **além** do que já se paga hoje (VM1 + Postgres, sem mudança
neles).

## Plano de rollout (fases)

1. **Preparo**: endpoint `/api/healthz` profundo; eleição de líder
   (advisory lock) implementada e testada; auditoria de todos os jobs
   de fundo listados em Restrições, convertidos pra só rodar no líder;
   base de conhecimento criada e seedada com os incidentes já
   documentados (túnel IPsec, EADDRINUSE/fantasma, contenção de I/O de
   15-16/11).
2. **2ª VM em standby**: provisionada, rodando o mesmo código, líder
   desativado nela (passiva) — validar que funciona contra o mesmo
   Postgres sem concorrer com a 1ª.
3. **VPN Gateway**: provisionar, migrar o túnel da loja Metro (janela
   de baixo risco, já está caído), validar reachability antes de
   desligar o strongSwan da VM.
4. **Load Balancer**: provisionar, health probe no `/healthz`, cortar
   DNS/hostname público pra apontar pro LB em vez da VM direto.
5. **Ativar eleição de líder** nas duas VMs — testar failover do papel
   de líder manualmente (derrubar o processo líder, confirmar que a
   outra assume os jobs em segundos).
6. **Vigilante (Function)**: deploy, integrar Resend + API da Claude,
   rodar em modo "só observa e avisa" por uma semana antes de confiar
   na ação automática de restart.
7. **Teste de carga/falha real**: derrubar uma VM de propósito em
   horário comercial, confirmar zero requisição nova perdida, confirmar
   que job de fundo não duplicou, confirmar que o vigilante recupera o
   nó morto e manda o e-mail certo.

## O que fica pro builder

- Implementação exata da eleição de líder (lock simples vs. tabela de
  heartbeat com TTL — builder decide, advisory lock é a recomendação
  mas não é obrigatório)
- Formato exato da base de conhecimento (recomendo Markdown, um arquivo
  por padrão de incidente, referenciado no prompt da IA)
- Deploy nas 2 VMs sequencial-com-validação vs. paralelo
- Debounce exato do vigilante (quantas falhas seguidas antes de agir)
- Versão exata do runtime da Azure Function (acompanhar a versão de
  Node já usada no `server/`)
- Fix do `useMachines.js` do dashboard (hoje marca "Sem conexão" numa
  única falha de poll, sem retry/debounce) — relacionado, menor, pode
  entrar junto ou logo depois, builder decide o sequenciamento
