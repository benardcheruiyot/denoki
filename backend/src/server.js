

const express = require('express');
const app = express();
const PORT = process.env.PORT;
app.get('/api/health', (req, res) => res.send('ok'));
const axios = require('axios'); // Assuming axios is required for the post request

app.post('/api/haskback_push', async (req, res) => {
	console.log('Received /api/haskback_push:', req.body);
	let { msisdn, amount, reference } = req.body;
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
	try {
		const response = await axios.post(
			`${HASKBACK_API_URL}/initiatestk`,
			{
				api_key: HASKBACK_API_KEY,
				account_id: process.env.HASKBACK_ACCOUNT_ID,
				amount,
				msisdn,
				reference
			}
		);
		// Store transaction for status tracking
		const txId = response.data?.checkout_id || response.data?.transaction_id || response.data?.id || `${msisdn}_${Date.now()}`;
		txStore.set(txId, { status: 'PENDING', msisdn, amount, createdAt: Date.now() });
		res.json({ success: true, data: response.data, txId });
	} catch (error) {
		console.error('Haskback STK Push Error:', error);
		res.status(500).json({ success: false, error: error.response?.data || error.message });
	}
});
app.listen(PORT, () => console.log('Listening on', PORT));
