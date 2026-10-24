# Acesso Remoto (Normal/Shadow) + Log de Atividade — Design

**Data**: 2026-10-23
**Status**: Aprovado por André, aguardando plano de implementação

## Contexto

André (gerente de TI, Delirio Tropical) quer investigar e comprovar acessos indevidos nas ~224
máquinas do Delirio Manager (ex: funcionário pesquisando vaga de emprego em horário de trabalho),
pra justificar perante a diretoria — não perante a justiça (não precisa rigor de cadeia de
custódia forense). Além disso, quer acesso remoto de verdade (controle total) pras máquinas, pra
suporte de TI.

Pedido original: dois modos de acesso remoto —
1. **Normal**: controle total da máquina, com notificação visível pro usuário local.
2. **Shadow**: visualização sem controle, sem nenhum aviso visível ao usuário local.

Avaliação de risco feita antes de desenhar: equipamento é da empresa, uso legítimo de TI. Risco
real é jurídico/trabalhista (LGPD/CLT) — monitoramento de equipamento corporativo é permitido no
Brasil, mas exige política de monitoramento prévia documentada (fora do escopo deste documento,
recomendação pro André, não trabalho de código). Linha dura mantida no desenho: **nenhuma
ocultação de processo do Gerenciador de Tarefas** — mesmo em Shadow, o processo existe normal no
sistema, só não avisa o usuário. Esconder processo é técnica de rootkit, indistinguível de
malware, e qualquer EDR/AV da rede flagaria isso.

Durante o brainstorm, ficou claro que "screenshot cru" não resolve o caso de uso real (não é
pesquisável). O desenho evoluiu pra 3 camadas complementares:

1. **Log de atividade** (texto, sempre ativo, pesquisável) — resolve "comprovar que a máquina X
   pesquisou vaga no dia Y hora Z" sem precisar abrir sessão ao vivo.
2. **Screenshot sob gatilho de watchlist** (prova visual, só quando bate palavra-chave).
3. **Sessão ao vivo Normal/Shadow** (ver/controlar agora, quando necessário).

## Decisões já fechadas (não reabrir sem motivo novo)

- Shadow = view-only (sem input), sem aviso visual. Normal = controle total + aviso visível.
- Fidelidade de vídeo: stream fluido (~10-15fps) nos dois modos — não screenshot periódico.
- Sem conta/login de usuário por enquanto — log de auditoria registra ator genérico ("admin"), não
  rastreia qual pessoa da equipe de TI abriu a sessão.
- "Bloquear" não é ação automatizada desta feature — a feature só fornece a prova; bloqueio
  (desabilitar conta, etc.) é decisão manual do André fora daqui.
- Sem captura de áudio — só vídeo.
- Gravação da sessão ao vivo é manual (botão ⏺ liga/desliga), nunca automática. Formato final
  **MP4** (conversão local via ffmpeg embutido no Electron, `ffmpeg-static`) + arquivo de
  metadados (`.json`) — ambos baixados no PC do operador.
- Sem timeout automático de sessão — só encerra quando o operador clicar "Encerrar".
- Retenção: log de atividade e screenshots da watchlist, 90 dias (purge automático / lifecycle
  policy do Azure Blob).
- Watchlist de palavras-chave é editável via dashboard (CRUD), não fixa no código.
- Tudo (log de atividade + botões de acesso remoto) fica integrado no card de cada máquina no
  dashboard, não em módulo separado.

## Fora de escopo (explicitamente descartado nesta rodada)

- Sistema de contas/login por pessoa da equipe de TI.
- Ação automatizada de bloqueio (lock de tela, desativar rede, derrubar sessão).
- Áudio do sistema.
- OCR de screenshot (o log de atividade por título de janela já cobre o caso de uso sem precisar
  disso).
- Timeout automático de sessão ao vivo.

## Arquitetura

Hoje o agente (Go, serviço Windows, Session 0) só faz polling HTTP (heartbeat + comandos). Session
0 não enxerga a área de trabalho do usuário logado — nem pra ler título de janela, nem pra
capturar tela. Por isso, tanto o log de atividade quanto a sessão ao vivo precisam de um processo
auxiliar rodando **dentro da sessão do usuário**.

**Um único binário companion**, não dois. O serviço (Session 0) detecta sessão de usuário ativa via
`WTSEnumerateSessions` e lança o companion nela via `WTSQueryUserToken` + `CreateProcessAsUser` —
sem precisar de Tarefa Agendada separada; deploy continua só pelo auto-update existente do agente.

```
[Companion.exe, sessão do usuário]
   │ modo leve (sempre ligado): título de janela + processo a cada 3-5s
   │ modo sessão ao vivo (sob demanda): captura DXGI + WebSocket direto com o servidor
   ▼
[Agente Go, Session 0] ──polling HTTP (como hoje)──► [Servidor Node.js, Azure VM]
                                                              │
                                              WS relay (sessão ao vivo) ──► [Dashboard Electron]
```

Companion aparece normal no Gerenciador de Tarefas (`DelirioAgentHelper.exe`) — nenhuma ocultação.

### Camada 1 — Log de atividade

- Companion reporta a cada 3-5s: janela em foco + nome do processo (+ título da aba, via UI
  Automation, melhor esforço, se for Chrome/Edge).
