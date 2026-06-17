<#
.SYNOPSIS
  Faz deploy remoto do clock-proxy no Servidor Skill via Azure VM + VPN.
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

foreach ($f in @('server.js', 'henry-hexa.js')) {
  if (-not (Test-Path "$DIR\$f")) {
    Write-Error "$f nao encontrado em $DIR"; exit 1
  }
}

Write-Host "Lendo arquivos..." -ForegroundColor Cyan
$serverB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("$DIR\server.js"))
$henryB64  = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("$DIR\henry-hexa.js"))

$body = "{`"files`":{`"server.js`":`"$serverB64`",`"henry-hexa.js`":`"$henryB64`"}}"

$sizeKb = [Math]::Round($body.Length / 1024, 1)
Write-Host "Payload: $sizeKb KB" -ForegroundColor Cyan

# Escreve o script bash em arquivo temp — evita limite de 32767 chars do CreateProcess
$scriptContent = @"
set -e
cat > /tmp/deploy-body.json << 'ENDBODY'
$body
ENDBODY
echo "Body escrito ($sizeKb KB). Chamando /deploy..."
curl -sf -X POST http://192.168.14.1:4321/deploy \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d @/tmp/deploy-body.json
DEPLOY_EXIT=`$?
echo ""
if [ `$DEPLOY_EXIT -eq 0 ]; then
  echo "Deploy enviado. Aguardando restart (7s)..."
  sleep 7
  curl -sf http://192.168.14.1:4321/health && echo "Health OK" || echo "AVISO: health ainda nao responde"
else
  echo "ERRO: curl retornou `$DEPLOY_EXIT"
fi
"@

$tmpScript = "F:\Temp\deploy-clock-proxy.sh"
[System.IO.File]::WriteAllText($tmpScript, $scriptContent, [System.Text.Encoding]::UTF8)
Write-Host "Script salvo em $tmpScript — enviando via Azure VM..." -ForegroundColor Cyan

az vm run-command invoke `
  --resource-group $ResourceGroup `
  --name $VmName `
  --command-id RunShellScript `
  --scripts "@$tmpScript"

if ($LASTEXITCODE -ne 0) {
  Write-Error "az vm run-command falhou (exit $LASTEXITCODE)"
  exit 1
}

Remove-Item $tmpScript -ErrorAction SilentlyContinue
