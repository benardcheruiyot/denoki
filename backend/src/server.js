

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = Number(process.env.PORT || 1000);
// Forcefully allow CORS for production frontend
app.use(cors({
  origin: [
    'https://kopahelaa.vercel.app',
    'https://mkopoextrake.vercel.app',
    'http://localhost:3000'
  ],
  credentials: true
}));

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const DARAJA_BASE_URL = process.env.DARAJA_BASE_URL || 'https://sandbox.safaricom.co.ke';
const DARAJA_MOCK_STK = String(process.env.DARAJA_MOCK_STK || 'false').toLowerCase() === 'true';
const SANDBOX_SHORTCODE = '174379';
const SANDBOX_PASSKEY = 'bfb279f9aa9bdbcf158e97ddf9f1b5f4b6b17f81e8f8f52ce8f86f4e9f0f5f6d';

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// In-memory transaction tracker for pending/completed STK checks.
const txStore = new Map();
const STORE_TTL_MS = 1000 * 60 * 60 * 6;

function cleanupTxStore() {
  const now = Date.now();
  for (const [key, value] of txStore.entries()) {
    if (!value || now - value.updatedAt > STORE_TTL_MS) {
      txStore.delete(key);
    }
  }
}

setInterval(cleanupTxStore, 5 * 60 * 1000).unref();

function nowInNairobi() {
  // Daraja expects East Africa time in yyyyMMddHHmmss format.
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const yyyy = now.getUTCFullYear();
  const MM = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}${hh}${mm}${ss}`;
}

function getRequiredEnv() {
  return {
    DARAJA_CONSUMER_KEY: process.env.DARAJA_CONSUMER_KEY,
    DARAJA_CONSUMER_SECRET: process.env.DARAJA_CONSUMER_SECRET,
    DARAJA_SHORTCODE: process.env.DARAJA_SHORTCODE,
    DARAJA_PASSKEY: process.env.DARAJA_PASSKEY,
    DARAJA_CALLBACK_URL: process.env.DARAJA_CALLBACK_URL
  };
}

function isSandbox() {
  return /sandbox\.safaricom\.co\.ke/i.test(String(DARAJA_BASE_URL || ''));
}

function resolveShortcode() {
  const configured = String(process.env.DARAJA_SHORTCODE || '').trim();
  if (configured) return configured;
  return isSandbox() ? SANDBOX_SHORTCODE : '';
}

function resolvePasskey() {
  const configured = String(process.env.DARAJA_PASSKEY || '').trim();
  if (configured) return configured;
  return isSandbox() ? SANDBOX_PASSKEY : '';
}

function makeMockCheckoutId() {
  return `ws_CO_MOCK_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function envReadiness() {
  if (DARAJA_MOCK_STK) {
    return {
      ok: true,
      missing: [],
      hasPlaceholderValues: false,
      passkeyHasWhitespace: false,
      usingSandboxDefaults: false,
      mockStk: true
    };
  }

  const required = {
    ...getRequiredEnv(),
    DARAJA_SHORTCODE: resolveShortcode(),
    DARAJA_PASSKEY: resolvePasskey()
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !String(value || '').trim())
    .map(([key]) => key);

  const placeholders = [
    'your_consumer_key',
    'your_consumer_secret',
    'your_shortcode_or_till_number',
    'your_lipa_na_mpesa_online_passkey',
    'https://replace-with-your-public-url/api/stk_callback'
  ];

  const hasPlaceholderValues = Object.values(required).some((value) =>
    placeholders.includes(String(value || '').trim())
  );

  const passkeyHasWhitespace = /\s/.test(String(required.DARAJA_PASSKEY || ''));

  return {
    ok: missing.length === 0 && !hasPlaceholderValues && !passkeyHasWhitespace,
    missing,
    hasPlaceholderValues,
    passkeyHasWhitespace,
    usingSandboxDefaults: isSandbox() &&
      !String(process.env.DARAJA_SHORTCODE || '').trim() &&
      !String(process.env.DARAJA_PASSKEY || '').trim()
  };
}

