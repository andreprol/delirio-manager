# Design — Flag "Relógio Novo" (bypass do guard de divergência)

## Contexto

O `dt-clock-proxy` tem um guard de segurança (`clock-proxy/server.js`, `isSuspicious`) que
protege contra leituras corrompidas dos relógios Henry Hexa: se um relógio de repente retorna
menos de 50% dos funcionários que tinha na leitura anterior, o sistema assume que é uma falha
transitória (firmware sob carga, timeout, página vazia) e **mantém o cache antigo** em vez de
aceitar o dado novo. Esse guard foi construído em 20/06/2026 depois de um incidente real de
divergência explosiva causado por firmware instável (ver `feedback` do projeto).

O problema: uma **troca física legítima de hardware** (relógio quebrado, substituído por um novo)
produz exatamente o mesmo sintoma — o relógio novo lê 0 funcionários, porque nunca foi cadastrado.
O guard não distingue "glitch temporário" de "hardware novo permanentemente vazio", e vai mascarar
a substituição para sempre, silenciosamente: o dashboard continua mostrando o relógio como se
tivesse todo mundo cadastrado, a divergência nunca aparece, e ninguém percebe que precisa
sincronizar os funcionários no relógio novo.

André confirmou que trocas de hardware vão continuar acontecendo (relógio queimou, foi trocado
por um novo com o mesmo IP) e quer uma forma de avisar o sistema antecipadamente que a próxima
leitura de um IP específico é esperada ser diferente — sem desligar a proteção pra sempre.

## Solução

Uma flag "relógio novo" por IP, armada manualmente pelo usuário antes da leitura, consumida
automaticamente (um tiro só) na primeira leitura seguinte daquele IP — sucesso ou falha.

### Fluxo

1. André troca o relógio fisicamente, configura o novo hardware com o mesmo IP e credenciais
2. No dashboard (Módulo RH → grid de relógios), clica "🆕 Marcar como relógio novo" no relógio
   trocado → confirmação ("Confirma que este relógio foi fisicamente substituído?")
3. Isso chama `POST /api/rh/clock/:ip/mark-new` → proxy pro clock-proxy →
   `POST /clock/:ip/mark-new` → seta a flag em memória + persiste em disco
4. André clica "Atualizar" no dashboard quando o relógio novo já está respondendo — dispara a
   releitura normal desse IP
5. No guard (`server.js`), a checagem de divergência é pulada **só para esse IP, só nessa
   leitura** — o resultado novo (0 funcionários, ou o que vier) é aceito como verdade
6. A flag é consumida (removida) logo após essa leitura, independente do resultado — nunca fica
   ligada esquecida, nunca desprotege o relógio permanentemente

### Armazenamento da flag

Objeto em memória `_newClockFlags` (Set de IPs) no `clock-proxy/server.js`, espelhando o padrão
já existente do `employee-cache.json` — persistido em `new-clock-flags.json` no mesmo diretório,
recarregado no boot do processo (sobrevive a restart do PM2 entre o "Marcar" e o "Atualizar" se
o processo cair nesse meio-tempo).

### Mudança no guard

Em `server.js`, na função que calcula `isSuspicious` (linha ~496):

```js
const bypassGuard = _newClockFlags.has(ip);
const isSuspicious = !bypassGuard && prevEntry?.success && prevCount > 0
  && newCount < Math.ceil(prevCount * 0.5);
// ... processamento normal do resultado ...
if (bypassGuard) {
  _newClockFlags.delete(ip);
  persistNewClockFlags();
}
```

### Novos endpoints

- `clock-proxy/server.js`: `POST /clock/:ip/mark-new` — valida que `ip` está em `CLOCK_IPS`,
  seta a flag, responde `{ ok: true, ip }`
- `server/routes/rh.js`: `POST /api/rh/clock/:ip/mark-new` — proxy simples via `callClockProxy`,
  mesmo padrão de auth (`CLOCK_PROXY_TOKEN`) das rotas existentes

### UI

`dashboard/src/components/ClockStatusGrid.jsx` — botão "🆕 Marcar como relógio novo" no menu de
ações de cada relógio (mesmo padrão visual dos outros botões de ação do grid). Ao clicar:
`window.confirm(...)` de segurança → chama a API → feedback visual de "flag armada" (badge
temporário tipo "🆕 aguardando releitura" no card do relógio, desaparece quando a flag é consumida
ou quando os dados desse relógio mudam).

## Risco conhecido (aceito)

Se o módulo RH ficar aberto e algum refresh automático da UI disparar antes do relógio físico
estar pronto, a flag pode ser consumida numa leitura prematura (relógio ainda não configurado,
ainda respondendo com dados antigos ou erro de conexão). Mitigação: instrução de uso — armar a
flag só quando o relógio novo já estiver plugado e respondendo no IP correto, e clicar
"Atualizar" logo em seguida. Não é um bug do sistema, é uma janela de uso que depende da ordem
correta de operação do usuário.

## Fora de escopo

- Não criar um fluxo automático que dispara a releitura sozinha ao marcar a flag (decisão do
  usuário: marcar e atualizar são ações manuais separadas, dão tempo pra terminar a configuração
  física do relógio entre uma e outra)
- Não expor a flag como um toggle "ligado/desligado" manual — é estritamente um bypass de um
  tiro, para não correr o risco de ficar esquecida ligada e desproteger o relógio permanentemente

## Arquivos afetados

- **Editar**: `clock-proxy/server.js` — flag, endpoint, persistência, mudança no guard
- **Editar**: `server/routes/rh.js` — rota de proxy `POST /api/rh/clock/:ip/mark-new`
- **Editar**: `dashboard/src/components/ClockStatusGrid.jsx` — botão + badge de estado
- **Novos testes**: cobertura do guard com bypass ativo/consumido, da rota de proxy, e do
  endpoint no clock-proxy

## Testes previstos

1. Guard aceita leitura com `newCount` bem abaixo de 50% quando a flag está armada pro IP
2. Flag é consumida (removida) após a leitura, mesmo em caso de falha de conexão
3. Guard comporta-se normalmente (proteção ativa) para IPs sem a flag armada
4. `POST /clock/:ip/mark-new` rejeita IP fora de `CLOCK_IPS`
5. Persistência: flag sobrevive a um restart simulado do processo (recarrega do arquivo)
6. Rota de proxy no server retorna erro apropriado se `CLOCK_PROXY_TOKEN` ausente (mesmo padrão
   das rotas existentes)
