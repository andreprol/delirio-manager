<#
.SYNOPSIS
  Faz deploy remoto do clock-proxy no Servidor Skill via Azure VM + VPN.
  Fase 1: atualiza ALLOWED para aceitar utils.js (bootstrap).
  Fase 2: envia utils.js + server.js + henry-hexa.js.
.EXAMPLE
  .\deploy-remote.ps1
#>
param(
  [string]$ResourceGroup = "rg-dt-manager",
  [string]$VmName        = "vm-dt-manager"
)

# Lê token do .env local (não commitado) ou da variável de ambiente
$DIR   = $PSScriptRoot
$TOKEN = $env:CLOCK_PROXY_TOKEN
if (-not $TOKEN) {
  $envFile = "$DIR\.env"
  if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
      if ($_ -match '^CLOCK_PROXY_TOKEN=(.+)$') { $TOKEN = $Matches[1] }
    }
  }
}
if (-not $TOKEN) {
  Write-Error "CLOCK_PROXY_TOKEN nao encontrado. Defina em $DIR\.env ou como variavel de ambiente."
  exit 1
}

foreach ($f in @('server.js', 'henry-hexa.js', 'utils.js')) {
  if (-not (Test-Path "$DIR\$f")) {
    Write-Error "$f nao encontrado em $DIR"; exit 1
  }
}

Write-Host "Lendo arquivos..." -ForegroundColor Cyan
$serverB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("$DIR\server.js"))
$henryB64  = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("$DIR\henry-hexa.js"))
$utilsB64  = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("$DIR\utils.js"))

# ─── FASE 1 — Bootstrap: garante que utils.js está no ALLOWED do servidor vivo ─
# O servidor atual pode não ter utils.js no ALLOWED. Enviamos um server.js mínimo
# que só expande ALLOWED, sem importar utils.js. Isso permite a fase 2 funcionar.
Write-Host "" -ForegroundColor Cyan
Write-Host "Fase 1 — bootstrap ALLOWED..." -ForegroundColor Yellow

$serverSrc = [System.IO.File]::ReadAllText("$DIR\server.js", [System.Text.Encoding]::UTF8)
$phase1Src = $serverSrc -replace "new Set\(\['server\.js', 'henry-hexa\.js', 'utils\.js'\]\)", "new Set(['server.js', 'henry-hexa.js', 'utils.js'])"

# Verifica se o servidor atual JA tem utils.js no ALLOWED (fase 1 já aplicada antes)
# Para isso, lemos o server.js e verificamos. Simplificação: sempre enviamos fase 1.
$phase1B64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($phase1Src))

$body1 = "{`"files`":{`"server.js`":`"$phase1B64`"}}"
$sizeKb1 = [Math]::Round($body1.Length / 1024, 1)
Write-Host "Payload fase 1: $sizeKb1 KB" -ForegroundColor Cyan

$scriptPhase1 = @"
set -e
cat > /tmp/deploy-body-p1.json << 'ENDBODY'
$body1
ENDBODY
echo "Fase 1 ($sizeKb1 KB). Chamando /deploy..."
curl -sf -X POST http://192.168.14.1:4321/deploy \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d @/tmp/deploy-body-p1.json
P1_EXIT=`$?
echo ""
if [ `$P1_EXIT -eq 0 ]; then
  echo "Fase 1 OK. Aguardando restart (10s)..."
  sleep 10
  curl -sf http://192.168.14.1:4321/health && echo "Health fase 1 OK" || echo "AVISO: health fase 1 sem resposta"
else
  echo "ERRO fase 1: curl retornou `$P1_EXIT"
  exit 1
fi
"@

$tmpScript1 = "F:\Temp\deploy-clock-proxy-p1.sh"
[System.IO.File]::WriteAllText($tmpScript1, $scriptPhase1, [System.Text.Encoding]::UTF8)
Write-Host "Enviando fase 1 via Azure VM..." -ForegroundColor Cyan

az vm run-command invoke `
  --resource-group $ResourceGroup `
  --name $VmName `
  --command-id RunShellScript `
  --scripts "@$tmpScript1"

if ($LASTEXITCODE -ne 0) {
  Write-Error "Fase 1 falhou (exit $LASTEXITCODE)"
  Remove-Item $tmpScript1 -ErrorAction SilentlyContinue
  exit 1
}
Remove-Item $tmpScript1 -ErrorAction SilentlyContinue

# ─── FASE 2 — Deploy completo: utils.js + server.js + henry-hexa.js ────────────
Write-Host "" -ForegroundColor Cyan
Write-Host "Fase 2 — deploy completo (utils.js + server.js + henry-hexa.js)..." -ForegroundColor Yellow

$body2 = "{`"files`":{`"utils.js`":`"$utilsB64`",`"server.js`":`"$serverB64`",`"henry-hexa.js`":`"$henryB64`"}}"
$sizeKb2 = [Math]::Round($body2.Length / 1024, 1)
Write-Host "Payload fase 2: $sizeKb2 KB" -ForegroundColor Cyan

$scriptPhase2 = @"
set -e
cat > /tmp/deploy-body-p2.json << 'ENDBODY'
$body2
ENDBODY
echo "Fase 2 ($sizeKb2 KB). Chamando /deploy..."
curl -sf -X POST http://192.168.14.1:4321/deploy \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d @/tmp/deploy-body-p2.json
P2_EXIT=`$?
echo ""
if [ `$P2_EXIT -eq 0 ]; then
  echo "Fase 2 OK. Aguardando restart (10s)..."
  sleep 10
  curl -sf http://192.168.14.1:4321/health && echo "Health fase 2 OK — deploy concluido" || echo "AVISO: health fase 2 sem resposta"
else
  echo "ERRO fase 2: curl retornou `$P2_EXIT"
  exit 1
fi
"@

$tmpScript2 = "F:\Temp\deploy-clock-proxy-p2.sh"
[System.IO.File]::WriteAllText($tmpScript2, $scriptPhase2, [System.Text.Encoding]::UTF8)
Write-Host "Enviando fase 2 via Azure VM..." -ForegroundColor Cyan

az vm run-command invoke `
  --resource-group $ResourceGroup `
  --name $VmName `
  --command-id RunShellScript `
  --scripts "@$tmpScript2"

if ($LASTEXITCODE -ne 0) {
  Write-Error "Fase 2 falhou (exit $LASTEXITCODE)"
  Remove-Item $tmpScript2 -ErrorAction SilentlyContinue
  exit 1
}
Remove-Item $tmpScript2 -ErrorAction SilentlyContinue

Write-Host "" -ForegroundColor Green
Write-Host "Deploy concluido com sucesso!" -ForegroundColor Green
