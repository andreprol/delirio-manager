---
name: documentar
description: Documenta a sessão em Memória, GitHub, Obsidian (hub-e-raio, linkado ao JARVIS) e NotebookLM. Invocar quando André disser "documentar".
---

# Skill: documentar

Quando André disser **"documentar"**, execute este fluxo completo — sem pedir confirmação em cada etapa.

## O que "documentar" significa

1. **Memória** → atualizar arquivos `.md` em `C:\Users\fileserver\.claude\projects\F--RichClub\memory\`
2. **GitHub** → commit no repo relevante ao que foi feito na sessão — **antes** do Obsidian/NotebookLM, pra nota já nascer citando o commit real, não um hash que ainda não existe
3. **Compor o conteúdo da sessão uma vez só** → o mesmo texto vai pro Obsidian e pro NotebookLM, sem reescrever/resumir entre um e outro
4. **Obsidian** → criar/atualizar a nota de sessão com esse texto, linkada ao hub do projeto **e** o hub do projeto linkado ao hub central do JARVIS (estrutura hub-e-raio)
5. **NotebookLM** → subir o **mesmo texto** do Passo 3 como fonte no notebook do projeto — **obrigatório, não best-effort**
6. **Vault scan** → varrer notas vazias, links quebrados e backlinks (incluindo hub→JARVIS) e reportar ao final

**Por que essa ordem (mudou em 20/09/2026):** Obsidian e NotebookLM costumavam ser
compostos separadamente — cada um "resumia" a sessão à sua maneira, e com o tempo os dois
divergiam (a mesma sessão, escrita duas vezes, nunca fica idêntica). André comparou os dois lados
numa auditoria de export em massa (ver [[project_claude_24hrs]], 19-20/09/2026) e pediu garantia
estrutural: um texto só, colado igual nos dois lugares. GitHub subiu pra Passo 2 porque a nota de
sessão frequentemente cita commit hash — precisa existir antes de ser citado.

---

## Passo 1 — Memória

Identifique o que mudou na sessão e atualize os arquivos de memória relevantes:
- Novos fatos de projeto → arquivo `project_*.md` correspondente
- Novas lições aprendidas → arquivo `feedback_*.md` correspondente
- Novo setup/ferramenta instalada → atualizar `setup_claude.md`
- Atualizar `MEMORY.md` se um arquivo novo foi criado

Use o padrão de frontmatter:
```markdown
---
name: slug-kebab-case
description: uma linha descritiva
metadata:
  type: project | feedback | user | reference
---
```

## Passo 2 — GitHub

### 2.0 — Checagem obrigatória: repo exclusivo ou misturado? — ETAPA BLOQUEANTE

> ⛔ NUNCA commitar/pushar sem rodar esta checagem antes. Regra criada em 14/09/2026 após
> descobrir que `andreprol/delirio-manager` (repo PÚBLICO) vinha recebendo commits de 5+
> projetos não relacionados por mais de um mês (F:\RichClub é um monorepo com `origin`
> apontando pro Delirio Manager, e outros projetos viviam como subpasta dele). Ver
> `feedback_delirio_manager_repo_contaminado` na memória.
>
> Motivo crítico: recrutadores (projeto Web3/emprego) e clientes olham o GitHub do André.
> Repo misturado passa impressão de falta de organização — inaceitável.

Antes de `git add`/`git commit`/`git push`, rodar:

```bash
# 1. nome do remote origin do repo em questão
git remote get-url origin

