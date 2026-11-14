<#
.SYNOPSIS
    Publica a versao atual do agent (agent/main.go) pro servidor e manda
    atualizar sozinho em todas as maquinas online -- sem digitar versao,
    sem escolher arquivo na mao, sem rodar comando PowerShell maquina por
    maquina. Equivalente do `npm run release:auto` do dashboard, mas pro
    agent (Go).

.DESCRIPTION
    1. Le a Version de agent/main.go (fonte unica da verdade -- ja e
       bumpada manualmente a cada feature, junto do commit "chore(agent):
       bump versao pra X.Y.Z", igual sempre foi feito neste repo).
    2. Builda o binario Windows (-ldflags="-s -w", mesma flag do CI em
       .github/workflows/release-agent.yml).
    3. Confirma que o binario buildado realmente reporta essa versao
       (`-version`) antes de publicar -- nunca publica as cegas.
    4. POST /api/update/publish (sobe o .exe + version.json no servidor).
    5. POST /api/update/broadcast (manda o comando "update" de verdade --
       agent/commands.go:handleUpdate, self-update real do agent, NAO o
       hack de rename do push-agent-to-machines.ps1 -- pra TODAS as
       maquinas que estiverem online nesse instante).

    Nenhum dos dois endpoints pede secret (diferente de
    push-agent-to-machines.ps1, que le .secrets/admin-secret.txt pro
    canal run_powershell). Confirmado lendo server/routes/update.js --
    /publish e /broadcast nao tem middleware de auth.

.NOTES
    Autorizado por Andre em 13/11/2026 (sessao de atualizacao de frota)
    como MEDIUM -- igual o release:auto do dashboard, sempre logar em
    .claude/decision.log, nao pausar. Ver CLAUDE.md secao "Agent — Release
    Automatico".

    Maquinas OFFLINE no momento do broadcast nao recebem nada agora --
    so vao pegar a versao nova no proximo heartbeat depois de reconectar
    (agent confere a propria Version contra version.json a cada
    heartbeat -- auto-update e pull-based, ver
    feedback_agent_autoupdate_pull_based_any_heartbeat.md).
#>
param(
    [string]$ServerURL = "https://dt-manager.brazilsouth.cloudapp.azure.com"
)

$ErrorActionPreference = "Stop"
$agentDir = $PSScriptRoot

# 1. Versao atual (fonte unica: agent/main.go)
$mainGo = Get-Content (Join-Path $agentDir "main.go") -Raw
if ($mainGo -notmatch 'Version\s*=\s*"([^"]+)"') {
    throw 'Nao consegui achar a linha Version = "..." em agent/main.go'
}
$version = $Matches[1]
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version '$version' em main.go nao parece semver valido (X.Y.Z)"
}
Write-Host "Versao em main.go: v$version" -ForegroundColor Cyan

$decisionLog = Join-Path $agentDir "..\.claude\decision.log"
function Write-DecisionLog([string]$line) {
    Add-Content -Path $decisionLog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] MEDIUM | release-auto.ps1 (agent) -> $line"
}

# 2. Build -- remove exe velho ANTES: se o build falhar, Test-Path tem que
# falhar tambem, nunca deixar passar um .exe de uma tentativa anterior.
Write-Host "Buildando delirio-agent.exe..." -ForegroundColor Cyan
$exePath = Join-Path $agentDir "delirio-agent.exe"
Remove-Item $exePath -ErrorAction SilentlyContinue
Push-Location $agentDir
try {
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    go build -ldflags="-s -w" -o delirio-agent.exe .
    if ($LASTEXITCODE -ne 0) { throw "go build falhou (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
if (-not (Test-Path $exePath)) { throw "Build nao gerou $exePath" }

# 3. Confirma que o binario buildado E a versao que vamos publicar --
# -First 1 + .Trim() pra nunca comparar array (saida multi-linha quebraria
# o -ne silenciosamente, virando filtro em vez de bool).
$builtVersion = (& $exePath -version | Select-Object -First 1).Trim() -replace '^DelirioAgent v', ''
if ($builtVersion -ne $version) {
    throw "Build gerou v$builtVersion mas main.go diz v$version -- binario desatualizado ou flag errada. Abortando, NAO publicando."
}
Write-Host "Build confirmado: v$builtVersion" -ForegroundColor Green

# 4. Publica no servidor
Write-Host "Publicando v$version no servidor..." -ForegroundColor Cyan
$publishResp = Invoke-RestMethod -Uri "$ServerURL/api/update/publish" -Method Post -TimeoutSec 60 `
    -InFile $exePath -ContentType "application/octet-stream" `
    -Headers @{ "X-Agent-Version" = $version }
if (-not $publishResp.ok) { throw "Publish falhou: $($publishResp | ConvertTo-Json -Compress)" }
$shaPrefix = $publishResp.sha256.Substring(0, [Math]::Min(16, $publishResp.sha256.Length))
Write-Host "Publicado: v$($publishResp.version), sha256 $shaPrefix..., $([math]::Round($publishResp.sizeBytes/1KB))KB" -ForegroundColor Green
# Loga o publish JA AQUI -- e irreversivel (feed atualizado, qualquer
# heartbeat futuro puxa esse binario) mesmo que o broadcast abaixo falhe.
Write-DecisionLog "publish v$version ok (sha256 $shaPrefix) | razao: deploy automatico padrao do agent, autorizado em CLAUDE.md (elevate, igual dashboard)"

# 5. Dispara update pra todo mundo online
try {
    Write-Host "Disparando update pras maquinas online..." -ForegroundColor Cyan
    $broadcastResp = Invoke-RestMethod -Uri "$ServerURL/api/update/broadcast" -Method Post -TimeoutSec 60 `
        -ContentType "application/json" -Body "{}"
    Write-Host "Comando enviado: $($broadcastResp.sent) de $($broadcastResp.total) maquina(s) online. Atualizam sozinhas nos proximos ~30s." -ForegroundColor Green
    Write-DecisionLog "broadcast $($broadcastResp.sent)/$($broadcastResp.total) maquina(s) online | razao: push imediato apos publish bem-sucedido"
} catch {
    Write-DecisionLog "broadcast FALHOU ($($_.Exception.Message)) apos publish v$version ja confirmado | razao: maquinas pegam a versao no proximo heartbeat de qualquer forma (pull-based)"
    throw
}

Write-Host "`nRelease v$version concluido. Maquinas offline pegam a versao nova sozinhas no proximo heartbeat apos reconectar." -ForegroundColor Green
