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

    05/11/2026 (2a sessao): Apply na AUXILIAR-ASS "rodou" mas a confirmacao
    imediata mostrou SeShutdownPrivilege ausente da secao. Diag melhorado
    (exit code + log real + 2a leitura +2s) confirmou CAUSA RAIZ: nao era
    race -- secedit /configure retornava exit code 1, log "nao foi feito
    mapeamento entre nomes de conta e SIDs" (SIDs de servico orfaos em
    OUTRAS linhas da secao faziam a secao INTEIRA falhar, derrubando junto
    a linha que a gente tava tentando mudar). Separado disso: whoami /priv
    de usuario JA LOGADO cacheia privilegios no token no logon -- teste de
    "shutdown ainda funcionou" sem reautenticar a conta nao prova nada.

    Fix: trocado secedit /export+edita+reimporta por LsaAddAccountRights /
    LsaRemoveAccountRights via P/Invoke direto (Apply/Rollback) -- mexe SO
    nos SIDs e privilegio alvo, sem reprocessar/resolver o resto da secao
    USER_RIGHTS. Validado localmente (ADD+REMOVE round-trip limpo no grupo
    Guests, S-1-5-32-546) antes de ir pra producao. Verify/Diag continuam
    lendo via secedit /export (isso sempre funcionou certo, so a ESCRITA
    via /configure que quebrava).
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

# Preambulo LSA (LsaAddAccountRights/LsaRemoveAccountRights via P/Invoke) --
# substitui secedit /configure, que confirmado 05/11/2026 (2a sessao) falha
# com exit code 1 "nao foi feito mapeamento entre nomes de conta e SIDs" em
# maquinas com SIDs de servico orfaos em OUTRAS linhas da secao USER_RIGHTS
# (secedit reprocessa a secao INTEIRA, nao so a linha editada -- 1 SID orfao
# em qualquer lugar derruba a operacao toda). LSA API mexe so no privilegio e
# SIDs especificos, sem tocar nem resolver o resto da secao. Validado local
# (ADD+REMOVE round-trip limpo no grupo Guests) antes de ir pra producao.
$lsaPreamble = @'
if (-not ([System.Management.Automation.PSTypeName]"LsaHelper").Type) {
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class LsaHelper {
    [StructLayout(LayoutKind.Sequential)]
    public struct LSA_UNICODE_STRING {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct LSA_OBJECT_ATTRIBUTES {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public int Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [DllImport("advapi32.dll", SetLastError = true, PreserveSig = true)]
    public static extern uint LsaOpenPolicy(ref LSA_UNICODE_STRING SystemName, ref LSA_OBJECT_ATTRIBUTES ObjectAttributes, uint DesiredAccess, out IntPtr PolicyHandle);

    [DllImport("advapi32.dll", SetLastError = true, PreserveSig = true)]
    public static extern uint LsaAddAccountRights(IntPtr PolicyHandle, byte[] AccountSid, LSA_UNICODE_STRING[] UserRights, int CountOfRights);

    [DllImport("advapi32.dll", SetLastError = true, PreserveSig = true)]
    public static extern uint LsaRemoveAccountRights(IntPtr PolicyHandle, byte[] AccountSid, [MarshalAs(UnmanagedType.U1)] bool AllRights, LSA_UNICODE_STRING[] UserRights, int CountOfRights);

    [DllImport("advapi32.dll")]
    public static extern int LsaNtStatusToWinError(uint status);

    [DllImport("advapi32.dll")]
    public static extern uint LsaClose(IntPtr ObjectHandle);
}
"@
}

function Convert-ToLsaString([string]$s) {
    $r = New-Object LsaHelper+LSA_UNICODE_STRING
    $r.Buffer = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni($s)
    $r.Length = [uint16]($s.Length * 2)
    $r.MaximumLength = [uint16](($s.Length + 1) * 2)
    return $r
}

function Open-LsaPolicy {
    $sysName = New-Object LsaHelper+LSA_UNICODE_STRING
    $oa = New-Object LsaHelper+LSA_OBJECT_ATTRIBUTES
    $handle = [IntPtr]::Zero
    $POLICY_ALL_ACCESS = 0x000F0FFF
    $status = [LsaHelper]::LsaOpenPolicy([ref]$sysName, [ref]$oa, $POLICY_ALL_ACCESS, [ref]$handle)
    if ($status -ne 0) {
        $win = [LsaHelper]::LsaNtStatusToWinError($status)
        throw "LsaOpenPolicy falhou: status=$status winerror=$win"
    }
    return $handle
}

function Add-LsaRight([string]$sidString, [string]$rightName) {
    $handle = Open-LsaPolicy
    try {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($sidString)
        $sidBytes = New-Object byte[] ($sid.BinaryLength)
        $sid.GetBinaryForm($sidBytes, 0)
        $lsaStr = Convert-ToLsaString $rightName
        try {
            $rights = [LsaHelper+LSA_UNICODE_STRING[]]@($lsaStr)
            $status = [LsaHelper]::LsaAddAccountRights($handle, $sidBytes, $rights, 1)
        } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($lsaStr.Buffer) }
        if ($status -ne 0) {
            $win = [LsaHelper]::LsaNtStatusToWinError($status)
            return "ERRO-status=$status-winerror=$win"
        }
        return "OK"
    } finally { [LsaHelper]::LsaClose($handle) | Out-Null }
}

function Remove-LsaRight([string]$sidString, [string]$rightName) {
    $handle = Open-LsaPolicy
    try {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($sidString)
        $sidBytes = New-Object byte[] ($sid.BinaryLength)
        $sid.GetBinaryForm($sidBytes, 0)
        $lsaStr = Convert-ToLsaString $rightName
        try {
            $rights = [LsaHelper+LSA_UNICODE_STRING[]]@($lsaStr)
            $status = [LsaHelper]::LsaRemoveAccountRights($handle, $sidBytes, $false, $rights, 1)
        } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($lsaStr.Buffer) }
        if ($status -ne 0 -and $status -ne 0xC0000034) {
            $win = [LsaHelper]::LsaNtStatusToWinError($status)
            return "ERRO-status=$status-winerror=$win"
        }
        return "OK"
    } finally { [LsaHelper]::LsaClose($handle) | Out-Null }
}

