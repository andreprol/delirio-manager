<#
.SYNOPSIS
    Cria a VM Azure para o servidor central do Delirio Manager.
.PRE-REQUISITOS
    1. az login  (ja executado)
    2. Subscription correta selecionada
.USO
    .\criar-vm-dt-manager.ps1
    .\criar-vm-dt-manager.ps1 -VMSize "Standard_B2s"
#>

param(
    [string]$VMSize    = "Standard_B1ms",
    [string]$Location  = "brazilsouth",
    [string]$DNSLabel  = "dt-manager",
    [string]$AdminUser = "delirioadmin"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RESOURCE_GROUP = "rg-dt-manager"
$VM_NAME        = "vm-dt-manager"
$NSG_NAME       = "nsg-dt-manager"
$PUBLIC_IP_NAME = "pip-dt-manager"
$IMAGE          = "Ubuntu2204"
$DISK_SIZE_GB   = 30

# [1/7] Pre-requisitos
Write-Host ""
Write-Host "[1/7] Verificando pre-requisitos..." -ForegroundColor Cyan

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Error "Azure CLI nao encontrado. Execute: winget install Microsoft.AzureCLI"
}

$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host "Nao esta logado. Abrindo login..." -ForegroundColor Yellow
    az login
    $account = az account show 2>$null | ConvertFrom-Json
}

Write-Host "  Conta       : $($account.user.name)" -ForegroundColor Gray
Write-Host "  Subscription: $($account.name)" -ForegroundColor Gray

$confirm = Read-Host "`n  Criar a VM nesta subscription? (S/N)"
if ($confirm -notin @("S","s")) {
    Write-Host "  Para trocar: az account set --subscription NOME" -ForegroundColor Yellow
    exit 0
}

# [2/7] IP da maquina local
Write-Host ""
Write-Host "[2/7] Detectando seu IP publico para restringir SSH..." -ForegroundColor Cyan
try {
    $MY_IP = (Invoke-RestMethod -Uri "https://api.ipify.org?format=json" -TimeoutSec 10).ip
    Write-Host "  Seu IP: $MY_IP" -ForegroundColor Gray
} catch {
    Write-Warning "Nao foi possivel detectar IP. SSH ficara aberto."
    $MY_IP = "*"
}

# [3/7] Resource Group
Write-Host ""
Write-Host "[3/7] Criando Resource Group $RESOURCE_GROUP em $Location..." -ForegroundColor Cyan
az group create --name $RESOURCE_GROUP --location $Location --output table

# [4/7] IP Publico Estatico
Write-Host ""
Write-Host "[4/7] Criando IP publico estatico..." -ForegroundColor Cyan
az network public-ip create `
    --resource-group $RESOURCE_GROUP `
    --name $PUBLIC_IP_NAME `
    --sku Standard `
    --allocation-method Static `
    --dns-name $DNSLabel `
    --location $Location `
    --output table

# [5/7] Criacao da VM
Write-Host ""
Write-Host "[5/7] Criando VM $VM_NAME ($VMSize) - aguarde 2-3 minutos..." -ForegroundColor Cyan

az vm create `
    --resource-group $RESOURCE_GROUP `
    --name $VM_NAME `
    --image $IMAGE `
    --size $VMSize `
    --admin-username $AdminUser `
    --generate-ssh-keys `
    --public-ip-address $PUBLIC_IP_NAME `
    --nsg $NSG_NAME `
    --os-disk-size-gb $DISK_SIZE_GB `
    --storage-sku Premium_LRS `
    --output table

# [6/7] Firewall NSG
Write-Host ""
Write-Host "[6/7] Configurando regras de firewall..." -ForegroundColor Cyan

az network nsg rule delete `
    --resource-group $RESOURCE_GROUP `
    --nsg-name $NSG_NAME `
    --name "default-allow-ssh" 2>$null

az network nsg rule create `
    --resource-group $RESOURCE_GROUP `
    --nsg-name $NSG_NAME `
    --name "Allow-SSH-Home" `
    --protocol Tcp --direction Inbound --priority 100 `
    --source-address-prefixes $MY_IP `
    --destination-port-ranges 22 `
    --access Allow --output none

az network nsg rule create `
    --resource-group $RESOURCE_GROUP `
    --nsg-name $NSG_NAME `
    --name "Allow-HTTPS" `
    --protocol Tcp --direction Inbound --priority 110 `
    --source-address-prefixes "*" `
    --destination-port-ranges 443 `
    --access Allow --output none

az network nsg rule create `
    --resource-group $RESOURCE_GROUP `
    --nsg-name $NSG_NAME `
    --name "Allow-HTTP" `
    --protocol Tcp --direction Inbound --priority 120 `
    --source-address-prefixes "*" `
    --destination-port-ranges 80 `
    --access Allow --output none

Write-Host "  SSH (22): permitido de $MY_IP" -ForegroundColor Gray
Write-Host "  HTTPS (443): aberto para agentes e dashboard" -ForegroundColor Gray
Write-Host "  HTTP (80): aberto, redireciona para HTTPS" -ForegroundColor Gray

# [7/7] Resultado
Write-Host ""
Write-Host "[7/7] Coletando informacoes da VM..." -ForegroundColor Cyan

$PUBLIC_IP = az network public-ip show `
    --resource-group $RESOURCE_GROUP `
    --name $PUBLIC_IP_NAME `
    --query ipAddress --output tsv

$FQDN = "$DNSLabel.$Location.cloudapp.azure.com"

@{
    publicIP   = $PUBLIC_IP
    fqdn       = $FQDN
    adminUser  = $AdminUser
    sshKeyPath = "$env:USERPROFILE\.ssh\id_rsa"
    createdAt  = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
} | ConvertTo-Json | Out-File -FilePath "$PSScriptRoot\vm-info.json" -Encoding UTF8

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Delirio Manager - VM criada com sucesso!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host "  IP Publico : $PUBLIC_IP" -ForegroundColor White
Write-Host "  DNS        : $FQDN" -ForegroundColor White
Write-Host "  Usuario    : $AdminUser" -ForegroundColor White
Write-Host "  Tamanho    : $VMSize (~USD 15/mes)" -ForegroundColor White
Write-Host "  Regiao     : $Location (Sao Paulo)" -ForegroundColor White
Write-Host "================================================" -ForegroundColor Green
Write-Host "  SSH: ssh $AdminUser@$FQDN" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Salvo em: $PSScriptRoot\vm-info.json" -ForegroundColor Gray
Write-Host ""
Write-Host "  IMPORTANTE: Faca backup da chave SSH:" -ForegroundColor Yellow
Write-Host "  $env:USERPROFILE\.ssh\id_rsa" -ForegroundColor Yellow
Write-Host "  Sem ela voce perde o acesso SSH a VM." -ForegroundColor Yellow
