# build.ps1 - Compila o DelirioAgent para Windows x64
# Uso: .\build.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$OUT = "$PSScriptRoot\delirio-agent.exe"

# [1/4] Verificar Go
Write-Host "[1/4] Verificando Go..." -ForegroundColor Cyan
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$goCmd = Get-Command go -ErrorAction SilentlyContinue
if (-not $goCmd) {
    Write-Error "Go nao encontrado. Instale via: winget install GoLang.Go"
}
go version

# [2/4] Baixar dependencias
Write-Host "[2/4] Baixando dependencias..." -ForegroundColor Cyan
Set-Location $PSScriptRoot
go mod tidy
if ($LASTEXITCODE -ne 0) { Write-Error "go mod tidy falhou." }

# [3/4] Rodar testes
Write-Host "[3/4] Rodando testes..." -ForegroundColor Cyan
go test ./... -v -timeout 30s
if ($LASTEXITCODE -ne 0) { Write-Error "Testes falharam. Corrigir antes de buildar." }

# [4/4] Compilar
Write-Host "[4/4] Compilando para Windows x64..." -ForegroundColor Cyan
$env:GOOS        = "windows"
$env:GOARCH      = "amd64"
$env:CGO_ENABLED = "0"

go build -ldflags "-s -w -H windowsgui" -o $OUT .
if ($LASTEXITCODE -ne 0) { Write-Error "go build falhou." }

if (Test-Path $OUT) {
    $size = [math]::Round((Get-Item $OUT).Length / 1MB, 1)
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Green
    Write-Host "  Build OK: $OUT" -ForegroundColor Green
    Write-Host "  Tamanho : ${size}MB" -ForegroundColor Green
    Write-Host "================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Proximos passos:"
    Write-Host "  1. Configurar servidor:"
    Write-Host "     .\delirio-agent.exe -server https://dt-manager.brazilsouth.cloudapp.azure.com"
    Write-Host "  2. Testar em modo console:"
    Write-Host "     .\delirio-agent.exe -run"
    Write-Host "  3. Instalar como servico (Administrador):"
    Write-Host "     .\delirio-agent.exe -install"
} else {
    Write-Error "Build falhou - arquivo de saida nao encontrado."
}
