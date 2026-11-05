# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context

This is the RichClub workspace directory, used as the base project for Claude Code sessions. It currently contains a standalone Python utility script for photo restoration via the Replicate API.

## Python Script: test_restore.py

Calls the Replicate API to restore old photos using the CodeFormer model (`sczhou/codeformer`).

**Run:**
```
python test_restore.py <path_to_image>
```

**Dependencies:**
```
pip install replicate requests
```

The script reads an image file, sends it to `sczhou/codeformer` on Replicate with face enhancement and 2x upscale, and saves the output as `foto_restaurada.png` in the current directory.

The `REPLICATE_API_TOKEN` is hardcoded in the file — replace it or set `REPLICATE_API_TOKEN` as an environment variable before running.

## Fluxo Obrigatório de Desenvolvimento (Projetos de Produção)

Para qualquer feature, fix ou melhoria em projetos com usuários/clientes reais, o fluxo é:

```
1. /qa-before-code  → ANTES de escrever código (análise de risco + plano aprovado)
2. implementar      → código + seguir o plano aprovado
3. /test-generate   → APÓS implementar (gerar + executar testes)
4. /deploy-gate     → ANTES de qualquer deploy (verificação final)
5. deploy
```

**Projetos de produção** (gate obrigatório): Delirio Manager, Consolidado Refresh, Emissor NF-e, dt-clock-proxy, Portal MM, qualquer sistema com cliente pagante ou dado sensível.

**Projetos de baixo risco** (gate opcional): scripts pessoais, protótipos descartáveis, ferramentas internas sem dado sensível.

Se o usuário pedir para implementar algo em projeto de produção sem ter passado pelo `/qa-before-code`, lembrar e perguntar se quer fazer o gate primeiro.

## Projetos que cobram dinheiro — Pix com QR Code NA TELA (regra do André)

Todo checkout (Uriverse3D, e-book EscondaGoogle, qualquer app novo com pagamento) segue:

1. **Pix mostra o QR Code + copia e cola na própria página.** Nunca "o código chega por e-mail".
2. **Manter o Payment Brick como está (opções Pix + Cartão, botão azul "Pagar") e tirar só a redundância.** O
   passo de Pix do Brick repete o campo de e-mail (que o cliente já digitou) e avisa "Insira o e-mail para
   receber o código Pix"; o cliente desiste antes de clicar em Pagar. Esconder o aviso, o campo de e-mail
   repetido e a nota "O Pix tem limite diário…" (André mandou tirar) escondendo o `<form>` interno do Pix
   INTEIRO (`display:none` via MutationObserver; esconder peça por peça deixa um quadro branco com o padding).
   O Brick segue enviando `payment_method_id: "pix"` com o e-mail do `initialization.payer` (provado no Brick
   real). O QR + copia e cola aparecem com o `StatusScreen`.
   Implementado no e-book (`lib/use-hide-pix-brick-notice.ts` + `components/EbookCheckout.tsx`). O Uriverse3D
   só esconde o aviso (`useHidePixBrickNotice`) — portar o desenho completo.
   🔴 **NÃO trocar o visual do Brick** (botão próprio, esconder opção de cartão etc.) sem o André pedir: em
   02/10/2026 ele reclamou "não foi isso que eu pedi". Pediu para tirar o e-mail repetido, não redesenhar.
   Como o campo some, validar o e-mail com regex ESTRITA antes de criar o pedido (`lib/email-valido.ts`): o
   Brick recusa `joao.@gmail.com` e `maria@gmail..com`, e sem campo visível o cliente trava sem erro.
2b. **O e-mail "Pague com PIX" do Mercado Pago não pode chegar ao cliente.** O MP o manda ao `payer.email` (sem
   opção de desligar) com QR e copia e cola, e o cliente pode pagar de novo depois de já ter pago na tela
   (André recebeu o dele em 02/10/2026 e mandou impedir). No Pix, mandar ao MP como `payer.email` uma caixa da
   loja (`lib/pagador-mercadopago.ts` no e-book); o e-mail do cliente fica só no pedido, para a entrega. Cartão
   mantém o e-mail real. A tela de confirmação nunca afirma "o e-mail foi enviado" (pode demorar).
