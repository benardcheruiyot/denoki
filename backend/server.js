const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DARAJA_MOCK = String(process.env.DARAJA_MOCK || 'false').toLowerCase() === 'true';
const DARAJA_HTTP_TIMEOUT_MS = Number(process.env.DARAJA_HTTP_TIMEOUT_MS || 60000);
const DARAJA_HTTP_RETRIES = Number(process.env.DARAJA_HTTP_RETRIES || 1);
const PLACEHOLDER_VALUES = new Set([
  '',
  'your_consumer_key',
  'your_consumer_secret',
  'your_lipa_na_mpesa_online_passkey',
  'https://replace-with-your-public-url/api/stk_callback',
  'replace_with_live_consumer_key',
  'replace_with_live_consumer_secret',
  'replace_with_live_shortcode',
  'replace_with_live_lipa_na_mpesa_passkey',
  'https://replace-with-live-domain.com/api/stk_callback',
]);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// In-memory status store for local polling.
const checkoutStore = new Map();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(value).trim();
}

function darajaBaseUrl() {
  return process.env.DARAJA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

function getTimestampEAT() {
  // Daraja expects YYYYMMDDHHmmss in East Africa Time.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const yyyy = map.year;
  const mm = map.month;
  const dd = map.day;
  const hh = map.hour;
  const mi = map.minute;
  const ss = map.second;
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}

function normalizePhone(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('254')) return p;
  if (p.startsWith('0')) return `254${p.slice(1)}`;
  if (p.startsWith('7') || p.startsWith('1')) return `254${p}`;
  return p;
}

function isRetryableAxiosError(error) {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.response?.status || 0);
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || status >= 500;
}

async function requestWithRetry(fn, retries = DARAJA_HTTP_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableAxiosError(error) || attempt === retries) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function getAccessToken() {
  const consumerKey = requiredEnv('DARAJA_CONSUMER_KEY');
  const consumerSecret = requiredEnv('DARAJA_CONSUMER_SECRET');
  const base = darajaBaseUrl();
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const url = `${base}/oauth/v1/generate?grant_type=client_credentials`;
  const response = await requestWithRetry(() => axios.get(url, {
    headers: { Authorization: `Basic ${auth}` },
    timeout: DARAJA_HTTP_TIMEOUT_MS,
    validateStatus: () => true,
  }));

  if (response.status >= 400 || !response.data?.access_token) {
    const msg = response.data?.error_description || response.data?.error || 'Failed to get Daraja access token';
    throw new Error(`${msg} (status ${response.status})`);
  }

  return response.data.access_token;
}

function buildPassword(shortCode, passkey, timestamp) {
  return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
}

function isPlaceholder(value) {
  return PLACEHOLDER_VALUES.has(String(value || '').trim());
}

function getReadiness() {
  const env = String(process.env.DARAJA_ENV || 'sandbox').trim();
  const callbackUrl = String(process.env.DARAJA_CALLBACK_URL || '').trim();
  const checks = {
    mode: DARAJA_MOCK ? 'mock' : 'live',
    env,
    consumerKey: !isPlaceholder(process.env.DARAJA_CONSUMER_KEY),
    consumerSecret: !isPlaceholder(process.env.DARAJA_CONSUMER_SECRET),
    shortCode: !isPlaceholder(process.env.DARAJA_SHORTCODE),
    passkey: !isPlaceholder(process.env.DARAJA_PASSKEY),
    callbackUrl: !isPlaceholder(callbackUrl) && /^https:\/\//i.test(callbackUrl),
  };

  const missing = Object.entries(checks)
    .filter(([k, v]) => !['mode', 'env'].includes(k) && !v)
    .map(([k]) => k);

  return {
    ok: DARAJA_MOCK ? true : missing.length === 0,
    liveReady: missing.length === 0,
    checks,
    missing,
  };
}

app.get('/api/health', (_req, res) => {
  const readiness = getReadiness();
  res.json({
    ok: true,
    service: 'daraja-backend',
    mock: DARAJA_MOCK,
    readyForLiveStk: readiness.liveReady,
  });
});

app.get('/api/stk_readiness', (_req, res) => {
  const readiness = getReadiness();
  res.json(readiness);
});