# 2. pastas de nível raiz rastreadas — cada uma deveria pertencer a UM projeto só
git ls-tree -r --name-only HEAD | cut -d/ -f1 | sort -u
```

**Avaliar — pergunta 1 primeiro, sozinha, antes de olhar qualquer outra coisa:**
- **O nome do remote (`andreprol/nome-repo`) corresponde ao projeto da sessão atual?** Se a
  resposta é não, **isso já basta pra parar** — não precisa checar mais nada, não precisa
  justificar com a pergunta 2. 🚨 Recorrência 28/10/2026 ([[project_projeto_ia]]): rodei os dois
  comandos, mas pulei esta pergunta e fui direto pra pergunta 2 — exatamente o erro a evitar.
- As pastas de raiz rastreadas pertencem TODAS ao mesmo projeto, ou há pastas de projetos
  diferentes misturadas no mesmo histórico?
  - 🚨 **Resíduo de outro projeto já presente (ex.: doc solto em `docs/superpowers/specs|plans/`)
    NUNCA é evidência de que misturar é aceitável — é evidência de contaminação não resolvida.**
    Isso virou precedente usado por engano duas vezes (18/09 com Claude 24hrs, 28/10 com Projeto
    IA e outros 3 projetos) pra justificar adicionar MAIS um projeto errado. Se achar resíduo,
    ele mesmo vira um alerta separado pro André — nunca justificativa pra prosseguir.

**Se misturado (ou remote não corresponde ao projeto):**
1. NÃO commitar/pushar ainda.
2. Avisar André explicitamente: "Repo `<nome>` está misturando `<projeto A>` e `<projeto B>`."
3. Sugerir fix: `git rm -r --cached <pasta-do-projeto-errado>` + entrada no `.gitignore`
   (nunca apagar do disco, só do tracking — ver `feedback_git_rm_env_sem_cached`) e, se o
   projeto misturado não tiver repo próprio ainda, sugerir criar um via
   `git subtree split --prefix=<dir> -b <branch>` (técnica já usada pro music-channel-pipeline).
4. Só prosseguir com o commit desta sessão depois que André decidir (corrigir agora ou aceitar
   o risco conscientemente).

**Se correto (repo exclusivo do projeto, remote bate):** prosseguir normalmente pro resto do Passo 2.

**Backstop mecânico (desde 28/10/2026):** `.claude/hooks/check-single-project-repo.sh`
(`PreToolUse` em Bash/PowerShell, `F:\RichClub\.claude\settings.json`) pede confirmação
automaticamente antes de qualquer `git commit`/`git push` em delirio-manager que adicione arquivo
novo em `docs/superpowers/specs|plans/` ou caminho de topo fora da allowlist. Esse hook é
cinturão-e-suspensório — **não substitui rodar esta checagem 2.0 de propósito**, porque a lógica
de "este projeto é mesmo do Delirio Manager" só o humano/eu sabemos responder; o hook só sabe
dizer "isso parece novo, confirme".

### 2.1 — Commit e push

Faça commit **e push** no repo do projeto dominante da sessão.

- Verifique o status git e identifique arquivos modificados
- Mensagem de commit: `docs: session notes DD/MM/YYYY — [resumo]` (ou `feat/fix:` se houve código)
- Inclua o Co-Authored-By padrão
- Só commitar arquivos de documentação/notas — nunca código não revisado
- **Sempre fazer push após o commit** — sem precisar que André peça
- **Anote o(s) commit hash(es) relevante(s)** — vai citá-los no texto do Passo 3

```bash
git add <arquivos> && git commit -m "feat/fix/docs: ..." && git push
```

## Passo 3 — Compor o conteúdo da sessão (uma vez só)

Escreva **um único bloco de texto** cobrindo a sessão. Esse é o texto canônico — vai pro
Obsidian (Passo 4) e pro NotebookLM (Passo 5) **idêntico, sem reescrever nem resumir de novo**.
Se precisar editar depois de já ter escrito, edite aqui e recopie pros dois lugares — nunca edite
só um dos dois.

**Estrutura:**
```markdown
# Sessão YYYY-MM-DD — [Contexto / versão]

## O que foi feito
- bullet com cada mudança relevante (cite commit hash do Passo 2 quando fizer sentido)

## Decisões tomadas
- decisões de arquitetura, produto ou processo

## Próximos passos
- o que ficou pendente

