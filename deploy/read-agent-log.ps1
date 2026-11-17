<#
.SYNOPSIS
    Le as ultimas N linhas de agent.log de UMA maquina remotamente, via
    run_powershell (mesmo canal admin de toggle-feature-flag.ps1) -- sem
    precisar copiar o arquivo (que falha via ferramentas de transferencia
    normais enquanto o servico tem ele aberto pra escrita).

.PARAMETER MachineId
    GUID da maquina alvo (ver GET /api/machines).

.PARAMETER Lines
    Quantas linhas do final do arquivo (default 150).

.EXAMPLE
    .\read-agent-log.ps1 -MachineId 4a885577-061b-4e5a-a489-9a6f9985fbb1 -Lines 150
#>
param(
    [Parameter(Mandatory)][string]$MachineId,
    [int]$Lines = 150,
    [string]$ServidorURL = "https://dt-manager.brazilsouth.cloudapp.azure.com",
    [string]$AdminSecretPath = (Join-Path $PSScriptRoot "..\.secrets\admin-secret.txt")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $AdminSecretPath)) { throw "Admin secret nao encontrado em $AdminSecretPath" }
$adminSecret = (Get-Content $AdminSecretPath | Where-Object { $_ -and $_ -notmatch '^-+$' -and $_ -ne 'adminSecret' } | Select-Object -First 1).Trim()
if (-not $adminSecret) { throw "Nao consegui extrair o valor de $AdminSecretPath" }

$remoteScript = @"
try {
    `$svc = Get-WmiObject Win32_Service -Filter "Name='DelirioAgent'"
    `$exePath = (`$svc.PathName -replace '"','').Trim()
    `$logPath = Join-Path (Split-Path `$exePath) "agent.log"
    if (-not (Test-Path `$logPath)) { Write-Output "ARQUIVO-NAO-ENCONTRADO: `$logPath"; exit }
    Get-Content -Path `$logPath -Tail $Lines -ErrorAction Stop | Out-String -Width 500
} catch { Write-Output "ERRO: `$(`$_.Exception.Message)" }
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

if (Wait-Job $job -Timeout 40) {
    try {
        $resp = Receive-Job $job -ErrorAction Stop
        Write-Output $resp.output
    } catch {
        Write-Host "ERRO - $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "sem resposta em 40s" -ForegroundColor Yellow
}
Stop-Job $job -ErrorAction SilentlyContinue | Out-Null
Remove-Job $job -Force -ErrorAction SilentlyContinue

$logLine = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] MEDIUM | read-agent-log.ps1 -> leu agent.log (tail $Lines) de $MachineId | razao: diagnosticar captura preta no modo session-zero"
Add-Content -Path (Join-Path $PSScriptRoot "..\.claude\decision.log") -Value $logLine
