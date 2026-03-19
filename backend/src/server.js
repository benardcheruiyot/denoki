

const express = require('express');
const app = express();
app.use(express.json());
const PORT = process.env.PORT;
const axios = require('axios');

// --- CORS Middleware ---
app.use((req, res, next) => {
	const allowedOrigins = [
		'http://localhost:1000',
		'http://localhost:3000',
		'https://denoki-3.onrender.com',
		'https://denoki.vercel.app',
		'https://www.denoki.vercel.app',
		'https://kopahella.vercel.app'
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

// Load environment variables
const trimEnv = (v) => typeof v === 'string' ? v.trim() : v;
const HASKBACK_API_KEY = trimEnv(process.env.HASKBACK_API_KEY);
const HASKBACK_API_URL = trimEnv(process.env.HASKBACK_API_URL);
const HASKBACK_PARTYB = trimEnv(process.env.HASKBACK_PARTYB);
const HASKBACK_ACCOUNT_ID = trimEnv(process.env.HASKBACK_ACCOUNT_ID);
const HASKBACK_CALLBACK_URL = trimEnv(process.env.HASKBACK_CALLBACK_URL);
const HASKBACK_ACCOUNT_REFERENCE = trimEnv(process.env.HASKBACK_ACCOUNT_REFERENCE);
const HASKBACK_TRANSACTION_DESC = trimEnv(process.env.HASKBACK_TRANSACTION_DESC);

app.post('/api/haskback_push', async (req, res) => {
	console.log('Received /api/haskback_push:', req.body);
	let { msisdn, amount, reference, partyB } = req.body;
	// Validate required fields
	if (!msisdn || !amount || !reference) {
		console.error('Missing required fields:', req.body);
		return res.status(400).json({ success: false, message: 'msisdn, amount, and reference are required.' });
	}
	// Use partyB from request, else from env
	partyB = partyB || HASKBACK_PARTYB;
	// Validate all Hashback fields
	const requiredFields = {
		api_key: HASKBACK_API_KEY,
		account_id: HASKBACK_ACCOUNT_ID,
		amount,
		msisdn,
		reference,
		partyB,
		callback_url: HASKBACK_CALLBACK_URL,
		account_reference: HASKBACK_ACCOUNT_REFERENCE,
		transaction_desc: HASKBACK_TRANSACTION_DESC
	};
	for (const [k, v] of Object.entries(requiredFields)) {
		if (!v || typeof v === 'string' && v.trim() === '') {
			console.error(`Missing or empty field: ${k}`);
			return res.status(400).json({ success: false, message: `Missing or empty field: ${k}` });
		}
	}
	if (!msisdn || !amount || !reference) {
		console.error('Missing required fields:', req.body);
		return res.status(400).json({ success: false, message: 'msisdn, amount, and reference are required.' });
	}
	// Force msisdn to 254XXXXXXXXX format
	msisdn = String(msisdn).replace(/\D/g, '');
	if (msisdn.startsWith('0')) {
		msisdn = '254' + msisdn.substring(1);
	} else if (msisdn.startsWith('7') || msisdn.startsWith('1')) {
		msisdn = '254' + msisdn;
	} else if (!msisdn.startsWith('254')) {
		msisdn = '254' + msisdn;
	}
	// Use partyB from request, else from env
	partyB = partyB || HASKBACK_PARTYB;
	if (!partyB) {
		console.error('Missing partyB (till number)');
		return res.status(400).json({ success: false, message: 'partyB (till number) is required.' });
	}
	try {
		const payload = requiredFields;
		console.log('Sending to Hashback API:', payload);
		const response = await axios.post(
			`${HASKBACK_API_URL}/initiatestk`,
			payload
		);
		// Store transaction for status tracking
		const txId = response.data?.checkout_id || response.data?.transaction_id || response.data?.id || `${msisdn}_${Date.now()}`;
		if (typeof txStore !== 'undefined') {
			txStore.set(txId, { status: 'PENDING', msisdn, amount, partyB, createdAt: Date.now() });
		}
		res.json({ success: true, data: response.data, txId });
	} catch (error) {
		console.error('Haskback STK Push Error:', error);
		if (error.response && error.response.data) {
			console.error('Hashback API error response:', error.response.data);
		}
		res.status(500).json({ success: false, error: error.response?.data || error.message });
	}
});
app.listen(PORT, () => console.log('Listening on', PORT));
