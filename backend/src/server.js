

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
		'https://www.denoki.vercel.app'
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
const HASKBACK_API_KEY = process.env.HASKBACK_API_KEY;
const HASKBACK_API_URL = process.env.HASKBACK_API_URL;
const HASKBACK_PARTYB = process.env.HASKBACK_PARTYB;

app.post('/api/haskback_push', async (req, res) => {
	console.log('Received /api/haskback_push:', req.body);
	let { msisdn, amount, reference, partyB } = req.body;
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
		const payload = {
			api_key: HASKBACK_API_KEY,
			account_id: process.env.HASKBACK_ACCOUNT_ID,
			amount,
			msisdn,
			reference,
			partyB
		};
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
