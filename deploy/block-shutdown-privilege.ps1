<#
.SYNOPSIS
    Bloqueia shutdown/restart local SEM tirar ninguem do grupo Administradores
    (Aloha/NCR continuam funcionando -- eles checam GRUPO, nao privilegio).

.DESCRIPTION
    Cada privilegio do Windows (User Rights Assignment / secedit "Privilege
    Rights") tem sua PROPRIA lista de quem recebe, independente de quem esta
    em qual grupo. Este script tira SOMENTE os aliases BUILTIN\Administrators
    (*S-1-5-32-544), BUILTIN\Users (*S-1-5-32-545) e BUILTIN\Power Users
    (*S-1-5-32-551, grupo legado -- confirmado presente no template padrao
    da frota via -Action Verify em 05/11/2026) da lista de quem tem
    "SeShutdownPrivilege" ("Shut down the system"), mantendo SYSTEM/LOCAL
    SERVICE/NETWORK SERVICE. Ninguem e removido do grupo Administradores de
    verdade -- continuam admin pra tudo, so perdem a capacidade especifica de
    desligar/reiniciar pela tela ou por `shutdown.exe`.

    O comando remoto "shutdown"/"cancel-shutdown" que o agente ja tem
    (agent/commands.go) roda como SYSTEM (servico do Windows) -- nao e afetado,
    TI continua desligando remoto normal via dashboard/API.

    Mesmo limite de sempre: Windows nao separa shutdown de restart no mesmo
    privilegio -- essa acao bloqueia OS DOIS, sem excecao possivel.

    So mexe na secao USER_RIGHTS do secedit (/areas USER_RIGHTS) -- nunca toca
    em outras politicas de seguranca da maquina.

.PARAMETER Action
    Verify   -- so leitura, mostra a lista atual de quem tem o privilegio.
    Apply    -- faz backup da linha original (deploy/shutdown-privilege-backups/
                <hostname>.txt) e aplica o bloqueio. Pede confirmacao interativa.
    Rollback -- le o backup salvo e devolve a linha original exata. Pede
                confirmacao interativa.
    Diag     -- so leitura, nao destrutivo. Mostra `whoami /priv` do processo do
                servico (SYSTEM) + dump bruto da secao Privilege Rights inteira
                (nao so a linha de SeShutdownPrivilege) -- usar quando Apply/
                Verify devolver algo inesperado tipo "NAO ENCONTRADA", pra
                confirmar se SYSTEM ainda tem o privilegio antes de testar
                desligar a maquina de verdade.

.PARAMETER Filter
    Regex sobre o hostname (ex: "GERENTE-ASS"). Use -Filter OU -MachineIds,
    nunca os dois. Sem default -- selecao de alvo tem que ser deliberada,
    sem "todas as maquinas" acidental numa acao que muda seguranca.

.PARAMETER MachineIds
    Lista explicita de IDs (GUID) de maquina, alternativa a -Filter.

.EXAMPLE
    .\block-shutdown-privilege.ps1 -Action Verify -Filter GERENTE-ASS
.EXAMPLE
    .\block-shutdown-privilege.ps1 -Action Apply -Filter GERENTE-ASS
.EXAMPLE
    .\block-shutdown-privilege.ps1 -Action Rollback -Filter GERENTE-ASS

.NOTES
    Rodar direto no terminal do Andre -- o hook de seguranca da plataforma
    bloqueia qualquer comando disparado pelo agente que leia o admin-secret.txt
    e chame a API (confirmado 05/11/2026, ver feedback_hook_seguranca_nao_ve_chat).

    Apply/Rollback sao HIGH (modifica configuracao de seguranca) -- sempre
    registrado em .claude/decision.log pelo proprio script, confirmacao
    interativa obrigatoria, sem elevate em auto-approve.json ainda.
#>
param(
    [Parameter(Mandatory)][ValidateSet("Verify","Apply","Rollback","Diag")][string]$Action,
    [string]$Filter,
    [string[]]$MachineIds,
    [string]$ServidorURL = "https://dt-manager.brazilsouth.cloudapp.azure.com",
    [string]$AdminSecretPath = (Join-Path $PSScriptRoot "..\.secrets\admin-secret.txt"),
    [string]$BackupDir = (Join-Path $PSScriptRoot "shutdown-privilege-backups")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $AdminSecretPath)) { throw "Admin secret nao encontrado em $AdminSecretPath" }
$adminSecret = (Get-Content $AdminSecretPath | Where-Object { $_ -and $_ -notmatch '^-+$' -and $_ -ne 'adminSecret' } | Select-Object -First 1).Trim()
if (-not $adminSecret) { throw "Nao consegui extrair o valor de $AdminSecretPath" }

if (-not $Filter -and (-not $MachineIds -or $MachineIds.Count -eq 0)) {
    throw "Especifique -Filter ou -MachineIds -- selecao de alvo e obrigatoria, sem default de 'todas'."
}

