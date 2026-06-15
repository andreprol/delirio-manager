# install-service.ps1 -- Instala dt-clock-proxy via PM2 no Servidor Skill
# Executar no Servidor Skill (192.168.17.252)

$InstallDir = "C:\DtClockProxy"
$ServiceName = "DtClockProxy"

Write-Host "=== dt-clock-proxy -- Instalacao via PM2 ===" -ForegroundColor Cyan

# Verifica versao do Node (deve ser v22)
$nodeVer = node --version 2>&1
Write-Host "Node.js: $nodeVer"
if ($nodeVer -notmatch "v22") {
    Write-Host "ERRO: Node.js v22.16.0 obrigatorio. Execute: nvm use 22.16.0" -ForegroundColor Red
    exit 1
}

# Instala PM2 globalmente se nao existir
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "Instalando PM2 globalmente..."
    npm install -g pm2
    Write-Host "OK -- PM2 instalado" -ForegroundColor Green
} else {
    $pm2Ver = pm2 --version 2>&1
    Write-Host "PM2 ja instalado: $pm2Ver"
}

# Cria pasta de logs
New-Item -ItemType Directory -Path "$InstallDir\logs" -Force | Out-Null

# Para instancia anterior se existir
Write-Host "Parando instancia anterior (se existir)..."
pm2 stop $ServiceName 2>$null
pm2 delete $ServiceName 2>$null
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Copia ecosystem.config.js
Copy-Item "\\tsclient\F\RichClub\clock-proxy\ecosystem.config.js" "$InstallDir\ecosystem.config.js" -Force

# Inicia via PM2
Write-Host "Iniciando DtClockProxy via PM2..."
Set-Location $InstallDir
pm2 start ecosystem.config.js

Start-Sleep -Seconds 4

# Health check
$health = Invoke-RestMethod http://localhost:4321/health -ErrorAction SilentlyContinue
if ($health.ok) {
    Write-Host ""
    Write-Host "OK -- Servico rodando! Health: ok=true" -ForegroundColor Green
} else {
    Write-Host "ERRO -- Health check falhou. Logs:" -ForegroundColor Red
    pm2 logs $ServiceName --lines 30 --nostream
    exit 1
}

# Salva lista de processos
pm2 save
Write-Host "OK -- pm2 save executado" -ForegroundColor Green

# Configura inicializacao automatica no boot do Windows
Write-Host ""
Write-Host "Configurando inicializacao automatica..." -ForegroundColor Cyan
pm2 startup

Write-Host ""
Write-Host "IMPORTANTE: Se o comando acima gerou algo para rodar como Admin, execute-o agora!" -ForegroundColor Yellow
Write-Host "            Depois execute: pm2 save" -ForegroundColor Yellow
Write-Host ""
Write-Host "Comandos uteis:" -ForegroundColor Gray
Write-Host "  pm2 status                           -- ver todos os processos" -ForegroundColor Gray
Write-Host "  pm2 logs DtClockProxy                -- logs em tempo real" -ForegroundColor Gray
Write-Host "  pm2 logs DtClockProxy --lines 50 --nostream  -- ultimas 50 linhas" -ForegroundColor Gray
Write-Host "  pm2 restart DtClockProxy             -- reiniciar" -ForegroundColor Gray
Write-Host "  pm2 stop DtClockProxy                -- parar" -ForegroundColor Gray