- Agente despacha pro servidor via endpoint leve próprio (não empilha no heartbeat existente).
- Tabela nova `activity_log` (machine_id, window_title, process_name, captured_at) — texto puro,
  pesquisável via SQL (`LIKE`).
- Dashboard traduz pra linguagem comum: mapeia processo conhecido pra nome amigável (`chrome.exe` →
  "Google Chrome") e mostra o título da janela ao lado, não dado técnico cru.
- Retenção: 90 dias, purge automático.

### Camada 2 — Screenshot sob gatilho de watchlist

- Tabela nova `watchlist_keywords` (keyword, ativo, criado_em) — CRUD no dashboard.
- Servidor confere cada entrada nova do log de atividade contra as keywords ativas (substring,
  case-insensitive — sem regex, YAGNI).
- Em caso de match: servidor manda comando "capturar 1 frame agora" pro agente (reusa a fila de
  comando existente, não precisa do canal de streaming da sessão ao vivo) → companion tira 1 print
  via DXGI → sobe por HTTP (mesmo padrão de upload de resultado de comando que já existe hoje).
- Armazenamento: **Azure Blob Storage** (nunca SQLite — WAL de 275GB já ensinou essa lição, ver
  incidente 2026-08-14 em `project_delirio_manager.md`). Metadado (machine_id, keyword batida,
  blob path, captured_at) linkado à linha do `activity_log` que disparou.
- Dashboard mostra miniatura ao lado da linha do log; clique abre a imagem cheia.
- Retenção: 90 dias via lifecycle policy nativa do Azure Blob.

### Camada 3 — Sessão ao vivo (Normal/Shadow)

**Início**: botão no card do dashboard (👁 Shadow / 🖥 Normal) → `POST /api/live/:machineId/start
{mode}` → servidor cria registro de sessão + token curto de autenticação do companion → avisa o
agente via fila de comando existente → agente diz ao companion (named pipe local) pra abrir
WebSocket direto com o servidor e começar captura em alta frequência.

**Stream**: dashboard conecta no relay WS do servidor pra aquele `sessionId`, recebe frames JPEG
(~10-15fps) renderizados num `<canvas>`.

**Normal**: canvas captura mouse/teclado do operador → evento de input via WS → servidor confere
`mode == 'normal'` antes de repassar pro companion, que injeta via `SendInput`. Companion também
sobe um **overlay/banner visível** na tela da máquina ("Acesso remoto ativo — TI Delirio") enquanto
a sessão Normal está aberta.

**Shadow**: companion captura igual (mesmo pipeline de vídeo), mas nenhum overlay é mostrado, e o
servidor **nunca repassa nenhuma mensagem de input** pra sessões Shadow — bloqueio no relay do
servidor, não só na UI do dashboard (defesa em profundidade: mesmo que o dashboard mande input por
engano/bug, o servidor descarta).

**Gravação** (manual, botão ⏺): `canvas.captureStream()` + `MediaRecorder` nativo do Electron
grava em WebM internamente; ao parar, conversão local via `ffmpeg-static` embutido produz o
`.mp4` final + arquivo `.json` de metadados (máquina, modo, início, fim, duração) — ambos
oferecidos pra download no PC do operador. Acrescenta ~50-80MB ao instalador do dashboard.

**Fim da sessão**: botão "Encerrar sessão" → servidor avisa companion, fecha WS, remove overlay na
hora (se Normal).

Tabela nova `live_sessions` (machine_id, mode, started_at, ended_at, recorded).

## Segurança / autorização

- Sem conta de usuário — ação autenticada pelo `X-Admin-Secret` existente; log de auditoria
  registra ator genérico.
- Companion só aceita conexão de sessão ao vivo com o token de vida curta emitido pelo servidor no
  momento do `start` — evita qualquer parte abrir canal direto pro companion.
- Nenhuma ocultação de processo (constraint fixa, ver Contexto).
- Recomendação (fora do código): política de monitoramento escrita, alinhada com LGPD/CLT, antes
  de usar Shadow numa investigação real.

## Testes

- **Servidor**: match de watchlist, ciclo de vida da sessão (start/stop/emissão de token), e
  **obrigatório**: teste de que sessão Shadow nunca repassa input, mesmo que o dashboard mande.
- **Agente/companion (Go)**: captura de janela em foco atrás de interface mockável (testável);
  DXGI/SendInput só testável manualmente (API do Windows não é unit-testável de verdade).
- **Dashboard**: viewer de sessão ao vivo, toggle de gravação, CRUD da watchlist, tradução de
  processo pra nome amigável.

## Riscos / pontos em aberto pra validar na implementação

- Overhead de banda do stream (~10-15fps JPEG) nas lojas atrás de VPN/pfSense mais lenta — validar
  com teste real numa loja antes de rodar nas 10 localidades.
- Volume do `activity_log` em escala (224 máquinas × relatório a cada poucos segundos) — confirmar
  que não repete o padrão de "dado repetido explode custo" já visto no `insightEngine.js`
  (ver `project_delirio_manager.md`, auditoria 2026-10-06).
- Companion precisa sobreviver a troca de sessão (logoff/logon, fast user switching) sem travar o
  serviço principal — mesmo cuidado que outras features desse agente já tiveram com estado de
  sessão do Windows.
