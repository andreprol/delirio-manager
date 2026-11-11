# Acesso Remoto — Tecla Windows + Transferência de Arquivo — Design

**Data**: 2026-11-11
**Status**: Aprovado por André, aguardando plano de implementação

## Contexto

Duas melhorias pedidas por André pra feature de Acesso Remoto (Normal/Shadow), independentes entre
si mas trabalhadas na mesma sessão: (1) liberar a tecla Windows na sessão remota, hoje bloqueada de
propósito; (2) transferir arquivos do PC do operador pra máquina sendo acessada.

Ver [[project_acesso_remoto_delirio]] (memória) pro histórico completo da feature-mãe.

## Feature 1 — Liberar a tecla Windows

### Contexto do bloqueio atual

Em 04/11/2026, `LiveSessionWindow.jsx` passou a **nunca repassar** `keyCode` 91/92 (VK_LWIN/
VK_RWIN) — achado ao vivo que a tecla Windows abre o Menu Iniciar da máquina remota e rouba o foco
da janela do Dashboard ANTES do `keyup` disparar, deixando a tecla logicamente "pressionada" pra
sempre na máquina remota (toda tecla seguinte virava atalho). Na mesma correção entraram 2 redes de
segurança que cobrem QUALQUER tecla, não só Win:
1. `heldKeysRef` (Set) rastreia teclas pressionadas do ponto de vista da janela; solta tudo
   automaticamente em `blur`, `visibilitychange`, troca de modo ou desmontagem.
2. Botão manual "⌨️ Liberar teclas travadas" — manda `keyup` fixo pra Win/Ctrl/Alt/Shift.

### Decisão

Remover o filtro que descarta 91/92 antes de mandar pro WS. As duas redes de segurança já
existentes passam a cobrir a tecla Windows também (antes, elas existiam mas a tecla nunca chegava
a ser enviada). Nenhuma mudança em agent nem servidor — o `SendInput`/`KEYBDINPUT` de
`input_windows.go` já trata keyCode 91/92 como qualquer outra tecla desde o fix de 04/11 (só o
dashboard filtrava antes de mandar).

### Escopo

- Arquivo tocado: `dashboard/src/components/LiveSessionWindow.jsx` (remove a condição de
  descarte).
- Sem endpoint novo, sem mudança de protocolo, sem mudança em agent/servidor.
- Risco residual aceito: tecla Windows pode abrir o Menu Iniciar da máquina remota (comportamento
  esperado agora, não bug) — o operador sabe disso e usa a rede de segurança (blur automático +
  botão manual) se precisar.

## Feature 2 — Transferência de arquivo (operador → máquina remota)

### Decisões já fechadas (não reabrir sem motivo novo)

- Direção única: PC do operador → máquina remota. Sem download no sentido inverso nesta rodada.
- Só funciona em modo **Normal**, sessão ao vivo aberta (sem transferência fora de sessão/async).
  Garantido de graça pelo allow-list existente em `routeMessage` (`liveSessionRelay.js`), que já
  bloqueia qualquer mensagem dashboard→companion fora de `mode==='normal'`.
- Gatilho: arrastar-e-soltar na janela da sessão ao vivo **e** botão "Enviar arquivo" com seletor —
  os dois.
- Destino: campo de texto na janela, pré-preenchido com `C:\Users\<usuário remoto>\Desktop`,
  editável livremente antes de enviar. Companion cria o diretório se não existir.
- Tamanho máximo: 2GB por arquivo (folga grande sobre instalador típico, evita SAS/companion
  segurando transferência por horas).
- Transporte: Azure Blob + SAS fora de banda (ver Arquitetura) — não via stream binário no mesmo
  WS que carrega mouse/teclado em tempo real, pra não arriscar travar o controle remoto durante
  envio de arquivo grande.
- Sem cancelamento de transferência em andamento nesta rodada (fast-follow, não v1).
- Sem retry automático de notificação se o dashboard cair no meio do download do companion —
  arquivo chega mesmo assim (download já está só entre companion e Blob nesse ponto), só sem
  confirmação visual. Limitação conhecida, documentada, não resolvida nesta rodada.

### Fora de escopo (explicitamente descartado nesta rodada)

- Download (máquina remota → operador).
- Cancelamento de transferência em andamento.
- Progresso resiliente a queda do dashboard (reconectar e retomar visualização do progresso).
- Múltiplas transferências simultâneas na mesma sessão.
- Pasta de destino fixa/sugerida além do Desktop (usuário sempre pode digitar outra).

### Arquitetura