# 1. Resolve alvo
$machines = Invoke-RestMethod -Uri "$ServidorURL/api/machines" -TimeoutSec 15
if ($Filter) { $targets = @($machines | Where-Object { $_.hostname -match $Filter }) }
else { $targets = @($machines | Where-Object { $MachineIds -contains $_.id }) }
if (-not $targets -or $targets.Count -eq 0) { throw "Nenhuma maquina encontrada para o filtro/lista dado." }

Write-Host "`nAlvo ($($targets.Count) maquina(s)) -- Action=$Action :" -ForegroundColor Cyan
$targets | ForEach-Object { Write-Host "  - $($_.hostname) ($($_.location)) [$($_.id)] $($_.status)" }

$mutating = $Action -in @("Apply","Rollback")
if ($mutating) {
    $confirm = Read-Host "`n$Action vai mudar SeShutdownPrivilege nessa(s) maquina(s). Confirma? (s/n)"
    if ($confirm -ne "s") { Write-Host "Abortado." -ForegroundColor Yellow; exit 1 }
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

# 2. Scripts remotos por acao (so leitura pra Verify; export+edita+reimporta pra Apply/Rollback)
function Build-RemoteCommand([string]$psScript) {
    $b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($psScript))
    return '$b="{0}";$s=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b));Invoke-Expression $s' -f $b64
}

$verifyScript = @'
try {
    $tmp = [System.IO.Path]::GetTempFileName()
    secedit /export /cfg $tmp /areas USER_RIGHTS | Out-Null
    $line = (Get-Content $tmp -Encoding Unicode | Where-Object { $_ -match '^SeShutdownPrivilege\s*=' })
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if ($line) { Write-Output "LINHA=[$($line.Trim())]" } else { Write-Output "LINHA=[NAO ENCONTRADA -- privilegio pode nao ter linha explicita no template local]" }
} catch { Write-Output "ERRO: $($_.Exception.Message)" }
'@

