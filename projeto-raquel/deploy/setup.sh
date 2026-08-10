#!/bin/bash
# Setup do ambiente para o Projeto Raquel
set -e

echo "=== Setup Projeto Raquel ==="

# Verifica Python
if ! command -v python3 &>/dev/null; then
    echo "ERRO: Python 3 não encontrado."
    exit 1
fi

# Instala dependências
echo "Instalando dependências..."
pip install anthropic python-dotenv google-api-python-client google-auth-oauthlib pytest

# Cria diretórios de runtime
mkdir -p data/temp data/scripts data/articles
touch data/.gitkeep

# Configura .env se não existir
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo "ATENÇÃO: Edite o arquivo .env com suas credenciais:"
    echo "  ANTHROPIC_API_KEY=..."
    echo "  YOUTUBE_CLIENT_SECRETS_FILE=config/client_secrets.json"
fi

echo ""
echo "=== Setup concluído ==="
echo "Próximos passos:"
echo "  1. Editar .env com suas chaves de API"
echo "  2. Copiar client_secrets.json do Google Cloud Console para config/"
echo "  3. python main.py add-review   (para adicionar seu primeiro drama)"
