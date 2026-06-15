# deploy.ps1 -- copia arquivos do PC local e reinicia via PM2
# Executar no Servidor Skill: .\deploy.ps1

$src = "\\tsclient\F\RichClub\clock-proxy"
$dst = "C:\DtClockProxy"

Write-Host "Copiando arquivos..." -ForegroundColor Cyan
Copy-Item "$src\henry-hexa.js"       "$dst\henry-hexa.js"       -Force
Copy-Item "$src\server.js"           "$dst\server.js"           -Force
Copy-Item "$src\ecosystem.config.js" "$dst\ecosystem.config.js" -Force

Write-Host "Reiniciando via PM2..." -ForegroundColor Cyan
Set-Location $dst

# Usa PM2 se disponivel, caso contrario cai no node direto
if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    $running = pm2 jlist 2>$null | ConvertFrom-Json | Where-Object { $_.name -eq "DtClockProxy" }
    if ($running) {
        pm2 restart DtClockProxy
    } else {
        pm2 start ecosystem.config.js
    }
    Start-Sleep -Seconds 3
} else {
    # Fallback: bare node (usar apenas se PM2 nao instalado)
    Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $dst -WindowStyle Normal
    Start-Sleep -Seconds 2
}

$health = Invoke-RestMethod http://localhost:4321/health -ErrorAction SilentlyContinue
if ($health.ok) {
    Write-Host "OK -- servidor rodando na porta 4321" -ForegroundColor Green
} else {
    Write-Host "ERRO -- servidor nao respondeu. Ver logs: pm2 logs DtClockProxy" -ForegroundColor Red
}
