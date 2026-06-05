# Installer + Auto-Update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empacotar o Delirio Manager como instalador Windows (.exe) com ícone próprio da marca, atalho na área de trabalho, e auto-update silencioso distribuído via VM Azure existente.

**Architecture:** `electron-updater` checa `latest.yml` em `https://dt-manager.../dashboard-updates/` no início de cada sessão, baixa updates em background, instala silenciosamente no próximo fechamento do app. O servidor Node.js existente serve os arquivos de update estaticamente e expõe um endpoint protegido para upload do installer binário. Um script de release automatiza o ciclo build→deploy.

**Tech Stack:** electron-builder 25, electron-updater 6, @napi-rs/canvas (geração de ícone), multer (upload multipart no servidor), NSIS (installer Windows)

---

## Mapa de Arquivos

| Arquivo | Ação |
|---------|------|
| `dashboard/scripts/build-icon.js` | Criar — gera icon.png 512×512 com design da marca |
| `dashboard/electron/icon.png` | Criar (gerado pelo script acima) |
| `dashboard/package.json` | Modificar — electron-updater, publish config, scripts |
| `dashboard/electron/main.js` | Modificar — integrar autoUpdater silencioso |
| `dashboard/scripts/release.sh` | Criar — script de build + deploy de novas versões |
| `dashboard/release-secret.txt.example` | Criar — exemplo do arquivo de segredo |
| `server/package.json` | Modificar — adicionar multer |
| `server/routes/update.js` | Modificar — endpoint POST /api/update/upload-dashboard |
| `server/server.js` | Modificar — rota estática /dashboard-updates/ |

---

## Task 1: Instalar dependências

**Files:**
- Modify: `dashboard/package.json` (scripts)
- Modify: `server/package.json`

- [ ] **Step 1: Instalar dependências do dashboard**

```powershell
cd F:\RichClub\dashboard
npm install electron-updater@^6.3.0
npm install --save-dev @napi-rs/canvas@^0.1.57
```

Esperado: `node_modules/electron-updater/` e `node_modules/@napi-rs/canvas/` criados sem erros.

- [ ] **Step 2: Instalar multer no servidor**

```powershell
cd F:\RichClub\server
npm install multer@^1.4.5-lts.1
```

Esperado: `node_modules/multer/` criado.

---

## Task 2: Script de geração do ícone

**Files:**
- Create: `dashboard/scripts/build-icon.js`
- Create: `dashboard/electron/icon.png` (gerado)

- [ ] **Step 1: Criar o diretório scripts se não existir**

```powershell
New-Item -ItemType Directory -Force -Path "F:\RichClub\dashboard\scripts" | Out-Null
```

- [ ] **Step 2: Criar `dashboard/scripts/build-icon.js`**

```javascript
'use strict';

const { createCanvas } = require('@napi-rs/canvas');
const fs   = require('fs');
const path = require('path');

const SIZE = 512;
const R    = 80; // corner radius

const canvas = createCanvas(SIZE, SIZE);
const ctx    = canvas.getContext('2d');

// ── Fundo escuro com cantos arredondados ──────────────────────────────────
ctx.fillStyle = '#0f1117';
ctx.beginPath();
ctx.moveTo(R, 0);
ctx.lineTo(SIZE - R, 0);
ctx.quadraticCurveTo(SIZE, 0, SIZE, R);
ctx.lineTo(SIZE, SIZE - R);
ctx.quadraticCurveTo(SIZE, SIZE, SIZE - R, SIZE);
ctx.lineTo(R, SIZE);
ctx.quadraticCurveTo(0, SIZE, 0, SIZE - R);
ctx.lineTo(0, R);
ctx.quadraticCurveTo(0, 0, R, 0);
ctx.closePath();
ctx.fill();

// ── Tilde coral (decoração da marca) ─────────────────────────────────────
ctx.strokeStyle = '#FF5C39';
ctx.lineWidth   = 16;
ctx.lineCap     = 'round';
ctx.beginPath();
ctx.moveTo(90,  155);
ctx.bezierCurveTo(145, 95,  210, 95,  256, 150);
ctx.bezierCurveTo(302, 205, 367, 205, 422, 145);
ctx.stroke();

// ── "DELÍRIO" em verde ────────────────────────────────────────────────────
ctx.fillStyle  = '#00B373';
ctx.font       = 'bold 96px Arial, sans-serif';
ctx.textAlign  = 'center';
ctx.textBaseline = 'middle';
ctx.fillText('DELÍRIO', SIZE / 2, 310);

// ── "MANAGER" em branco ───────────────────────────────────────────────────
ctx.fillStyle = 'rgba(255,255,255,0.75)';
ctx.font      = '48px Arial, sans-serif';
ctx.fillText('MANAGER', SIZE / 2, 405);

// ── Salva PNG ─────────────────────────────────────────────────────────────
const outPath = path.join(__dirname, '..', 'electron', 'icon.png');
fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
console.log('✓ Ícone gerado:', outPath);
```

