# Local Daraja STK Setup

## 1. Configure env
Copy `.env.example` to `.env` and fill in Daraja values.

## 2. Expose your local server (required for callback)
Daraja callback URL must be public. Use ngrok:

```bash
ngrok http 3000
```

Set `DARAJA_CALLBACK_URL` to:

```text
https://<your-ngrok-domain>/api/stk_callback
```

## 3. Run server

```bash
npm start
```

Then open:

```text
http://localhost:3000/apply/
```

## Endpoints used by frontend
- `POST /api/stk_initiate.js`
- `POST /api/stk_status.js`

## Quick health check

```text
http://localhost:3000/api/health
```
