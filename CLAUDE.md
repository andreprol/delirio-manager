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

## Installed Skills

- `agent-browser` — browser automation CLI (CDP-based). Load usage guide with: `agent-browser skills get core`
- `qa-before-code` — gate de entrada para desenvolvimento (análise de risco + plano)
- `test-generate` — gate de saída do desenvolvimento (gerar + executar testes)
- `deploy-gate` — portão final antes de qualquer deploy em produção
