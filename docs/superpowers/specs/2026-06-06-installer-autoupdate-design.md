# Installer + Auto-Update — Design Spec

## Objetivo

Empacotar o Delirio Manager como instalador Windows (`.exe`) com ícone próprio, atalho na área de trabalho e sistema de auto-update silencioso para distribuição a 4 usuários (André + 3 funcionários da Delírio Tropical).

---

## Decisões de Design

| Decisão | Escolha |
|---------|---------|
| Update behavior | Silencioso — baixa em background, instala na próxima abertura |
| Ícone | Opção C — fundo escuro `#0f1117`, tilde coral `#FF5C39`, "DELÍRIO" verde `#00B373`, "MANAGER" branco |
| Update hosting | VM Azure existente — nova rota `/dashboard-updates/` no servidor Node.js |
| Installer format | NSIS (.exe) via electron-builder (já configurado no projeto) |
| Distribuição inicial | André envia o `.exe` para os 3 funcionários |

---

## Arquitetura

```
[Código modificado]
    → npm run dist  (electron-builder)
    → dist-electron/Delirio Manager Setup x.x.x.exe
    → latest.yml + update files
    → npm run release  (script de deploy)
    → uploads para VM: /opt/dt-manager/public/dashboard-updates/

[App instalado no PC do funcionário]
    → abre o app
    → electron-updater checa https://dt-manager.../dashboard-updates/latest.yml
    → se versão nova: baixa silenciosamente
    → na próxima abertura: instala e reinicia transparentemente
```

---

## Componentes

### 1. Geração do ícone

**Script:** `dashboard/scripts/build-icon.js`

Usa `@napi-rs/canvas` (canvas puro JS, sem bindings nativos problemáticos) para gerar:
- `dashboard/electron/icon.png` — 512×512px
- Fundo: `#0f1117` (arredondado, rx=80)
- Tilde decorativa coral: `#FF5C39` (path SVG estilizado)
- "DELÍRIO": verde `#00B373`, bold, 80px, tracking +4px
- "MANAGER": branco `#ffffff`, 32px, tracking +8px, opacity 0.75

electron-builder converte o PNG para `.ico` multi-tamanho (16, 32, 48, 256px) automaticamente.

**Quando rodar:** `npm run build:icon` (uma vez, ou ao mudar o ícone). O arquivo gerado é commitado no repositório.

### 2. Configuração electron-builder

**Arquivo:** `dashboard/package.json` — bloco `"build"`

Adições ao config existente:
```json
"publish": {
  "provider": "generic",
  "url": "https://dt-manager.brazilsouth.cloudapp.azure.com/dashboard-updates/"
},
"nsis": {
  "oneClick": false,
  "allowToChangeInstallationDirectory": true,
  "createDesktopShortcut": true,
  "createStartMenuShortcut": true,
  "shortcutName": "Delirio Manager"
}
```

### 3. Auto-updater no main.js

**Arquivo:** `dashboard/electron/main.js`

Lógica adicionada ao `app.whenReady()`:
- Importa `autoUpdater` de `electron-updater`
- `autoUpdater.checkForUpdatesAndNotify()` — silencioso
- Eventos: `update-downloaded` → `autoUpdater.quitAndInstall(true, false)` (instala na próxima abertura, sem forçar reinício imediato)
- Logs de update em desenvolvimento (não visíveis em produção)
- Só verifica updates se `app.isPackaged` (não roda em desenvolvimento)

### 4. Servidor de updates na VM

**Arquivo:** `server/server.js`

Nova rota estática:
```javascript
app.use('/dashboard-updates', express.static(
  path.join(PUBLIC_DIR, 'dashboard-updates')
))
```

Pasta criada na VM: `/opt/dt-manager/public/dashboard-updates/`

Arquivos servidos por versão:
- `latest.yml` — manifesto da versão atual (gerado pelo electron-builder)
- `Delirio Manager Setup x.x.x.exe` — installer completo
- `Delirio Manager-x.x.x-full.nupkg` — pacote de update (gerado pelo electron-builder)

### 5. Script de release

**Arquivo:** `dashboard/scripts/release.sh`

