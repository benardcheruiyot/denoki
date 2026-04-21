# Backend (Haskback API)

## Setup

1. Copy `.env.example` to `.env` and fill your Haskback API values.
2. Set `HASKBACK_API_URL` to your local or production endpoint.
3. Paste your Haskback API key in `HASKBACK_API_KEY`.
4. Set `HASKBACK_CALLBACK_URL` to your callback endpoint.
5. Set `HASKBACK_ACCOUNT_REFERENCE` and `HASKBACK_TRANSACTION_DESC` as needed.

## Running

1. Install dependencies: `npm install`
2. Start server: `node src/server.js`

## Endpoints

- `/api/health` — Health check
- `/api/haskback_push` — Initiate Haskback transaction (implement as needed)
- `/api/haskback_status` — Check transaction status (implement as needed)
- `/api/haskback_callback` — Callback endpoint

## InterServer Deployment

Use the ready-made deployment files in `backend/deploy/interserver`:

- `backend/deploy/interserver/nginx.conf` — Nginx reverse proxy + static frontend
- `backend/deploy/interserver/apache-vhost.conf` — Apache reverse proxy + SPA fallback
- `backend/deploy/interserver/DEPLOY.md` — full step-by-step deployment guide