## Skills/ferramentas instaladas
- apenas se aplicável
```

## Passo 4 — Obsidian

Crie ou atualize uma nota de sessão usando `obsidian-cli`, com o texto exato do Passo 3.

**Formato do nome:** `Sessao_AAAA_MM_DD_[contexto].md`
**Pasta:** `Projetos/[NomeDoProjeto]/` — use o projeto principal da sessão.
Se a sessão cobriu múltiplos projetos, use a pasta do projeto dominante ou `Projetos/`.

Comando para criar:
```bash
obsidian vault="Cérebro do André" create name="Sessao_AAAA_MM_DD_contexto" path="Projetos/NomeProjeto/Sessao_AAAA_MM_DD_contexto.md" content="[texto do Passo 3]" silent overwrite
```

### 4.1 — Vincular sessão ao projeto principal — ETAPA BLOQUEANTE

> ⛔ NÃO avance para o Passo 4.2 sem confirmar que este link existe e funciona.

**Esta é a etapa que mais frequentemente é pulada por parecer "feita" quando não está.
Fazer append sem verificar o resultado é o erro mais comum.**

**Lógica — execute nesta ordem exata:**

**1. Encontrar a nota principal do projeto (o hub)**
```bash
# Listar arquivos na pasta do projeto
obsidian vault="Cérebro do André" eval code="app.vault.getMarkdownFiles().filter(f => f.path.startsWith('Projetos/NomeProjeto/')).map(f => f.path)"
```
O hub é o `.md` que NÃO começa com `Sessao_` e não está em subpasta. Exemplos: `Delirio Manager.md`, `Portal MM - Soluções — Visão Geral.md`.

**2. Ler o hub**
```bash
obsidian vault="Cérebro do André" read path="Projetos/NomeProjeto/NomeProjeto.md"
```
Verificar se já existe `## Sessões`. Se sim: usar eval/async para inserir no topo da lista existente — **nunca append**, que cria seção duplicada.

**3a. Se NÃO existe seção `## Sessões` → usar append**
```bash
obsidian vault="Cérebro do André" append path="Projetos/NomeProjeto/NomeProjeto.md" content="\n## Sessões\n- [[Sessao_AAAA_MM_DD_contexto]] — resumo de 1 linha"
```

**3b. Se JÁ existe `## Sessões` → usar eval+async para inserir no topo**
```bash
obsidian vault="Cérebro do André" eval code="
(async () => {
  const f = app.vault.getAbstractFileByPath('Projetos/NomeProjeto/NomeProjeto.md');
  const c = await app.vault.read(f);
  const novo = c.replace('## Sessões\n', '## Sessões\n- [[Sessao_AAAA_MM_DD_contexto]] — resumo\n');
  await app.vault.modify(f, novo);
  return 'done';
})()
"
```

**4. VERIFICAR que o link existe — obrigatório**
```bash
obsidian vault="Cérebro do André" read path="Projetos/NomeProjeto/NomeProjeto.md" | grep -i "Sessao_AAAA_MM_DD"
```
Só avance se o link aparecer na saída. Se não aparecer: investigar e repetir o passo.

**Nota única por projeto:** nunca criar duas seções `## Sessões`. Se já existe, inserir no topo da lista existente.

**Regra:** Se o hub do projeto não existir, criar estrutura mínima já com a seção `## Sessões` e o link.

**Também na nota de sessão:** insira uma linha `Projeto: [[NomeDoHub]]` logo no topo do corpo (link de volta, além do backlink do hub) — é o padrão usado no export de 19-20/09/2026 (ver [[project_claude_24hrs]]) e mantém a sessão navegável mesmo se alguém abrir ela direto, sem passar pelo hub primeiro.

### 4.2 — Vincular o hub do projeto ao hub central do JARVIS — ETAPA BLOQUEANTE

> ⛔ NÃO avance para o Passo 5 sem confirmar que o hub do projeto linka pro JARVIS.

**Estrutura hub-e-raio** (criada em 20/09/2026 — ver [[project_jarvis]]): toda nota linka pro
hub do seu projeto, e todo hub linka pro hub central `Projetos/JARVIS/00_Hub — JARVIS.md`
(link `[[00_Hub — JARVIS]]`). Isso é o segundo salto — não pula essa etapa achando que o link
sessão→hub (4.1) já basta.

**1. Ler o hub do projeto e checar se já linka pro JARVIS**
```bash
obsidian vault="Cérebro do André" read path="Projetos/NomeProjeto/NomeProjeto.md" | grep -i "00_Hub — JARVIS\|Hub central"
```

**2. Se NÃO linkar ainda, inserir a linha** (perto do topo do corpo, antes do conteúdo principal):
```bash
obsidian vault="Cérebro do André" eval code="
(async () => {
  const f = app.vault.getAbstractFileByPath('Projetos/NomeProjeto/NomeProjeto.md');
  const c = await app.vault.read(f);
  const novo = 'Hub central: [[00_Hub — JARVIS]]\n\n' + c;
  await app.vault.modify(f, novo);
  return 'done';
})()
"
```

**3. VERIFICAR** (mesmo comando do passo 1) — só avance se o link aparecer.

