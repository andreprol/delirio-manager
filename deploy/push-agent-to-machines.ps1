<#
.SYNOPSIS
    Aplica um delirio-agent.exe atualizado em maquinas ja instaladas da
    frota, SEM depender do feed de auto-update (que e fleet-wide e so
    dispara com bump de versao -- atingiria todas as ~130+ maquinas de
    uma vez, nao so o alvo escolhido).

.DESCRIPTION
    1. Resolve a lista de maquinas alvo via GET /api/machines (sem auth).
    2. Sobe o .exe pro Azure Blob (dtmanagerdr/deploy) com um nome unico,
       gera um SAS de leitura valido por 2h.
    3. Chama POST /api/machines/:id/run (canal run_powershell que o agent
       ja executa, autenticado via X-Admin-Secret) DIRETO pela URL publica
       do servidor, pra cada maquina alvo -- baixa o exe do SAS, valida
       tamanho, para o servico, substitui, reinicia.
    4. version.json / POST /api/update/publish NUNCA sao tocados -- zero
       risco de disparar autoupdate passivo em maquinas fora do alvo
       (o agent so se autoatualiza se a Version dele != a do feed; como
       este script nao muda nenhum feed, ninguem fora do alvo nota nada).

    Versao anterior deste script rodava um orquestrador bash NA VM via
    `az vm run-command` (achando ADMIN_SECRET la dentro, pra nunca expor
    o valor). Simplificado em 04/11/2026: o endpoint admin funciona pela
    URL publica tambem (nao so localhost na VM), e o `adminSecret` real
    mora no PC do Andre (mesmo arquivo que o Dashboard Electron le, ver
    -AdminSecretPath) -- nao precisa mais de VM nenhuma no meio, nem do
    orquestrador bash (que gerou 2 bugs reais de escaping/race condition
    na primeira tentativa, ver .claude/decision.log e CLAUDE.md).

.PARAMETER ExePath
    Caminho do delirio-agent.exe (ja buildado, com os testes passando).

.PARAMETER Filter
    Regex sobre o hostname pra escolher o alvo (ex: "BOH" pras 9
    maquinas back-of-house, uma por loja -- convencao de rollout
    "BOH-first" porque Andre pode mexer nelas em qualquer horario, sem
    risco de interromper caixa/atendimento).

.PARAMETER MachineIds
    Lista explicita de IDs (GUID) de maquina, alternativa a -Filter.

.PARAMETER AdminSecretPath
    Arquivo local com o adminSecret (default: .secrets/admin-secret.txt na
    raiz do repo -- gitignored explicitamente, NUNCA commitado; copia
    tambem existe em %APPDATA%\delirio-manager-dashboard\config.json e no
    Desktop do Andre, ver CLAUDE.md "Onde fica o ADMIN_SECRET"). Formato:
    "adminSecret\n-----------\n<valor>".

.EXAMPLE
    .\push-agent-to-machines.ps1 -ExePath ..\agent\delirio-agent.exe -Filter BOH

.EXAMPLE
    .\push-agent-to-machines.ps1 -ExePath ..\agent\delirio-agent.exe -MachineIds ff67c097-1b81-408c-897e-2fc5d3fdf7e8

.NOTES
    Autorizado como "elevate" em .claude/auto-approve.json (entrada
    "deploy: push-agent-to-machines.ps1"), por Andre, 04/11/2026 -- fix
    de injecao de teclado no Acesso Remoto modo Normal (commit 3eb3635),
    rollout iniciado pelas 9 BOH. Mesmo assim, toda execucao grava uma
    linha MEDIUM em .claude/decision.log (nao pular esse log so porque
    esta elevado).

    NAO testado ponta-a-ponta em maquina real ainda (04/11/2026) --
    validar numa unica maquina BOH primeiro e confirmar no dashboard
    (sessao Normal -> testar digitacao) que o servico voltou saudavel.
