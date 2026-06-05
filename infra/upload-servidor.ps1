# upload-servidor.ps1
# Envia todos os arquivos do servidor para a VM sem precisar de SSH/SCP
# Usa az vm run-command com conteudo codificado em base64

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$RG   = "rg-dt-manager"
$VM   = "vm-dt-manager"
$DEST = "/opt/dt-manager"

function Send-FileToVM {
    param([string]$LocalPath, [string]$RemotePath)

    $content   = Get-Content $LocalPath -Raw -Encoding UTF8
    $bytes     = [System.Text.Encoding]::UTF8.GetBytes($content)
    $b64       = [Convert]::ToBase64String($bytes)
    $dir       = Split-Path $RemotePath -Parent
    $script    = "mkdir -p '$dir' && echo '$b64' | base64 -d > '$RemotePath' && echo 'OK: $RemotePath'"

    $result = az vm run-command invoke `
        --resource-group $RG --name $VM `
        --command-id RunShellScript `
        --scripts $script `
        --output json 2>$null | ConvertFrom-Json

    $msg = $result.value[0].message
    if ($msg -match "OK:") {
        Write-Host "  [OK] $RemotePath" -ForegroundColor Green
    } else {
        Write-Host "  [ERRO] $RemotePath" -ForegroundColor Red
        Write-Host "  $msg" -ForegroundColor DarkRed
    }
}

$BASE = "F:\RichClub\server"

Write-Host "[1/4] Criando estrutura de diretorios na VM..." -ForegroundColor Cyan
az vm run-command invoke --resource-group $RG --name $VM `
    --command-id RunShellScript `
    --scripts "mkdir -p $DEST/routes $DEST/services $DEST/middleware $DEST/data $DEST/logs $DEST/public && chown -R dtmanager:dtmanager $DEST && echo OK" `
    --output json | ConvertFrom-Json | ForEach-Object { Write-Host "  $($_.value[0].message)" -ForegroundColor Gray }

Write-Host "[2/4] Enviando arquivos principais..." -ForegroundColor Cyan
Send-FileToVM "$BASE\package.json"      "$DEST/package.json"
Send-FileToVM "$BASE\server.js"         "$DEST/server.js"
Send-FileToVM "$BASE\db.js"             "$DEST/db.js"
Send-FileToVM "$BASE\ecosystem.config.js" "$DEST/ecosystem.config.js"

Write-Host "[3/4] Enviando modulos..." -ForegroundColor Cyan
Send-FileToVM "$BASE\routes\agent.js"      "$DEST/routes/agent.js"
Send-FileToVM "$BASE\routes\machines.js"   "$DEST/routes/machines.js"
Send-FileToVM "$BASE\routes\alerts.js"     "$DEST/routes/alerts.js"
Send-FileToVM "$BASE\services\websocket.js"   "$DEST/services/websocket.js"
Send-FileToVM "$BASE\services\alertEngine.js" "$DEST/services/alertEngine.js"
Send-FileToVM "$BASE\middleware\auth.js"   "$DEST/middleware/auth.js"

Write-Host "[4/4] Instalando dependencias e iniciando servidor..." -ForegroundColor Cyan
az vm run-command invoke --resource-group $RG --name $VM `
    --command-id RunShellScript `
    --scripts "cd $DEST && npm install --production 2>&1 | tail -3 && pm2 delete dt-manager 2>/dev/null; pm2 start ecosystem.config.js && pm2 save && sleep 3 && curl -s http://localhost:3847/health" `
    --output json | ConvertFrom-Json | ForEach-Object { Write-Host $_.value[0].message }

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Pronto! Testando HTTPS publico..." -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
try {
    $h = Invoke-RestMethod "https://dt-manager.brazilsouth.cloudapp.azure.com/health" -TimeoutSec 15
    Write-Host "  Status  : $($h.status)" -ForegroundColor Green
    Write-Host "  Versao  : $($h.version)" -ForegroundColor Green
    Write-Host "  Maquinas: $($h.machines)" -ForegroundColor Green
} catch {
    Write-Host "  HTTPS ainda nao respondeu (Nginx pode precisar de reload)" -ForegroundColor Yellow
    Write-Host "  Tente em 30s: Invoke-RestMethod https://dt-manager.brazilsouth.cloudapp.azure.com/health" -ForegroundColor Gray
}