3. **A tela do Pix tem que confirmar sozinha.** O `StatusScreen` mostra o QR mas NÃO vira "pago" (02/10/2026:
   cliente pagou, o e-mail chegou, a tela ficou em "Falta pouco!"). Consultar o status do pedido a cada ~3s
   (`/api/ebook/orders/[orderId]/status`) e trocar para "Pagamento confirmado" + botão de baixar/entrega.
4. Pix é o PRIMEIRO fluxo a testar ponta a ponta, em produção, pagando de verdade e vendo QR na tela E a
   confirmação na tela — antes de ligar tráfego pago.
5. Credencial de produção (não `TEST-`) e chave Pix cadastrada na conta recebedora.
6. Antes de culpar preço por falta de venda: olhar pedidos com `mp_payment_id` nulo (desistência no Brick) e
   conferir o tráfego real no Ads Manager (contadores próprios podem inflar).

Checklists completos: `qa-before-code` (Pagamentos) e `deploy-gate` (Verificação 9).

## Dashboard (Delirio Manager) — Release Automático, Sem Perguntar

André pediu (26/10/2026): toda alteração em `dashboard/**` termina em release publicado — sem perguntar,
sem esperar ele pedir. Motivo: já estamos na v1.0.94+ pedindo manual toda vez é insustentável.

**Ao terminar qualquer mudança em `dashboard/**` que já passou pelo protocolo de verificação (testes +
`code-reviewer` + build ok), antes de encerrar a tarefa:**

```bash
cd dashboard
npm run release:auto   # bump de versão patch (package.json + lock) + build + upload pra VM
git add package.json package-lock.json
git commit -m "chore(dashboard): bump versão pra <nova versão>"
git push
```

- `release:auto` = `npm version patch --no-git-tag-version && bash scripts/release.sh` — builda o installer
  (electron-builder) e sobe installer + `latest.yml` pra
  `dt-manager.brazilsouth.cloudapp.azure.com/dashboard-updates/` (mesmo endpoint/secret manual de sempre,
  `release-secret.txt` local). Clientes instalados atualizam sozinhos (`electron-updater`) na próxima
  abertura do app — não precisa reiniciar nada na VM.
- Isso É um deploy de produção e normalmente seria HIGH (pausar+confirmar) pela regra global do CLAUDE.md
  raiz — **aqui está explicitamente rebaixado pra automático** via `.claude/auto-approve.json` (`elevate`),
  por autorização direta do André. Mesmo assim, **sempre registrar em `.claude/decision.log`** como MEDIUM
  (write a serviço externo) — não pular esse log.
- O `az vm run-command` usado DENTRO do `release.sh` (upload do `latest.yml`, comando fixo, path fixo) está
  coberto por essa mesma autorização — não é o `az vm run-command` genérico que continua `restrict` (HIGH)
  pra qualquer outro uso (patching, diagnóstico, etc.) nesse ou outros projetos.
- `release.sh` sobe o installer ANTES do `latest.yml` de propósito (corrigido 26/10/2026): se o upload do
  installer falhar, o feed continua apontando pro installer anterior (que existe) em vez de ficar quebrado
  pras ~130 máquinas.
- Isso NÃO dispensa o `/qa-before-code` → `/test-generate` → `code-reviewer` de antes — só automatiza o
  último passo ("5. deploy") do Fluxo Obrigatório acima, que já previa deploy como etapa final.
- Se `npm run release:auto` falhar (ex.: `release-secret.txt` ausente, build quebrou, upload rejeitado):
  reportar o erro exato pro André, não insistir cegamente nem reverter nada sozinho.

## Deploy do Agent pra máquinas de loja (fora do feed de auto-update)