**Se já linkava** (hub tocado numa sessão anterior): pular, não duplicar.

**Nota:** isso só precisa ser feito **uma vez por hub**, não a cada sessão — depois que o hub já
linka pro JARVIS, sessões futuras nesse mesmo projeto pulam direto pra 4.1.

## Passo 5 — NotebookLM (obrigatório)

🚨 **Este passo é obrigatório, no mesmo nível que Memória/Obsidian/GitHub — não é
best-effort e não pode ser pulado silenciosamente.** Só pode faltar por uma causa
técnica real (extensão Chrome ausente/sem permissão, notebook não localizável
mesmo após busca) — nesse caso reportar a falha explicitamente ao André, nunca
apenas omitir o passo do relatório final.

⚠️ **Use o texto exato do Passo 3 — não reescreva, não resuma, não reformate.** É esse
o ponto inteiro da reordenação de 20/09/2026: Obsidian e NotebookLM têm que ser a mesma
sessão com as mesmas palavras, não duas versões independentes que divergem com o tempo.

### Preferência de método

**O Chrome MCP é o método, não uma preferência condicional.** O CLI (`bun scripts/main.ts`) usa
cookies próprios que expiram silenciosamente com frequência alta — na prática, tentar CLI primeiro
é a razão histórica desse passo falhar sempre (ver [[feedback_notebooklm_cli_sempre_falha]]).
**Não checar "se o Chrome está aberto" como pré-condição — sempre abrir/usar.** `tabs_context_mcp`
com `createIfEmpty: true` garante uma aba mesmo que nenhuma exista ainda.

**Ordem de prioridade:**
1. **Chrome MCP** (`mcp__claude-in-chrome__*`) — padrão, chamar sempre, sem checar condição antes
2. **CLI** (`bun scripts/main.ts`) — só se o passo 1 genuinamente falhar (extensão não instalada/sem permissão), nunca como primeira tentativa

### Método 1 — Chrome MCP (padrão)

**a) Garantir aba disponível:**
```
mcp__claude-in-chrome__tabs_context_mcp{createIfEmpty: true}
```
Se houver aba com `notebooklm.google.com`/`notebook.google.com` na URL: usar essa aba diretamente.
Se não: `tabs_create_mcp` + navegar para `https://notebook.google.com/notebook/[notebooklm_id]`.

**b) Conteúdo da fonte = o texto do Passo 3, sem alterar nada.**

**c) Adicionar fonte via "Copiar texto":**
1. Navegar até o notebook correto no Chrome
2. Clicar no botão "+ Adicionar fonte" (ou equivalente)
3. Selecionar "Texto copiado" / "Colar texto"
4. Colar o conteúdo exato do Passo 3
5. Confirmar adição
6. Verificar que a fonte apareceu na lista

### Método 2 — CLI (fallback)

```powershell
$env:Path += ";$env:USERPROFILE\.bun\bin"
$NLM = "C:\Users\fileserver\.claude\skills\notebooklm-ai-plugin\skills\notebooklm"
```

**Limpeza de arquivos temp antigos:** Delete `F:\Temp\session_*.md` se existirem.

**Upload via add-text (sem arquivo temp):**
```powershell
Set-Location $NLM
$sessionContent = @"
[texto exato do Passo 3]
"@
bun scripts/main.ts sources add-text --title "Sessao_YYYY-MM-DD_[slug]" --content $sessionContent --notebook [id]
```

Se CLI falhar (cookie expirado, timeout): reportar e usar Chrome MCP como alternativa.

### Para cada projeto identificado:

**a) Buscar notebook:**

Leia o `project_*.md` correspondente → campo `notebooklm_id:` no body.

Se não existe: avisar André para criar no browser (notebooklm.google.com) depois executar:
```powershell
Set-Location $NLM
bun scripts/main.ts notebooks add <url-do-notebook>
```
⚠️ CLI **NÃO** tem `notebooks create` — criar sempre no browser, depois registrar com `notebooks add`. Salvar ID no `project_*.md`.

**b) Verificar limite de fontes (rotação automática):**
Via Chrome: contar fontes visíveis no painel lateral do notebook.
Via CLI: `bun scripts/main.ts sources list --notebook [id] --json`
Se count >= 48: avisar André para criar notebook `[Projeto] — Sessões Claude 2` no browser.

### Segmentar por projeto

