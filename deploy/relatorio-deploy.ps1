<#
.SYNOPSIS
    Relatório de progresso do deploy do Delirio Agent.
.USO
    .\relatorio-deploy.ps1
    .\relatorio-deploy.ps1 -Localidade "Matriz"
    .\relatorio-deploy.ps1 -ApenasFilas    # mostra só pendentes e falhas
#>

param(
    [string]$Localidade  = "",
    [switch]$ApenasFilas
)

$InventarioPath = "$PSScriptRoot\inventario.json"
$StatusPath     = "$PSScriptRoot\deploy-status.json"

if (-not (Test-Path $InventarioPath)) {
    Write-Error "inventario.json não encontrado. Execute importar-planilha.ps1 primeiro."
}

$inventario = @(Get-Content $InventarioPath -Raw | ConvertFrom-Json)
$statusList = @()
if (Test-Path $StatusPath) { $statusList = @(Get-Content $StatusPath -Raw | ConvertFrom-Json) }

$idx = @{}
$statusList | ForEach-Object { $idx[$_.id] = $_ }

if ($Localidade) { $inventario = @($inventario | Where-Object { $_.localidade -like "*$Localidade*" }) }

$grupos = $inventario | Group-Object localidade | Sort-Object Name
$tOk = $tFalha = $tPulado = $tPend = 0

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║     DELIRIO MANAGER — Relatório de Deploy do Agente     ║" -ForegroundColor Cyan
Write-Host "║     $(Get-Date -Format 'dd/MM/yyyy HH:mm')                                    ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

foreach ($grupo in $grupos) {
    $macs = $grupo.Group
    $ok   = @($macs | Where-Object { $idx[$_.id]?.resultado -eq "ok" }).Count
    $fail = @($macs | Where-Object { $idx[$_.id]?.resultado -eq "falhou" }).Count
    $skip = @($macs | Where-Object { $idx[$_.id]?.resultado -eq "pulado" }).Count
    $pend = $macs.Count - $ok - $fail - $skip
    $pct  = if ($macs.Count -gt 0) { [math]::Round($ok / $macs.Count * 100) } else { 0 }

    $tOk    += $ok;   $tFalha += $fail
    $tPulado += $skip; $tPend  += $pend

    Write-Host "`n  ── $($grupo.Name)  ($pct% concluído) ──" -ForegroundColor Yellow
    Write-Host "     ✅$ok instalados  ❌$fail falhas  ⏭$skip pulados  ⏳$pend pendentes"

    if (-not $ApenasFilas) {
        foreach ($m in $macs | Sort-Object ipInterno) {
            $s       = $idx[$m.id]
            $critica = if ($m.critica) { " ⚠CRÍTICA" } else { "" }
            if ($s) {
                $icone = @{ ok="✅"; falhou="❌"; pulado="⏭" }[$s.resultado]
                $extra = if ($s.motivo) { " — $($s.motivo)" } else { "" }
                Write-Host "     $icone $($m.id)$critica | $($m.ipInterno) | AnyDesk: $($m.anydesk)$extra"
            } else {
                Write-Host "     ⏳ $($m.id)$critica | $($m.ipInterno) | AnyDesk: $($m.anydesk)" -ForegroundColor DarkGray
            }
        }
    }
}

$total = $inventario.Count
$pctT  = if ($total -gt 0) { [math]::Round($tOk / $total * 100) } else { 0 }

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  TOTAL: $pctT% ($tOk/$total instalados)$((' ' * [math]::Max(0,28-"$pctT% ($tOk/$total instalados)".Length)))║" -ForegroundColor Cyan
Write-Host "║  ✅$tOk  ❌$tFalha  ⏭$tPulado  ⏳$tPend$((' ' * [math]::Max(0,42-"✅$tOk  ❌$tFalha  ⏭$tPulado  ⏳$tPend".Length)))║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

if ($tFalha -gt 0) {
    Write-Host "`nMáquinas para instalação manual:" -ForegroundColor Red
    $inventario | Where-Object { $idx[$_.id]?.resultado -eq "falhou" } | ForEach-Object {
        Write-Host "  ❌ $($_.id) | AnyDesk: $($_.anydesk) | $($idx[$_.id].motivo)"
    }
}
