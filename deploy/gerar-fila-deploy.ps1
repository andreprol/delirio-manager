<#
.SYNOPSIS
    Gera a fila de deploy do Delirio Agent com rastreamento por máquina.
.USO
    .\gerar-fila-deploy.ps1 -ServidorURL "https://dt-manager.brazilsouth.cloudapp.azure.com"
#>

param(
    [Parameter(Mandatory)]
    [string]$ServidorURL,

    [string]$InventarioPath = "$PSScriptRoot\inventario.json",
    [string]$StatusPath     = "$PSScriptRoot\deploy-status.json"
)

Set-StrictMode -Version Latest

if (-not (Test-Path $InventarioPath)) {
    Write-Error "inventario.json não encontrado. Execute importar-planilha.ps1 primeiro."
}

$inventario = @(Get-Content $InventarioPath -Raw | ConvertFrom-Json)

# Carrega status anterior
$status = @{}
if (Test-Path $StatusPath) {
    @(Get-Content $StatusPath -Raw | ConvertFrom-Json) | ForEach-Object { $status[$_.id] = $_ }
    $jaFeitos = ($status.Values | Where-Object { $_.resultado -eq "ok" }).Count
    Write-Host "Status anterior: $jaFeitos máquinas já com agente instalado." -ForegroundColor Gray
}

# Somente pendentes ou retries
$pendentes = @($inventario | Where-Object {
    $_.ipInterno -and
    (-not $status.ContainsKey($_.id) -or $status[$_.id].resultado -eq "falhou")
})

Write-Host "`n=== DELIRIO MANAGER — Fila de Deploy ===" -ForegroundColor Cyan
Write-Host "Total no inventário : $($inventario.Count)"
Write-Host "Já instalados       : $(($status.Values | Where-Object {$_.resultado -eq 'ok'}).Count)"
Write-Host "Pendentes           : $($pendentes.Count)"
Write-Host ""

# Agrupa por localidade
$grupos = $pendentes | Group-Object localidade | Sort-Object Name

foreach ($grupo in $grupos) {
    Write-Host "── $($grupo.Name) ($($grupo.Count) máquinas) ──" -ForegroundColor Yellow
    foreach ($m in $grupo.Group | Sort-Object ipInterno) {
        $statusLabel = if ($status.ContainsKey($m.id)) { "RETRY" } else { "NOVO " }
        $critica     = if ($m.critica) { " [CRÍTICA ⚠]" } else { "" }
        Write-Host "  [$statusLabel] $($m.id)$critica  IP: $($m.ipInterno)  AnyDesk: $($m.anydesk)"
    }
    Write-Host ""
}

# Gera arquivo com comando por máquina
$fila = $pendentes | ForEach-Object {
    [PSCustomObject]@{
        id         = $_.id
        displayName = $_.displayName
        localidade = $_.localidade
        ipInterno  = $_.ipInterno
        anydesk    = $_.anydesk
        critica    = $_.critica
        comando    = "powershell -ExecutionPolicy Bypass -Command `"irm $ServidorURL/install.ps1 | iex`""
        status     = if ($status.ContainsKey($_.id)) { "retry" } else { "pendente" }
    }
}

$fila | ConvertTo-Json -Depth 3 | Out-File "$PSScriptRoot\fila-deploy.json" -Encoding UTF8

Write-Host "Fila salva em: $PSScriptRoot\fila-deploy.json" -ForegroundColor Green
Write-Host ""
Write-Host "─── Como usar ────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "1. Abra o AnyDesk e conecte na máquina"
Write-Host "2. Na máquina remota: abra PowerShell como Administrador"
Write-Host "3. Cole o 'comando' do fila-deploy.json para aquela máquina"
Write-Host "4. Registre: .\registrar-resultado.ps1 -ID 'NOME' -Status ok"
Write-Host "5. Progresso: .\relatorio-deploy.ps1"
Write-Host "──────────────────────────────────────────────────────────" -ForegroundColor DarkGray