async function getAccessToken() {
  const key = String(process.env.DARAJA_CONSUMER_KEY || '').trim();
  const secret = String(process.env.DARAJA_CONSUMER_SECRET || '').trim();
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');

  const url = `${DARAJA_BASE_URL}/oauth/v1/generate`;
  try {
    const response = await axios.get(url, {
      params: { grant_type: 'client_credentials' },
      headers: { Authorization: `Basic ${auth}` },
      timeout: 20000
    });

    if (!response.data || !response.data.access_token) {
      console.error('Daraja token error: No access_token in response', response.data);
      throw new Error('Failed to obtain Daraja access token.');
    }

    return response.data.access_token;
  } catch (error) {
    // Verbose error logging
    console.error('Daraja token error (verbose):', {
      message: error.message,
      code: error.code,
      stack: error.stack,
      config: error.config,
      response: error.response ? {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      } : null
    });
    if (error.response) {
      // Log full error details from Safaricom
      console.error('Daraja token error:', {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    } else {
      console.error('Daraja token error:', error.message);
    }
    throw new Error('Failed to obtain Daraja access token. See server logs for details.');
  }
}

function buildPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
  if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) return `254${digits}`;
  return digits;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'mkopoextrake-backend', timestamp: new Date().toISOString() });
});

app.get('/api/stk_readiness', async (_req, res) => {
  const readiness = envReadiness();
  if (DARAJA_MOCK_STK) {
    return res.status(200).json({ ...readiness, darajaAuth: 'skipped-mock' });
  }

  if (!readiness.ok) {
    return res.status(200).json(readiness);
  }

  try {
    await getAccessToken();
    return res.status(200).json({ ...readiness, darajaAuth: 'ok' });
  } catch (error) {
    return res.status(200).json({
      ...readiness,
      ok: false,
      darajaAuth: 'failed',
      message: 'Environment variables are set but Daraja auth failed. Verify key/secret pair.'
    });
  }
});

app.get('/api/daraja_test_api', async (_req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ ok: true, tokenPrefix: token.slice(0, 12) });
  } catch (error) {
    res.status(502).json({ ok: false, message: error.message });
  }
});

app.post('/api/stk_initiate', async (req, res) => {
  const readiness = envReadiness();
  if (!readiness.ok) {
    return res.status(400).json({
      success: false,
      retryable: false,
      message: `STK setup incomplete: ${readiness.missing.join(', ') || 'check .env values'}`
    });
  }

  const amount = Number(req.body?.amount);
  const phone = normalizePhone(req.body?.phone);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, retryable: false, message: 'Amount must be greater than 0.' });
  }

  if (!/^254\d{9}$/.test(phone)) {
    return res.status(400).json({ success: false, retryable: false, message: 'Phone must be in 254XXXXXXXXX format.' });
  }

  if (DARAJA_MOCK_STK) {
    const checkoutId = makeMockCheckoutId();
    const merchantRequestId = `mock_${Date.now()}`;
    txStore.set(checkoutId, {
      status: 'PENDING',
      message: 'Mock STK initiated. Awaiting confirmation.',
      updatedAt: Date.now(),
      pollCount: 0,
      amount: Math.round(amount),
      phone
    });

    return res.status(200).json({
      success: true,
      data: {
        MerchantRequestID: merchantRequestId,
        CheckoutRequestID: checkoutId,
        ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing',
        CustomerMessage: 'Success. Request accepted for processing'
      }
    });
  }

  const shortcode = resolveShortcode();
  const passkey = resolvePasskey();
  const callbackUrl = String(process.env.DARAJA_CALLBACK_URL || '').trim();
  const accountReference = String(process.env.DARAJA_ACCOUNT_REFERENCE || 'MkopoExtra').trim();
  const transactionDesc = String(process.env.DARAJA_TRANSACTION_DESC || 'Loan processing fee').trim();
  // Always use Buy Goods (till) integration
  const transactionType = 'CustomerBuyGoodsOnline';

  const timestamp = nowInNairobi();
  const password = buildPassword(shortcode, passkey, timestamp);

  try {
    const token = await getAccessToken();
    const url = `${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`;
    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: Math.round(amount),
      PartyA: phone,
      // Always use till number for PartyB
      PartyB: String(process.env.DARAJA_PARTYB).trim(),
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountReference,
      TransactionDesc: transactionDesc
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 70000
    });

    const data = response.data || {};
    const checkoutId = data.CheckoutRequestID;

    if (data.ResponseCode === '0' && checkoutId) {
      txStore.set(checkoutId, {
        status: 'PENDING',
        message: data.CustomerMessage || 'STK push sent. Awaiting PIN confirmation.',
        updatedAt: Date.now(),
        merchantRequestId: data.MerchantRequestID
      });

      return res.status(200).json({ success: true, data });
    }

    return res.status(400).json({
      success: false,
      retryable: false,
      message: data.ResponseDescription || 'STK request failed.',
      data
    });
  } catch (error) {
    // Enhanced error logging for debugging
    console.error('Daraja STK Error (verbose):', {
      message: error.message,
      code: error.code,
      stack: error.stack,
      config: error.config,
      response: error.response ? {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      } : null
    });
    const upstream = error.response?.data;
    const upstreamMessage = upstream?.errorMessage || upstream?.ResponseDescription || error.message;

    // Mark transient upstream/network issues as retryable for frontend backoff loop.
    const retryable =
      error.code === 'ECONNABORTED' ||
      error.code === 'ECONNRESET' ||
      (Number(error.response?.status || 0) >= 500);

    return res.status(502).json({
      success: false,
      retryable,
      retryAfterMs: retryable ? 2500 : undefined,
      message: upstreamMessage || 'Failed to call Daraja STK endpoint.',
      debug: {
        errorMessage: error.message,
        errorCode: error.code,
        errorStack: error.stack,
        upstreamResponse: upstream
      }
    });
  }
});

