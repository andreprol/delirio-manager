# TODO — Módulo RH / clock-proxy
**Data:** 2026-06-22

## Fase 1 — Deploy e PM2

- [x] **1.1** Remover `OK` do regex `forceBtn` em `henry-hexa.js:~77` (XS)
- [x] **1.2** Deploy via RDP: copiar `henry-hexa.js` → matar node → `pm2 resurrect` → verificar `/health`

### Checkpoint 1
- [x] `pm2 list` mostra `dt-clock-proxy` online
- [x] `http://localhost:4321/health` OK
- [x] Apenas 1 processo node (PM2 gerenciando)

## Fase 2 — Verificação em produção

- [ ] **2.1** Testar tratamento de "Outra conexão": abrir relógio no browser manualmente → tentar sync
- [ ] **2.2** Rodar Sincronizar Todos e confirmar que "Salvar não confirmado — tela: ''" sumiu

## Fase 3 — Investigação Niterói

- [ ] **3.1** Acessar `http://192.168.10.150` via browser no Servidor Skill → testar login `teste fabrica` / `111111`
- [ ] **3.2** (Condicional) Se credenciais OK → implementar retry com delay no `login()`

## Fase 4 — Dados

- [ ] **4.1** Comunicar ao RH: 8 pares com Ref1 duplicada (693, 903, 909, 922, 923, 924, 926, 936) — precisam de matrículas únicas no SAP

## Concluídos nesta sessão

- [x] Fix cooldown 30min alertas offline (alertEngine.js) — deployado Azure VM
- [x] Reset cooldown no heartbeat (agent.js) — deployado Azure VM  
- [x] Pasta `C:\Users\Administrator\AppData\Local\Temp\1\` criada no Servidor Skill
- [x] node reiniciado no Servidor Skill (ainda não via PM2)
- [x] Código dos 3 fixes henry-hexa.js commitado (23cc0b5) — aguarda deploy