function Get-SeShutdownLine {
    $tmp = [System.IO.Path]::GetTempFileName()
    secedit /export /cfg $tmp /areas USER_RIGHTS | Out-Null
    $line = Get-Content $tmp -Encoding Unicode | Where-Object { $_ -match '^SeShutdownPrivilege\s*=' }
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if ($line) { return $line.Trim() } else { return "NAO ENCONTRADA" }
}
'@

$verifyScript = @'
try {
    $tmp = [System.IO.Path]::GetTempFileName()
    secedit /export /cfg $tmp /areas USER_RIGHTS | Out-Null
    $line = (Get-Content $tmp -Encoding Unicode | Where-Object { $_ -match '^SeShutdownPrivilege\s*=' })
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if ($line) { Write-Output "LINHA=[$($line.Trim())]" } else { Write-Output "LINHA=[NAO ENCONTRADA -- privilegio pode nao ter linha explicita no template local]" }
} catch { Write-Output "ERRO: $($_.Exception.Message)" }
'@

# Apply: le SIDs atuais, remove Admins/Users/PowerUsers do privilegio via LSA
# e garante SYSTEM/LOCAL SERVICE/NETWORK SERVICE explicitos -- so os SIDs
# alvo, sem reprocessar o resto da secao USER_RIGHTS (o que quebrava no
# secedit /configure).
$applyBody = @'
try {
    $originalLine = Get-SeShutdownLine
    $originalSids = @()
    if ($originalLine -match '=\s*(.*)$') {
        $originalSids = ($matches[1] -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    }
    $toRemove = @('*S-1-5-32-544','*S-1-5-32-545','*S-1-5-32-551') | Where-Object { $originalSids -contains $_ }
    $toAdd    = @('*S-1-5-18','*S-1-5-19','*S-1-5-20') | Where-Object { $originalSids -notcontains $_ }
    $removeResults = @()
    foreach ($sidStr in $toRemove) { $plain = $sidStr.TrimStart('*'); $removeResults += "$sidStr=$(Remove-LsaRight $plain 'SeShutdownPrivilege')" }
    $addResults = @()
    foreach ($sidStr in $toAdd) { $plain = $sidStr.TrimStart('*'); $addResults += "$sidStr=$(Add-LsaRight $plain 'SeShutdownPrivilege')" }
    Start-Sleep -Seconds 1
    $confirmLine = Get-SeShutdownLine
    Write-Output "ORIGINAL=[$originalLine] | REMOVIDOS=[$($removeResults -join '; ')] | ADICIONADOS=[$($addResults -join '; ')] | APLICADO=[$confirmLine]"
} catch { Write-Output "ERRO: $($_.Exception.Message)" }
'@

# Rollback: mesma logica invertida -- __ORIGINAL_LINE_B64__ e substituido via
# .Replace() e decodificado de base64 dentro do template remoto. Trocar
# aspas simples por duplas (versao anterior) NAO elimina injecao -- o valor
# ainda vira codigo reinterpretado pelo Invoke-Expression remoto se contiver
# `"`, `` ` `` ou `$`. Base64 so usa [A-Za-z0-9+/=], sem metacaractere nenhum
# pro PowerShell interpretar (achado real do code-reviewer, 17/11/2026).
$rollbackBodyTemplate = @'
try {
    $originalLine = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("__ORIGINAL_LINE_B64__"))
    $originalSids = @()
    if ($originalLine -match '=\s*(.*)$') {
        $originalSids = ($matches[1] -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    }
    $toAddBack = @('*S-1-5-32-544','*S-1-5-32-545','*S-1-5-32-551') | Where-Object { $originalSids -contains $_ }
    $toRemoveBack = @('*S-1-5-18','*S-1-5-19','*S-1-5-20') | Where-Object { $originalSids -notcontains $_ }
    $addResults = @()
    foreach ($sidStr in $toAddBack) { $plain = $sidStr.TrimStart('*'); $addResults += "$sidStr=$(Add-LsaRight $plain 'SeShutdownPrivilege')" }
    $removeResults = @()
    foreach ($sidStr in $toRemoveBack) { $plain = $sidStr.TrimStart('*'); $removeResults += "$sidStr=$(Remove-LsaRight $plain 'SeShutdownPrivilege')" }
    Start-Sleep -Seconds 1
    $confirmLine = Get-SeShutdownLine
    Write-Output "RESTAURADO=[$confirmLine] | READICIONADOS=[$($addResults -join '; ')] | REMOVIDOS=[$($removeResults -join '; ')]"
} catch { Write-Output "ERRO: $($_.Exception.Message)" }
'@

$diagScript = @'
try {
    $priv = whoami /priv | Out-String
    $shutdownLine = ($priv -split "`r?`n" | Where-Object { $_ -match "SeShutdownPrivilege" })
    $sysPriv = if ($shutdownLine) { $shutdownLine.Trim() } else { "SeShutdownPrivilege NAO APARECE em whoami /priv do SYSTEM" }

    $tmp = [System.IO.Path]::GetTempFileName()
    secedit /export /cfg $tmp /areas USER_RIGHTS | Out-Null
    $exportExit1 = $LASTEXITCODE
    $full = Get-Content $tmp -Encoding Unicode
    $shutdownRaw = ($full | Where-Object { $_ -match "SeShutdownPrivilege" })
    $sectionDump1 = ($full | Where-Object { $_ -match '^Se\w+\s*=' }) -join ' || '
    Remove-Item $tmp -ErrorAction SilentlyContinue

    # 2a leitura, 2s depois -- detecta race/lock no local.sdb (export logo apos
    # configure pode pegar estado transitorio; comparar as duas leituras
    # isola se a "ausencia" e real ou e so timing)
    Start-Sleep -Seconds 2
    $tmp3 = [System.IO.Path]::GetTempFileName()
    secedit /export /cfg $tmp3 /areas USER_RIGHTS | Out-Null
    $exportExit2 = $LASTEXITCODE
    $full2 = Get-Content $tmp3 -Encoding Unicode
    $shutdownRaw2 = ($full2 | Where-Object { $_ -match "SeShutdownPrivilege" })
    Remove-Item $tmp3 -ErrorAction SilentlyContinue

    Write-Output "whoami/priv(SYSTEM)=[$sysPriv]"
    $estavel = ($shutdownRaw -join ',').Trim() -eq ($shutdownRaw2 -join ',').Trim()
    Write-Output "secedit-raw-leitura1=[$($shutdownRaw -join ' ; ')] exit=[$exportExit1]"
    Write-Output "secedit-raw-leitura2(+2s)=[$($shutdownRaw2 -join ' ; ')] exit=[$exportExit2]"
    Write-Output "ESTAVEL-ENTRE-LEITURAS=[$estavel]"
    Write-Output "SECTION-DUMP-COMPLETA=[$sectionDump1]"
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
        $originalLineB64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($originalLine))
        $rollbackScript = $lsaPreamble + "`n" + $rollbackBodyTemplate.Replace('__ORIGINAL_LINE_B64__', $originalLineB64)
        $remoteCommand = Build-RemoteCommand $rollbackScript
    } elseif ($Action -eq "Apply") {
        $remoteCommand = Build-RemoteCommand ($lsaPreamble + "`n" + $applyBody)
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
            $backupFileOut = Join-Path $BackupDir "$($t.hostname).txt"
            if ($Action -eq "Apply" -and $out -match 'ORIGINAL=\[(.*?)\]') {
                if (Test-Path $backupFileOut) {
                    Write-Host "    (backup ja existia em $backupFileOut -- NAO sobrescrito, so o Apply mais antigo conta como estado de fabrica)" -ForegroundColor DarkGray
                } else {
                    Set-Content -Path $backupFileOut -Value $matches[1] -NoNewline
                    Write-Host "    (backup salvo em $backupFileOut)" -ForegroundColor DarkGray
                }
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
