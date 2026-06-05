# deploy.ps1 - Envia o servidor para a VM Azure e inicia com PM2
# Uso: .\deploy.ps1

$VM   = "delirioadmin@dt-manager.brazilsouth.cloudapp.azure.com"
$DEST = "/opt/dt-manager"

Write-Host "[1/5] Copiando arquivos do servidor para a VM..." -ForegroundColor Cyan
scp -r `
  "$PSScriptRoot\server.js" `
  "$PSScriptRoot\db.js" `
  "$PSScriptRoot\package.json" `
  "$PSScriptRoot\ecosystem.config.js" `
  "$PSScriptRoot\routes" `
  "$PSScriptRoot\services" `
  "$PSScriptRoot\middleware" `
  "${VM}:${DEST}/"

Write-Host "[2/5] Copiando binario do agente para public/..." -ForegroundColor Cyan
$agentExe = "$PSScriptRoot\..\agent\delirio-agent.exe"
if (Test-Path $agentExe) {
  ssh $VM "mkdir -p $DEST/public"
  scp $agentExe "${VM}:${DEST}/public/delirio-agent.exe"
  Write-Host "  delirio-agent.exe copiado." -ForegroundColor Gray
} else {
  Write-Host "  AVISO: delirio-agent.exe nao encontrado. Copie manualmente depois." -ForegroundColor Yellow
}

Write-Host "[3/5] Instalando dependencias Node.js na VM..." -ForegroundColor Cyan
ssh $VM "cd $DEST && npm install --production"

Write-Host "[4/5] Iniciando/reiniciando servidor com PM2..." -ForegroundColor Cyan
ssh $VM "cd $DEST && pm2 delete dt-manager 2>/dev/null; pm2 start ecosystem.config.js && pm2 save"

Write-Host "[5/5] Verificando status..." -ForegroundColor Cyan
ssh $VM "pm2 status && curl -s http://localhost:3847/health"

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Servidor deployado com sucesso!" -ForegroundColor Green
Write-Host "  URL: https://dt-manager.brazilsouth.cloudapp.azure.com" -ForegroundColor Green
Write-Host "  Health: https://dt-manager.brazilsouth.cloudapp.azure.com/health" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
