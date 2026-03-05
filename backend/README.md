# Backend (Daraja STK)

## Quick start

1. `cd backend`
2. `npm install`
3. Copy `.env.example` to `.env` and fill your Daraja API values.
4. `npm start`
5. Open `http://localhost:3000/apply/`

## Test setup (sandbox)

1. Set `DARAJA_BASE_URL=https://sandbox.safaricom.co.ke`.
2. Paste your sandbox `DARAJA_CONSUMER_KEY` and `DARAJA_CONSUMER_SECRET`.
3. If dashboard shows `Short Code: N/A` and `Passkey: N/A`, leave `DARAJA_SHORTCODE` and `DARAJA_PASSKEY` blank.
4. Backend will use sandbox shared STK defaults automatically.
	`BusinessShortCode=174379` and standard Daraja sandbox passkey.
5. Set a public HTTPS callback URL in `DARAJA_CALLBACK_URL`.
6. Set transaction type to match profile:
	`DARAJA_TRANSACTION_TYPE=CustomerBuyGoodsOnline` for till/buy-goods.
	`DARAJA_TRANSACTION_TYPE=CustomerPayBillOnline` for paybill.
7. Run one-command verification:
	`npm run verify:stk`

## Stable local testing (mock STK)

If Daraja sandbox is unstable, set `DARAJA_MOCK_STK=true` in `.env`.

- `POST /api/stk_initiate.js` returns success immediately with mock checkout ID.
- `POST /api/stk_status.js` transitions from `PENDING` to `COMPLETED` after polling.
- Set back to `false` to resume real Daraja calls.

## Best-practice notes

- Use Buy Goods credentials from the same Daraja profile: `DARAJA_SHORTCODE` and `DARAJA_PASSKEY` must match.
- Keep `DARAJA_PASSKEY` as one uninterrupted string (no spaces/newlines).
- `DARAJA_CALLBACK_URL` must be public HTTPS URL for callbacks.
- Start in sandbox first; switch to production URL only after credentials are approved.
- Never commit `.env`.

## API routes

- `GET /api/health`
- `GET /api/stk_readiness`
- `GET /api/daraja_test_api`
- `POST /api/stk_initiate.js` with `{ "phone": "2547XXXXXXXX", "amount": 1 }`
- `POST /api/stk_status.js` with `{ "checkoutRequestId": "ws_CO_..." }`
- `POST /api/stk_callback`
