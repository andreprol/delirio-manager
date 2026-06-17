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

$TOKEN = "be2505efc1b0d0c04902c5279bcb794893de4b547c51b1ee63495f8fa155f7cb"
$DIR   = $PSScriptRoot

foreach ($f in @('server.js', 'henry-hexa.js')) {
  if (-not (Test-Path "$DIR\$f")) {
    Write-Error "$f nao encontrado em $DIR"; exit 1
  }
}

Write-Host "Lendo arquivos..." -ForegroundColor Cyan
$serverB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("$DIR\server.js"))
$henryB64  = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("$DIR\henry-hexa.js"))

# JSON body (base64 nao tem chars especiais — seguro para heredoc)
$body = "{`"files`":{`"server.js`":`"$serverB64`",`"henry-hexa.js`":`"$henryB64`"}}"

$sizeKb = [Math]::Round($body.Length / 1024, 1)
Write-Host "Payload: $sizeKb KB — enviando via Azure VM..." -ForegroundColor Cyan

# Script executado na Azure VM (Linux bash)
$script = @"
set -e
cat > /tmp/deploy-body.json << 'ENDBODY'
$body
ENDBODY
echo "Body escrito ($sizeKb KB). Chamando /deploy..."
curl -sf -X POST http://192.168.14.1:4321/deploy \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d @/tmp/deploy-body.json
DEPLOY_EXIT=\$?
echo ""
if [ \$DEPLOY_EXIT -eq 0 ]; then
  echo "Deploy enviado. Aguardando restart (7s)..."
  sleep 7
  curl -sf http://192.168.14.1:4321/health && echo "Health OK" || echo "AVISO: health ainda nao responde"
else
  echo "ERRO: curl retornou $DEPLOY_EXIT"
fi
"@

az vm run-command invoke `
  --resource-group $ResourceGroup `
  --name $VmName `
  --command-id RunShellScript `
  --scripts $script `
  --timeout 120

if ($LASTEXITCODE -ne 0) {
  Write-Error "az vm run-command falhou (exit $LASTEXITCODE)"
  exit 1
}
