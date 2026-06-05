#!/bin/bash
# configurar-vm.sh — Delirio Manager
# Execute NA VM logo após criação:
#
#   1. Copie este arquivo para a VM:
#      scp infra/configurar-vm.sh delirioadmin@dt-manager.brazilsouth.cloudapp.azure.com:~/
#
#   2. Acesse a VM via SSH:
#      ssh delirioadmin@dt-manager.brazilsouth.cloudapp.azure.com
#
#   3. Execute:
#      bash configurar-vm.sh dt-manager.brazilsouth.cloudapp.azure.com seu@email.com

set -euo pipefail

FQDN="${1:-dt-manager.brazilsouth.cloudapp.azure.com}"
EMAIL="${2:-andreprol1980@gmail.com}"
APP_DIR="/opt/dt-manager"
APP_USER="dtmanager"

echo "=== Delirio Manager — Configuração da VM ==="
echo "FQDN : $FQDN"
echo "Email: $EMAIL"
echo ""

echo "=== [1/6] Atualizando sistema ==="
sudo apt-get update -q
sudo apt-get upgrade -y -q

echo "=== [2/6] Instalando Node.js 24 ==="
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version && npm --version

echo "=== [3/6] Instalando ferramentas ==="
sudo apt-get install -y nginx certbot python3-certbot-nginx sqlite3 ufw
sudo npm install -g pm2

echo "=== [4/6] Configurando firewall UFW ==="
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status

echo "=== [5/6] Criando usuário e diretórios da aplicação ==="
sudo useradd -r -s /bin/false $APP_USER 2>/dev/null || true
sudo mkdir -p $APP_DIR/{data,logs,certs,public}
sudo chown -R $APP_USER:$APP_USER $APP_DIR

echo "=== [6/6] Configurando Nginx ==="
sudo tee /etc/nginx/sites-available/dt-manager > /dev/null <<NGINX
server {
    listen 80;
    server_name $FQDN;

    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name $FQDN;

    # SSL preenchido automaticamente pelo certbot

    location /ws {
        proxy_pass http://127.0.0.1:3847;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }

    location / {
        proxy_pass http://127.0.0.1:3847;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/dt-manager /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "=== Obtendo certificado SSL gratuito (Let's Encrypt) ==="
sudo certbot --nginx -d $FQDN --non-interactive --agree-tos -m $EMAIL
sudo systemctl enable certbot.timer

echo ""
echo "======================================================"
echo "  Delirio Manager — VM pronta!"
echo ""
echo "  URL: https://$FQDN"
echo "  App dir: $APP_DIR"
echo ""
echo "  Próximo passo: fazer deploy do servidor Node.js"
echo "  (próxima fase do desenvolvimento)"
echo "======================================================"