- [ ] **Step 3: Gerar o ícone**

```powershell
cd F:\RichClub\dashboard
node scripts/build-icon.js
```

Esperado: `✓ Ícone gerado: ...electron/icon.png` e arquivo criado em `dashboard/electron/icon.png`.

---

## Task 3: Configurar dashboard/package.json

**Files:**
- Modify: `dashboard/package.json`

- [ ] **Step 1: Atualizar package.json com novo conteúdo completo**

```json
{
  "name": "delirio-manager-dashboard",
  "version": "1.0.0",
  "description": "Delirio Manager - Dashboard de Monitoramento",
  "main": "electron/main.js",
  "scripts": {
    "dev":        "vite",
    "build":      "vite build",
    "build:icon": "node scripts/build-icon.js",
    "electron":   "electron .",
    "start":      "concurrently \"vite\" \"wait-on http://localhost:5173 && electron .\"",
    "dist":       "npm run build:icon && vite build && electron-builder",
    "release":    "bash scripts/release.sh"
  },
  "dependencies": {
    "electron-updater": "^6.3.0",
    "react":            "^19.0.0",
    "react-dom":        "^19.0.0"
  },
  "devDependencies": {
    "@napi-rs/canvas":    "^0.1.57",
    "@vitejs/plugin-react":"^4.3.0",
    "concurrently":        "^9.0.0",
    "electron":            "^34.0.0",
    "electron-builder":    "^25.0.0",
    "vite":                "^6.0.0",
    "wait-on":             "^8.0.0"
  },
  "build": {
    "appId":       "com.deliriotropical.manager",
    "productName": "Delirio Manager",
    "directories": { "output": "dist-electron" },
    "files": ["dist/**/*", "electron/**/*"],
    "win": {
      "target": "nsis",
      "icon":   "electron/icon.png"
    },
    "nsis": {
      "oneClick":                      false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut":         true,
      "createStartMenuShortcut":       true,
      "shortcutName":                  "Delirio Manager"
    },
    "publish": {
      "provider": "generic",
      "url": "https://dt-manager.brazilsouth.cloudapp.azure.com/dashboard-updates/"
    }
  }
}
```

---

## Task 4: Auto-updater silencioso no main.js

**Files:**
- Modify: `dashboard/electron/main.js`

- [ ] **Step 1: Adicionar import e lógica do autoUpdater**

Localizar a linha `'use strict'` no topo de `dashboard/electron/main.js` e adicionar o import após os requires existentes:

O arquivo completo após a modificação:

```javascript
'use strict'

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const fs   = require('fs')

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')
const IS_DEV      = process.env.NODE_ENV === 'development' || !app.isPackaged

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { serverUrl: 'https://dt-manager.brazilsouth.cloudapp.azure.com' }
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

function setupAutoUpdater() {
  // Só verifica updates em producao (app empacotado)
  if (!app.isPackaged) return

  const { autoUpdater } = require('electron-updater')

  autoUpdater.logger            = null  // sem logs em producao
  autoUpdater.autoDownload      = true  // baixa automaticamente
  autoUpdater.autoInstallOnAppQuit = true  // instala ao fechar o app

  // Silencia todos os dialogos — update 100% transparente
  autoUpdater.on('error', () => {})
  autoUpdater.on('update-downloaded', () => {
    // Update baixado e pronto — será instalado quando o usuario fechar o app
  })

  autoUpdater.checkForUpdates().catch(() => {})
}

function createWindow() {
  const win = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  1440,
    minHeight: 600,
    title: 'Delirio Manager',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })

  if (!IS_DEV) win.setMenuBarVisibility(false)

  if (IS_DEV) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', (_, cfg) => { saveConfig(cfg); return true })

  createWindow()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

---

## Task 5: Endpoint de upload do installer no servidor

**Files:**
- Modify: `server/routes/update.js`
- Modify: `server/package.json`

- [ ] **Step 1: Adicionar multer ao server/package.json**

Localizar as dependencies em `server/package.json` e adicionar `"multer": "^1.4.5-lts.1"`:

```json
{
  "name": "dt-manager-server",
  "version": "1.0.0",
  "description": "Delirio Manager - Servidor Central",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.100.1",
    "better-sqlite3": "^11.0.0",
    "express": "^4.19.2",
    "multer": "^1.4.5-lts.1",
    "nodemailer": "^8.0.10",
    "pdfkit": "^0.15.0",
    "ws": "^8.17.1"
  }
}
```

- [ ] **Step 2: Adicionar endpoint de upload ao final de `server/routes/update.js`**

Adicionar antes da linha `module.exports = router;`:

```javascript
// ── Upload do installer do dashboard ──────────────────────────────────────

const multer = require('multer');

const dashboardUpdatesDir = path.join(PUBLIC_DIR, 'dashboard-updates');
fs.mkdirSync(dashboardUpdatesDir, { recursive: true });

const dashboardStorage = multer.diskStorage({
  destination: dashboardUpdatesDir,
  filename:    (_req, file, cb) => cb(null, file.originalname),
});
const uploadDashboard = multer({
  storage: dashboardStorage,
  limits:  { fileSize: 500 * 1024 * 1024 }, // 500MB max
});

function loadServerConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

// POST /api/update/upload-dashboard — envia installer ou latest.yml para o servidor
// Header: X-Upload-Secret com o valor de config.json.uploadSecret
router.post('/upload-dashboard', (req, res, next) => {
  const cfg    = loadServerConfig();
  const secret = cfg.uploadSecret;
  if (!secret || req.headers['x-upload-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized — configure uploadSecret em config.json' });
  }
  next();
}, uploadDashboard.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  console.log(`[Update] Dashboard file uploaded: ${req.file.originalname} (${Math.round(req.file.size / 1024)}KB)`);
  res.json({ ok: true, filename: req.file.originalname, size: req.file.size });
});
```

---

## Task 6: Rota estática /dashboard-updates/ no servidor

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Adicionar rota estática e criação do diretório**

Localizar o bloco de rotas estáticas no `server/server.js` (onde estão os handlers de `/install.ps1`, `/downloads/delirio-agent.exe` e `/downloads/lhm.zip`) e adicionar logo após a definição de `PUBLIC_DIR`:

Localizar:
```javascript
const PUBLIC_DIR = path.join(__dirname, 'public');
```

Adicionar imediatamente abaixo:
```javascript
// Dashboard updates — servidos estaticamente para o electron-updater
const DASHBOARD_UPDATES_DIR = path.join(PUBLIC_DIR, 'dashboard-updates');
fs.mkdirSync(DASHBOARD_UPDATES_DIR, { recursive: true });
app.use('/dashboard-updates', express.static(DASHBOARD_UPDATES_DIR));
```

---

## Task 7: Script de release + arquivo de segredo

**Files:**
- Create: `dashboard/scripts/release.sh`
- Create: `dashboard/release-secret.txt.example`

- [ ] **Step 1: Criar `dashboard/scripts/release.sh`**

```bash
#!/bin/bash
# release.sh — build e deploy de nova versao do Delirio Manager Dashboard
# Uso: bash scripts/release.sh
# Prerequisito: criar release-secret.txt com o valor de config.json.uploadSecret na VM

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$(dirname "$SCRIPT_DIR")"
SECRET_FILE="$DASHBOARD_DIR/release-secret.txt"

