<#
.SYNOPSIS
    Converte a planilha Máquinas.xlsx para inventario.json — Delirio Manager.
.DESCRIPTION
    Lê a planilha de máquinas, ignora senhas, agrupa por subnet e
    marca automaticamente máquinas críticas (ALOHA POS, servidores).
.USO
    .\importar-planilha.ps1
    .\importar-planilha.ps1 -PlanilhaPath "C:\outro\caminho\Maquinas.xlsx"
#>

param(
    [string]$PlanilhaPath = "C:\Users\fileserver\Desktop\Máquinas.xlsx",
    [string]$OutputPath   = "$PSScriptRoot\inventario.json"
)

# ─── Nomes das localidades por subnet ─────────────────────────────────────────
# Edite os valores à direita com os nomes reais das suas lojas/unidades.
# Os nomes são exibidos e renomeáveis no dashboard do Delirio Manager.
$mapaLocalidades = @{
    "10.0.1"      = "Azure / Cloud"
    "192.168.0"   = "Localidade A"    # Ex: "Loja Barra"
    "192.168.10"  = "Localidade B"    # Ex: "Loja Centro"
    "192.168.11"  = "Localidade C"
    "192.168.12"  = "Localidade D"
    "192.168.13"  = "Localidade E"
    "192.168.14"  = "Localidade F"
    "192.168.15"  = "Localidade G"
    "192.168.16"  = "Localidade H"
    "192.168.17"  = "Matriz / HQ"
    "192.168.18"  = "Localidade I"
    "192.168.20"  = "Localidade J"
}

# Palavras que identificam máquinas críticas (bloqueiam restart acidental)
$palavrasCriticas = @("ALOHA", "TERM", "Servidor", "SERVER", "SRV", "ENCOMENDA", "FREST", "SKILL")

Write-Host "`n=== Delirio Manager — Importação de Inventário ===" -ForegroundColor Cyan
Write-Host "Planilha : $PlanilhaPath" -ForegroundColor Gray

if (-not (Test-Path $PlanilhaPath)) {
    Write-Error "Planilha não encontrada: $PlanilhaPath"
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible        = $false
$excel.DisplayAlerts  = $false

try {
    $workbook = $excel.Workbooks.Open($PlanilhaPath)
    $sheet    = $workbook.Sheets.Item(1)
    $lastRow  = $sheet.UsedRange.Rows.Count

    Write-Host "Lendo $lastRow linhas..." -ForegroundColor Gray

    $maquinas           = @()
    $subnetsEncontradas = @{}
    $idsUsados          = @{}

    for ($row = 2; $row -le $lastRow; $row++) {
        $pc         = $sheet.Cells.Item($row, 1).Text.Trim()
        $ipExterno  = $sheet.Cells.Item($row, 2).Text.Trim()
        $ipInterno  = $sheet.Cells.Item($row, 3).Text.Trim()
        $porta      = $sheet.Cells.Item($row, 4).Text.Trim()
        $nomePC     = $sheet.Cells.Item($row, 5).Text.Trim()
        $nomeAloha  = $sheet.Cells.Item($row, 6).Text.Trim()
        $usuario    = $sheet.Cells.Item($row, 7).Text.Trim()
        # Coluna 8 (senha) — NÃO importada por segurança
        $anydesk    = $sheet.Cells.Item($row, 9).Text.Trim()
        $teamviewer = $sheet.Cells.Item($row, 10).Text.Trim()
        $mac        = $sheet.Cells.Item($row, 11).Text.Trim()

        if (-not $pc) { continue }

        # Determina localidade pela subnet do IP interno
        $localidade = "Sem localidade"
        $subnetKey  = ""
        if ($ipInterno -match '^(\d+\.\d+\.\d+)\.\d+$') {
            $subnetKey = $Matches[1]
            $localidade = if ($mapaLocalidades.ContainsKey($subnetKey)) {
                $mapaLocalidades[$subnetKey]
            } else {
                "Subnet $subnetKey.x"
            }
            $subnetsEncontradas[$subnetKey] = $true
        }

        # Verifica criticidade
        $critica = $false
        foreach ($palavra in $palavrasCriticas) {
            if ($pc -match $palavra -or $nomeAloha -match $palavra -or $nomePC -match $palavra) {
                $critica = $true
                break
            }
        }

        # Gera ID único (baseado no hostname, sem caracteres especiais)
        $baseId = ($nomePC -replace '[^a-zA-Z0-9\-]', '-').Trim('-').ToUpper()
        if (-not $baseId) { $baseId = ($pc -replace '[^a-zA-Z0-9\-]', '-').Trim('-').ToUpper() }
        if (-not $baseId) { $baseId = "PC-ROW-$row" }

        # Garante unicidade
        $id = $baseId
        $counter = 2
        while ($idsUsados.ContainsKey($id)) {
            $id = "$baseId-$counter"
            $counter++
        }
        $idsUsados[$id] = $true

        $maquinas += [PSCustomObject]@{
            id          = $id
            displayName = $pc
            hostname    = $nomePC
            nomeAloha   = $nomeAloha
            ipInterno   = $ipInterno
            ipExterno   = $ipExterno
            porta       = $porta
            mac         = ($mac -replace '-', ':').ToUpper()
            subnet      = if ($subnetKey) { "$subnetKey.0/24" } else { "" }
            localidade  = $localidade
            usuario     = $usuario
            anydesk     = $anydesk
            teamviewer  = $teamviewer
            critica     = $critica
            agentStatus = "pendente"
            agentToken  = ""
        }
    }

    $maquinas | ConvertTo-Json -Depth 3 | Out-File $OutputPath -Encoding UTF8

    $totalCriticas = ($maquinas | Where-Object { $_.critica }).Count
    $totalComIP    = ($maquinas | Where-Object { $_.ipInterno }).Count
    $totalAnydesk  = ($maquinas | Where-Object { $_.anydesk }).Count

    Write-Host "`n=== RESUMO ===" -ForegroundColor Green
    Write-Host "Total importado          : $($maquinas.Count)"
    Write-Host "Com IP interno           : $totalComIP"
    Write-Host "Críticas (ALOHA/Serv.)   : $totalCriticas  ← restart bloqueado"
    Write-Host "Com AnyDesk ID           : $totalAnydesk"
    Write-Host ""
    Write-Host "Localidades detectadas:" -ForegroundColor Yellow
    foreach ($subnet in $subnetsEncontradas.Keys | Sort-Object) {
        $count = ($maquinas | Where-Object { $_.subnet -match [regex]::Escape($subnet) }).Count
        $nome  = if ($mapaLocalidades.ContainsKey($subnet)) { $mapaLocalidades[$subnet] } else { "?" }
        Write-Host "  $subnet.0/24  →  $nome  ($count máquinas)"
    }
    Write-Host ""
    Write-Host "Inventário salvo (SEM SENHAS): $OutputPath" -ForegroundColor Green
    Write-Host ""
    Write-Host "DICA: Edite os nomes das localidades no início deste script" -ForegroundColor Yellow
    Write-Host "  Ex: `"192.168.14`" = `"Loja Tijuca`"" -ForegroundColor Gray

} finally {
    $workbook.Close($false)
    $excel.Quit()
    [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel)
}
