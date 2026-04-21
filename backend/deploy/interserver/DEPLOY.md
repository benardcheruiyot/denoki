# InterServer Deployment Guide

This project is now host-agnostic on the frontend for API calls because it uses /api.

## 1) App layout on server

Use this structure:

- /var/www/extramkopo.mkopaji.com/frontend  -> contents of frontend folder
- /var/www/extramkopo.mkopaji.com/backend   -> contents of backend folder

## 2) Backend environment

In backend/.env, set at least:

PORT=1000
HASKBACK_API_KEY=...
HASKBACK_ACCOUNT_ID=...
HASKBACK_API_URL=https://api.hashback.co.ke
HASKBACK_CALLBACK_URL=https://extramkopo.mkopaji.com/api/haskback_callback
HASKBACK_ACCOUNT_REFERENCE=Haskback
HASKBACK_TRANSACTION_DESC=Haskback loan processing fee
HASKBACK_PARTYB=8733762

## 3) Start Node backend

From backend folder:

npm install
npm run start

For production, keep it alive with PM2 if available:

pm2 start src/server.js --name extramkopo-api
pm2 save

## 4) Reverse proxy setup

Pick one:

- Nginx: use nginx.conf in this folder
- Apache: use apache-vhost.conf in this folder

Edit paths if your InterServer home path differs.

## 5) SSL

After DNS points to InterServer, issue SSL and then update your web server to listen on 443.

## 6) Verify

- Open https://extramkopo.mkopaji.com
- Check API health: https://extramkopo.mkopaji.com/api/health
- Trigger a test payment and confirm callback logs on backend

## 7) Notes for cPanel shared hosting

If full vhost/proxy control is restricted, use Node.js App Manager for backend and map a reverse proxy through cPanel support or use a subdomain dedicated to API.
