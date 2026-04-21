#!/bin/bash
# InterServer automated setup: Nginx + Let's Encrypt SSL + Node backend
# Usage: sudo bash setup.sh
# Run this once on your InterServer VPS as root or with sudo.

set -e

DOMAIN="extramkopo.mkopaji.com"
WWW_DOMAIN="www.extramkopo.mkopaji.com"
EMAIL="admin@mkopaji.com"           # <-- change to your real email for cert expiry alerts
REPO_URL="https://github.com/benardcheruiyot/denoki.git"
FRONTEND_DIR="/var/www/${DOMAIN}/frontend"
BACKEND_DIR="/var/www/${DOMAIN}/backend"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"
NODE_PORT=1000

echo "==> [1/6] Installing Nginx, Certbot, Node.js, PM2..."
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx curl

# Install Node.js 20 if not present or version is below 18
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm install -g pm2 2>/dev/null || true

echo "==> [2/6] Cloning repo and creating directory structure..."
mkdir -p "$(dirname "${BACKEND_DIR}")"

# Clone if not already present; otherwise pull
if [ ! -d "/var/www/${DOMAIN}/.git" ]; then
  echo "  -> Cloning from ${REPO_URL}..."
  git clone "${REPO_URL}" "/var/www/${DOMAIN}"
else
  echo "  -> Repo already cloned, pulling latest..."
  git -C "/var/www/${DOMAIN}" pull origin main
fi

echo "==> [3/6] Installing backend dependencies..."
cd "${BACKEND_DIR}"
npm install --omit=dev

echo "==> [4/6] Writing temporary HTTP Nginx config for Certbot verification..."
cat > "${NGINX_CONF}" <<NGINX_HTTP
server {
    listen 80;
    server_name ${DOMAIN} ${WWW_DOMAIN};
    root ${FRONTEND_DIR};
    location / { try_files \$uri \$uri/ /index.html; }
}
NGINX_HTTP

ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

echo "==> [5/6] Obtaining Let's Encrypt SSL certificate..."
certbot --nginx \
  -d "${DOMAIN}" \
  -d "${WWW_DOMAIN}" \
  --non-interactive \
  --agree-tos \
  --email "${EMAIL}" \
  --redirect

echo "==> [5b/6] Writing final HTTPS Nginx config..."
cat > "${NGINX_CONF}" <<'NGINX_HTTPS'
# HTTP -> HTTPS redirect
server {
    listen 80;
    server_name DOMAIN_PLACEHOLDER WWW_DOMAIN_PLACEHOLDER;
    return 301 https://$host$request_uri;
}

# HTTPS main server
server {
    listen 443 ssl http2;
    server_name DOMAIN_PLACEHOLDER WWW_DOMAIN_PLACEHOLDER;

    ssl_certificate     /etc/letsencrypt/live/DOMAIN_PLACEHOLDER/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/DOMAIN_PLACEHOLDER/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff" always;
    add_header X-Frame-Options           "DENY" always;
    add_header Referrer-Policy           "no-referrer" always;

    root  FRONTEND_DIR_PLACEHOLDER;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /apply {
        try_files $uri $uri/ /apply/index.html;
    }

    location /eligibility {
        try_files $uri $uri/ /eligibility/index.html;
    }

    location /api/ {
        proxy_pass         http://127.0.0.1:NODE_PORT_PLACEHOLDER/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 90s;
    }

    client_max_body_size 10m;
}
NGINX_HTTPS

# Substitute placeholders
sed -i \
  -e "s|DOMAIN_PLACEHOLDER|${DOMAIN}|g" \
  -e "s|WWW_DOMAIN_PLACEHOLDER|${WWW_DOMAIN}|g" \
  -e "s|FRONTEND_DIR_PLACEHOLDER|${FRONTEND_DIR}|g" \
  -e "s|NODE_PORT_PLACEHOLDER|${NODE_PORT}|g" \
  "${NGINX_CONF}"

nginx -t
systemctl reload nginx

# Auto-renew cert (Certbot installs a systemd timer; this is a belt-and-suspenders cron)
(crontab -l 2>/dev/null | grep -v certbot; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | crontab -

echo "==> [6/6] Starting Node backend with PM2..."
cd "${BACKEND_DIR}"
pm2 delete extramkopo-api 2>/dev/null || true
pm2 start src/server.js --name extramkopo-api
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo ""
echo "======================================================"
echo " Done! Visit: https://${DOMAIN}"
echo " API health: https://${DOMAIN}/api/health"
echo " PM2 logs:   pm2 logs extramkopo-api"
echo "======================================================"
