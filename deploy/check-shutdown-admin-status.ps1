<#
.SYNOPSIS
    Diagnostico fleet-wide (so leitura) pra decidir o mecanismo de bloqueio de
    shutdown local: em cada maquina online, descobre quem e o usuario logado
    interativo (explorer.exe) e se essa conta e membro do grupo Administradores
    (via SID fixo S-1-5-32-544, nao pelo nome -- "Administrators" em ingles
    nao existe em Windows PT-BR, so "Administradores"; achado ao vivo
    05/11/2026 rodando `net localgroup Administrators` numa maquina PT-BR).

.DESCRIPTION
    Zero mudanca nas maquinas -- so roda um comando de leitura via o MESMO
    canal run_powershell (POST /api/machines/:id/run, X-Admin-Secret) ja
    usado no resto do projeto (push-agent-to-machines.ps1, rollouts de
    featureLiveAccess/pollSecs). Nao toca no agente nem em config nenhuma.

    Resultado: CSV em deploy/admin-check-results-<timestamp>.csv com uma
    linha por maquina (hostname, local, usuario ativo, e-admin?, status da
    chamada). Decide por maquina se o plano A (remover SeShutdownPrivilege
    do grupo Users) funciona direto, ou se precisa do plano B (conta e
    admin, bloqueio exige rebaixar pra usuario padrao -- mais invasivo,
    maior risco de quebrar Aloha/NCR, testar isolado).

.PARAMETER Filter
    Regex sobre o hostname pra restringir o alvo (default: todas as
    maquinas online). Ex: "BOH" pra rodar so nas 9 back-of-house primeiro.

.PARAMETER BatchSize
    Quantas chamadas em paralelo por vez (default 12 -- mesma ordem de
    grandeza da concorrencia ja usada em scripts anteriores do projeto).

.EXAMPLE
    .\check-shutdown-admin-status.ps1 -Filter BOH

.EXAMPLE
    .\check-shutdown-admin-status.ps1
    # roda em TODAS as maquinas online (~130), ~10-15min dependendo de timeouts

.NOTES
    So leitura -- nao precisa do pause/confirmacao HIGH (nenhuma config e
    alterada em nenhuma maquina), mas ainda registra MEDIUM em decision.log
    por ser escrita via API externa (POST, mesmo que o efeito seja so ler).

    Rodar direto no terminal do Andre -- o hook de seguranca da plataforma
    bloqueia qualquer comando que leia o admin-secret.txt e chame a API
    quando disparado pelo agente (confirmado 05/11/2026, ver
    feedback_hook_seguranca_nao_ve_chat), nao importa confirmacao no chat.
#>
param(
    [string]$Filter,
    [int]$BatchSize = 12,
    [string]$ServidorURL = "https://dt-manager.brazilsouth.cloudapp.azure.com",
    [string]$AdminSecretPath = (Join-Path $PSScriptRoot "..\.secrets\admin-secret.txt")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $AdminSecretPath)) { throw "Admin secret nao encontrado em $AdminSecretPath (passe -AdminSecretPath)" }
$adminSecret = (Get-Content $AdminSecretPath | Where-Object { $_ -and $_ -notmatch '^-+$' -and $_ -ne 'adminSecret' } | Select-Object -First 1).Trim()
if (-not $adminSecret) { throw "Nao consegui extrair o valor de $AdminSecretPath" }

# 1. Resolve maquinas alvo (so online -- offline nao responde o run de qualquer forma)
$machines = Invoke-RestMethod -Uri "$ServidorURL/api/machines" -TimeoutSec 15
$allTargets = @($machines | Where-Object { $_.status -eq "online" })
if ($Filter) { $allTargets = @($allTargets | Where-Object { $_.hostname -match $Filter }) }
if (-not $allTargets -or $allTargets.Count -eq 0) { throw "Nenhuma maquina online encontrada para o filtro dado." }

Write-Host "Alvo: $($allTargets.Count) maquina(s) online." -ForegroundColor Cyan

# 2. Script remoto -- so leitura, SID fixo (locale-safe)
$checkScript = @'
try {
    $activeUser = (Get-Process -Name explorer -IncludeUserName -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty UserName)
    $adminsRaw = Get-LocalGroupMember -SID "S-1-5-32-544" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
    $isAdmin = $false
    if ($activeUser -and $adminsRaw) { $isAdmin = $adminsRaw -contains $activeUser }
    $winVer = [System.Environment]::OSVersion.VersionString
    Write-Output "ActiveUser=$activeUser | AdministradoresSID=[$($adminsRaw -join '; ')] | ActiveUserIsAdmin=$isAdmin | OS=$winVer"
} catch {
    Write-Output "ERRO: $($_.Exception.Message)"
}
'@
$b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($checkScript))
$remoteCommand = '$b="{0}";$s=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b));Invoke-Expression $s' -f $b64
$body = @{ script = $remoteCommand } | ConvertTo-Json

