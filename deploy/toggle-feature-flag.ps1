<#
.SYNOPSIS
    Liga/desliga um feature flag (featureLiveAccess, featureSessionZeroCapture)
    no config.json de UMA máquina, via POST /api/machines/:id/run (mesmo canal
    run_powershell admin de push-agent-to-machines.ps1).

.DESCRIPTION
    Edita config.json no disco da máquina alvo e reinicia o processo via
    Stop-Process -Force (NUNCA Stop-Service aqui -- mesmo motivo documentado
    em push-agent-to-machines.ps1: Stop-Service pede pro SCM derrubar o
    PROPRIO processo que está no meio da execução deste script via
    run_powershell, o que impede o script de terminar e o ACK nunca é
    mandado -- Stop-Process -Force é abrupto e deixa a SetRecoveryActions
    (5s/10s/30s) reiniciar o serviço sozinho, já com o config.json novo no
    disco).

    Confirmar sucesso depois via banco (SELECT ... FROM machines) ou nova
    sessão de Acesso Remoto -- não via status do comando run_powershell
    (mesma ressalva do push-agent-to-machines.ps1: esse comando específico
    também não garante ACK).

.PARAMETER MachineId
    GUID da máquina alvo (ver GET /api/machines).

.PARAMETER FlagName
    Nome exato do campo no config.json (ex: featureLiveAccess,
    featureSessionZeroCapture).

.PARAMETER Value
    "true" ou "false".

.EXAMPLE
    .\toggle-feature-flag.ps1 -MachineId ff67c097-1b81-408c-897e-2fc5d3fdf7e8 -FlagName featureLiveAccess -Value true
#>
param(
    [Parameter(Mandatory)][string]$MachineId,
    [Parameter(Mandatory)][ValidateSet("featureLiveAccess", "featureSessionZeroCapture")][string]$FlagName,
    [Parameter(Mandatory)][ValidateSet("true", "false")][string]$Value,
    [string]$ServidorURL = "https://dt-manager.brazilsouth.cloudapp.azure.com",
    [string]$AdminSecretPath = (Join-Path $PSScriptRoot "..\.secrets\admin-secret.txt")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $AdminSecretPath)) { throw "Admin secret nao encontrado em $AdminSecretPath" }
$adminSecret = (Get-Content $AdminSecretPath | Where-Object { $_ -and $_ -notmatch '^-+$' -and $_ -ne 'adminSecret' } | Select-Object -First 1).Trim()
if (-not $adminSecret) { throw "Nao consegui extrair o valor de $AdminSecretPath" }

$valueLiteral = if ($Value -eq "true") { '$true' } else { '$false' }

$remoteScript = @"
`$svc = Get-WmiObject Win32_Service -Filter "Name='DelirioAgent'"
`$exePath = (`$svc.PathName -replace '"','').Trim()
`$cfgPath = Join-Path (Split-Path `$exePath) "config.json"
`$cfg = Get-Content `$cfgPath -Raw | ConvertFrom-Json
`$cfg.$FlagName = $valueLiteral
[System.IO.File]::WriteAllText(`$cfgPath, (`$cfg | ConvertTo-Json -Depth 5))
`$targetPid = `$svc.ProcessId
if (`$targetPid -and `$targetPid -ne 0) { Stop-Process -Id `$targetPid -Force }
Write-Output "OK $FlagName=$Value em `$cfgPath (processo derrubado p/ SCM reiniciar via recovery action)"
"@

$swapBytes = [System.Text.Encoding]::UTF8.GetBytes($remoteScript)
$swapB64 = [System.Convert]::ToBase64String($swapBytes)
$remoteCommand = '$b="{0}";$s=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b));Invoke-Expression $s' -f $swapB64

$body = @{ script = $remoteCommand } | ConvertTo-Json
$job = Start-Job -ScriptBlock {
    param($uri, $secret, $body)
    Invoke-RestMethod -Uri $uri -Method Post `
        -Headers @{ "X-Admin-Secret" = $secret } -ContentType "application/json" `
        -Body $body -TimeoutSec 60
} -ArgumentList "$ServidorURL/api/machines/$MachineId/run", $adminSecret, $body

Write-Host -NoNewline "${MachineId}: "
if (Wait-Job $job -Timeout 25) {
    try {
        $resp = Receive-Job $job -ErrorAction Stop
        Write-Host "$($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
    } catch {
        Write-Host "ERRO - $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "sem resposta em 25s -- disparado, confirmar no banco/dashboard" -ForegroundColor Yellow
}
Stop-Job $job -ErrorAction SilentlyContinue | Out-Null
Remove-Job $job -Force -ErrorAction SilentlyContinue

$logLine = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] MEDIUM | toggle-feature-flag.ps1 -> $FlagName=$Value em $MachineId | razao: toggle manual via toggle-feature-flag.ps1"
Add-Content -Path (Join-Path $PSScriptRoot "..\.claude\decision.log") -Value $logLine