Executado no Bash pelo André após fazer alterações:
```bash
# 1. Builda o installer + arquivos de update
npm run dist

# 2. Faz upload dos arquivos de update para a VM
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "mkdir -p /opt/dt-manager/public/dashboard-updates"

# 3. Envia latest.yml
b64=$(base64 -w 0 "dist-electron/latest.yml")
az vm run-command invoke ... --scripts "echo '$b64' | base64 -d > /opt/dt-manager/public/dashboard-updates/latest.yml"

# 4. Envia o installer (binário grande — via endpoint /api/update/upload)
# usa Invoke-RestMethod ou curl para o endpoint de upload
```

Para o installer (arquivo binário grande, ~80-120MB), o upload via base64/az é inviável (limite de tamanho do az run-command). Solução: endpoint protegido no servidor Node.js:

```bash
# Envia o installer via multipart POST
curl -X POST https://dt-manager.brazilsouth.cloudapp.azure.com/api/update/upload-dashboard \
  -F "file=@dist-electron/Delirio Manager Setup 1.1.0.exe" \
  -H "X-Upload-Secret: <segredo_em_config.json>"
```

O servidor salva o arquivo em `/opt/dt-manager/public/dashboard-updates/`. O segredo é lido de `config.json` (campo `uploadSecret`). André configura esse segredo uma única vez.

**Nota:** `latest.yml` é o arquivo crítico para o auto-updater. Sem ele atualizado, os apps não veem a nova versão. O `latest.yml` é pequeno (~200 bytes) e pode ser deployado via base64/az normalmente.

---

## Fluxo de Release (passo a passo para André)

```
1. Modificar código do dashboard
2. Editar dashboard/package.json → incrementar "version": "1.0.x" → "1.0.x+1"
3. Rodar: npm run dist
   → gera: dist-electron/Delirio Manager Setup x.x.x.exe
   → gera: dist-electron/latest.yml
4. Rodar: npm run release
   → faz upload do latest.yml e do installer para a VM
5. Pronto — apps dos funcionários atualizam silenciosamente na próxima abertura
```

---

## Distribuição Inicial

André envia `dist-electron/Delirio Manager Setup x.x.x.exe` para os 3 funcionários (e-mail, WhatsApp, etc.).

Instalação pelo funcionário:
1. Duplo clique no `.exe`
2. Autorizar UAC (prompt de administrador)
3. Escolher diretório (padrão: `C:\Program Files\Delirio Manager\`)
4. Concluir
5. Ícone aparece na área de trabalho e no menu Iniciar

---

## Arquivos tocados

| Arquivo | Ação | Responsabilidade |
|---------|------|-----------------|
| `dashboard/scripts/build-icon.js` | Criar | Gera icon.png 512×512 com design C |
| `dashboard/electron/icon.png` | Criar (gerado) | Ícone do app |
| `dashboard/package.json` | Modificar | Adicionar electron-updater, publish config, scripts |
| `dashboard/electron/main.js` | Modificar | Integrar autoUpdater silencioso |
| `server/server.js` | Modificar | Servir /dashboard-updates/ estaticamente |
| `dashboard/scripts/release.sh` | Criar | Script de deploy de novas versões |
| `server/routes/update.js` | Modificar | Adicionar POST /api/update/upload-dashboard (multipart, protegido por uploadSecret) |

---

## Sincronização em Tempo Real — Múltiplos Dashboards

**Esta funcionalidade já está implementada e não requer alterações.**

Quando qualquer evento ocorre (máquina online, agente instalado, heartbeat, alerta):
1. O servidor recebe o evento via API REST
2. Chama `broadcast()` em `services/websocket.js`
3. `wss.clients.forEach(ws => ws.send(msg))` — envia para **todos** os clientes conectados simultaneamente
4. Cada dashboard Electron recebe o update via WebSocket e atualiza o estado em tempo real

**Capacidade confirmada:**
- PM2 roda em `instances: 1` (single process) — broadcast alcança 100% dos clientes conectados
- 20 conexões WebSocket simultâneas = ~2MB RAM extra (VM usa 45MB de 2GB disponíveis)
- SQLite em WAL mode suporta leituras concorrentes sem bloqueio
- Arquitetura suporta dezenas de dashboards simultâneos sem modificação

**Limite real de escala:** se no futuro ultrapassar ~100 dashboards simultâneos, considerar migrar PM2 para cluster mode + Redis adapter para WebSocket. Para o cenário atual e previsível (4-20 usuários), a arquitetura atual é suficiente.

---

## O que NÃO muda

- Código React/frontend do dashboard
- Servidor Node.js (só adiciona rota estática)
- Agente Go
- Configuração da VM (só cria pasta dentro do diretório já existente)
