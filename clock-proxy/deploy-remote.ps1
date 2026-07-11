<#
.SYNOPSIS
  Faz deploy remoto do clock-proxy no Servidor Skill via Azure VM + VPN.
  Envia server.js + henry-hexa.js + utils.js em uma única requisição.
  O /deploy endpoint escreve os arquivos e chama process.exit(0) — PM2 reinicia.

.EXAMPLE
  .\deploy-remote.ps1
#>
param(
  [string]$ResourceGroup = "rg-dt-manager",
  [string]$VmName        = "vm-dt-manager"
)

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

$body    = "{`"files`":{`"utils.js`":`"$utilsB64`",`"server.js`":`"$serverB64`",`"henry-hexa.js`":`"$henryB64`"}}"
$sizeKb  = [Math]::Round($body.Length / 1024, 1)
Write-Host "Payload: $sizeKb KB (utils.js + server.js + henry-hexa.js)" -ForegroundColor Cyan

$script = @"
set -e
cat > /tmp/deploy-body.json << 'ENDBODY'
$body
ENDBODY
echo "Deploy ($sizeKb KB). Chamando /deploy..."
curl -sf -X POST http://192.168.14.1:4321/deploy \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d @/tmp/deploy-body.json
EXIT=`$?
echo ""
if [ `$EXIT -eq 0 ]; then
  echo "Deploy OK. Aguardando restart PM2 (12s)..."
  sleep 12
  curl -sf http://192.168.14.1:4321/health && echo "Health OK — deploy concluido" || echo "AVISO: health sem resposta (PM2 pode estar reiniciando ainda)"
else
  echo "ERRO: curl retornou `$EXIT"
  exit 1
fi
"@

$tmpScript = "F:\Temp\deploy-clock-proxy.sh"
[System.IO.File]::WriteAllText($tmpScript, $script, [System.Text.Encoding]::UTF8)
Write-Host "Enviando via Azure VM..." -ForegroundColor Cyan

az vm run-command invoke `
  --resource-group $ResourceGroup `
  --name $VmName `
  --command-id RunShellScript `
  --scripts "@$tmpScript"

$rc = $LASTEXITCODE
Remove-Item $tmpScript -ErrorAction SilentlyContinue

if ($rc -ne 0) {
  Write-Error "Deploy falhou (exit $rc)"
  exit 1
}

Write-Host ""
Write-Host "Deploy concluido!" -ForegroundColor Green