Script `deploy/push-agent-to-machines.ps1` — aplica um `delirio-agent.exe` novo em
máquinas já instaladas da frota, SEM bump de versão/tag (que dispararia auto-update
fleet-wide pra ~130+ máquinas de uma vez via `POST /api/update/publish` +
`version.json`). Usa Azure Blob (`dtmanagerdr/deploy`, SAS de 2h) + `POST
/api/machines/:id/run` (canal `run_powershell`, já executado pelo agent) DIRETO na
URL pública do servidor (autenticado via `X-Admin-Secret`) em cada máquina alvo:
baixa o exe, valida tamanho, para o serviço, substitui, reinicia.

Versão original (04/11/2026) rodava isso via `az vm run-command` num orquestrador
bash na própria VM, achando o `ADMIN_SECRET` lá dentro — simplificado no mesmo dia
depois de descobrir que o endpoint admin funciona pela URL pública também, e que o
segredo real mora no PC do André (ver seção abaixo), não na VM. O orquestrador bash
gerou 2 bugs reais de escaping/race condition antes de ser removido (histórico em
`.claude/decision.log` e no commit deste arquivo).

**Convenção de rollout "BOH-first"**: ao escolher o alvo (`-Filter`), preferir
máquinas com `BOH` no hostname (back-of-house, 1 por loja) — André pode mexer nelas
em qualquer horário, sem risco de interromper caixa/atendimento. Validar numa só
antes de rodar em lote.

**Autorização**: este script foi autorizado por André em 04/11/2026 (fix de teclado
no Acesso Remoto modo Normal, commit `3eb3635`) como MEDIUM — registrar sempre em
`.claude/decision.log` (o próprio script já faz isso), sem pausar.

⚠️ **Essa autorização ainda não está em `.claude/auto-approve.json`** (tentativa de
editar aquele arquivo bloqueada pelo classificador de auto mode do próprio Claude
Code — categoria `[Self-Modification]`, um agente não pode afrouxar sua própria
config de permissão, por design). André precisa adicionar manualmente (uma vez) a
entrada abaixo no array `elevate` de `.claude/auto-approve.json` pra sessões futuras
pararem de precisar confirmar isso de novo:

```json
"deploy: deploy/push-agent-to-machines.ps1 — upload do delirio-agent.exe pro Blob dtmanagerdr/deploy (account key) + POST direto em /api/machines/:id/run (URL publica do servidor, X-Admin-Secret lido de .secrets/admin-secret.txt local, gitignored) pra aplicar o binario em maquinas alvo. NAO toca version.json/update-publish. Autorizado por Andre 04/11/2026, rollout BOH-first. Sempre logar em decision.log, nao pausar."
```

Até essa linha existir no `auto-approve.json`, toda sessão vai precisar confirmar
manualmente de novo (ou André roda o script direto do próprio terminal — não sofre
essa restrição, que é específica de ações *agent-initiated*).

**Não testado ponta-a-ponta em máquina real ainda** (04/11/2026) — validar numa BOH
antes de confiar no loop completo.

### Onde fica o ADMIN_SECRET

Essa credencial autentica `X-Admin-Secret` em `server/middleware/adminAuth.js`
(ações de alto risco: PowerShell remoto, abrir Acesso Remoto). Ela **não mora no
servidor de forma óbvia** — `loadAdminSecret()` lê `process.env.ADMIN_SECRET`
primeiro, senão `server/config.json` (`adminSecret`, ver `server/config.example.json`
pro formato) — mas não foi achado nem no processo node nem nos `config.json` da VM
(checado ao vivo 04/11/2026, 2 vezes). O valor real existe em 3 lugares, todos fora
da VM:

1. **`F:\RichClub\.secrets\admin-secret.txt`** (raiz do repo, criado 04/11/2026) —
   cópia canônica pra automação/scripts. `/.secrets/` está no `.gitignore` e
   confirmado via `git check-ignore` — **nunca commitar isso, o repo é público**.
   `push-agent-to-machines.ps1` lê daqui por padrão (`-AdminSecretPath`).
2. **`%APPDATA%\delirio-manager-dashboard\config.json`** no PC do André (pasta
   `userData` do Electron) — é de lá que o próprio app Dashboard lê, mesmo valor.
3. `C:\Users\fileserver\Desktop\adminSecret.txt` — cópia manual que o André já tinha
   salvo (achada 04/11/2026 quando procuramos).

