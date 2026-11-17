<#
.SYNOPSIS
    Liga/desliga um feature flag (featureLiveAccess, featureSessionZeroCapture)
    em TODAS as máquinas online da frota, uma de cada vez, via o mesmo
    mecanismo de toggle-feature-flag.ps1 (POST /api/machines/:id/run).

.DESCRIPTION
    SEQUENCIAL de propósito, nunca paralelo -- o incidente de 15/11/2026
    (broadcast fleet-wide sem jitter derrubou o dt-manager por horas,
    ver [[feedback_broadcast_fleet_wide_sem_jitter_derruba_servidor]])
    é exatamente o motivo de este script nunca disparar run_powershell pra
    mais de 1 máquina ao mesmo tempo. Delay aleatório (DelayMinSecs..DelayMaxSecs)
    entre cada chamada -- não é cosmético, é a defesa contra rajada sincronizada.

    Cada chamada mata o processo do agente (Stop-Process -Force) pra forçar
    o SCM a reiniciar com o config.json novo -- mesma ressalva de
    toggle-feature-flag.ps1: run_powershell não garante ACK, confirmar
    depois via GET /api/machines ou nova sessão de Acesso Remoto.

    Máquinas OFFLINE no momento do rollout são puladas (não tem como
    enfileirar comando que seria executado -- ficam reportadas no resumo
    final pra rodar de novo depois que reconectarem).

.PARAMETER FlagName
    Nome exato do campo no config.json (featureLiveAccess, featureSessionZeroCapture).

.PARAMETER Value
    "true" ou "false".

.PARAMETER Filter
    Regex opcional pro hostname (ex: "BOH" pra só back-of-house). Default: todas.

.PARAMETER DelayMinSecs / DelayMaxSecs
    Janela do delay aleatório entre cada máquina. Default 3-8s (130 máquinas
    -> ~10-15min de rollout total).

.EXAMPLE
    .\rollout-feature-flag.ps1 -FlagName featureLiveAccess -Value true
#>
param(
    [Parameter(Mandatory)][ValidateSet("featureLiveAccess", "featureSessionZeroCapture")][string]$FlagName,
    [Parameter(Mandatory)][ValidateSet("true", "false")][string]$Value,
    [string]$Filter = ".",
    [int]$DelayMinSecs = 3,
    [int]$DelayMaxSecs = 8,
    [string]$ServidorURL = "https://dt-manager.brazilsouth.cloudapp.azure.com",
    [string]$AdminSecretPath = (Join-Path $PSScriptRoot "..\.secrets\admin-secret.txt")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $AdminSecretPath)) { throw "Admin secret nao encontrado em $AdminSecretPath" }
$adminSecret = (Get-Content $AdminSecretPath | Where-Object { $_ -and $_ -notmatch '^-+$' -and $_ -ne 'adminSecret' } | Select-Object -First 1).Trim()
if (-not $adminSecret) { throw "Nao consegui extrair o valor de $AdminSecretPath" }

Write-Host "Buscando lista de maquinas..." -ForegroundColor Cyan
$allMachines = Invoke-RestMethod -Uri "$ServidorURL/api/machines" -Method Get -TimeoutSec 30
$targets = $allMachines | Where-Object { $_.hostname -match $Filter -and $_.status -eq 'online' }
$skippedOffline = $allMachines | Where-Object { $_.hostname -match $Filter -and $_.status -ne 'online' }

Write-Host "Alvos online: $($targets.Count) | offline (pulados): $($skippedOffline.Count)" -ForegroundColor Cyan

$valueLiteral = if ($Value -eq "true") { '$true' } else { '$false' }
$ok = 0; $noResp = 0; $err = 0
$results = @()

foreach ($m in $targets) {
    $remoteScript = @"
`$svc = Get-WmiObject Win32_Service -Filter "Name='DelirioAgent'"
`$exePath = (`$svc.PathName -replace '"','').Trim()
`$cfgPath = Join-Path (Split-Path `$exePath) "config.json"
`$cfg = Get-Content `$cfgPath -Raw | ConvertFrom-Json
`$cfg.$FlagName = $valueLiteral
[System.IO.File]::WriteAllText(`$cfgPath, (`$cfg | ConvertTo-Json -Depth 5))
`$targetPid = `$svc.ProcessId
if (`$targetPid -and `$targetPid -ne 0) { Stop-Process -Id `$targetPid -Force }
Write-Output "OK $FlagName=$Value em `$cfgPath"
"@
    $swapBytes = [System.Text.Encoding]::UTF8.GetBytes($remoteScript)
    $swapB64 = [System.Convert]::ToBase64String($swapBytes)
    $remoteCommand = '$b="{0}";$s=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b));Invoke-Expression $s' -f $swapB64
    $body = @{ script = $remoteCommand } | ConvertTo-Json

    Write-Host -NoNewline "$($m.hostname) ($($m.id)): "
    try {
        $job = Start-Job -ScriptBlock {
            param($uri, $secret, $body)
            Invoke-RestMethod -Uri $uri -Method Post `
                -Headers @{ "X-Admin-Secret" = $secret } -ContentType "application/json" `
                -Body $body -TimeoutSec 40
        } -ArgumentList "$ServidorURL/api/machines/$($m.id)/run", $adminSecret, $body

        if (Wait-Job $job -Timeout 25) {
            try {
                $resp = Receive-Job $job -ErrorAction Stop
                Write-Host "$($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
                $ok++
                $results += [pscustomobject]@{ hostname = $m.hostname; id = $m.id; result = 'ok' }
            } catch {
                Write-Host "ERRO - $($_.Exception.Message)" -ForegroundColor Red
                $err++
                $results += [pscustomobject]@{ hostname = $m.hostname; id = $m.id; result = 'erro' }
            }
        } else {
            Write-Host "sem resposta em 25s -- disparado, confirmar depois" -ForegroundColor Yellow
            $noResp++
            $results += [pscustomobject]@{ hostname = $m.hostname; id = $m.id; result = 'sem_resposta' }
        }
        Stop-Job $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host "FALHA - $($_.Exception.Message)" -ForegroundColor Red
        $err++
        $results += [pscustomobject]@{ hostname = $m.hostname; id = $m.id; result = 'falha' }
    }

    $delay = Get-Random -Minimum $DelayMinSecs -Maximum ($DelayMaxSecs + 1)
    Start-Sleep -Seconds $delay
}

Write-Host ""
Write-Host "=== RESUMO ===" -ForegroundColor Cyan
Write-Host "OK: $ok | sem resposta (disparado): $noResp | erro: $err | offline (pulados): $($skippedOffline.Count)"
if ($skippedOffline.Count -gt 0) {
    Write-Host "Offline (rodar de novo quando reconectarem): $($skippedOffline.hostname -join ', ')" -ForegroundColor Yellow
}

$logLine = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] MEDIUM | rollout-feature-flag.ps1 -> $FlagName=$Value fleet-wide (filter='$Filter') | ok=$ok sem_resposta=$noResp erro=$err offline=$($skippedOffline.Count) | razao: rollout fleet-wide pos fix do bug de BOM/re-key em toggle-feature-flag.ps1"
Add-Content -Path (Join-Path $PSScriptRoot "..\.claude\decision.log") -Value $logLine
