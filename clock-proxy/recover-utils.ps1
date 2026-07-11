<#
.SYNOPSIS
  Recovery: escreve utils.js no Servidor Skill via WinRM (Tailscale 100.67.84.67)
  e reinicia o PM2. Rode como ADMINISTRADOR.

.EXAMPLE
  .\recover-utils.ps1
#>

$TS_IP    = "100.67.84.67"
$DIR      = $PSScriptRoot
$UTILS    = "$DIR\utils.js"

if (-not (Test-Path $UTILS)) {
  Write-Error "utils.js não encontrado em $UTILS"; exit 1
}

# 1. TrustedHosts (requer admin)
Write-Host "Adicionando $TS_IP ao TrustedHosts..." -ForegroundColor Cyan
Set-Item WSMan:\localhost\Client\TrustedHosts -Value $TS_IP -Force -Concatenate

# 2. Credenciais do Servidor Skill
$cred = Get-Credential -Message "Credenciais do Servidor Skill (win-rs6c9bgdij5-1 / $TS_IP)" -UserName "Administrador"

# 3. Conteúdo de utils.js
$utilsContent = [System.IO.File]::ReadAllText($UTILS, [System.Text.Encoding]::UTF8)

# 4. Copia e reinicia via WinRM
Write-Host "Conectando via WinRM..." -ForegroundColor Cyan
Invoke-Command -ComputerName $TS_IP -Credential $cred -ScriptBlock {
  param($content)

  $target = "C:\DtClockProxy\utils.js"
  [System.IO.File]::WriteAllText($target, $content, [System.Text.Encoding]::UTF8)
  Write-Host "utils.js escrito: $((Get-Item $target).Length) bytes" -ForegroundColor Green

  # Reinicia PM2 — nome do app no ecosystem.config.js é DtClockProxy
  $pm2 = Get-Command pm2.cmd -ErrorAction SilentlyContinue
  if (-not $pm2) { $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue }
  if ($pm2) {
    Write-Host "Reiniciando PM2 app 'DtClockProxy'..." -ForegroundColor Cyan
    & $pm2.Source restart DtClockProxy 2>&1 | Write-Host
  } else {
    Write-Host "pm2 não encontrado no PATH do Servidor Skill" -ForegroundColor Red
    Write-Host "Tente manualmente: pm2 restart DtClockProxy" -ForegroundColor Yellow
  }

  Start-Sleep 5

  # Verifica saúde
  try {
    $h = Invoke-RestMethod -Uri "http://localhost:4321/health" -TimeoutSec 10
    Write-Host "Health: $($h | ConvertTo-Json)" -ForegroundColor Green
  } catch {
    Write-Host "Health check falhou — PM2 pode estar reiniciando ainda" -ForegroundColor Yellow
  }
} -ArgumentList $utilsContent

Write-Host ""
Write-Host "Recovery concluído." -ForegroundColor Green