# Verifica segredo
if [ ! -f "$SECRET_FILE" ]; then
  echo "❌ Arquivo release-secret.txt não encontrado."
  echo "   Crie o arquivo com o valor de uploadSecret do config.json da VM."
  echo "   Exemplo: echo 'meu-segredo-aqui' > release-secret.txt"
  exit 1
fi

UPLOAD_SECRET=$(cat "$SECRET_FILE" | tr -d '[:space:]')
if [ -z "$UPLOAD_SECRET" ]; then
  echo "❌ release-secret.txt está vazio."
  exit 1
fi

# Lê versão atual
VERSION=$(node -e "console.log(require('$DASHBOARD_DIR/package.json').version)")
echo "🚀 Releasing Delirio Manager v$VERSION..."
echo ""

# 1. Build
echo "📦 Gerando installer..."
cd "$DASHBOARD_DIR"
npm run dist
echo "✓ Build concluído"
echo ""

# 2. Verifica arquivos gerados
INSTALLER="$DASHBOARD_DIR/dist-electron/Delirio Manager Setup $VERSION.exe"
LATEST_YML="$DASHBOARD_DIR/dist-electron/latest.yml"

if [ ! -f "$LATEST_YML" ]; then
  echo "❌ latest.yml não encontrado em dist-electron/"
  exit 1
fi

if [ ! -f "$INSTALLER" ]; then
  echo "❌ Installer não encontrado: $INSTALLER"
  exit 1
fi

SERVER="https://dt-manager.brazilsouth.cloudapp.azure.com"

# 3. Upload do latest.yml (pequeno — via base64/az)
echo "📤 Enviando latest.yml para a VM..."
b64=$(base64 -w 0 "$LATEST_YML")
az vm run-command invoke \
  --resource-group rg-dt-manager \
  --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "mkdir -p /opt/dt-manager/public/dashboard-updates && echo '$b64' | base64 -d > /opt/dt-manager/public/dashboard-updates/latest.yml && echo OK_YML" \
  --output none
echo "✓ latest.yml enviado"
echo ""

# 4. Upload do installer via endpoint protegido
INSTALLER_SIZE=$(du -sh "$INSTALLER" | cut -f1)
echo "📤 Enviando installer ($INSTALLER_SIZE)..."
RESPONSE=$(curl -s -X POST \
  "$SERVER/api/update/upload-dashboard" \
  -F "file=@$INSTALLER" \
  -H "X-Upload-Secret: $UPLOAD_SECRET" \
  --progress-bar 2>&1)

if echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "✓ Installer enviado com sucesso"
else
  echo "❌ Falha no upload do installer: $RESPONSE"
  exit 1
fi

echo ""
echo "✅ Release v$VERSION concluído!"
echo "   Os dashboards instalados atualizarão silenciosamente na próxima abertura."
```

- [ ] **Step 2: Criar `dashboard/release-secret.txt.example`**

```
# Copie este arquivo para release-secret.txt e preencha com o valor de
# uploadSecret do /opt/dt-manager/config.json na VM Azure.
#
# NUNCA commite release-secret.txt no repositório.
#
# Para definir o segredo na VM, execute:
#   az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
#     --command-id RunShellScript \
#     --scripts "cd /opt/dt-manager && node -e \"const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.json','utf8'));c.uploadSecret='SEU-SEGREDO-AQUI';fs.writeFileSync('config.json',JSON.stringify(c,null,2));console.log('OK')\""

