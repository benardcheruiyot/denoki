console.log('Starting server...');

// ...existing code...
// (Move this to the very end of the file)

// Log all uncaught exceptions and unhandled promise rejections
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = Number(process.env.PORT || 1000);

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - Body:`, req.body);
  next();
});


// Health check endpoint for Render and monitoring
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Test endpoint to verify backend is reachable
app.get('/api/test', (req, res) => {
  res.json({ success: true, message: 'Backend is reachable.' });
});

app.use(cors({
  origin: '*', // Allow all origins for development; restrict in production
  credentials: true
}));

const HASKBACK_API_URL = process.env.HASKBACK_API_URL || 'http://localhost:1000/api';
const HASKBACK_API_KEY = process.env.HASKBACK_API_KEY || '';
const HASKBACK_CALLBACK_URL = process.env.HASKBACK_CALLBACK_URL || 'http://localhost:1000/api/haskback_callback';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
// Daraja/M-Pesa variables removed

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// In-memory transaction tracker for Haskback STK push
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

// Haskback STK Push Initiation Endpoint
app.post('/api/haskback_push', async (req, res) => {
  let { msisdn, amount, reference } = req.body;
  if (!msisdn || !amount || !reference) {
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
    // Enhanced error logging for debugging
    console.error('Haskback STK Push Error:', {
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
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// Haskback STK Push Status Endpoint
app.post('/api/haskback_status', (req, res) => {
  const { txId } = req.body;
  if (!txId) return res.status(400).json({ success: false, message: 'txId is required.' });
  const tx = txStore.get(txId);
  if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found.' });
  res.json({ success: true, status: tx.status, tx });
});

// Haskback Callback Endpoint
app.post('/api/haskback_callback', (req, res) => {
  // Example: { transaction_id, status, ... }
  const { transaction_id, status } = req.body;
  if (transaction_id && status) {
    const tx = txStore.get(transaction_id);
    if (tx) {
      tx.status = status;
      tx.updatedAt = Date.now();
      txStore.set(transaction_id, tx);
    }
  }
  res.status(200).json({ received: true });
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
