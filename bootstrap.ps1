# bootstrap.ps1 — Run once to fully set up InterServer VPS + GitHub Actions
# Usage: .\bootstrap.ps1
# Requires: ssh, scp, ssh-keygen (all bundled with Windows 10/11 OpenSSH)

$VPS_IP   = "69.169.97.136"
$VPS_USER = "root"
$KEY_PATH = "$env:USERPROFILE\.ssh\denoki_deploy"
$REPO     = "https://github.com/benardcheruiyot/denoki"

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " Denoki InterServer Bootstrap" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Generate SSH key pair ---
Write-Host "[1/5] Generating SSH deploy key..." -ForegroundColor Yellow
if (-not (Test-Path "$KEY_PATH")) {
    ssh-keygen -t ed25519 -C "github-actions-deploy" -f "$KEY_PATH" -N ""
} else {
    Write-Host "  -> Key already exists at $KEY_PATH, skipping."
}
$PUBLIC_KEY  = Get-Content "$KEY_PATH.pub"
$PRIVATE_KEY = Get-Content "$KEY_PATH" -Raw

# --- Step 2: Ask for VPS password once ---
Write-Host ""
Write-Host "[2/5] Copying SSH key to VPS (you will be prompted for the root password once)..." -ForegroundColor Yellow
$PUB_KEY_ESCAPED = $PUBLIC_KEY -replace '"', '\"'
ssh "${VPS_USER}@${VPS_IP}" "mkdir -p ~/.ssh && echo `"$PUB_KEY_ESCAPED`" >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"
Write-Host "  -> SSH key installed on VPS. Password login no longer needed."

# --- Step 3: Upload and run setup.sh ---
Write-Host ""
Write-Host "[3/5] Uploading setup.sh to VPS..." -ForegroundColor Yellow
scp -i "$KEY_PATH" "backend\deploy\interserver\setup.sh" "${VPS_USER}@${VPS_IP}:~/setup.sh"

Write-Host "  -> Running setup.sh on VPS (this installs Nginx, SSL, PM2 - may take ~2 min)..."
ssh -i "$KEY_PATH" "${VPS_USER}@${VPS_IP}" "bash ~/setup.sh"

# --- Step 4: Upload project files and .env ---
Write-Host ""
Write-Host "[4/5] Uploading project files to VPS..." -ForegroundColor Yellow
ssh -i "$KEY_PATH" "${VPS_USER}@${VPS_IP}" "mkdir -p /var/www/extramkopo.mkopaji.com"
scp -i "$KEY_PATH" -r "frontend" "${VPS_USER}@${VPS_IP}:/var/www/extramkopo.mkopaji.com/"
scp -i "$KEY_PATH" -r "backend"  "${VPS_USER}@${VPS_IP}:/var/www/extramkopo.mkopaji.com/"
scp -i "$KEY_PATH" "backend\.env" "${VPS_USER}@${VPS_IP}:/var/www/extramkopo.mkopaji.com/backend/.env"

Write-Host "  -> Installing Node dependencies and starting PM2..."
$remoteCmd = "cd /var/www/extramkopo.mkopaji.com/backend; npm install --omit=dev; pm2 delete extramkopo-api >/dev/null 2>&1 || true; pm2 start src/server.js --name extramkopo-api; pm2 save; pm2 startup systemd -u root --hp /root | tail -1 | bash || true"
ssh -i "$KEY_PATH" "${VPS_USER}@${VPS_IP}" $remoteCmd

# --- Step 5: Print GitHub secrets ---
$APP_ENV = Get-Content "backend\.env" -Raw

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host " [5/5] ADD THESE SECRETS TO GITHUB:" -ForegroundColor Green
Write-Host "  $REPO/settings/secrets/actions/new" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Secret name : VPS_HOST" -ForegroundColor White
Write-Host "Secret value: $VPS_IP" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Secret name : VPS_USER" -ForegroundColor White
Write-Host "Secret value: $VPS_USER" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Secret name : VPS_SSH_KEY" -ForegroundColor White
Write-Host "Secret value:" -ForegroundColor DarkGray
Write-Host $PRIVATE_KEY -ForegroundColor DarkGray
Write-Host ""
Write-Host "Secret name : APP_ENV" -ForegroundColor White
Write-Host "Secret value:" -ForegroundColor DarkGray
Write-Host $APP_ENV -ForegroundColor DarkGray
Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host " All done! Push to main to trigger auto-deploy." -ForegroundColor Green
Write-Host "  Health check: https://extramkopo.mkopaji.com/api/health" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