#>
param(
    [Parameter(Mandatory)][string]$ExePath,
    [string]$Filter,
    [string[]]$MachineIds,
    [string]$ServidorURL = "https://dt-manager.brazilsouth.cloudapp.azure.com",
    [string]$StorageAccount = "dtmanagerdr",
    [string]$Container = "deploy",
    [string]$AdminSecretPath = (Join-Path $PSScriptRoot "..\.secrets\admin-secret.txt")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ExePath)) { throw "Exe nao encontrado: $ExePath" }
if (-not (Test-Path $AdminSecretPath)) { throw "Admin secret nao encontrado em $AdminSecretPath (passe -AdminSecretPath)" }

# Arquivo e "adminSecret\n-----------\n<valor>" -- pega a primeira linha
# que nao e o cabecalho nem a linha de tracos.
$adminSecret = (Get-Content $AdminSecretPath | Where-Object { $_ -and $_ -notmatch '^-+$' -and $_ -ne 'adminSecret' } | Select-Object -First 1).Trim()
if (-not $adminSecret) { throw "Nao consegui extrair o valor de $AdminSecretPath" }

# 1. Resolve maquinas alvo
$machines = Invoke-RestMethod -Uri "$ServidorURL/api/machines" -TimeoutSec 15
if ($Filter) {
    $targets = @($machines | Where-Object { $_.hostname -match $Filter })
} elseif ($MachineIds) {
    $targets = @($machines | Where-Object { $MachineIds -contains $_.id })
} else {
    throw "Especifique -Filter ou -MachineIds"
}
if (-not $targets -or $targets.Count -eq 0) { throw "Nenhuma maquina encontrada para o filtro/lista dado." }

Write-Host "`nAlvo ($($targets.Count) maquina(s)):" -ForegroundColor Cyan
$targets | ForEach-Object {
    Write-Host "  - $($_.hostname) ($($_.location)) [$($_.id)] v$($_.agentVersion) $($_.status)"
}

$confirm = Read-Host "`nConfirma deploy nessa(s) maquina(s)? (s/n)"
if ($confirm -ne "s") { Write-Host "Abortado." -ForegroundColor Yellow; exit 1 }

# 2. Upload pro blob + SAS de leitura (2h)
$blobName = "delirio-agent-push-$(Get-Date -Format yyyyMMdd-HHmmss).exe"
$accountKey = az storage account keys list --account-name $StorageAccount --query "[0].value" -o tsv
if (-not $accountKey) { throw "Nao consegui obter a account key de $StorageAccount." }

az storage blob upload --account-name $StorageAccount --account-key $accountKey `
    --container-name $Container --name $blobName --file $ExePath --overwrite true | Out-Null

$expiry = (Get-Date).ToUniversalTime().AddHours(2).ToString("yyyy-MM-ddTHH:mmZ")
$sas = az storage blob generate-sas --account-name $StorageAccount --account-key $accountKey `
    --container-name $Container --name $blobName --permissions r --expiry $expiry --https-only -o tsv
$blobUrl = "https://$StorageAccount.blob.core.windows.net/$Container/$blobName" + "?" + $sas

Write-Host "Upload OK: $blobName (SAS expira em 2h)" -ForegroundColor Green

# 3. Script Windows (PowerShell) que cada maquina alvo vai executar via
#    run_powershell -- baixa PRIMEIRO, valida, so DEPOIS para o servico
#    (minimiza a janela com o agente fora do ar: stop+copy+start, nao
#    stop+download+copy+start).
$swapScript = @'
$tmp = "$env:TEMP\delirio-agent-push.exe"
try {
    Invoke-WebRequest -Uri "__BLOB_URL__" -OutFile $tmp -TimeoutSec 20
    $len = (Get-Item $tmp).Length
    if ($len -lt 1000000) { throw "download suspeito: $len bytes" }
    $svc = Get-WmiObject Win32_Service -Filter "Name='DelirioAgent'"
    $exePath = ($svc.PathName -replace '"','').Trim()
    Stop-Service DelirioAgent -Force
    Copy-Item $tmp $exePath -Force
    Start-Service DelirioAgent
    Start-Sleep -Seconds 2
    $status = (Get-Service DelirioAgent).Status
    Write-Output "OK status=$status path=$exePath size=$len"
} catch {
    Write-Output "ERRO: $($_.Exception.Message)"
}
'@.Replace('__BLOB_URL__', $blobUrl)