function makeMockCheckoutId() {
  return `ws_CO_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

app.post('/api/stk_initiate.js', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const amount = Number(req.body.amount);

    if (!/^254[17]\d{8}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number format' });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    if (DARAJA_MOCK) {
      const checkoutRequestId = makeMockCheckoutId();
      checkoutStore.set(checkoutRequestId, {
        status: 'PENDING',
        message: 'Mock STK initiated',
        amount: Math.round(amount),
        phone,
        pollCount: 0,
        updatedAt: new Date().toISOString(),
      });

      return res.json({
        success: true,
        mode: 'mock',
        data: {
          MerchantRequestID: `mock_${Date.now()}`,
          CheckoutRequestID: checkoutRequestId,
          ResponseCode: '0',
          ResponseDescription: 'Mock request accepted for processing',
          CustomerMessage: 'Success. Request accepted for processing',
        },
      });
    }

    const readiness = getReadiness();
    if (!readiness.ok) {
      return res.status(400).json({
        success: false,
        message: 'STK is not ready. Update backend/.env Daraja settings.',
        missing: readiness.missing,
      });
    }

    const shortCode = requiredEnv('DARAJA_SHORTCODE');
    const passkey = requiredEnv('DARAJA_PASSKEY');
    const callbackUrl = requiredEnv('DARAJA_CALLBACK_URL');

    const timestamp = getTimestampEAT();
    const password = buildPassword(shortCode, passkey, timestamp);
    const token = await getAccessToken();
    const base = darajaBaseUrl();

    const accountReference = process.env.DARAJA_ACCOUNT_REFERENCE || 'MkopoExtra';
    const transactionDesc = process.env.DARAJA_TRANSACTION_DESC || 'Loan processing fee';

    const payload = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: shortCode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountReference,
      TransactionDesc: transactionDesc,
    };

    const response = await requestWithRetry(() => axios.post(`${base}/mpesa/stkpush/v1/processrequest`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: DARAJA_HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    }));

    const data = response.data;

    if (response.status >= 400) {
      const raw = typeof data === 'string' ? data : JSON.stringify(data || {});
      return res.status(502).json({
        success: false,
        message: data?.errorMessage || data?.ResponseDescription || 'Daraja rejected STK request',
        upstreamStatus: response.status,
        upstreamBody: raw.slice(0, 500),
      });
    }

    const checkoutRequestId = data.CheckoutRequestID;

    if (checkoutRequestId) {
      checkoutStore.set(checkoutRequestId, {
        status: 'PENDING',
        message: data.ResponseDescription || 'STK initiated',
        amount: Math.round(amount),
        phone,
        updatedAt: new Date().toISOString(),
      });
    }

    return res.json({ success: true, mode: 'live', data });
  } catch (error) {
    const message = error.response?.data?.errorMessage || error.response?.data?.ResponseDescription || error.message;
    console.error('STK initiate error:', message, error.response?.data || '');
    return res.status(500).json({ success: false, message, details: error.response?.data || null });
  }
});

app.post('/api/stk_status.js', async (req, res) => {
  try {
    const checkoutRequestId = String(req.body.checkoutRequestId || '').trim();
    if (!checkoutRequestId) {
      return res.status(400).json({ status: 'FAILED', message: 'checkoutRequestId is required' });
    }

    const cached = checkoutStore.get(checkoutRequestId);

    if (DARAJA_MOCK) {
      if (!cached) {
        return res.json({ status: 'PENDING', message: 'Mock transaction still processing' });
      }

      const nextPoll = Number(cached.pollCount || 0) + 1;
      const done = nextPoll >= 3;
      const status = done ? 'COMPLETED' : 'PENDING';
      const message = done ? 'Mock payment completed' : 'Mock transaction still processing';

      const updated = {
        ...cached,
        pollCount: nextPoll,
        status,
        message,
        updatedAt: new Date().toISOString(),
      };

      checkoutStore.set(checkoutRequestId, updated);
      return res.json({ status, message, data: updated });
    }

    if (cached && cached.status !== 'PENDING') {
      return res.json({ status: cached.status, message: cached.message || null, data: cached });
    }

    // Query Daraja for latest status when still pending.
    const shortCode = requiredEnv('DARAJA_SHORTCODE');
    const passkey = requiredEnv('DARAJA_PASSKEY');
    const timestamp = getTimestampEAT();
    const password = buildPassword(shortCode, passkey, timestamp);
    const token = await getAccessToken();
    const base = darajaBaseUrl();

    const queryPayload = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    };

    const queryResponse = await requestWithRetry(() => axios.post(`${base}/mpesa/stkpushquery/v1/query`, queryPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: DARAJA_HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    }));

    const d = queryResponse.data || {};
    if (queryResponse.status >= 400) {
      return res.json({
        status: 'PENDING',
        message: d?.errorMessage || d?.ResponseDescription || `Status query upstream HTTP ${queryResponse.status}`,
      });
    }
    const resultCode = Number(d.ResultCode);

    let status = 'PENDING';
    if (Number.isFinite(resultCode)) {
      status = resultCode === 0 ? 'COMPLETED' : 'FAILED';
    }

    const record = {
      status,
      message: d.ResultDesc || d.ResponseDescription || 'Awaiting confirmation',
      resultCode: Number.isFinite(resultCode) ? resultCode : null,
      updatedAt: new Date().toISOString(),
    };
    checkoutStore.set(checkoutRequestId, record);

    return res.json({ status: record.status, message: record.message, data: d });
  } catch (error) {
    // Keep pending on transient backend/API issues so frontend can retry polling.
    return res.json({
      status: 'PENDING',
      message: error.response?.data?.errorMessage || error.message || 'Still processing',
    });
  }
});

app.post('/api/stk_callback', (req, res) => {
  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) {
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback payload' });
    }

    const checkoutRequestId = body.CheckoutRequestID;
    const resultCode = Number(body.ResultCode);
    const status = resultCode === 0 ? 'COMPLETED' : 'FAILED';

    checkoutStore.set(checkoutRequestId, {
      status,
      resultCode,
      message: body.ResultDesc || null,
      callbackData: body,
      updatedAt: new Date().toISOString(),
    });

    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (_error) {
    return res.status(500).json({ ResultCode: 1, ResultDesc: 'Callback processing error' });
  }
});

app.use((req, res) => {
  // Fallback for unknown API routes.
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'API route not found' });
  }
  return res.status(404).send('Not Found');
});

app.listen(PORT, () => {
  const readiness = getReadiness();
  console.log(`Daraja backend running at http://localhost:${PORT}`);
  console.log(`STK mode: ${DARAJA_MOCK ? 'MOCK' : 'LIVE'}`);
  if (!DARAJA_MOCK && !readiness.ok) {
    console.warn(`STK live mode is not ready. Missing/invalid: ${readiness.missing.join(', ')}`);
  }
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled server error:', err.message);
  return res.status(500).json({ success: false, message: 'Internal server error' });
});
