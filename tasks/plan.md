# Plano de Correção — Módulo RH / clock-proxy / alertas
**Data:** 2026-06-22  
**Contexto:** Sessão de diagnóstico revelou erros na sincronização em massa (Sincronizar Todos), spam de alertas offline e instabilidade no clock-proxy.

---

## Estado Atual (pré-plano)

### O que já foi corrigido e deployado nesta sessão
| Fix | Arquivo | Deploy |
|-----|---------|--------|
| Cooldown 30min alertas offline (TERMIPA5) | `alertEngine.js` | ✅ Azure VM |
| Reset cooldown no heartbeat | `agent.js` | ✅ Azure VM |

### O que foi codificado mas NÃO deployado ainda
| Fix | Arquivo | Commit |
|-----|---------|--------|
| `login()`: detecta "Outra conexão" + força desconexão | `henry-hexa.js` | `23cc0b5` |
| `enrollEmployee()`: timeout `#lblName` 15s → 30s | `henry-hexa.js` | `23cc0b5` |
| `enrollEmployee()` + `updateCardRef2()`: flag `savedEarly` | `henry-hexa.js` | `23cc0b5` |

**Atenção:** clock-proxy está rodando no Servidor Skill mas foi iniciado **manualmente** (não via PM2). O PM2 não está gerenciando o processo atual.

---

## Inventário Completo de Erros Observados

| # | Erro | Tipo | Status |
|---|------|------|--------|
| 1 | Spam de alertas offline — TERMIPA5 | Bug de código | ✅ Corrigido + deployado |
| 2 | clock-proxy indisponível (Temp dir ausente) | Configuração | ✅ Resolvido no Servidor Skill |
| 3 | `browserType.launch: ENOENT mkdtemp` | Configuração | ✅ Resolvido (pasta Temp\1\ criada) |
| 4 | "Outra conexão está ativa" | Bug de código | ✅ Codificado — aguarda deploy |
| 5 | Timeout 15000ms `#lblName` | Bug de código | ✅ Codificado — aguarda deploy |
| 6 | "Salvar não confirmado — tela: ''" | Bug de código | ✅ Codificado — aguarda deploy |
| 7 | "Login falhou — tela: LOGIN \| Usuário: \| Senha:" | A investigar | ⚠️ Provável: credencial diferente em 1 relógio |
| 8 | Conflito de Ref1 (matrícula duplicada) | Dado / RH | ❌ Não corrigível em código |
| 9 | PM2 não está gerenciando o processo | Operacional | ❌ Precisa restauração |

---

## Riscos Identificados no Código Atual (commit 23cc0b5)

### Risco 1 — `forceBtn` locator muito amplo
```javascript
const forceBtn = page.locator('a, button').filter({
  hasText: /Continuar|Desconectar|Forçar|Forcar|OK/i,
}).first();
```
`OK` pode coincidir com outros botões na página (confirmações de dialog, alertas). Se Henry Hexa tiver qualquer botão com texto "OK" em tela de erro diferente, o código clicaria no lugar errado.

**Mitigação:** Remover `OK` do regex. Os textos mais prováveis para força-desconexão no Hexa ADV são `Continuar` e `Desconectar`. Podemos adicionar outros à medida que descobrirmos.

### Risco 2 — `Promise.race` com `loggedIn` mutation em `.then()`
```javascript
await Promise.race([
  page.waitForSelector('text=Colaboradores', { timeout: 30000 }).then(() => { loggedIn = true; }),
  page.waitForSelector('text=Outra conexão', ...),
  ...
]);
```
Se o `Promise.race` resolver via "Outra conexão" e **depois** "Colaboradores" aparecer (ex: force disconnect trabalhou e a página navegou), `loggedIn` pode ser setado após o `if (!loggedIn)` já ter executado.

**Análise:** Na prática, o fluxo entra em `if (!loggedIn)`, detecta session conflict, clica forceBtn, aguarda "Colaboradores" com `waitForSelector`. Se isso funcionar, a função retorna `return`. A mutation tardia de `loggedIn` não causa problema neste fluxo. Risco baixo.

