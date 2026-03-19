

const express = require('express');
const app = express();
const PORT = process.env.PORT;
app.get('/api/health', (req, res) => res.send('ok'));
const axios = require('axios');

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
		const response = await axios.post(
			`${HASKBACK_API_URL}/initiatestk`,
			{
				api_key: HASKBACK_API_KEY,
				account_id: process.env.HASKBACK_ACCOUNT_ID,
				amount,
				msisdn,
				reference,
				partyB
			}
		);
		// Store transaction for status tracking
		const txId = response.data?.checkout_id || response.data?.transaction_id || response.data?.id || `${msisdn}_${Date.now()}`;
		if (typeof txStore !== 'undefined') {
			txStore.set(txId, { status: 'PENDING', msisdn, amount, partyB, createdAt: Date.now() });
		}
		res.json({ success: true, data: response.data, txId });
	} catch (error) {
		console.error('Haskback STK Push Error:', error);
		res.status(500).json({ success: false, error: error.response?.data || error.message });
	}
});
app.listen(PORT, () => console.log('Listening on', PORT));