$applyScript = @'
try {
    $tmp = [System.IO.Path]::GetTempFileName()
    secedit /export /cfg $tmp /areas USER_RIGHTS | Out-Null
    $content = Get-Content $tmp -Encoding Unicode
    $line = $content | Where-Object { $_ -match '^SeShutdownPrivilege\s*=' }
    $originalLine = if ($line) { $line.Trim() } else { "SeShutdownPrivilege = " }
    $originalSids = @()
    if ($originalLine -match '=\s*(.*)$') {
        $originalSids = ($matches[1] -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    }
    $keepSids = $originalSids | Where-Object { $_ -ne '*S-1-5-32-544' -and $_ -ne '*S-1-5-32-545' -and $_ -ne '*S-1-5-32-551' }
    foreach ($essential in @('*S-1-5-18','*S-1-5-19','*S-1-5-20')) {
        if ($keepSids -notcontains $essential) { $keepSids += $essential }
    }
    $newLine = "SeShutdownPrivilege = " + ($keepSids -join ',')
    if ($content -match '^SeShutdownPrivilege\s*=') {
        $newContent = $content | ForEach-Object { if ($_ -match '^SeShutdownPrivilege\s*=') { $newLine } else { $_ } }
    } else {
        $newContent = $content -replace '(\[Privilege Rights\])', "`$1`r`n$newLine"
    }
    Set-Content -Path $tmp -Value $newContent -Encoding Unicode
    secedit /configure /db "$env:windir\security\local.sdb" /cfg $tmp /areas USER_RIGHTS /quiet | Out-Null
    $tmp2 = [System.IO.Path]::GetTempFileName()
    secedit /export /cfg $tmp2 /areas USER_RIGHTS | Out-Null
    $confirmLineRaw = Get-Content $tmp2 -Encoding Unicode | Where-Object { $_ -match '^SeShutdownPrivilege\s*=' }
    $confirmLine = if ($confirmLineRaw) { $confirmLineRaw.Trim() } else { "NAO ENCONTRADA" }
    Remove-Item $tmp,$tmp2 -ErrorAction SilentlyContinue
    Write-Output "ORIGINAL=[$originalLine] | APLICADO=[$confirmLine]"
} catch { Write-Output "ERRO: $($_.Exception.Message)" }
'@

$diagScript = @'
try {
    $priv = whoami /priv | Out-String
    $shutdownLine = ($priv -split "`r?`n" | Where-Object { $_ -match "SeShutdownPrivilege" })
    $sysPriv = if ($shutdownLine) { $shutdownLine.Trim() } else { "SeShutdownPrivilege NAO APARECE em whoami /priv do SYSTEM" }

    $tmp = [System.IO.Path]::GetTempFileName()
    secedit /export /cfg $tmp /areas USER_RIGHTS | Out-Null
    $full = Get-Content $tmp -Encoding Unicode
    $shutdownRaw = ($full | Where-Object { $_ -match "SeShutdownPrivilege" })
    Remove-Item $tmp -ErrorAction SilentlyContinue

    Write-Output "whoami/priv(SYSTEM)=[$sysPriv]"
    Write-Output "secedit-raw=[$($shutdownRaw -join ' ; ')]"
} catch { Write-Output "ERRO: $($_.Exception.Message)" }
'@

# 3. Dispara (Start-Job + Wait-Job -Timeout -- -TimeoutSec sozinho nao segura,
#    confirmado 04/11/2026 em push-agent-to-machines.ps1)
$results = @()
foreach ($t in $targets) {
    if ($Action -eq "Rollback") {
        $backupFile = Join-Path $BackupDir "$($t.hostname).txt"
        if (-not (Test-Path $backupFile)) {
            Write-Host "$($t.hostname): SEM BACKUP em $backupFile -- pulando (rode Apply antes, ou restaure manual)" -ForegroundColor Red
            $results += [PSCustomObject]@{ hostname = $t.hostname; status = "sem-backup" }
            continue
        }
        $originalLine = (Get-Content $backupFile -Raw).Trim()
        $rollbackScript = @"
try {
    `$tmp = [System.IO.Path]::GetTempFileName()
    secedit /export /cfg `$tmp /areas USER_RIGHTS | Out-Null
    `$content = Get-Content `$tmp -Encoding Unicode
    `$newContent = `$content | ForEach-Object { if (`$_ -match '^SeShutdownPrivilege\s*=') { '$originalLine' } else { `$_ } }
    Set-Content -Path `$tmp -Value `$newContent -Encoding Unicode
    secedit /configure /db "`$env:windir\security\local.sdb" /cfg `$tmp /areas USER_RIGHTS /quiet | Out-Null
    `$tmp2 = [System.IO.Path]::GetTempFileName()
    secedit /export /cfg `$tmp2 /areas USER_RIGHTS | Out-Null
    `$confirmLineRaw = Get-Content `$tmp2 -Encoding Unicode | Where-Object { `$_ -match '^SeShutdownPrivilege\s*=' }
    `$confirmLine = if (`$confirmLineRaw) { `$confirmLineRaw.Trim() } else { "NAO ENCONTRADA" }
    Remove-Item `$tmp,`$tmp2 -ErrorAction SilentlyContinue
    Write-Output "RESTAURADO=[`$confirmLine]"
} catch { Write-Output "ERRO: `$(`$_.Exception.Message)" }
"@
        $remoteCommand = Build-RemoteCommand $rollbackScript
    } elseif ($Action -eq "Apply") {
        $remoteCommand = Build-RemoteCommand $applyScript
    } elseif ($Action -eq "Diag") {
        $remoteCommand = Build-RemoteCommand $diagScript
    } else {
        $remoteCommand = Build-RemoteCommand $verifyScript
    }

    $body = @{ script = $remoteCommand } | ConvertTo-Json
    $job = Start-Job -ScriptBlock {
        param($uri, $secret, $body)
        Invoke-RestMethod -Uri $uri -Method Post -Headers @{ "X-Admin-Secret" = $secret } -ContentType "application/json" -Body $body -TimeoutSec 60
    } -ArgumentList "$ServidorURL/api/machines/$($t.id)/run", $adminSecret, $body

    Write-Host -NoNewline "$($t.hostname): "
    if (Wait-Job $job -Timeout 25) {
        try {
            $resp = Receive-Job $job -ErrorAction Stop
            $out = $resp.output
            Write-Host $out -ForegroundColor Green
            if ($Action -eq "Apply" -and $out -match 'ORIGINAL=\[(.*?)\]\s*\|\s*APLICADO=') {
                Set-Content -Path (Join-Path $BackupDir "$($t.hostname).txt") -Value $matches[1] -NoNewline
                Write-Host "    (backup salvo em $BackupDir\$($t.hostname).txt)" -ForegroundColor DarkGray
            }
            $results += [PSCustomObject]@{ hostname = $t.hostname; status = "ok"; output = $out }
        } catch {
            Write-Host "ERRO - $($_.Exception.Message)" -ForegroundColor Red
            $results += [PSCustomObject]@{ hostname = $t.hostname; status = "erro" }
        }
    } else {
        Write-Host "sem resposta em 25s -- confirmar manual depois" -ForegroundColor Yellow
        $results += [PSCustomObject]@{ hostname = $t.hostname; status = "timeout" }
    }
    Stop-Job $job -ErrorAction SilentlyContinue | Out-Null
    Remove-Job $job -Force -ErrorAction SilentlyContinue
}

if ($mutating) {
    $okCount = ($results | Where-Object { $_.status -eq "ok" }).Count
    $logLine = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] HIGH (confirmado pelo Andre) | block-shutdown-privilege.ps1 -Action $Action -> $okCount ok de $($targets.Count) maquina(s) ($($targets.hostname -join ', ')) | razao: bloqueio de shutdown local via SeShutdownPrivilege (grupo Administradores/Users/Power Users removidos da lista, sem tirar ninguem do grupo), piloto antes de rollout"
    Add-Content -Path (Join-Path $PSScriptRoot "..\.claude\decision.log") -Value $logLine
}

Write-Host "`nResultado:" -ForegroundColor Cyan
$results | Format-Table -AutoSize