### Risco 3 — Niterói: "Login falhou — tela: LOGIN | Usuário: | Senha:"
Este erro **não é "Outra conexão"** — é o servidor do relógio rejeitando as credenciais (página retorna ao formulário de login). O novo código trata corretamente (throws com mensagem clara), mas **não resolve a causa raiz**.

Causas possíveis:
- Niterói tem senha diferente de `111111`
- Race condition na criptografia RSA (chave carregada mas timing diferente)
- Throttle do firmware após múltiplas tentativas rápidas

**Precisa investigação antes de qualquer fix de código.**

---

## Arquitetura de Dependências

```
Servidor Skill (192.168.17.252)
  └── dt-clock-proxy (Node.js PM2)
        ├── server.js          — Express, filas, endpoints
        └── henry-hexa.js      — Playwright, automação web
              └── Chrome.exe   — Headless, controla UI relógio
                    └── Henry Hexa ADV (192.168.x.151)
                          └── Firmware web (RSA login, CRUD colaboradores)

Azure VM → [IPsec → Metro pfSense → IPsec → EC pfSense] → Servidor Skill
  └── dt-manager (Node.js PM2)
        └── routes/rh.js       — Proxy para clock-proxy
              └── alertEngine.js — Alertas offline com cooldown
```

---

## Plano de Tarefas

### Fase 1 — Deploy e Restauração do PM2
**Objetivo:** Colocar o clock-proxy em estado estável com o código mais recente e gerenciado por PM2.

#### Tarefa 1.1 — Corrigir `forceBtn` antes do deploy
**Descrição:** Remover `OK` do regex do `forceBtn` locator para evitar click acidental.

**Aceitação:**
- [ ] Regex em `login()` não contém `OK`
- [ ] Mantém `Continuar`, `Desconectar`, `Forçar`, `Forcar`

**Arquivos:** `F:\RichClub\clock-proxy\henry-hexa.js` (linha ~77)  
**Escopo:** XS — 1 linha

---

#### Tarefa 1.2 — Deploy do `henry-hexa.js` via RDP + restaurar PM2
**Descrição:** Copiar arquivo atualizado para o Servidor Skill e reiniciar via PM2 (não Start-Process manual).

**Sequência exata (via RDP no Servidor Skill):**
```powershell
# 1. Copiar arquivo do PC local (via redirecionamento de drive RDP)
Copy-Item "\\tsclient\F\RichClub\clock-proxy\henry-hexa.js" "C:\DtClockProxy\henry-hexa.js" -Force

# 2. Matar processos node manualmente iniciados
Stop-Process -Name node -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# 3. Restaurar via PM2 (inicia daemon + ressurge processos salvos)
pm2 resurrect

# 4. Verificar saúde
Start-Sleep -Seconds 3
pm2 list
Invoke-RestMethod http://localhost:4321/health
```

**Aceitação:**
- [ ] `pm2 list` mostra `dt-clock-proxy` com status `online`
- [ ] `http://localhost:4321/health` retorna `{ ok: true }`
- [ ] Apenas 1 processo node rodando para o clock-proxy

**Escopo:** XS — operacional

---

### Checkpoint 1
- [ ] `pm2 list` online
- [ ] `/health` respondendo
- [ ] Apenas 1 node process

---

### Fase 2 — Verificação dos Fixes Deployados
**Objetivo:** Confirmar que os 3 fixes de código funcionam em produção.

#### Tarefa 2.1 — Testar "Outra conexão" (erro 4)
**Descrição:** Abrir o relógio que teve sessão presa (Metro 192.168.14.151 ou Niterói) num browser manualmente, deixar logado, então tentar enroll via dashboard.

**Verificação:**
- [ ] Dashboard não mostra mais "Erro Playwright: Login falhou — Outra conexão está ativa"
- [ ] OU mostra "Outra conexão está ativa no relógio — não foi possível forçar desconexão (botão não encontrado)" se Henry Hexa não tiver botão Continuar/Desconectar (nesse caso, precisamos capturar o texto real do botão)

**Observação:** Se o teste revelar que o botão tem nome diferente (ex: "Sim", "Prosseguir"), atualizar o regex na Tarefa 1.1 e fazer redeploy.

