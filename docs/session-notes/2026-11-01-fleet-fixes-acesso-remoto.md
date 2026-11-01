# Sessão 2026-11-01 — Teste fleet-wide (113 máquinas) + 3 fixes de produção no Acesso Remoto

Projeto: [[project_acesso_remoto_delirio]]

## O que foi feito

- André reportou Daniela-Esc e depois várias outras máquinas "não conectam" no Acesso Remoto, e
  pediu teste da frota inteira de madrugada (ninguém usando): "não pare até que todas estejam
  acessíveis".
- **Fix 1 — v1.8.1** (commit `0aad95d3`): `sessionWatchTick` só lançava o companion com sessão
  `WTS_ACTIVE` — sessão `Disconnected` (tela/energia desligou sem logoff) era tratada igual a
  "ninguém logado", companion nunca relançava. Reproduzido ao vivo em Daniela-Esc e Bruno
  (`query user` mostrou `STATE=Disco`, idle 11-13h). `tscon <id> /dest:console` resolveu na hora
  manualmente — virou fix automático (`pickReconnectableSession` + `reconnectSessionToConsole`),
  com restrição deliberada pra nunca puxar sessão RDP abandonada (`WinStationName` não-vazio) pro
  console físico da loja.
- **Fix 2 — v1.8.2** (commit `59d283b4`): causa raiz real do "`gerente` com 504 mesmo com
  heartbeat ok" (sinalizado desde 26/10, nunca investigado). `commandLoop` (goroutine única, sem
  timeout em volta de nada) travava pra sempre se um handler nunca retornasse — achado:
  `handleDRSetup→installVeeam` roda o instalador do Veeam sem nenhum `context`/timeout.
  `runCommandWithDeadline` (5min) abandona o comando e segue pro próximo poll. `code-reviewer`
  achou 3 CRÍTICO + 2 ALTO reais: clientes HTTP perdendo `Proxy`/defaults do ambiente, race real em
  `drStatusCache` + 2 instalações concorrentes possíveis do Veeam, timeout do dial primário
  competindo com o fallback de DNS pelo mesmo budget, processo do instalador ficando órfão sem
  `exec.CommandContext`. Todos corrigidos antes de publicar.
- **Fix 3 — v1.8.2** (mesmo commit): DNS local da loja podia falhar sem o agente se recuperar.
  André apontou o ponto certo ao ver o diagnóstico da Kione-Esc: "quando instala o AnyDesk funciona
  na hora, independente do roteador — não podemos ficar dependendo de PowerShell". Confirmado ao
  vivo (`nslookup` do André + EC pfSense): DNS local (`route17.delirio.local`) às vezes não resolve
  o hostname do servidor, mesmo com a rede geral saudável. `resilient_dns.go` (novo):
  `resilientDialContext` tenta o DNS do sistema primeiro, com cap de 3s pra sobrar tempo real pro
  fallback (8.8.8.8/1.1.1.1) dentro do mesmo timeout do cliente — só ativa pra erro de DNS de
  verdade (`*net.DNSError`), nunca pra timeout comum de TCP. Plugado no heartbeat, polling de
  comando, WebSocket de live-session e `http.DefaultTransport` global. Kione-Esc confirmada
  funcionando depois de atualizar.
- **Fix pontual — Gerente-Plaza**: `start-live-session` retornava `FEATURE_LIVE_ACCESS
  desabilitada neste agente` — máquina ficou de fora do rollout gradual de 26/10 (provavelmente
  offline no momento) e nenhuma passada posterior pegou ela. Corrigido na hora via
  `run_powershell` (editar `config.json` + `Restart-Service`), confirmado
  `featureLiveAccess=True serviceStatus=Running`.
- Diagnóstico fleet-wide: script Python (não um round-trip manual por máquina) checou sessão
  Windows + `companion.log` + config em 113 máquinas online em paralelo (10 workers) — achou os
  padrões acima sem precisar testar uma por uma manualmente.

## Decisões tomadas

- Cada causa de "não conecta" é investigada e corrigida individualmente, nunca assumida igual às
  anteriores — 4 máquinas reportadas (Daniela-Esc/Bruno, Kione-Esc, Gerente, Gerente-Plaza) tinham
  4 causas DIFERENTES (sessão Disconnected, DNS local, commandLoop morto, feature flag faltando).
- Repassei de memória (sessão de 29/10) que a Kione-Esc tinha problema de DNS sem reverificar ao
  vivo primeiro — André cobrou corretamente ("tem algo de errado na sua análise"). Por sorte o
  achado se confirmou depois com evidência fresca, mas o processo estava errado independente do
  resultado — lição registrada em
  [[feedback_memoria_desatualizada_precisa_reverificar]].
- Tentando diagnosticar via login no EC pfSense (mesma rede da Kione-Esc, credenciais documentadas
  no projeto), um hook de segurança do app bloqueou a ação mesmo após confirmação explícita do
  André no chat — porque o hook não tem acesso ao histórico da conversa. Identifiquei isso
  inspecionando os hooks reais do projeto (nenhum dos dois reagia a pfSense) em vez de insistir
  tentando bypass — lição registrada em [[feedback_hook_seguranca_nao_ve_chat]].
- Todos os fixes de código passaram por `code-reviewer` antes de commit/tag — 2 rodadas, achados
  reais corrigidos em ambas (não cosmético).

## Próximos passos

- 🔴 **Crítico**: `gerente` (Metropolitano) e Nutricionista têm `commandLoop` genuinamente morto —
  nenhum comando é sequer entregue ao agente (`sent_at:null` pra sempre), mesmo depois de
  atualizarem sozinhas pra v1.8.2 via heartbeat (prova que não é a classe de bug que o fix de hoje
  cobre). Hipótese não confirmada: goroutine `commandLoop` lançada sem `recover` (diferente de
  `sessionWatchLoop`), panic determinístico no boot causando crash-loop rápido o bastante pra
  heartbeat continuar saudável. André vai reiniciar o serviço `DelirioAgent` fisicamente nas duas
  em 02/11/2026 — próxima sessão confirma se resolve e tenta capturar `agent.log` real se
  acontecer de novo.
- Rodar varredura fleet-wide de `featureLiveAccess==false` nas máquinas online — o rollout de
  26/10 não é mais garantidamente 100% (Gerente-Plaza prova que não).
- Achados menores não corrigidos ainda (baixa prioridade): Bruno teve `SendInput: Acesso negado`
  transitório logo após reconexão via `tscon`, resolveu sozinho; GAVEABOH loga
  `BlockInput(false) falhou` mas a chamada na verdade funciona (mesmo padrão de `GetLastError`
  obsoleto do bug GDI antigo) — cosmético, só log.
- Limpar os `delirio-update-*` órfãos da TermIpa5 (pendência antiga, não tocada nesta sessão).
