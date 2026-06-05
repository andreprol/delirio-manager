<#
.SYNOPSIS
    Registra o resultado de instalação do Delirio Agent em uma máquina.
.USO
    .\registrar-resultado.ps1 -ID "NOME-PC" -Status ok
    .\registrar-resultado.ps1 -ID "NOME-PC" -Status falhou -Motivo "AnyDesk offline"
    .\registrar-resultado.ps1 -ID "NOME-PC" -Status pulado  -Motivo "máquina desligada"
#>

param(
    [Parameter(Mandatory)] [string]$ID,
    [Parameter(Mandatory)] [ValidateSet("ok","falhou","pulado")] [string]$Status,
    [string]$Motivo = ""
)

$StatusPath = "$PSScriptRoot\deploy-status.json"

$lista = @()
if (Test-Path $StatusPath) {
    $lista = @(Get-Content $StatusPath -Raw | ConvertFrom-Json)
}

$lista = @($lista | Where-Object { $_.id -ne $ID })
$lista += [PSCustomObject]@{
    id        = $ID
    resultado = $Status
    motivo    = $Motivo
    timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
}

$lista | ConvertTo-Json -Depth 2 | Out-File $StatusPath -Encoding UTF8

$cor = @{ ok = "Green"; falhou = "Red"; pulado = "Yellow" }[$Status]
Write-Host "[$Status] $ID registrado." -ForegroundColor $cor
