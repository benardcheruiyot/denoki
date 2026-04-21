const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 1000);
const DARAJA_MOCK = String(process.env.DARAJA_MOCK || 'false').toLowerCase() === 'true';
const DARAJA_ENV = String(process.env.DARAJA_ENV || 'production').toLowerCase();
const DARAJA_HTTP_TIMEOUT_MS = Number(process.env.DARAJA_HTTP_TIMEOUT_MS || 30000);
const STK_PENDING_TX_TIMEOUT = Number(process.env.STK_PENDING_TX_TIMEOUT_MS || 120000);

app.use((req, res, next) => {
	const allowedOrigins = [
		'http://localhost:1000',
		'http://localhost:3000',
		'https://extramkopo.mkopaji.com',
		'https://www.extramkopo.mkopaji.com'
	];
	const origin = req.headers.origin;
	if (allowedOrigins.includes(origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin);
	}
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
	res.setHeader('Access-Control-Allow-Credentials', 'true');
	if (req.method === 'OPTIONS') {
		return res.sendStatus(204);
	}
	next();
});

app.get('/api/health', (req, res) => res.send('ok'));

const trimEnv = (v) => typeof v === 'string' ? v.trim() : v;
const DARAJA_CONSUMER_KEY = trimEnv(process.env.DARAJA_CONSUMER_KEY);
const DARAJA_CONSUMER_SECRET = trimEnv(process.env.DARAJA_CONSUMER_SECRET);
const DARAJA_SHORTCODE = trimEnv(process.env.DARAJA_SHORTCODE);
const DARAJA_PARTYB = trimEnv(process.env.DARAJA_PARTYB || process.env.DARAJA_SHORTCODE);
const DARAJA_PASSKEY = trimEnv(process.env.DARAJA_PASSKEY);
const DARAJA_CALLBACK_URL = trimEnv(process.env.DARAJA_CALLBACK_URL);
const DARAJA_TRANSACTION_TYPE = trimEnv(process.env.DARAJA_TRANSACTION_TYPE || 'CustomerBuyGoodsOnline');
const DARAJA_ACCOUNT_REFERENCE = trimEnv(process.env.DARAJA_ACCOUNT_REFERENCE || 'Mkopo Extra');
const DARAJA_TRANSACTION_DESC = trimEnv(process.env.DARAJA_TRANSACTION_DESC || 'Loan processing fee');

const stkPendingTx = new Map();
const txStore = new Map();
const TX_STATUS_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

setInterval(() => {
	const now = Date.now();
	for (const [txId, tx] of txStore.entries()) {
		if (tx.updatedAt && now - tx.updatedAt > TX_STATUS_EXPIRY) {
			txStore.delete(txId);
		}
	}
}, 60 * 60 * 1000); // every hour

setInterval(() => {
	const now = Date.now();
	for (const [msisdn, val] of stkPendingTx.entries()) {
		if (!val || !val.createdAt || now - val.createdAt > STK_PENDING_TX_TIMEOUT) {
			stkPendingTx.delete(msisdn);
		}
	}
}, 60 * 1000);

function darajaBaseUrl() {
	return DARAJA_ENV === 'production'
		? 'https://api.safaricom.co.ke'
		: 'https://sandbox.safaricom.co.ke';
}

function normalizePhone(phone) {
	let p = String(phone || '').replace(/\D/g, '');
	if (p.startsWith('0')) p = `254${p.slice(1)}`;
	if (p.startsWith('7') || p.startsWith('1')) p = `254${p}`;
	return p;
}

function getTimestampEAT() {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Africa/Nairobi',
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit',
		hour12: false,
	}).formatToParts(new Date());
	const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
	return `${map.year}${map.month}${map.day}${map.hour}${map.minute}${map.second}`;
}

function buildPassword(shortCode, passkey, timestamp) {
	return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
}

function ensureDarajaConfig() {
	const missing = [];
	if (!DARAJA_CONSUMER_KEY) missing.push('DARAJA_CONSUMER_KEY');
	if (!DARAJA_CONSUMER_SECRET) missing.push('DARAJA_CONSUMER_SECRET');
	if (!DARAJA_SHORTCODE) missing.push('DARAJA_SHORTCODE');
	if (!DARAJA_PASSKEY) missing.push('DARAJA_PASSKEY');
	if (!DARAJA_CALLBACK_URL) missing.push('DARAJA_CALLBACK_URL');
	return missing;
}

