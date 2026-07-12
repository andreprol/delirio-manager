---
name: documentar
description: Documenta a sessão em Memória, Obsidian e GitHub. Invocar quando André disser "documentar".
---

# Skill: documentar

Quando André disser **"documentar"**, execute este fluxo completo — sem pedir confirmação em cada etapa.

## O que "documentar" significa

1. **Memória** → atualizar arquivos `.md` em `C:\Users\fileserver\.claude\projects\F--RichClub\memory\`
2. **Obsidian** → criar/atualizar nota de sessão no vault `Cérebro do André`
3. **GitHub** → commit no repo relevante ao que foi feito na sessão
4. **Vault scan** → varrer notas vazias e reportar ao final

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

## Passo 2 — Obsidian

Crie ou atualize uma nota de sessão usando `obsidian-cli`.

**Formato do nome:** `Sessao_AAAA_MM_DD_[contexto].md`  
**Pasta:** `Projetos/[NomeDoProjeto]/` — use o projeto principal da sessão.  
Se a sessão cobriu múltiplos projetos, use a pasta do projeto dominante ou `Projetos/`.

**Estrutura da nota:**
```markdown
# Sessão YYYY-MM-DD — [Contexto / versão]

## O que foi feito
- bullet com cada mudança relevante

## Decisões tomadas
- decisões de arquitetura, produto ou processo

## Próximos passos
- o que ficou pendente

## Skills/ferramentas instaladas
- apenas se aplicável
```

Comando para criar:
```bash
obsidian vault="Cérebro do André" create name="Sessao_AAAA_MM_DD_contexto" path="Projetos/NomeProjeto/Sessao_AAAA_MM_DD_contexto.md" content="[conteúdo]" silent overwrite
```

### Vincular sessão ao projeto principal — ETAPA BLOQUEANTE

> ⛔ NÃO avance para o Passo 3 (GitHub) sem confirmar que este link existe e funciona.

**Esta é a etapa que mais frequentemente é pulada por parecer "feita" quando não está.  
Fazer append sem verificar o resultado é o erro mais comum.**

**Lógica — execute nesta ordem exata:**

**1. Encontrar a nota principal do projeto**
```bash
# Listar arquivos na pasta do projeto
obsidian vault="Cérebro do André" eval code="app.vault.getMarkdownFiles().filter(f => f.path.startsWith('Projetos/NomeProjeto/')).map(f => f.path)"
```
A nota principal é o `.md` que NÃO começa com `Sessao_` e não está em subpasta. Exemplos: `Delirio Manager.md`, `Portal MM - Soluções — Visão Geral.md`.

**2. Ler a nota principal**
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

**Regra:** Se a nota principal do projeto não existir, criar estrutura mínima já com a seção `## Sessões` e o link.

## Passo 3 — GitHub

Faça commit **e push** no repo do projeto dominante da sessão.

- Verifique o status git e identifique arquivos modificados
- Mensagem de commit: `docs: session notes DD/MM/YYYY — [resumo]`
- Inclua o Co-Authored-By padrão
- Só commitar arquivos de documentação/notas — nunca código não revisado
- **Sempre fazer push após o commit** — sem precisar que André peça

Se a sessão foi sobre setup/skills (como hoje), commitar em `F:\RichClub`:
```bash
git -C "F:\RichClub" add .claude/ && git -C "F:\RichClub" commit -m "docs: ..." && git -C "F:\RichClub" push
```

Para projetos com código modificado:
```bash
git add <arquivos> && git commit -m "feat/fix/docs: ..." && git push
```

## Passo 4 — Vault scan + verificação de links

### 4a. Notas vazias

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

### 4b. Verificar backlinks — checklist obrigatório antes de encerrar

Para **cada nota de sessão criada nesta execução**, executar:

```bash
obsidian vault="Cérebro do André" backlinks file="Sessao_AAAA_MM_DD_contexto"
```

✅ Correto: aparece pelo menos uma nota linkando de volta (a nota principal do projeto).  
❌ Problema: lista vazia = nota órfã = o Passo 2 falhou silenciosamente.

**Se lista vazia:** voltar ao Passo 2, encontrar a nota principal, e aplicar o procedimento 3b (eval+async) para inserir o link. Não avançar até confirmar.

**Regras de linkagem:**
- `Sessao_*.md` → link SEMPRE na nota principal do projeto (`NomeProjeto.md` ou `Visão Geral.md`)
- Notas de feedback/referência de projeto → link na nota de sessão correspondente
- Notas genéricas sem projeto → dispensadas

**Por que isso falha frequentemente:** `append` cria seção duplicada quando `## Sessões` já existe; o link fica "lá" mas Obsidian não o resolve corretamente porque há duas seções com o mesmo nome. Sempre verificar com `backlinks` após qualquer modificação.

---

## Passo 5 — NotebookLM

### Preferência de método

**SEMPRE preferir o browser aberto** ao CLI. O browser já está autenticado e evita problemas de cookie expirado.

**Ordem de prioridade:**
1. **Chrome MCP** (`mcp__claude-in-chrome__*`) — se o Chrome estiver aberto (verificar com `tabs_context_mcp`)
2. **CLI** (`bun scripts/main.ts`) — fallback se o Chrome não estiver disponível

### Método 1 — Chrome MCP (preferido)

**a) Verificar abas abertas:**
```
mcp__claude-in-chrome__tabs_context_mcp
```
Se houver aba com `notebooklm.google.com` na URL: usar essa aba diretamente.
Se não: navegar para `https://notebooklm.google.com/notebook/[notebooklm_id]`.

**b) Compor conteúdo da sessão** (texto puro, sem tool call internals):
```
# Sessão YYYY-MM-DD — [Nome do Projeto]
_Projeto: [Nome]_

## O que foi feito
[bullets das mudanças]

## Decisões
[decisões técnicas]

## Próximos passos
[pendências]
```

**c) Adicionar fonte via "Copiar texto":**
1. Navegar até o notebook correto no Chrome
2. Clicar no botão "+ Adicionar fonte" (ou equivalente)
3. Selecionar "Texto copiado" / "Colar texto"
4. Colar o conteúdo da sessão
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
# Sessão YYYY-MM-DD — [Nome do Projeto]
_Projeto: [Nome] | ID: [session-id]_

## André
[mensagem do usuário]

## Claude
[resposta do assistente]
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

Analise o transcript e identifique blocos por projeto:
- Nomes de projeto mencionados explicitamente
- Arquivos/repos acessados
- Keywords de domínio (NF-e/SAP/BOH → Delirio; laudo/NBC → Perícia; Stellar/Solidity → Web3)
- Descartar blocos sem projeto identificável (meta-conversa, caveman setup, system reminders)

### Tratamento de erro

Se qualquer etapa do Passo 5 falhar: exibir warning mas NÃO interromper o `documentar`. Passo 5 é best-effort.

### Relatório do Passo 5

Ao final: `"NotebookLM: [N] projetos salvos ([lista de nomes]), [M] fontes criadas"` ou `"NotebookLM: skipped ([motivo])"`

---

## Regras gerais

- Não pergunte "posso documentar?" — execute diretamente
- Se o repo não for claro, pergunte apenas isso antes de commitar
- A nota do Obsidian e a memória são obrigatórias; o commit é obrigatório se houve mudança em código/config
- Mantenha a nota de sessão objetiva: o que mudou, por quê, o que vem a seguir