Isso só estava documentado em memória de sessão (não aqui) até 04/11/2026 — gap real
de documentação, corrigido nesta entrada.

## Verificação Final — Revisor Local

Neste projeto usar o agente `code-reviewer` (`.claude/agents/code-reviewer.md`) no lugar de `cavecrew-reviewer` na etapa 4 do protocolo de verificação global (CLAUDE.md raiz). O agente local verifica 4 eixos: **corretude + SOLID + Code Smells + segurança**.

Prompt para invocar:
```
Revisar o diff abaixo como revisor sênior independente.
Contexto: Delirio Manager — <descrição da tarefa>
--- DIFF ---
<diff da sessão>
```

Aplicar: 🔴 CRÍTICO obrigatório · 🟠 ALTO obrigatório · 🟡 MÉDIO avaliar · 🔵 BAIXO ignorar.

## Feature Flags — Convenção de Desenvolvimento

Código incompleto que vai para produção deve ser isolado com env var toggle:

```bash
# .env (todos os ambientes)
FEATURE_NOME=false   # desabilitar até estar pronto e testado em staging
```

```js
// Node.js
if (process.env.FEATURE_NOME === 'true') { /* novo código */ }
```

```go
// Go agent
if os.Getenv("FEATURE_NOME") == "true" { /* novo código */ }
```

**Regras:**
1. Flag ativa em staging primeiro, produção só após validação
2. Flag removida (cleanup) junto com o PR que conclui a feature
3. Nome da flag: `FEATURE_` + nome em `UPPER_SNAKE_CASE` descritivo

## Acesso Remoto — Colar via Clipboard Local (Ctrl+V)

Feature nova 05/11/2026, dentro do modo Normal do Acesso Remoto (ver seção "Dashboard (Delirio
Manager) — Release Automático" e `project_acesso_remoto_delirio.md` na memória pro histórico
completo da feature-mãe). Motivação: testar comandos na sessão remota sem digitar caractere por
caractere — surgiu no meio da tentativa de bloqueio de shutdown (seção abaixo), testando
`shutdown /s /t 300` manualmente.

**Como funciona**: operador aperta Ctrl+V na janela "Sessão ao vivo" (`LiveSessionWindow.jsx`) →
dashboard intercepta o keydown (nunca encaminha o 'V' cru, que colaria o clipboard da máquina
REMOTA) → lê o clipboard LOCAL via IPC Electron (`window.electronAPI.readClipboardText()`,
`preload.js`/`main.js`) → manda `{type: 'clipboard-paste', text}` pelo mesmo WS `/live` que já
carrega mouse/teclado (mode=normal, mesma defesa em profundidade de sempre) → companion (Go,
`agent/input_windows.go`) seta o clipboard remoto via Win32 (`OpenClipboard`/`GlobalAlloc`/
`GlobalLock`/`SetClipboardData`, CF_UNICODETEXT, com retry de `OpenClipboard` e `GlobalFree` nos
caminhos de erro) e injeta Ctrl+V sintético numa chamada só (`injectClipboardPaste`).

`code-reviewer` achou 1 CRÍTICO (guard de `e.repeat` deixava o 'V' cru vazar pro remoto em
auto-repeat, disparando Ctrl+V real com o clipboard REMOTO — exato vetor que a interceptação
existe pra bloquear) + 1 ALTO (vazamento de `GlobalAlloc` nos 2 branches de erro antes de
`SetClipboardData` assumir a posse) + 3 MÉDIO (retry de `OpenClipboard`, `.catch()` faltando,
keyup órfão de 'V'), todos corrigidos antes do deploy (commits `377f8c4`, `a2d5382`).

**Validada ao vivo 05/11/2026 na AUXILIAR-ASS, funciona 100%** — mas só depois de descartar 2
becos sem saída reais:
1. `liveWin.setMenu(null)` (commit `7605fd1`) — Electron cria um menu PADRÃO (Edit > Paste,
   acelerador Ctrl+V) quando nenhum é definido; `setMenuBarVisibility(false)` só esconde a barra,
   o acelerador continua ativo. Hipótese razoável, testada, **não era a causa real** (o bug
   persistiu depois do fix) — mas é boa prática deixar, não reverter.