Se a sessão cobriu múltiplos projetos, o texto do Passo 3 deve ser segmentado por projeto antes
deste passo (cada projeto recebe só a parte dele, ainda verbatim/sem reescrever) — identifique os
blocos por:
- Nomes de projeto mencionados explicitamente
- Arquivos/repos acessados
- Keywords de domínio (NF-e/SAP/BOH → Delirio; laudo/NBC → Perícia; Stellar/Solidity → Web3)
- Descartar blocos sem projeto identificável (meta-conversa, caveman setup, system reminders)

### Verificação obrigatória — NÃO reportar sucesso sem isso

⛔ **Proibido dizer "NotebookLM: N fontes criadas" sem antes confirmar visualmente.** Esse foi
exatamente o bug encontrado em 03/09/2026: a skill reportou sucesso na sessão do Uriverse3D e o
notebook nunca existiu. Motivo raiz: relatava com base em "o comando não retornou erro", não em
"eu vi a fonte na lista".

Após adicionar cada fonte (Método 1 passo 6, ou Método 2 equivalente):
1. `get_page_text` (ou `read_page`) na aba do notebook e procurar o título da fonte recém-criada na lista de "Fontes".
2. Se não aparecer: tirar `screenshot` — pode estar processando (spinner) ou o clique/paste falhou. Aguardar até 5s e reconferir.
3. Só reportar "criada" a fonte que apareceu confirmada na lista. Qualquer fonte não confirmada entra no relatório como "NÃO confirmada — verificar manualmente", nunca como sucesso.
4. Se o notebook do projeto não existir ainda: criar primeiro (botão "Criar notebook" na home do NotebookLM), confirmar que a página do notebook novo carregou (título correto, `url` com um UUID), só então adicionar a fonte. Salvar o `notebooklm_id` (UUID da URL) no `project_*.md` imediatamente — não deixar para depois.

### Tratamento de erro

Se qualquer etapa do Passo 5 falhar: **tentar o fallback (Método 2 CLI) antes de desistir.**
Se ambos os métodos falharem, não interromper o `documentar` como um todo (Passos 1-4 já
entregues continuam válidos), mas reportar a falha do Passo 5 explicitamente e com destaque
no relatório final — nunca omitir ou enterrar num "skipped" genérico sem motivo claro. "Best-effort"
nunca significou pular por conveniência nem significa reportar sucesso sem verificar.

### Relatório do Passo 5

Ao final: `"NotebookLM: [N] projetos salvos e CONFIRMADOS ([lista de nomes]), [M] fontes criadas e confirmadas na lista"` ou `"NotebookLM: skipped ([motivo])"`. Se alguma fonte não pôde ser confirmada, listar separadamente com "NÃO confirmada".

---

## Passo 6 — Vault scan + verificação de links

### 6.1. Notas vazias

Após documentar, sempre executar:

```bash
obsidian vault="Cérebro do André" eval code="app.vault.getMarkdownFiles().filter(f => f.stat.size === 0).map(f => f.path)"
```

Se encontrar notas vazias:
- Se o conteúdo existir na memória (`feedback_*.md` ou `project_*.md`): preencher a nota diretamente com o conteúdo equivalente
- Se não houver conteúdo: reportar ao André e perguntar se apaga ou tem conteúdo planejado

**Armadilha — nota " 1":** o `obsidian create` com `overwrite` pode criar `nome 1.md` em vez de sobrescrever `nome.md` quando há conflito de nome. Após criar notas, verificar se apareceu versão com sufixo " 1":
```bash
obsidian vault="Cérebro do André" eval code="app.vault.getMarkdownFiles().filter(f=>/ \d+\.md$/.test(f.path)).map(f=>f.path)"
```
Se encontrar: apagar o original vazio e renomear a " 1" para o nome correto via eval+async/await.

⚠️ **A varredura é do vault INTEIRO, nunca só da pasta do projeto da sessão.** Um link escrito
numa nota do projeto A pode apontar para nota inexistente na raiz — filtrar por pasta esconde
exatamente o que se está procurando.

### 6.2. Links quebrados — obrigatório

**Nota vazia e link quebrado são problemas DIFERENTES.** `f.stat.size === 0` só encontra arquivo
vazio; link quebrado não é arquivo nenhum — é referência apontando para o nada. O Obsidian
desenha o card mesmo assim, e no grafo parece nota vazia.

