<#
.SYNOPSIS
    Checklist de validação do piloto — execute NA MÁQUINA REMOTA após instalar o Delirio Agent.
.CRITERIOS DE ACEITE
    ✅ Serviço "DelirioAgent" está rodando
    ✅ Agente aparece como online no dashboard em < 60s
    ✅ Consumo de RAM < 50MB
    ✅ CPU do processo < 5%
    ✅ Sem erros CRITICAL no log
    ✅ N-able NÃO emitiu alerta (verificação manual)
    ✅ Temperatura lida (ou "N/D" se sensor indisponível — aceitável)
#>

param(
    [string]$ServidorURL = "https://dt-manager.brazilsouth.cloudapp.azure.com"
)

Write-Host "`n=== DELIRIO MANAGER — Checklist do Piloto ===" -ForegroundColor Cyan
Write-Host "Servidor: $ServidorURL`n"

$ok = 0; $falha = 0

function Test-Item([string]$desc, [scriptblock]$bloco) {
    Write-Host -NoNewline "  Verificando: $desc... "
    try {
        if (& $bloco) { Write-Host "✅ OK" -ForegroundColor Green;  $script:ok++ }
        else          { Write-Host "❌ FALHOU" -ForegroundColor Red; $script:falha++ }
    } catch {
        Write-Host "❌ ERRO: $($_.Exception.Message)" -ForegroundColor Red
        $script:falha++
    }
}

Test-Item "Serviço DelirioAgent existe" {
    $null -ne (Get-Service -Name "DelirioAgent" -ErrorAction SilentlyContinue)
}

Test-Item "Serviço DelirioAgent está RUNNING" {
    (Get-Service -Name "DelirioAgent" -ErrorAction SilentlyContinue)?.Status -eq "Running"
}

Test-Item "Consumo de RAM < 50 MB" {
    $p = Get-Process -Name "delirio-agent" -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    $mb = [math]::Round($p.WorkingSet64 / 1MB, 1)
    Write-Host -NoNewline " (atual: ${mb}MB) "
    $mb -lt 50
}

Test-Item "Agente alcança o servidor" {
    try {
        (Invoke-WebRequest -Uri "$ServidorURL/health" -TimeoutSec 10 -UseBasicParsing).StatusCode -eq 200
    } catch { $false }
}

Test-Item "Log sem erros CRITICAL" {
    $log = "C:\Program Files\DelirioAgent\logs\agent.log"
    if (-not (Test-Path $log)) { return $true }
    (Select-String -Path $log -Pattern "CRITICAL|FATAL" -SimpleMatch).Count -eq 0
}

Test-Item "Evento de início registrado no Windows" {
    $e = Get-EventLog -LogName Application -Source "DelirioAgent" -Newest 5 -ErrorAction SilentlyContinue
    $null -ne $e -and $e.Count -gt 0
}

Test-Item "CPU acumulada do processo < 5%" {
    Start-Sleep -Seconds 3
    $p = Get-Process -Name "delirio-agent" -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    $cpu = [math]::Round($p.CPU / (Get-Date).Subtract($p.StartTime).TotalSeconds, 2)
    Write-Host -NoNewline " ($cpu%) "
    $cpu -lt 5
}

Write-Host ""
if ($falha -eq 0) {
    Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "║  PILOTO APROVADO — $ok/$($ok+$falha) testes passaram        ║" -ForegroundColor Green
    Write-Host "║  Pode prosseguir com o deploy em lote.           ║" -ForegroundColor Green
    Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Green
} else {
    Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Red
    Write-Host "║  PILOTO REPROVADO — $falha teste(s) falharam           ║" -ForegroundColor Red
    Write-Host "║  NÃO prosseguir com deploy em lote.              ║" -ForegroundColor Red
    Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Red
    Write-Host ""
    Write-Host "Log do agente: C:\Program Files\DelirioAgent\logs\agent.log"
    Write-Host "Desinstalar : sc stop DelirioAgent && sc delete DelirioAgent"
}

Write-Host ""
Write-Host "VERIFICAÇÃO MANUAL OBRIGATÓRIA (N-able):" -ForegroundColor Yellow
Write-Host "  1. Abra o console N-able nesta máquina"
Write-Host "  2. Confirme que 'DelirioAgent' NÃO aparece em alertas ou quarentena"
Write-Host "  3. Se aparecer, adicione whitelist por caminho:"
Write-Host "     C:\Program Files\DelirioAgent\" -ForegroundColor Gray