app.post('/api/stk_status', async (req, res) => {
  const checkoutRequestId = String(req.body?.checkoutRequestId || '').trim();
  if (!checkoutRequestId) {
    return res.status(400).json({ status: 'FAILED', message: 'checkoutRequestId is required.' });
  }

  const cached = txStore.get(checkoutRequestId);

  if (DARAJA_MOCK_STK) {
    if (!cached) {
      return res.status(200).json({ status: 'PENDING', message: 'Mock transaction still processing.' });
    }

    const nextPoll = Number(cached.pollCount || 0) + 1;
    const status = nextPoll >= 2 ? 'COMPLETED' : 'PENDING';
    const message = status === 'COMPLETED'
      ? 'The service request is processed successfully.'
      : 'Mock transaction still processing.';

    txStore.set(checkoutRequestId, {
      ...cached,
      pollCount: nextPoll,
      status,
      message,
      updatedAt: Date.now()
    });

    return res.status(200).json({ status, message });
  }

  if (cached && (cached.status === 'COMPLETED' || cached.status === 'FAILED')) {
    return res.status(200).json({ status: cached.status, message: cached.message });
  }

  try {
    const shortcode = resolveShortcode();
    const passkey = resolvePasskey();
    const timestamp = nowInNairobi();
    const password = buildPassword(shortcode, passkey, timestamp);
    const token = await getAccessToken();

    const url = `${DARAJA_BASE_URL}/mpesa/stkpushquery/v1/query`;
    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const data = response.data || {};
    const resultCode = Number(data.ResultCode);

    let status = 'PENDING';
    let message = data.ResultDesc || 'Payment is still pending.';

    if (Number.isFinite(resultCode)) {
      if (resultCode === 0) {
        status = 'COMPLETED';
      } else {
        status = 'FAILED';
      }
    }

    txStore.set(checkoutRequestId, { status, message, updatedAt: Date.now() });
    return res.status(200).json({ status, message, result: data });
  } catch (error) {
    const upstream = error.response?.data;
    const message = upstream?.errorMessage || upstream?.ResponseDescription || error.message;

    // Keep polling for transient errors instead of failing immediately in UI.
    return res.status(200).json({ status: 'PENDING', message: `Status check pending: ${message}` });
  }
});

app.post('/api/stk_callback', (req, res) => {
  const callback = req.body?.Body?.stkCallback;
  const checkoutId = String(callback?.CheckoutRequestID || '').trim();
  const resultCode = Number(callback?.ResultCode);
  const resultDesc = String(callback?.ResultDesc || '');

  if (checkoutId) {
    const status = resultCode === 0 ? 'COMPLETED' : 'FAILED';
    txStore.set(checkoutId, {
      status,
      message: resultDesc || (status === 'COMPLETED' ? 'Payment completed.' : 'Payment failed.'),
      updatedAt: Date.now()
    });
  }

  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.use(express.static(FRONTEND_DIR));

app.get('/apply', (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'apply', 'index.html'));
});

app.get('/eligibility', (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'eligibility', 'index.html'));
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
});
