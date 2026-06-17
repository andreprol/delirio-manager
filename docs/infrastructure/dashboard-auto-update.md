# Dashboard Auto-Update — Processo de Release

> **Status:** Produção ✅ | Configurado em: 2026-06-16

## Arquitetura

```
Electron App (instalações nas lojas)
  → autoUpdater.checkForUpdates() ao iniciar
  → GET https://dt-manager.brazilsouth.cloudapp.azure.com/dashboard-updates/latest.yml
  → compara versão local com versão no servidor
  → se nova: baixa .exe em background (delta update via .blockmap)
  → ao fechar: instala silenciosamente
  → próxima abertura: nova versão ativa
```

## Configuração (package.json)

```json
"build": {
  "publish": {
    "provider": "generic",
    "url": "https://dt-manager.brazilsouth.cloudapp.azure.com/dashboard-updates/"
  }
}
```

## Auto-updater (electron/main.js)

```js
autoUpdater.autoDownload = true          // baixa em background sem perguntar
autoUpdater.autoInstallOnAppQuit = true  // instala ao fechar — sem prompt
// só ativo em produção (app.isPackaged)
```

## Servidor de Atualizações (Azure VM)

- **Caminho:** `/opt/dt-manager/public/dashboard-updates/`
- **Rota Express:** `app.use('/dashboard-updates', express.static(DASHBOARD_UPDATES_DIR))`
- **Arquivos servidos:**
  - `latest.yml` — versão atual + SHA512 (lido pelo electron-updater)
  - `Delirio Manager Setup X.Y.Z.exe` — instalador completo
  - `Delirio Manager Setup X.Y.Z.exe.blockmap` — delta update (economiza banda)

## Processo de Release (passo a passo)

### 1. Fazer as mudanças no código

```powershell
# Editar os arquivos necessários em F:\RichClub\dashboard\src\
```

### 2. Bumpar a versão

```powershell
cd F:\RichClub\dashboard
npm version patch    # 1.0.4 → 1.0.5 (patch)
# npm version minor  # 1.0.4 → 1.1.0 (minor)
# npm version major  # 1.0.4 → 2.0.0 (major)
```

### 3. Build do instalador

```powershell
npm run dist
# Gera em dist-electron/:
#   Delirio Manager Setup X.Y.Z.exe         (~80 MB)
#   Delirio Manager Setup X.Y.Z.exe.blockmap (~87 KB)
#   latest.yml                               (< 1 KB)
```

### 4. Criar GitHub Release e fazer upload

```powershell
cd F:\RichClub

# Criar release com latest.yml e .blockmap (pequenos — rápido)
gh release create vX.Y.Z `
  "dashboard/dist-electron/latest.yml" `
  "dashboard/dist-electron/Delirio Manager Setup X.Y.Z.exe.blockmap" `
  --title "vX.Y.Z — descrição" `
  --notes "Changelog aqui"

# Upload do .exe (80 MB — demora ~1-2 min)
gh release upload vX.Y.Z "dashboard/dist-electron/Delirio Manager Setup X.Y.Z.exe"
```

> **Atenção:** GitHub renomeia espaços para pontos no nome do asset.  
> Ex: `Delirio Manager Setup 1.0.5.exe` → `Delirio.Manager.Setup.1.0.5.exe`  
> Ao baixar na VM, salvar com o nome original (com espaços) para corresponder ao `latest.yml`.

### 5. Publicar na Azure VM

```bash
# Via az vm run-command
az vm run-command invoke \
  --resource-group rg-dt-manager \
  --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "
DIR=/opt/dt-manager/public/dashboard-updates
VER=X.Y.Z

curl -fsSL -o \"\$DIR/latest.yml\" \
  'https://github.com/andreprol/delirio-manager/releases/download/v\$VER/latest.yml'

curl -fsSL -o \"\$DIR/Delirio Manager Setup \$VER.exe.blockmap\" \
  'https://github.com/andreprol/delirio-manager/releases/download/v\$VER/Delirio.Manager.Setup.\$VER.exe.blockmap'

curl -fL -o \"\$DIR/Delirio Manager Setup \$VER.exe\" \
  'https://github.com/andreprol/delirio-manager/releases/download/v\$VER/Delirio.Manager.Setup.\$VER.exe'

cat \"\$DIR/latest.yml\"
"
```

### 6. Verificar

```bash
# latest.yml deve retornar a nova versão
az vm run-command invoke \
  --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "curl -s http://localhost:3847/dashboard-updates/latest.yml"
```

### 7. Commit

```powershell
git add dashboard/package.json
git commit -m "chore: bump version to X.Y.Z — descrição"
git push
```

## Comportamento nas Instalações

| Situação | Resultado |
|---|---|
| App abre, versão igual ao servidor | Nenhuma ação |
| App abre, versão nova disponível | Baixa em background silenciosamente |
| Usuário fecha o app | Instala automaticamente |
| Próxima abertura | Nova versão ativa |

> As instalações se atualizam **sem nenhuma ação do usuário** — zero interrupção.

## Histórico de Releases

| Versão | Data | Mudança |
|---|---|---|
| 1.0.0  | 2026-06-05 | Release inicial |
| 1.0.1  | 2026-06-16 | Busca ao vivo + fixes de layout |
| 1.0.2  | 2026-06-16 | RH Module: ClockStatusGrid |
| 1.0.3  | 2026-06-16 | RH button redesign + full-screen |
| 1.0.4  | 2026-06-16 | Alerts panel fix topbar |
| 1.0.5  | 2026-06-16 | Fix IP Niterói 192.168.20.150→192.168.10.150 (reachable: 6→7) |
| 1.0.6  | 2026-06-16 | /rh/employees assíncrono — background job + cache + polling frontend |
| 1.0.7  | 2026-06-16 | EmployeeTable: coluna Ref2, filtro Não divergentes, botão Novo Funcionário |
| 1.0.8  | 2026-06-16 | Versão no topbar + cache de funcionários entre trocas de aba |
| 1.0.9  | 2026-06-17 | allClockIps, 4 estados ✅/⚠️/❌/—, filtro Incompletos, Completar Crachá, POST /deploy, deploy-remote.ps1 |
| 1.0.10 | 2026-06-17 | Tooltip no ⚠️ com lojas ausentes e lojas sem crachá |
| 1.0.11 | 2026-06-17 | Correção crítica ref2 (concat 40-char), isDivergent expandido, seletor de relógios |
| 1.0.12 | 2026-06-17 | ref2 confirmado em produção, partial refresh, debug endpoint, PM2, deploy via process.exit(0), Task Scheduler startup |
| 1.0.13 | 2026-06-17 | Botão Editar por funcionário (Ref2 NFC), Atualizar offline dinâmico por seleção, auto-desmarca offline ao carregar, backend skip offline antes de Playwright |
| 1.0.14 | 2026-06-17 | Kit LGPD na remoção: cria G:\CENTRAL\LGPD\{NOME}_{CPF}_{ts}\ com log-remocao.json + comprovante.txt |
| 1.0.15 | 2026-06-17 | LGPD path UNC (Azure File Share), Option B (06_Evidências_e_Registros\Exclusoes_Biometria), botão "Abrir pasta LGPD" na aba Auditoria via shell.openPath |

---

*Veja também: [VPN Chain](./delirio-vpn-chain.md) | [IPsec Troubleshooting](./ipsec-perl-proxy-troubleshooting.md)*