SEU-SEGREDO-AQUI
```

- [ ] **Step 3: Adicionar release-secret.txt ao .gitignore**

Verificar se existe `F:\RichClub\dashboard\.gitignore`. Se não existir, criar:
```
node_modules/
dist/
dist-electron/
release-secret.txt
```

Se existir, apenas adicionar `release-secret.txt` ao final.

---

## Task 8: Configurar uploadSecret na VM

- [ ] **Step 1: Definir o segredo na VM via az**

Escolha um segredo forte (ex: UUID ou senha aleatória). Substitua `MEU-SEGREDO-FORTE` pelo valor escolhido:

```bash
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "cd /opt/dt-manager && node -e \"const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.json','utf8'));c.uploadSecret='MEU-SEGREDO-FORTE';fs.writeFileSync('config.json',JSON.stringify(c,null,2));console.log('OK_SECRET')\""
```

Esperado: `OK_SECRET` no output.

- [ ] **Step 2: Criar release-secret.txt localmente**

```powershell
# Substitua MEU-SEGREDO-FORTE pelo mesmo segredo usado no Step 1
"MEU-SEGREDO-FORTE" | Out-File -FilePath "F:\RichClub\dashboard\release-secret.txt" -Encoding utf8 -NoNewline
```

---

## Task 9: Deploy server changes + npm install na VM

- [ ] **Step 1: Deploy server/package.json**

```bash
b64=$(base64 -w 0 "F:/RichClub/server/package.json")
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/package.json && echo OK_PKG"
```

- [ ] **Step 2: Deploy server/routes/update.js**

```bash
b64=$(base64 -w 0 "F:/RichClub/server/routes/update.js")
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/routes/update.js && echo OK_UPDATE"
```

- [ ] **Step 3: Deploy server/server.js**

```bash
b64=$(base64 -w 0 "F:/RichClub/server/server.js")
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "echo '$b64' | base64 -d > /opt/dt-manager/server.js && echo OK_SERVER"
```

- [ ] **Step 4: npm install + pm2 restart na VM**

```bash
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "cd /opt/dt-manager && npm install --production && pm2 restart dt-manager && sleep 3 && pm2 logs dt-manager --lines 15 --nostream"
```

Verificar: `[Update]` e `[AlertEngine] Iniciado` nos logs, sem erros de `require('multer')`.

---

## Task 10: Build do installer

- [ ] **Step 1: Gerar o installer**

```powershell
cd F:\RichClub\dashboard
npm run dist
```

Esperado (em ~2-3 minutos):
- `dist-electron/Delirio Manager Setup 1.0.0.exe` — o installer
- `dist-electron/latest.yml` — manifesto de versão
- `dist-electron/Delirio Manager-1.0.0-full.nupkg` — pacote de update

- [ ] **Step 2: Verificar o installer**

Executar `dist-electron/Delirio Manager Setup 1.0.0.exe` na própria máquina:
- UAC pede permissão → autorizar
- Tela de instalação aparece (não one-click)
- Instalar em `C:\Program Files\Delirio Manager\` (padrão)
- Ícone "Delirio Manager" aparece na área de trabalho
- Ícone "Delirio Manager" aparece no Menu Iniciar
- Abrir pelo ícone da área de trabalho — dashboard carrega normalmente
- "Delirio Manager" aparece em Configurações → Aplicativos → Aplicativos instalados

---

## Task 11: Primeiro release (publicar versão inicial)

- [ ] **Step 1: Rodar o script de release**

```bash
cd "F:/RichClub/dashboard"
bash scripts/release.sh
```

Esperado:
- `✓ Build concluído`
- `✓ latest.yml enviado`
- `✓ Installer enviado com sucesso`
- `✅ Release v1.0.0 concluído!`

- [ ] **Step 2: Verificar que os arquivos chegaram na VM**

```bash
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "ls -la /opt/dt-manager/public/dashboard-updates/ && cat /opt/dt-manager/public/dashboard-updates/latest.yml"
```

Esperado: `latest.yml` e `Delirio Manager Setup 1.0.0.exe` listados.

- [ ] **Step 3: Verificar URL pública**

Abrir no browser: `https://dt-manager.brazilsouth.cloudapp.azure.com/dashboard-updates/latest.yml`

Esperado: arquivo YAML com `version: 1.0.0` e SHA256 do installer.

---

## Fluxo de releases futuros (referência)

Sempre que André fizer uma alteração no dashboard:
```
1. Editar código
2. Editar dashboard/package.json → incrementar "version": "1.0.x"
3. cd F:\RichClub\dashboard && bash scripts/release.sh
4. ✅ Pronto — dashboards instalados atualizam silenciosamente
```