# 3. Dispara em lotes (Start-Job + Wait-Job -Timeout + Stop-Job -- -TimeoutSec do
#    Invoke-RestMethod sozinho nao segura de verdade, confirmado ao vivo 04/11/2026
#    em push-agent-to-machines.ps1; aqui o risco de travar e menor pq e so leitura,
#    mas mantem o mesmo padrao por seguranca)
$results = [System.Collections.Generic.List[object]]::new()
$batches = [System.Collections.Generic.List[object[]]]::new()
for ($i = 0; $i -lt $allTargets.Count; $i += $BatchSize) {
    $end = [Math]::Min($i + $BatchSize, $allTargets.Count) - 1
    $batches.Add($allTargets[$i..$end])
}

$batchNum = 0
foreach ($batch in $batches) {
    $batchNum++
    Write-Host "`nLote $batchNum/$($batches.Count) ($($batch.Count) maquinas)..." -ForegroundColor DarkCyan
    $jobs = @{}
    foreach ($t in $batch) {
        $job = Start-Job -ScriptBlock {
            param($uri, $secret, $body)
            Invoke-RestMethod -Uri $uri -Method Post -Headers @{ "X-Admin-Secret" = $secret } -ContentType "application/json" -Body $body -TimeoutSec 60
        } -ArgumentList "$ServidorURL/api/machines/$($t.id)/run", $adminSecret, $body
        $jobs[$job.Id] = $t
    }

    foreach ($jobId in $jobs.Keys) {
        $t = $jobs[$jobId]
        $job = Get-Job -Id $jobId
        $row = [PSCustomObject]@{
            hostname      = $t.hostname
            location      = $t.location
            id            = $t.id
            callStatus    = "erro"
            activeUser    = ""
            administrators = ""
            isAdmin       = ""
            os            = ""
            rawOutput     = ""
        }
        if (Wait-Job $job -Timeout 25) {
            try {
                $resp = Receive-Job $job -ErrorAction Stop
                $out = $resp.output
                $row.rawOutput = $out
                if ($out -match 'ActiveUser=([^|]*)\|\s*AdministradoresSID=\[([^\]]*)\]\s*\|\s*ActiveUserIsAdmin=(\w+)\s*\|\s*OS=(.*)') {
                    $row.callStatus     = "ok"
                    $row.activeUser     = $matches[1].Trim()
                    $row.administrators = $matches[2].Trim()
                    $row.isAdmin        = $matches[3].Trim()
                    $row.os             = $matches[4].Trim()
                } else {
                    $row.callStatus = "parse-falhou"
                }
            } catch {
                $row.callStatus = "erro"
                $row.rawOutput = $_.Exception.Message
            }
        } else {
            $row.callStatus = "timeout"
        }
        Stop-Job $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        $results.Add($row)

        $color = switch ($row.callStatus) { "ok" { if ($row.isAdmin -eq "True") { "Red" } else { "Green" } }; "timeout" { "Yellow" }; default { "Red" } }
        Write-Host "  $($t.hostname): $($row.callStatus) activeUser=$($row.activeUser) isAdmin=$($row.isAdmin)" -ForegroundColor $color
    }
}

# 4. CSV + resumo
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$csvPath = Join-Path $PSScriptRoot "admin-check-results-$ts.csv"
$results | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8

$okCount      = ($results | Where-Object { $_.callStatus -eq "ok" }).Count
$adminCount   = ($results | Where-Object { $_.isAdmin -eq "True" }).Count
$notAdminCount= ($results | Where-Object { $_.isAdmin -eq "False" }).Count
$failCount    = ($results | Where-Object { $_.callStatus -ne "ok" }).Count

Write-Host "`n=== Resumo ===" -ForegroundColor Cyan
Write-Host "Total: $($results.Count) | OK: $okCount | Falha/timeout: $failCount"
Write-Host "Conta ativa E admin (plano B necessario): $adminCount" -ForegroundColor $(if ($adminCount -gt 0) { "Red" } else { "Green" })
Write-Host "Conta ativa NAO admin (plano A funciona): $notAdminCount" -ForegroundColor Green
Write-Host "`nCSV salvo em: $csvPath" -ForegroundColor Cyan

# Log MEDIUM obrigatorio (escrita via API externa, mesmo sendo leitura)
$logLine = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] MEDIUM | check-shutdown-admin-status.ps1 -> $okCount ok ($adminCount admin / $notAdminCount nao-admin) / $failCount falha-timeout de $($allTargets.Count) maquina(s) | razao: diagnostico fleet-wide so-leitura pra decidir plano A vs B do bloqueio de shutdown local"
Add-Content -Path (Join-Path $PSScriptRoot "..\.claude\decision.log") -Value $logLine