```
[Dashboard Electron]                [Servidor Node.js]              [Azure Blob Storage]
       │  1. POST /api/live/:id/file/upload-url ──────────────────────────►│
       │◄───────────────────── {uploadUrl (SAS write, 15min), blobPath} ───┤
       │                                                                    │
       │  2. PUT direto pro Blob (bytes nunca passam pelo servidor) ───────►│
       │                                                                    │
       │  3. WS /live: {type:"file-transfer", downloadUrl, fileName, destPath}
       ▼
[liveSessionRelay.js — routeMessage, ZERO mudança, repasse opaco já gated por mode==='normal']
       │
       ▼
[Companion Go]  4. http.Get(downloadUrl) → io.Copy pra temp → rename pra destPath
       │           (mesmo padrão de downloadBinary, updater.go)
       │  5. WS /live: {type:"file-transfer-progress"|"file-transfer-done"|"file-transfer-error"}
       ▼
[Dashboard] atualiza barra de progresso / erro
       │  6. DELETE do blob (limpeza imediata, além do lifecycle de 24h no container)
```

### Componentes tocados

- **Servidor** (`server/routes/live.js` + novo `server/services/blobSas.js`): endpoint
  `POST /api/live/:sessionId/file/upload-url` (mesmo middleware `adminAuth` das rotas existentes
  de `live.js`), gera SAS de escrita via SDK `@azure/storage-blob` (nunca shell-out pra `az` CLI) —
  1 blob só, 15min, container novo `dtmanagerdr/live-transfer`. Rejeita `fileSize > 2GB` antes de
  gerar qualquer SAS. Account key do Blob vira campo novo em `config.json` (segredo, nunca logado).
  Novo container precisa ser criado 1x (infra), com regra de lifecycle auto-expirando blobs em 24h
  como rede de segurança independente da limpeza feita pelo dashboard no passo 6.
- **Dashboard** (`LiveSessionWindow.jsx`): drop-zone + botão "Enviar arquivo" + campo de destino +
  barra de progresso. Upload direto pro Blob via `fetch`/`PUT` com a SAS recebida — bytes nunca
  passam pelo Node.
- **Companion** (`agent/input_windows.go`): `inputMessage` ganha `type:"file-transfer"` com
  `downloadUrl`/`fileName`/`destPath`; `dispatchLiveSessionInput` ganha o case novo. Reaproveita o
  padrão de `downloadBinary` (`updater.go`) pra baixar com segurança (temp + rename atômico).
  Primeira vez que o companion manda `TextMessage` JSON de volta pro dashboard (hoje só manda
  vídeo binário) — função nova pequena, espelhando o `frameWriter` existente.
- **Relay** (`liveSessionRelay.js`): zero mudança — repasse opaco já cobre o novo tipo de mensagem
  nos dois sentidos, e o allow-list de modo Normal já existe.

### Tratamento de erro

| Falha | Onde é detectada | Comportamento |
|---|---|---|
| Upload pro Blob falha (rede local, SAS expirado) | Dashboard | Mostra erro antes de mandar qualquer comando — companion nunca sabe que houve tentativa |
| Destino inválido (sem permissão, não cria) | Companion | `file-transfer-error` com mensagem real do SO, nada fica pendurado |
| Download incompleto (WAN caiu, Blob expirou) | Companion | Arquivo parcial fica só no temp, nunca sobrescreve destino; erro reportado |
| Dashboard cai durante o download do companion | — | Companion termina sozinho (download já é direto Blob↔companion); mensagem de done/erro se perde — limitação conhecida, aceita |
| SAS vazar/reuso | — | Escopo de 1 blob, 15min, write-only na subida / read-only no download — exposição mínima mesmo se vazar |
| Arquivo acima de 2GB | Servidor | Recusa o `upload-url` com erro claro antes de qualquer upload |

### Testes

- Unit: servidor (geração de SAS, limite de 2GB, `adminAuth` obrigatório), companion Go
  (download→temp→rename, criação de diretório, erros de path/disco — molde de `updater_test.go`),
  dashboard (drop-zone, máquina de estado do progresso).
- `code-reviewer` local nos 3 diffs (server/agent/dashboard) antes de publicar.
- Teste ao vivo em 1 máquina BOH antes de qualquer rollout mais amplo: arquivo pequeno, arquivo
  grande (100-500MB), destino inválido, e a tecla Windows liberada.

### Rollout

- **Tecla Windows**: só dashboard → `release:auto` (regra fixa do projeto), sem tag de agent.
- **Transferência de arquivo**: 3 sub-projetos, worktree separado por sub-projeto (mesmo padrão da
  feature-mãe). Servidor sobe sozinho no push pro master (CI existente). Dashboard = `release:auto`.
  **Agent = HIGH** — pausar e confirmar explicitamente antes do `git tag` (propaga pull-based pra
  frota toda assim que tagueado, mesmo padrão de todo release de agent anterior).
- Container Blob `dtmanagerdr/live-transfer` + regra de lifecycle: infra nova, criar antes do
  primeiro deploy (André autoriza e eu crio, ou ele roda `az storage container create` +
  lifecycle policy).