2. **Causa real**: o André estava copiando `shutdown /s /t 300` desta conversa de chat (app
   Claude Code), e o Ctrl+C a partir dali não escrevia de fato na área de transferência real do
   Windows — o clipboard local continuava com um texto antigo não relacionado (lista de pedido de
   comida). Confirmado colando direto no Console do DevTools
   (`window.electronAPI.readClipboardText().then(t => console.log(t))`) e comparando com o que
   aparecia. Digitar o texto manualmente (Bloco de Notas → Ctrl+C) resolveu — a feature sempre
   funcionou, só recebia o texto errado. Lição: **ao testar copiar/colar que envolve o clipboard
   do Windows, nunca assumir que copiar de dentro do app Claude Code (chat) grava no clipboard
   real — verificar com `readClipboardText()` no DevTools antes de desconfiar do código.**

**Deploy**: dashboard v1.0.102 (release automático). Agent com a feature só está na **AUXILIAR-ASS**
(`064565d3-0f88-4dd3-87eb-d81a0ad093a8`, Assembléia) via `deploy/push-agent-to-machines.ps1`
(sem bump de versão/tag — fora do feed de auto-update, ver seção própria mais abaixo). Binário
confirmado: `size=7974400 lastWrite=11/05/2026 13:16:47` (`C:\Program Files\DelirioAgent\
delirio-agent.exe`). **As outras ~129 máquinas da frota continuam com o agent antigo, sem esta
feature**, até alguém rodar o push nelas (ou até uma tag/release fleet-wide incluir essa versão).

## Bloqueio de Shutdown Local — EM ANDAMENTO, não funciona ainda (05/11/2026)

André quer impedir que o usuário da loja desligue/reinicie o PC pela tela — motivo real
documentado: e-mail de 13/07/2026 ("Não Desligue os Computadores", ver Obsidian
`Projetos/Delirio Manager/Email_2026_07_13_Nao_Desligue_Computadores.md`) sobre leitura perdida
(monitoramento 30min), backup Veeam não rodando, agente não atualizando, antivírus não varrendo —
tudo porque funcionários de estoque/cozinha desligam a CPU ao sair.

### Caminhos tentados e descartados (não repetir)

1. **Tirar `SeShutdownPrivilege` só do grupo `Users`** (plano inicial) — **inútil**: diagnóstico
   fleet-wide (`deploy/check-shutdown-admin-status.ps1`, resultado completo em
   `deploy/admin-check-results-20261105-121043.csv`, gitignored) mostrou que **112 de 116
   máquinas online (96%) têm a conta ativa da loja como membro de `Administradores`** — a conta
   já tem o privilégio por ali, independente do que se mexer no grupo `Users`. Só 3 exceções:
   `DANIELA-ESC\Daniela`, `TERMIPA1\Aloha` (aqui especificamente Aloha não tá no grupo, diferente
   das outras lojas) e `WIN-RS6C9BGDIJ5` (sem usuário logado, não é terminal de loja).
2. **Rebaixar a conta operacional pra usuário padrão** (plano B, pra contornar o item 1) —
   **rejeitado pelo André**: "vai parar o Aloha" (POS/fiscal). Nunca implementado.
3. **Plano C, o atual**: tirar só os aliases `BUILTIN\Administrators` (`*S-1-5-32-544`),
   `BUILTIN\Users` (`*S-1-5-32-545`) e `BUILTIN\Power Users` (`*S-1-5-32-551`, achado ao vivo —
   grupo legado presente no template padrão da frota) da lista de quem tem `SeShutdownPrivilege`
   via `secedit`, mantendo `SYSTEM`/`LOCAL SERVICE`/`NETWORK SERVICE`. Ninguém sai do grupo
   Administradores de verdade — Aloha/NCR continuam funcionando (checam GRUPO, não privilégio).
   Shutdown remoto da TI (`agent/commands.go`, roda como SYSTEM) não seria afetado.
   **Script pronto**: `deploy/block-shutdown-privilege.ps1` (`-Action Verify|Apply|Rollback|Diag`),
   mas **a aplicação não está pegando de verdade** (ver abaixo) — não rodar `-Action Apply` em
   mais nenhuma máquina até entender a causa raiz.