```bash
obsidian vault="Cérebro do André" eval code="
Object.entries(app.metadataCache.unresolvedLinks)
  .flatMap(([origem, alvos]) => Object.keys(alvos).map(a => origem + '  ->  ' + a))
"
```

Comparar com a saída da execução anterior: **só interessa o que ESTA sessão criou.** O vault tem
links quebrados antigos que não são responsabilidade da execução atual.

🔴 **A causa mais comum é minha, e é sempre a mesma: misturar namespaces de link.**

| Onde | Convenção | Exemplo |
|---|---|---|
| Arquivos de memória (`~/.claude/.../memory/`) | slug kebab-case | `[[project-backup-estacao]]` |
| Notas do Obsidian | nome exato da nota | `[[SEO Burial — Agente de Publicação]]` |

Escrever um slug de memória dentro de uma nota do Obsidian cria link permanentemente quebrado —
os arquivos de memória **não estão no vault**. Nesse caso, referenciar como texto puro:
``Ver a memória `project_backup_estacao`.``

⚠️ **Nunca inventar nome de nota.** Antes de escrever `[[Alguma Nota]]`, confirmar que ela
existe. Aconteceu em 24/08/2026 com `[[SEO Burial — Playbook]]`, que nunca existiu — a nota real
chama-se `SEO Burial — Agente de Publicação`.

⚠️ **Nome de hub genérico (`_Hub.md`) precisa de link com caminho completo.** Se o hub criado
pra um projeto novo usar nome genérico tipo `_Hub.md` (quando não existe candidato óbvio — ver
Passo 4.1), outros projetos podem ter hub com o mesmo nome em pasta diferente. Nesse caso o
wikilink tem que ser `[[Projetos/NomeProjeto/_Hub|NomeProjeto]]` (caminho completo + alias), nunca
`[[_Hub]]` puro — resolução ambígua no Obsidian. Descoberto em 20/09/2026 ao linkar ~720 notas de
uma vez (ver [[project_jarvis]]) — vários hubs novos colidiram por nome antes da correção.

### 6.3. Verificar backlinks — checklist obrigatório antes de encerrar

Para **cada nota de sessão criada nesta execução**, executar:

```bash
obsidian vault="Cérebro do André" backlinks file="Sessao_AAAA_MM_DD_contexto"
```

✅ Correto: aparece pelo menos uma nota linkando de volta (o hub do projeto).
❌ Problema: lista vazia = nota órfã = o Passo 4.1 falhou silenciosamente.

**Se lista vazia:** voltar ao Passo 4.1, encontrar o hub, e aplicar o procedimento 3b (eval+async) para inserir o link. Não avançar até confirmar.

**Para cada hub tocado nesta execução** (novo ou que ainda não linkava pro JARVIS), executar também:

```bash
obsidian vault="Cérebro do André" backlinks file="00_Hub — JARVIS"
```

✅ Correto: o hub do projeto aparece na lista.
❌ Problema: hub não aparece = o Passo 4.2 falhou silenciosamente — voltar e repetir.

**Regras de linkagem:**
- `Sessao_*.md` → link SEMPRE no hub do projeto (`NomeProjeto.md` ou `Visão Geral.md`)
- Hub do projeto → link SEMPRE no hub central (`00_Hub — JARVIS`)
- Notas de feedback/referência de projeto → link na nota de sessão correspondente
- Notas genéricas sem projeto → linkam direto no hub central do JARVIS, sem hub intermediário

**Por que isso falha frequentemente:** `append` cria seção duplicada quando `## Sessões` já existe; o link fica "lá" mas Obsidian não o resolve corretamente porque há duas seções com o mesmo nome. Sempre verificar com `backlinks` após qualquer modificação.

---

## Regras gerais

- Não pergunte "posso documentar?" — execute diretamente
- Se o repo não for claro, pergunte apenas isso antes de commitar
- A nota do Obsidian, a memória e o NotebookLM são obrigatórios; o commit é obrigatório se houve mudança em código/config
- O texto do Passo 3 é único e vai idêntico pro Obsidian e pro NotebookLM — nunca compor duas vezes
- Mantenha o texto da sessão objetivo: o que mudou, por quê, o que vem a seguir
- Nunca declarar o `documentar` como concluído sem os 6 passos executados (ou o Passo 5 reportado como falha explícita, ver Passo 5)
