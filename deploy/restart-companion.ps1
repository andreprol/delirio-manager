<#
.SYNOPSIS
    Reinicia so o companion (Acesso Remoto) de UMA maquina, sem precisar de
    Zamak/AnyDesk/RDP nem reboot da maquina inteira.

.DESCRIPTION
    Achado real 17/11/2026 (AUXILIAR-ASS, ver
    feedback_companion_long_running_trava_input_mantem_captura na memoria): o
    companion (delirio-agent.exe --companion, roda sob a conta da loja, NAO
    SYSTEM) pode ficar muito tempo vivo e parar de aceitar input remoto
    (mouse/teclado/tecla Win) enquanto a CAPTURA de tela continua funcionando
    normal -- sintoma enganoso, parece rede/relay quebrado mas nao e. Fix que
    funcionou ao vivo: finalizar esse processo especifico no Gerenciador de
    Tarefas (nao o do SISTEMA) -- sessionWatchTick relanca um companion novo
    sozinho.

    Esse script faz a MESMA coisa remotamente, via run_powershell (mesmo canal
    admin de toggle-feature-flag.ps1/push-agent-to-machines.ps1) -- motivacao
    direta: sem a Zamak como fallback (Andre pretende cancelar quando o
    Delirio Manager tiver 100%), precisa de um jeito de resolver isso sem
    outra ferramenta de acesso remoto.

    Mata SOMENTE processos delirio-agent.exe cujo dono NAO e SYSTEM (a conta
    do servico) -- nunca o processo do servico em si. Diferente de
    toggle-feature-flag.ps1 (que mata o PROPRIO processo que executa o
    script, via Stop-Process no PID do servico, e por isso nunca recebe ACK),
    este mata um processo IRMAO (companion) -- o powershell.exe que roda este
    script (filho do servico) sobrevive e consegue responder normal, ACK
    esperado desta vez.

.PARAMETER MachineId
    GUID da maquina alvo (ver GET /api/machines).

.EXAMPLE
    .\restart-companion.ps1 -MachineId 4a885577-061b-4e5a-a489-9a6f9985fbb1
#>
param(
    [Parameter(Mandatory)][string]$MachineId,
    [string]$ServidorURL = "https://dt-manager.brazilsouth.cloudapp.azure.com",
    [string]$AdminSecretPath = (Join-Path $PSScriptRoot "..\.secrets\admin-secret.txt")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $AdminSecretPath)) { throw "Admin secret nao encontrado em $AdminSecretPath" }
$adminSecret = (Get-Content $AdminSecretPath | Where-Object { $_ -and $_ -notmatch '^-+$' -and $_ -ne 'adminSecret' } | Select-Object -First 1).Trim()
if (-not $adminSecret) { throw "Nao consegui extrair o valor de $AdminSecretPath" }

$remoteScript = @'
$procs = Get-CimInstance Win32_Process -Filter "Name='delirio-agent.exe'"
if (-not $procs) { Write-Output "NENHUM-PROCESSO-delirio-agent.exe-ENCONTRADO"; exit }
$killed = @()
$kept = @()
foreach ($p in $procs) {
    try {
        $ownerInfo = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
        # achado 🔴 do code-reviewer: GetOwner pode "falhar" sem lancar excecao
        # (ReturnValue != 0, Domain/User vazios) -- nesse caso $null -eq "SYSTEM"
        # e falso e o processo cairia no else e seria MORTO, podendo ser o
        # servico cujo dono nao foi possivel resolver. Em duvida, preservar,
        # nunca matar.
        if ($ownerInfo.ReturnValue -ne 0) {
            $kept += "PID=$($p.ProcessId) owner=INDETERMINADO (GetOwner retornou $($ownerInfo.ReturnValue), preservado por seguranca)"
            continue
        }
        $owner = "$($ownerInfo.Domain)\$($ownerInfo.User)"
        if ($ownerInfo.Domain -eq "NT AUTHORITY" -and $ownerInfo.User -eq "SYSTEM") {
            $kept += "PID=$($p.ProcessId) owner=$owner (SERVICO, preservado)"
            continue
        }
        # achado 🟠 do code-reviewer: filtrar só por Name mataria qualquer
        # delirio-agent.exe nao-SYSTEM, inclusive uma execucao manual de
        # diagnostico (ex: Andre rodando o exe na mao numa sessao Normal) --
        # só mata quem tem --companion na linha de comando de verdade.
        if ($p.CommandLine -notlike '*--companion*') {
            $kept += "PID=$($p.ProcessId) owner=$owner cmdline=[$($p.CommandLine)] (sem --companion, preservado)"
            continue
        }
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        $killed += "PID=$($p.ProcessId) owner=$owner"
    } catch {
        # achado 🟠 do code-reviewer: sem isso, 1 falha no meio do loop (ex:
        # processo ja morreu sozinho entre o Get-CimInstance e o Stop-Process
        # -- sessionWatchTick pode relançar/matar por conta propria) jogava a
        # excecao pro catch de fora (que nem existe mais) e descartava todo o
        # progresso ja feito nos outros processos.
        $kept += "PID=$($p.ProcessId) (erro ao processar: $($_.Exception.Message))"
    }
}
Write-Output "MATADOS=[$($killed -join '; ')] PRESERVADOS=[$($kept -join '; ')]"
'@

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
if (Wait-Job $job -Timeout 40) {
    try {
        $resp = Receive-Job $job -ErrorAction Stop
        Write-Host "$($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
    } catch {
        Write-Host "ERRO - $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "sem resposta em 40s -- confirmar via nova sessao de Acesso Remoto" -ForegroundColor Yellow
}
Stop-Job $job -ErrorAction SilentlyContinue | Out-Null
Remove-Job $job -Force -ErrorAction SilentlyContinue

$logLine = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] MEDIUM | restart-companion.ps1 -> kill companion (nao-SYSTEM) em $MachineId | razao: recuperar input remoto travado sem depender de outra ferramenta de acesso remoto"
Add-Content -Path (Join-Path $PSScriptRoot "..\.claude\decision.log") -Value $logLine