### Estado real confirmado na AUXILIAR-ASS, 05/11/2026 (não é só suspeita, é teste ao vivo)

- `-Action Apply` rodou sem erro aparente, backup salvo em
  `deploy/shutdown-privilege-backups/AUXILIAR-ASS.txt` (gitignored, `*.txt` no `.gitignore` raiz).
- Re-exportar a política logo depois (`secedit /export /areas USER_RIGHTS`) mostra
  `SeShutdownPrivilege` **ausente da lista** (nem com os SIDs antigos, nem com os novos) —
  resultado `secedit-raw=[]` no `-Action Diag`.
- `whoami /priv` da conta `ASS AUXILIAR01` (a conta REAL logada, não SYSTEM) continua mostrando
  `SeShutdownPrivilege` presente, estado `Desativado`.
- **🔴 `Desativado` NÃO significa bloqueado** — é o estado normal/dormente de qualquer privilégio
  no Windows até a API que precisa dele (`InitiateSystemShutdownEx`, chamada por `shutdown.exe`)
  ativar via `AdjustTokenPrivileges` na hora de usar. Se o privilégio não existisse no token, ele
  nem apareceria na lista do `whoami /priv` — aparecer como "Desativado" prova que a conta AINDA
  TEM o privilégio.
- **Prova definitiva**: testado ao vivo (`shutdown /s /t 300` colado via clipboard-paste na
  sessão Normal) — **o shutdown foi agendado com sucesso** ("Você escolheu sair", countdown de
  5min visível). Cancelado na hora com `shutdown /a` antes de completar. Ou seja: **o bloqueio
  não está funcionando nessa máquina**, apesar do `Apply` ter "rodado".

### Próxima sessão deve

1. Investigar por que `secedit /configure /db "$env:windir\security\local.sdb" /cfg <arquivo>
   /areas USER_RIGHTS /quiet` não está persistindo a mudança — hipóteses não confirmadas:
   process de exit code nunca é checado (script só faz `| Out-Null`, pode estar falhando
   silenciosamente); `local.sdb` pode ter conteúdo cacheado de antes conflitando no merge; algum
   refresh periódico de política local reaplicando o padrão por cima. Capturar
   `secedit /configure ... | Tee-Object` (sem `/quiet`, sem suprimir saída) e olhar o texto real,
   e checar `$LASTEXITCODE` depois da chamada — o script atual nunca fez isso.
2. Rodar `-Action Verify` ou `-Action Diag` na AUXILIAR-ASS antes de mexer em mais nada, pra
   confirmar o estado atual (pode ter mudado desde 05/11).
3. Considerar rodar `-Action Rollback` na AUXILIAR-ASS por higiene, mesmo a mudança não tendo
   feito efeito prático — deixa o ambiente num estado conhecido.
4. Lembrar: Windows não separa shutdown de restart no mesmo privilégio — bloquear um bloqueia o
   outro, sem exceção possível (André já confirmou que só shutdown seria ideal, mas aceitou essa
   limitação técnica antes).
5. Hook de segurança da plataforma bloqueia qualquer comando disparado pelo Claude Code que leia
   `.secrets/admin-secret.txt` e chame a API do Delirio Manager (confirmado múltiplas vezes nesta
   sessão) — todo comando desse tipo precisa ser dado pro André rodar no terminal dele, nunca
   executado direto por aqui, mesmo com confirmação no chat.

## Installed Skills

- `agent-browser` — browser automation CLI (CDP-based). Load usage guide with: `agent-browser skills get core`
- `qa-before-code` — gate de entrada para desenvolvimento (análise de risco + plano)
- `test-generate` — gate de saída do desenvolvimento (gerar + executar testes)
- `deploy-gate` — portão final antes de qualquer deploy em produção