# Base64 evita qualquer problema de aspas/$ na hora de embutir isso dentro
# do JSON que o servidor repassa pro agent (que por sua vez passa pro
# `powershell -Command`) -- decodifica e roda de uma vez só.
$swapBytes = [System.Text.Encoding]::UTF8.GetBytes($swapScript)
$swapB64 = [System.Convert]::ToBase64String($swapBytes)
$remoteCommand = '$b="{0}";$s=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b));Invoke-Expression $s' -f $swapB64

# 4. POST direto na API publica pra cada maquina alvo. Rodado via Start-Job
#    + Wait-Job -Timeout + Stop-Job em vez de so Invoke-RestMethod
#    -TimeoutSec: confirmado ao vivo 04/11/2026 que -TimeoutSec nao segura
#    de verdade nesse caminho (ASSBOH ficou ~30min pendurado ate o proprio
#    gateway/nginx desistir com 504 -- o timeout do PowerShell nunca
#    disparou). Stop-Job mata o PROCESSO do job de verdade, garante que
#    uma maquina lenta/travada nunca segura as outras 8.
#
# Resposta devagar/504/timeout NAO significa que a maquina falhou -- o
# ASSBOH confirmou reconectar com sucesso mesmo com a resposta HTTP nunca
# voltando. Por isso um timeout aqui conta como "disparado, confirmar no
# dashboard", nao como erro definitivo.
$results = @()
foreach ($t in $targets) {
    $body = @{ script = $remoteCommand } | ConvertTo-Json
    $job = Start-Job -ScriptBlock {
        param($uri, $secret, $body)
        Invoke-RestMethod -Uri $uri -Method Post `
            -Headers @{ "X-Admin-Secret" = $secret } -ContentType "application/json" `
            -Body $body -TimeoutSec 60
    } -ArgumentList "$ServidorURL/api/machines/$($t.id)/run", $adminSecret, $body

    Write-Host -NoNewline "$($t.hostname): "
    if (Wait-Job $job -Timeout 25) {
        try {
            $resp = Receive-Job $job -ErrorAction Stop
            Write-Host "$($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
            $results += [PSCustomObject]@{ hostname = $t.hostname; status = "ok" }
        } catch {
            Write-Host "ERRO - $($_.Exception.Message)" -ForegroundColor Red
            $results += [PSCustomObject]@{ hostname = $t.hostname; status = "erro" }
        }
    } else {
        Write-Host "sem resposta em 25s -- disparado, confirmar no dashboard" -ForegroundColor Yellow
        $results += [PSCustomObject]@{ hostname = $t.hostname; status = "timeout" }
    }
    Stop-Job $job -ErrorAction SilentlyContinue | Out-Null
    Remove-Job $job -Force -ErrorAction SilentlyContinue
}

# Log MEDIUM obrigatorio mesmo com elevate (regra global do CLAUDE.md).
$okCount = ($results | Where-Object { $_.status -eq "ok" }).Count
$timeoutCount = ($results | Where-Object { $_.status -eq "timeout" }).Count
$erroCount = ($results | Where-Object { $_.status -eq "erro" }).Count
$logLine = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] MEDIUM | push-agent-to-machines.ps1 -> $okCount ok / $timeoutCount sem-resposta / $erroCount erro de $($targets.Count) maquina(s) ($($targets.hostname -join ', ')) | razao: deploy via blob+POST direto, elevado em auto-approve.json"
Add-Content -Path (Join-Path $PSScriptRoot "..\.claude\decision.log") -Value $logLine

Write-Host "`n$okCount ok / $timeoutCount sem-resposta (pode ter funcionado mesmo assim) / $erroCount erro." -ForegroundColor Green
Write-Host "Confira CADA maquina no dashboard (Acesso Remoto -> sessao Normal -> testar digitacao), principalmente as 'sem-resposta'." -ForegroundColor Green