async function getAccessToken() {
	const auth = Buffer.from(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`).toString('base64');
	const url = `${darajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`;
	const response = await axios.get(url, {
		headers: { Authorization: `Basic ${auth}` },
		timeout: DARAJA_HTTP_TIMEOUT_MS,
	});
	return response.data.access_token;
}

function setTransactionState(txId, status, msisdn, message, extra = {}) {
	const existing = txStore.get(txId) || {};
	txStore.set(txId, {
		...existing,
		...extra,
		txId,
		status,
		msisdn: msisdn || existing.msisdn || null,
		message: message || existing.message || null,
		updatedAt: Date.now(),
	});
}

function clearPendingByTx(txId, msisdn) {
	if (msisdn && stkPendingTx.has(msisdn)) {
		const pending = stkPendingTx.get(msisdn);
		if (pending && pending.txId === txId) {
			stkPendingTx.delete(msisdn);
		}
	}
}

app.post('/api/haskback_push', async (req, res) => {
	let { msisdn, amount, reference, partyB } = req.body;
	msisdn = normalizePhone(msisdn);
	amount = Number(amount);

	if (!/^254[17]\d{8}$/.test(msisdn)) {
		return res.status(400).json({ success: false, message: 'Invalid phone number format' });
	}
	if (!Number.isFinite(amount) || amount < 1) {
		return res.status(400).json({ success: false, message: 'Invalid amount' });
	}

	const now = Date.now();
	const pending = stkPendingTx.get(msisdn);
	if (pending) {
		if (!pending.createdAt || now - pending.createdAt > STK_PENDING_TX_TIMEOUT) {
			stkPendingTx.delete(msisdn);
		} else {
			return res.status(429).json({ success: false, message: 'You have a pending transaction. Please complete it before initiating a new one.' });
		}
	}

	try {
		if (DARAJA_MOCK) {
			const txId = `ws_CO_${Date.now()}`;
			stkPendingTx.set(msisdn, { txId, createdAt: Date.now() });
			setTransactionState(txId, 'PENDING', msisdn, 'Mock STK initiated', { amount, partyB: partyB || DARAJA_PARTYB });
			return res.json({ success: true, txId, data: { CheckoutRequestID: txId, ResponseCode: '0', ResponseDescription: 'Mock accepted' } });
		}

		const missing = ensureDarajaConfig();
		if (missing.length > 0) {
			return res.status(400).json({ success: false, message: 'Missing Daraja configuration', missing });
		}

		const token = await getAccessToken();
		const timestamp = getTimestampEAT();
		const payload = {
			BusinessShortCode: DARAJA_SHORTCODE,
			Password: buildPassword(DARAJA_SHORTCODE, DARAJA_PASSKEY, timestamp),
			Timestamp: timestamp,
			TransactionType: DARAJA_TRANSACTION_TYPE,
			Amount: Math.round(amount),
			PartyA: msisdn,
			PartyB: String(partyB || DARAJA_PARTYB || DARAJA_SHORTCODE),
			PhoneNumber: msisdn,
			CallBackURL: DARAJA_CALLBACK_URL,
			AccountReference: String(reference || DARAJA_ACCOUNT_REFERENCE),
			TransactionDesc: DARAJA_TRANSACTION_DESC,
		};

		const response = await axios.post(`${darajaBaseUrl()}/mpesa/stkpush/v1/processrequest`, payload, {
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			timeout: DARAJA_HTTP_TIMEOUT_MS,
			validateStatus: () => true,
		});

		if (response.status >= 400 || response.data?.ResponseCode !== '0') {
			return res.status(502).json({
				success: false,
				message: response.data?.errorMessage || response.data?.ResponseDescription || 'Daraja rejected STK request',
				details: response.data,
			});
		}

		const txId = response.data?.CheckoutRequestID;
		if (!txId) {
			return res.status(502).json({ success: false, message: 'Missing CheckoutRequestID from Daraja', details: response.data });
		}

		stkPendingTx.set(msisdn, { txId, createdAt: Date.now() });
		setTransactionState(txId, 'PENDING', msisdn, response.data?.ResponseDescription || 'STK initiated', { amount, partyB: payload.PartyB });
		res.json({ success: true, data: response.data, txId });
	} catch (error) {
		res.status(500).json({ success: false, message: error.response?.data?.errorMessage || error.message, details: error.response?.data || null });
	}
});

app.post('/api/clear_pending_tx', (req, res) => {
	const { msisdn, txId } = req.body;
	if (!msisdn) return res.status(400).json({ success: false, message: 'msisdn required' });
	const pending = stkPendingTx.get(msisdn);
	if (pending && (pending.txId === txId || !txId)) {
		stkPendingTx.delete(msisdn);
		return res.json({ success: true });
	}
	res.status(400).json({ success: false, message: 'txId does not match pending transaction' });
});

app.post('/api/haskback_status', (req, res) => {
	let { msisdn, txId } = req.body;
	txId = String(txId || '').trim();
	msisdn = normalizePhone(msisdn);
	if (!txId) {
		return res.status(400).json({ status: 'FAILED', message: 'txId required' });
	}

	const now = Date.now();
	if (txStore.has(txId)) {
		const tx = txStore.get(txId);
		if (tx.status === 'COMPLETED') {
			return res.json({ status: 'COMPLETED', message: 'Payment completed.' });
		} else if (tx.status === 'FAILED') {
			return res.json({ status: 'FAILED', message: 'Payment failed or cancelled.' });
		} else {
			if (tx.updatedAt && now - tx.updatedAt > STK_PENDING_TX_TIMEOUT && msisdn) {
				stkPendingTx.delete(msisdn);
				txStore.set(txId, { ...tx, status: 'FAILED', updatedAt: now });
				return res.json({ status: 'FAILED', message: 'Transaction timed out.' });
			}
			return res.json({ status: 'PENDING', message: 'Transaction is still pending.' });
		}
	}

	const pending = stkPendingTx.get(msisdn);
	if (!pending || !pending.txId || pending.txId !== txId) {
		return res.json({ status: 'FAILED', message: 'No pending transaction found.' });
	}
	if (now - pending.createdAt > STK_PENDING_TX_TIMEOUT) {
		stkPendingTx.delete(msisdn);
		return res.json({ status: 'FAILED', message: 'Transaction timed out.' });
	}
	return res.json({ status: 'PENDING', message: 'Transaction is still pending.' });
});

app.post('/api/haskback_callback', (req, res) => {
	const stkCb = req.body?.Body?.stkCallback;

	if (stkCb) {
		const txId = String(stkCb.CheckoutRequestID || '').trim();
		const resultCode = Number(stkCb.ResultCode);
		const status = resultCode === 0 ? 'COMPLETED' : 'FAILED';
		let msisdn = null;

		const items = Array.isArray(stkCb.CallbackMetadata?.Item) ? stkCb.CallbackMetadata.Item : [];
		const phoneItem = items.find((i) => i?.Name === 'PhoneNumber');
		if (phoneItem?.Value) {
			msisdn = normalizePhone(String(phoneItem.Value));
		}

		setTransactionState(txId, status, msisdn, stkCb.ResultDesc || null, { callbackData: stkCb, resultCode });
		clearPendingByTx(txId, msisdn);
		return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
	}

	const { txId, status, msisdn, ...extra } = req.body;
	if (!txId || !status) {
		return res.status(400).json({ success: false, message: 'Invalid callback payload' });
	}
	const normMsisdn = normalizePhone(msisdn);
	let normStatus = String(status).trim().toUpperCase();
	if (["SUCCESS", "COMPLETED"].includes(normStatus)) {
		normStatus = 'COMPLETED';
	} else if (["FAILED", "CANCELLED", "REVERSED", "DECLINED"].includes(normStatus)) {
		normStatus = 'FAILED';
	} else {
		normStatus = 'PENDING';
	}
	setTransactionState(String(txId), normStatus, normMsisdn, null, extra);
	clearPendingByTx(String(txId), normMsisdn);
	return res.json({ success: true });
});

app.post('/api/manual_callback', (req, res) => {
	const { txId, status, msisdn } = req.body;
	if (!txId || !status || !msisdn) {
		return res.status(400).json({ success: false, message: 'txId, status, msisdn required' });
	}
	let normStatus = String(status).trim().toUpperCase();
	if (["SUCCESS", "COMPLETED"].includes(normStatus)) normStatus = 'COMPLETED';
	else if (["FAILED", "CANCELLED", "REVERSED", "DECLINED"].includes(normStatus)) normStatus = 'FAILED';
	else normStatus = 'PENDING';
	const normalizedMsisdn = normalizePhone(msisdn);
	setTransactionState(String(txId), normStatus, normalizedMsisdn, 'Manual callback');
	clearPendingByTx(String(txId), normalizedMsisdn);
	return res.json({ success: true, simulated: true });
});

app.get('/api/stk_readiness', (_req, res) => {
	const missing = ensureDarajaConfig();
	res.json({
		mode: DARAJA_MOCK ? 'mock' : 'live',
		env: DARAJA_ENV,
		ok: DARAJA_MOCK ? true : missing.length === 0,
		missing,
	});
});

app.listen(PORT, () => console.log('Listening on', PORT));
