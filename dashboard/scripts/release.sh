#!/bin/bash
# release.sh — build e deploy de nova versao do Delirio Manager Dashboard
# Uso: bash scripts/release.sh
# Prerequisito: criar release-secret.txt com o valor de config.json.uploadSecret na VM

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$(dirname "$SCRIPT_DIR")"
SECRET_FILE="$DASHBOARD_DIR/release-secret.txt"

# Verifica segredo
if [ ! -f "$SECRET_FILE" ]; then
  echo "Arquivo release-secret.txt nao encontrado."
  echo "   Crie o arquivo com o valor de uploadSecret do config.json da VM."
  echo "   Exemplo: echo 'meu-segredo-aqui' > release-secret.txt"
  exit 1
fi

UPLOAD_SECRET=$(cat "$SECRET_FILE" | tr -d '[:space:]')
if [ -z "$UPLOAD_SECRET" ]; then
  echo "release-secret.txt esta vazio."
  exit 1
fi

# Le versao atual (cd antes do node para usar path relativo — node no Windows nao aceita path Unix)
cd "$DASHBOARD_DIR"
VERSION=$(node -e "console.log(require('./package.json').version)")
echo "Releasing Delirio Manager v$VERSION..."
echo ""

# 1. Build
echo "Gerando installer..."
npm run dist
echo "Build concluido"
echo ""

# 2. Verifica arquivos gerados
INSTALLER="$DASHBOARD_DIR/dist-electron/Delirio Manager Setup $VERSION.exe"
LATEST_YML="$DASHBOARD_DIR/dist-electron/latest.yml"

if [ ! -f "$LATEST_YML" ]; then
  echo "latest.yml nao encontrado em dist-electron/"
  exit 1
fi

if [ ! -f "$INSTALLER" ]; then
  echo "Installer nao encontrado: $INSTALLER"
  exit 1
fi

SERVER="https://dt-manager.brazilsouth.cloudapp.azure.com"

# 3. Upload do latest.yml via base64/az
echo "Enviando latest.yml para a VM..."
b64=$(base64 -w 0 "$LATEST_YML")
az vm run-command invoke \
  --resource-group rg-dt-manager \
  --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts "mkdir -p /opt/dt-manager/public/dashboard-updates && echo '$b64' | base64 -d > /opt/dt-manager/public/dashboard-updates/latest.yml && echo OK_YML" \
  --output none
echo "latest.yml enviado"
echo ""

# 4. Upload do installer via endpoint protegido
echo "Enviando installer..."
RESPONSE=$(curl -s -X POST \
  "$SERVER/api/update/upload-dashboard" \
  -F "file=@$INSTALLER" \
  -H "X-Upload-Secret: $UPLOAD_SECRET")

if echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "Installer enviado com sucesso"
else
  echo "Falha no upload do installer: $RESPONSE"
  exit 1
fi

echo ""
echo "Release v$VERSION concluido!"
echo "   Os dashboards instalados atualizarao silenciosamente na proxima abertura."