---

#### Tarefa 2.2 — Testar "Salvar não confirmado — tela: ''" (erro 6)
**Descrição:** Executar Sincronizar Todos e verificar se o erro de tela vazia persiste.

**Verificação:**
- [ ] Não aparece mais "Salvar não confirmado — tela: ''"
- [ ] Jobs completam com ✅ ou com erros significativos (não erro de captura de tela vazia)

---

### Fase 3 — Investigação do Login Niterói (erro 7)
**Objetivo:** Determinar causa raiz do "Login falhou — tela: LOGIN | Usuário: | Senha:" antes de qualquer fix de código.

#### Tarefa 3.1 — Teste manual de credenciais em Niterói
**Descrição:** Acessar `http://192.168.10.150` via browser no Servidor Skill e tentar login com `teste fabrica` / `111111`.

**Verificação:**
- [ ] Login funciona manualmente → causa é timing/throttle de firmware (fix: retry com delay)
- [ ] Login falha manualmente → causa é credencial diferente (ação: reset de senha físico no relógio)

**Condição de saída:** Só prosseguir para fix de código SE login manual funcionar (descarta problema de credencial).

---

#### Tarefa 3.2 — (Condicional) Fix de retry no login
**Só executar se Tarefa 3.1 confirmar que credenciais estão certas.**

**Descrição:** Adicionar retry no `login()` quando detectar retorno à tela de login (credentials rejected), com delay de 5s entre tentativas.

**Aceitação:**
- [ ] Até 2 retentativas automáticas
- [ ] Mensagem de erro inclui número de tentativas
- [ ] Não afeta fluxo normal (login na 1ª tentativa)

**Arquivos:** `henry-hexa.js`, método `login()`  
**Escopo:** S — ~20 linhas

---

### Fase 4 — Dados: Conflito de Ref1 (erro 8)
**Objetivo:** Documentar e comunicar os 8 pares de funcionários com Ref1 duplicada para ação do RH.

#### Tarefa 4.1 — Levantar lista completa de conflitos
**Descrição:** Os conflitos de Ref1 já são conhecidos (mapeados na memória do projeto): 8 pares/trios com matrículas 693, 903, 909, 922, 923, 924, 926, 936. Não é bug de código — é dado.

**Ação requerida (fora do escopo de código):**
- RH/SAP deve atribuir matrículas únicas a cada funcionário
- Após correção dos dados, re-sincronizar os afetados

**Aceitação:**
- [ ] Lista dos 8 pares comunicada ao RH
- [ ] Dashboard exibe mensagem clara de "Conflito de Ref1" (já funciona ✅)

---

### Checkpoint Final
- [ ] PM2 gerenciando clock-proxy
- [ ] "Outra conexão" tratada automaticamente ou com erro claro
- [ ] "Salvar não confirmado — tela: ''" eliminado
- [ ] Niterói: causa raiz identificada
- [ ] Ref1 conflicts: RH notificado

---

## Riscos e Mitigações

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| PM2 `dump.pm2` corrompido/ausente | Médio | Fallback: `pm2 start server.js --name dt-clock-proxy` em `C:\DtClockProxy` |
| `forceBtn` "Continuar" não existe no Hexa ADV | Médio | Tarefa 2.1 confirma; se falhar, capturar screenshot para identificar botão real |
| Niterói tem senha diferente | Alto | Requer acesso físico ao relógio para reset de fábrica |
| `savedEarly` verdadeiro mas relógio não persistiu | Baixo | Verificação pós-save via `navigateAndSearchByCPF` já cobre esse caso |

---

## Ordem de Execução

```
1.1 → 1.2 → [Checkpoint 1] → 2.1 → 2.2 → [Checkpoint 2] → 3.1 → (3.2 se necessário) → 4.1
```

---

## Fora do Escopo (deferidos)

- Trocar senhas de fábrica `111111` nos 10 relógios (LGPD Art. 46)
- Corrigir bug de encoding no `deploy-remote.ps1`
- Relógios Città e Tijuca (problemas de hardware físico)
