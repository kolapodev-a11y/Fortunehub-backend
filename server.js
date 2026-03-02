const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();
const https = require('https');



// ===================================================
// 0) ENV + BASIC VALIDATION
// ===================================================
const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;

// ✅ FIX: Support multiple common env variable names for Paystack keys.
// Render dashboard may use PAYSTACK_SECRET_KEY, PAYSTACK_ACK_SECRET, or PAYSTACK_SECRET.
// The PUBLIC key must also be set so the backend can return it to the frontend,
// ensuring the frontend always uses the SAME account's public key.
const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY ||
  process.env.PAYSTACK_ACK_SECRET ||
  process.env.PAYSTACK_SECRET ||
  '';

// ✅ FIX: Backend returns PAYSTACK_PUBLIC_KEY to frontend in /api/payment/initialize
// so the frontend popup always uses the matching public key for the same account.
// ✅ PAYSTACK_PUBLIC_KEY: Must match the same account as PAYSTACK_SECRET_KEY
// ⚠️  If not set, the frontend will fall back to its hardcoded key — which may NOT match
//     the secret key account, causing "We could not start this transaction" error.
// Set PAYSTACK_PUBLIC_KEY in your Render environment variables!
const PAYSTACK_PUBLIC_KEY =
  process.env.PAYSTACK_PUBLIC_KEY ||
  process.env.PAYSTACK_ACK_PUB ||
  process.env.PAYSTACK_PUB ||
  '';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OWNER_EMAIL = process.env.OWNER_EMAIL;

// Admin credentials (you should change these in production)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'fortunehub2026';

// ---------------------------------------------------
// ⚠️  SPAM / DOMAIN WARNING:
// ---------------------------------------------------
const MAIL_FROM = 'Fortunehub <hello@fortunehub.name.ng>';


// Initialize Resend (safe even if key is missing; sending will fail with a clear message)
const resend = new Resend(RESEND_API_KEY || '');


function paystackRequest(path, method, bodyObj = null) {
  return new Promise((resolve, reject) => {
    if (!PAYSTACK_SECRET_KEY) {
      return reject(new Error('PAYSTACK_SECRET_KEY is missing'));
    }

    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const req = https.request(
      {
        hostname: 'api.paystack.co',
        path,
        method,
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch (e) {
            parsed = { raw: data };
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}


// ===================================================
// 1) CORS
// ===================================================
// ✅ FIX (ADMIN PANEL PRODUCT SAVE FAILS): allow admin.html to work even when opened
// from a different origin (e.g. file:// on mobile gives Origin: null) and when you
// deploy to new domains.
//
// - Add extra allowed origins using env var: ALLOWED_ORIGINS
//   Example (Render):
//   ALLOWED_ORIGINS=https://your-admin-domain.com,https://another-domain.com
//
// Security note: We still echo back the request Origin (not '*') because
// credentials=true cannot be used with wildcard.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://kolapodev-a11y.github.io',
  'https://fortunehub.name.ng',
  'https://www.fortunehub.name.ng',
  'https://fortunehub-frontend.vercel.app',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:5501'
];

const EXTRA_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]));

const corsOptions = {
  origin: (origin, cb) => {
    // Requests from tools like curl/postman may have no origin
    if (!origin) return cb(null, true);

    // When admin.html is opened as a local file on some phones/browsers
    if (origin === 'null') return cb(null, true);

    // Exact whitelist
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);

    // Allow common subdomains safely (optional convenience)
    try {
      const o = new URL(origin);
      const host = o.hostname.toLowerCase();
      if (
        host.endsWith('.fortunehub.name.ng') ||
        host.endsWith('.vercel.app') ||
        host.endsWith('.github.io')
      ) {
        return cb(null, true);
      }
    } catch (_) {}

    return cb(new Error(`CORS blocked origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Paystack-Signature'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.set('trust proxy', 1);

// ===================================================
// 2) PAYMENTS MODEL
// ===================================================
const paymentSchema = new mongoose.Schema({
  reference:       { type: String, required: true, unique: true },
  email:           { type: String, required: true },
  amount:          { type: Number, required: true }, // stored in NAIRA (not kobo)
  status:          { type: String, default: 'pending' },
  currency:        { type: String, default: 'NGN' },
  metadata:        { type: Object },
  paymentDate:     { type: Date, default: Date.now },
  webhookReceived: { type: Boolean, default: false },
  emailSent:       { type: Boolean, default: false },
  createdAt:       { type: Date, default: Date.now }
});

const Payment = mongoose.model('Payment', paymentSchema);

// ===================================================
// 3) WEBHOOK (MUST BE BEFORE express.json())
//    Paystack signature verification requires the RAW body bytes.
//    If express.json() runs first, signature verification will fail.
// ===================================================
app.post(
  '/api/payment/webhook/paystack',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        console.error('❌ PAYSTACK_SECRET_KEY is missing (webhook cannot be verified)');
        return res.status(500).send('Server misconfigured');
      }

      const signature = req.headers['x-paystack-signature'];
      const rawBody   = req.body; // Buffer

      const computedHash = crypto
        .createHmac('sha512', PAYSTACK_SECRET_KEY)
        .update(rawBody)
        .digest('hex');

      if (!signature || computedHash !== signature) {
        console.log('❌ Invalid Paystack webhook signature');
        return res.status(401).send('Invalid signature');
      }

      const event = JSON.parse(rawBody.toString('utf8'));
      console.log('📨 Paystack webhook received:', event.event);

      if (event.event === 'charge.success') {
        const { reference, customer, amount, currency, paid_at, metadata } = event.data;
        const email       = customer?.email;
        const amountNaira = amount / 100;

        const updated = await Payment.findOneAndUpdate(
          { reference },
          {
            reference,
            email,
            amount: amountNaira,
            currency: currency || 'NGN',
            status: 'success',
            metadata,
            paymentDate:     paid_at ? new Date(paid_at) : new Date(),
            webhookReceived: true
          },
          { upsert: true, new: true }
        );

        console.log(`✅ Webhook: Payment ${reference} confirmed (saved: ${updated._id})`);

        if (!updated.emailSent) {
          try {
            await sendPaymentEmails({
              toEmail:     email,
              reference,
              amountNaira,
              currency:    currency || 'NGN',
              paidAt:      paid_at ? new Date(paid_at) : new Date(),
              metadata:    metadata || {}
            });

            await Payment.findOneAndUpdate({ reference }, { emailSent: true });
            console.log('✅ Webhook emails sent successfully');
          } catch (e) {
            console.error('❌ Webhook email failed:', e?.message || e);
            // do not fail webhook
          }
        }
      }

      return res.status(200).send('Webhook received');
    } catch (error) {
      console.error('❌ Webhook error:', error);
      return res.status(500).send('Webhook processing failed');
    }
  }
);

// ===================================================
// 4) BODY PARSERS (AFTER WEBHOOK)
// ===================================================
// ✅ FIX (ADMIN PRODUCT UPLOADS): Increase request body size limit.
// Admin can upload base64 images (data URLs). Default Express limit is ~100kb,
// which causes product creation/update to fail (often seen as 413 or "Unexpected token <").
// 15mb is usually enough for a few compressed images.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ✅ Return JSON for body parser errors (so admin.html can show a clean toast)
app.use((err, req, res, next) => {
  // Body too large
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      success: false,
      message: 'Request payload too large. Please upload smaller/compressed images (or use image URLs).'
    });
  }

  // Invalid JSON
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      message: 'Invalid JSON payload.'
    });
  }

  return next(err);
});

// ===================================================
// 5) MONGODB CONNECTION (WITH RETRY)
// ===================================================
let connecting = false;
async function connectMongo() {
  if (connecting) return;
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI is missing');
    process.exit(1);
  }

  connecting = true;
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS:         10000,
      socketTimeoutMS:          45000,
      maxPoolSize:              10
    });

    console.log('🔗 Mongoose connected to MongoDB');
    console.log('✅ MongoDB Connected Successfully');
    console.log('📊 Database:', mongoose.connection.name);

    // ✅ FIX: Drop stale 'id_1' unique index on products collection (caused E11000 duplicate key error)
    // This index existed from an old products.json schema where 'id' was a field with unique constraint.
    // The new Product schema does NOT have an 'id' field, so MongoDB stores id=null for all docs, triggering E11000.
    try {
      const productsCollection = mongoose.connection.db.collection('products');
      const indexes = await productsCollection.indexes();
      const hasOldIdIndex = indexes.some(idx => idx.name === 'id_1');
      if (hasOldIdIndex) {
        await productsCollection.dropIndex('id_1');
        console.log('🧹 Dropped stale id_1 index from products collection');
      }
    } catch (idxErr) {
      // Non-fatal: index may not exist or already dropped
      console.log('ℹ️  id_1 index cleanup (non-fatal):', idxErr.message);
    }

  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    console.log('⏳ Retrying MongoDB connection in 5s...');
    setTimeout(() => {
      connecting = false;
      connectMongo();
    }, 5000);
    return;
  }
  connecting = false;
}

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected. Attempting to reconnect...');
  connectMongo();
});

mongoose.connection.on('error', (err) => {
  console.log('⚠️ MongoDB runtime error:', err?.message || err);
});

connectMongo();

// ===================================================
// 6) ROUTES
// ===================================================
app.get('/', (req, res) => {
  res.json({
    status:    'OK',
    message:   'FortuneHub Backend API is running',
    timestamp: new Date().toISOString(),
    endpoints: {
      verify:   '/api/payment/verify?reference=xxx',
      webhook:  '/api/payment/webhook/paystack',
      currency: 'NGN (Nigerian Naira ₦)',
      payments: '/api/payments',
      admin:    '/api/admin/login',
      health:   '/health'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status:   'healthy',
    mongodb:  mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    resend:   RESEND_API_KEY  ? 'configured' : 'missing',
    mailFrom: MAIL_FROM,
    paystack: PAYSTACK_SECRET_KEY ? 'configured' : 'missing'
  });
});

// Handles both GET + POST
app.get('/api/payment/verify',  async (req, res) => handlePaymentVerification(req, res));
app.post('/api/payment/verify', async (req, res) => handlePaymentVerification(req, res));

// ===================================================
// 6.1) INITIALIZE PAYSTACK TRANSACTION (RECOMMENDED)
//      Fixes Paystack popup "We could not start this transaction"
//      by creating a transaction on the server first.
// ===================================================
app.post('/api/payment/initialize', async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      console.error('❌ PAYSTACK_SECRET_KEY is not set in environment variables!');
      return res.status(500).json({
        success: false,
        message: 'Server misconfigured: PAYSTACK_SECRET_KEY is missing. Set it in your Render/hosting environment variables.'
      });
    }

    // ✅ FIX: Warn if public key is missing — this causes key mismatch in frontend
    if (!PAYSTACK_PUBLIC_KEY) {
      console.warn('⚠️  PAYSTACK_PUBLIC_KEY is not set! The frontend may use a mismatched public key,');
      console.warn('⚠️  causing "We could not start this transaction". Set PAYSTACK_PUBLIC_KEY in Render env vars.');
      console.warn('⚠️  It should match the same Paystack account as your PAYSTACK_SECRET_KEY.');
    }

    const email = String(req.body?.email || '').trim();
    const amountNaira = Number(req.body?.amount);
    const rawMetadata = req.body?.metadata || {};

    // ✅ FIX: Strip base64 images from cart_items before sending to Paystack.
    // Paystack rejects metadata larger than ~5KB. Admin-panel products store images
    // as base64 data URLs (data:image/...) which can be 50–300 KB each. When such
    // a product is in the cart the metadata blows up Paystack's limit, causing
    // "We could not start this transaction / Unknown error occurred".
    // products.json products use short relative paths so they were NOT affected.
    function sanitizeMetadataForPaystack(meta) {
      const out = Object.assign({}, meta);
      if (Array.isArray(out.cart_items)) {
        out.cart_items = out.cart_items.map(function(item) {
          const img = String(item.image || '');
          // Remove base64 data URLs and any URL longer than 300 chars
          const safeImg = (img.startsWith('data:') || img.length > 300) ? '' : img;
          return Object.assign({}, item, { image: safeImg });
        });
      }
      return out;
    }

    const metadata = sanitizeMetadataForPaystack(rawMetadata);

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a number greater than 0 (in Naira)' });
    }

    const amountKobo = Math.round(amountNaira * 100);

    // Initialize with Paystack — currency MUST be 'NGN' (Naira)
    // Amount is in KOBO (Naira × 100) as required by Paystack
    // metadata is already sanitized above (base64 images stripped)
    const initRes = await paystackRequest('/transaction/initialize', 'POST', {
      email,
      amount: amountKobo,   // kobo = naira * 100
      currency: 'NGN',
      metadata
    });

    const initData = initRes.data || {};

    if (!initRes.ok || !initData.status) {
      console.error('❌ Paystack initialize failed:', initData);
      return res.status(400).json({
        success: false,
        message: initData.message || 'Failed to initialize transaction',
        error: initData
      });
    }

    const reference = initData.data?.reference;
    const access_code = initData.data?.access_code;

    // Save as pending in DB (helps admin payments list show attempts)
    if (reference) {
      try {
        await Payment.findOneAndUpdate(
          { reference },
          {
            reference,
            email,
            amount: amountNaira, // store in NAIRA
            currency: 'NGN',
            status: 'pending',
            metadata,
            paymentDate: new Date()
          },
          { upsert: true, new: true }
        );
      } catch (dbErr) {
        console.log('ℹ️  Initialize: could not save pending payment (non-fatal):', dbErr.message);
      }
    }

    return res.json({
      success: true,
      message: 'Transaction initialized',
      reference,
      access_code,
      // ✅ FIX: Return public key so frontend uses the SAME account's key in PaystackPop.setup()
      // This prevents "We could not start this transaction" caused by mismatched public/secret keys.
      public_key: PAYSTACK_PUBLIC_KEY  // ✅ Always returned (empty string if not set in env)
    });
  } catch (err) {
    console.error('❌ Initialize payment error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to initialize transaction',
      error: err.message
    });
  }
});

async function handlePaymentVerification(req, res) {
  try {
    const reference = req.query.reference || req.body?.reference;

    console.log('🔍 Verifying payment:', reference);
    console.log('🌐 Request origin:',    req.headers.origin);
    console.log('📥 Request method:',    req.method);

    if (!reference) {
      return res.status(400).json({ success: false, message: 'Payment reference is required' });
    }

    // If already success — skip Paystack call but retry email if not sent
    const existingPayment = await Payment.findOne({ reference });
    if (existingPayment && existingPayment.status === 'success') {
      if (existingPayment.emailSent) {
        console.log('✅ Payment already verified and email already sent:', reference);
        return res.status(200).json({
          success:   true,
          message:   'Payment already verified',
          emailSent: true,
          data: {
            reference:   existingPayment.reference,
            amount:      existingPayment.amount,
            email:       existingPayment.email,
            status:      existingPayment.status,
            paymentDate: existingPayment.paymentDate
          }
        });
      }

      // Retry email
      let resent = false;
      try {
        await sendPaymentEmails({
          toEmail:     existingPayment.email,
          reference:   existingPayment.reference,
          amountNaira: existingPayment.amount,
          currency:    existingPayment.currency || 'NGN',
          paidAt:      existingPayment.paymentDate || new Date(),
          metadata:    existingPayment.metadata || {}
        });
        await Payment.findOneAndUpdate({ reference }, { emailSent: true });
        console.log('✅ Emails re-sent successfully');
        resent = true;
      } catch (e) {
        console.error('❌ Email re-send failed:', e?.message || e);
      }

      return res.status(200).json({
        success:   true,
        message:   resent
          ? 'Payment verified and email was sent successfully'
          : 'Payment verified but email still not sent (check backend logs / Resend settings)',
        emailSent: resent,
        data: {
          reference:   existingPayment.reference,
          amount:      existingPayment.amount,
          currency:    existingPayment.currency || 'NGN',
          email:       existingPayment.email,
          status:      existingPayment.status,
          paymentDate: existingPayment.paymentDate
        }
      });
    }

    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Server misconfigured: PAYSTACK_SECRET_KEY is missing'
      });
    }

    console.log('📡 Calling Paystack verify endpoint...');

    const paystackResponse = await paystackRequest(`/transaction/verify/${reference}`, 'GET');

    if (!paystackResponse.ok) {
      console.error('❌ Paystack API error:', paystackResponse.status, paystackResponse.data);
      return res.status(400).json({
        success: false,
        message: 'Failed to verify payment with Paystack',
        error:   `API returned ${paystackResponse.status}`
      });
    }

    const paymentData = paystackResponse.data;
    console.log('📦 Paystack response status:', paymentData.status);
    console.log('📦 Paystack payment status:',  paymentData.data?.status);

    if (!paymentData.status || paymentData.data.status !== 'success') {
      console.log('❌ Payment verification failed:', paymentData.message);
      return res.status(400).json({
        success: false,
        message: paymentData.message || 'Payment verification failed',
        error:   paymentData.message
      });
    }

    const { customer, amount, currency, metadata, paid_at } = paymentData.data;
    const customerEmail = customer?.email;
    const amountNaira   = amount / 100;

    console.log('💰 Payment details:', { email: customerEmail, amountNaira, currency });

    const payment = await Payment.findOneAndUpdate(
      { reference },
      {
        reference,
        email:       customerEmail,
        amount:      amountNaira,
        currency:    currency || 'NGN',
        status:      'success',
        metadata,
        paymentDate: paid_at ? new Date(paid_at) : new Date()
      },
      { upsert: true, new: true }
    );

    console.log('💾 Payment saved to database:', payment._id);

    // Send rich confirmation emails (customer + owner)
    let emailSent = false;
    try {
      await sendPaymentEmails({
        toEmail:     customerEmail,
        reference,
        amountNaira,
        currency:    currency || 'NGN',
        paidAt:      paid_at ? new Date(paid_at) : new Date(),
        metadata:    metadata || {}
      });

      console.log('✅ Emails sent successfully');
      emailSent = true;
      await Payment.findOneAndUpdate({ reference }, { emailSent: true });
    } catch (e) {
      console.error('❌ Email sending failed:', e);
      console.error('Email error details:', e?.message || e);
    }

    return res.status(200).json({
      success:   true,
      message:   emailSent
        ? 'Payment verified and email sent successfully'
        : 'Payment verified successfully (email not sent — check Resend configuration)',
      emailSent,
      data: {
        reference,
        amount:      amountNaira,
        currency:    currency || 'NGN',
        email:       customerEmail,
        status:      'success',
        paymentDate: paid_at || new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Payment verification error:', error);
    console.error('Error stack:', error.stack);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while verifying payment',
      error:   error.message
    });
  }
}

// ===================================================
// 7) ADMIN ROUTES - NEW
// ===================================================

// Admin login endpoint (simple authentication)
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      // In production, use JWT tokens
      return res.json({
        success: true,
        message: 'Login successful',
        token: Buffer.from(`${username}:${password}`).toString('base64')
      });
    }

    return res.status(401).json({
      success: false,
      message: 'Invalid credentials'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Middleware to verify admin authentication
function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ success: false, message: 'No authorization header' });
  }

  const token = authHeader.replace('Basic ', '');
  const decoded = Buffer.from(token, 'base64').toString('utf-8');
  const [username, password] = decoded.split(':');

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    next();
  } else {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
}

// Get all payments with pagination and filters
app.get('/api/admin/payments', verifyAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const status = req.query.status;
    const search = req.query.search;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    const query = {};

    // Filter by status
    if (status && status !== 'all') {
      query.status = status;
    }

    // Search by reference or email
    if (search) {
      query.$or = [
        { reference: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    // Filter by date range
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const total = await Payment.countDocuments(query);
    const payments = await Payment.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip((page - 1) * limit);

    // Calculate statistics
    const stats = await Payment.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          totalCount:  { $sum: 1 },
          successCount: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          failedCount:  { $sum: { $cond: [{ $eq: ['$status', 'failed']  }, 1, 0] } }
        }
      }
    ]);

    res.json({
      success: true,
      data: payments,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      },
      stats: stats[0] || { totalAmount: 0, successCount: 0, pendingCount: 0 }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get payment details by ID
app.get('/api/admin/payments/:id', verifyAdmin, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    // ✅ FIX: Enrich cart_items with product images from DB.
    // Images are intentionally stripped from metadata before saving to Paystack (to keep
    // metadata under 5KB). This restores them so the admin payment detail modal can show
    // product thumbnails in the Order Items section.
    const paymentObj = payment.toObject();
    const cartItems = paymentObj?.metadata?.cart_items;
    if (Array.isArray(cartItems) && cartItems.length) {
      const enriched = await Promise.all(cartItems.map(async (item) => {
        if (item.image) return item; // already has image, skip lookup
        let prod = null;
        try {
          const mongoose = require('mongoose');
          if (item.id) {
            // item.id may be a plain ObjectId string or 'db_<ObjectId>'
            const rawId = String(item.id).replace(/^db_/, '');
            if (mongoose.Types.ObjectId.isValid(rawId)) {
              prod = await Product.findById(rawId).select('image images').lean();
            }
          }
          if (!prod && item.name) {
            prod = await Product.findOne({ name: item.name }).select('image images').lean();
          }
        } catch (e) {
          console.warn('⚠️  Could not enrich cart item image for admin detail view:', e.message);
        }
        if (prod) {
          const img = (Array.isArray(prod.images) && prod.images.find(Boolean)) || prod.image || '';
          return Object.assign({}, item, { image: img });
        }
        return item;
      }));
      if (paymentObj.metadata) paymentObj.metadata.cart_items = enriched;
    }

    res.json({ success: true, data: paymentObj });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// Admin: Clear all transactions (DELETE endpoint)
// ⚠️ IMPORTANT: This route MUST be defined BEFORE /api/admin/payments/:id
// Express matches routes in order — if :id comes first, "clear-all" is treated as an ID
app.delete('/api/admin/payments/clear-all', verifyAdmin, async (req, res) => {
  try {
    const result = await Payment.deleteMany({});
    console.log(`✅ Cleared ${result.deletedCount} transaction(s) from database`);
    res.json({ 
      success: true, 
      message: `Successfully cleared ${result.deletedCount} transaction(s)`,
      deletedCount: result.deletedCount 
    });
  } catch (error) {
    console.error('❌ Error clearing transactions:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin: Delete a single transaction by ID
app.delete('/api/admin/payments/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const payment = await Payment.findByIdAndDelete(id);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    console.log(`✅ Deleted transaction: ${id}`);
    res.json({ success: true, message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error('❌ Error deleting transaction:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin: list last 50 payments (kept for backward compatibility)
app.get('/api/payments', async (req, res) => {
  try {
    const payments = await Payment.find().sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, count: payments.length, data: payments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===================================================

// ===================================================
// PRODUCT MANAGEMENT — INSERT AFTER SECTION 7 (Admin Routes)
// in server.js — PASTE BEFORE the "8) UTILITY" section
// ===================================================

// ===================================================
// 7b) PRODUCT MODEL
// ===================================================
const productSchema = new mongoose.Schema({
  name:            { type: String, required: true },
  price:           { type: Number, required: true },  // stored in Naira
  category:        { type: String, required: true },
  description:     { type: String, default: '' },
  image:           { type: String, default: '' },     // primary image (base64 or URL)
  images:          [{ type: String }],                // array of up to 4 images
  tag:             { type: String, default: 'none' }, // 'new' | 'sale' | 'none'
  outOfStock:      { type: Boolean, default: false },
  sold:            { type: Boolean, default: false },
  statusIndicator: { type: String, default: 'available' },
  createdAt:       { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);

// ===================================================
// 7c) PRODUCT ROUTES
// ===================================================

// GET all products (PUBLIC - used by frontend)
app.get('/api/products', async (req, res) => {
  try {
    const dbProducts = await Product.find().sort({ createdAt: -1 });

    // Map to same shape as products.json
    const mapped = dbProducts.map((p, i) => ({
      id:              `db_${p._id}`,
      _id:             p._id,
      name:            p.name,
      price:           p.price,
      category:        p.category,
      description:     p.description,
      image:           p.image,
      images:          p.images && p.images.length ? p.images : [p.image, p.image, p.image],
      tag:             p.tag,
      outOfStock:      p.outOfStock,
      sold:            p.sold,
      statusIndicator: p.statusIndicator
    }));

    res.json({ success: true, count: mapped.length, data: mapped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET single product by mongo _id (ADMIN)
app.get('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, data: product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST create product (ADMIN) — images sent as base64 strings in JSON
app.post('/api/products', verifyAdmin, async (req, res) => {
  try {
    const { name, price, category, description, image, images, tag, outOfStock, sold, statusIndicator } = req.body;

    if (!name || !price || !category) {
      return res.status(400).json({ success: false, message: 'name, price, and category are required' });
    }

    const product = new Product({
      name,
      price:           Number(price),
      category:        category.toLowerCase(),
      description:     description || '',
      image:           image || '',
      images:          Array.isArray(images) ? images : (image ? [image] : []),
      tag:             tag || 'none',
      outOfStock:      Boolean(outOfStock),
      sold:            Boolean(sold),
      statusIndicator: statusIndicator || 'available'
    });

    await product.save();
    console.log(`✅ New product created: ${product.name} (${product._id})`);
    res.status(201).json({ success: true, message: 'Product created successfully', data: product });
  } catch (err) {
    console.error('❌ Product create error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT update product (ADMIN)
app.put('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const { name, price, category, description, image, images, tag, outOfStock, sold, statusIndicator } = req.body;

    const updateData = {};
    if (name            !== undefined) updateData.name            = name;
    if (price           !== undefined) updateData.price           = Number(price);
    if (category        !== undefined) updateData.category        = category.toLowerCase();
    if (description     !== undefined) updateData.description     = description;
    if (image           !== undefined) updateData.image           = image;
    if (images          !== undefined) updateData.images          = Array.isArray(images) ? images : [image];
    if (tag             !== undefined) updateData.tag             = tag;
    if (outOfStock      !== undefined) updateData.outOfStock      = Boolean(outOfStock);
    if (sold            !== undefined) updateData.sold            = Boolean(sold);
    if (statusIndicator !== undefined) updateData.statusIndicator = statusIndicator;

    const product = await Product.findByIdAndUpdate(req.params.id, updateData, { new: true });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    console.log(`✅ Product updated: ${product.name} (${product._id})`);
    res.json({ success: true, message: 'Product updated successfully', data: product });
  } catch (err) {
    console.error('❌ Product update error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE product (ADMIN)
app.delete('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    console.log(`✅ Product deleted: ${product.name} (${product._id})`);
    res.json({ success: true, message: `Product "${product.name}" deleted successfully` });
  } catch (err) {
    console.error('❌ Product delete error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8) UTILITY: Format currency (Naira)
// ===================================================
function formatNaira(amount) {
  return '₦' + Number(amount || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
}

// ===================================================
// 9) UTILITY: Format date in WAT (UTC+1, Africa/Lagos)
// ===================================================
function formatDateWAT(date) {
  return new Date(date).toLocaleString('en-NG', {
    timeZone:     'Africa/Lagos',
    day:          '2-digit',
    month:        '2-digit',
    year:         'numeric',
    hour:         '2-digit',
    minute:       '2-digit',
    second:       '2-digit',
    hour12:       false
  });
}

// ===================================================
// 10) UTILITY: Convert relative image URLs to absolute
// ===================================================
function resolveImageUrl(imagePath) {
  if (!imagePath) return '';

  // Already absolute URL or a data/blob URL
  if (
    imagePath.startsWith('http://') ||
    imagePath.startsWith('https://') ||
    imagePath.startsWith('data:') ||
    imagePath.startsWith('blob:')
  ) {
    return imagePath;
  }

  // Email clients require PUBLICLY ACCESSIBLE https image URLs.
  // If you store images as relative paths (e.g. "/images/p1.jpg"), we convert them
  // to absolute URLs using PUBLIC_BASE_URL.
  // Example: PUBLIC_BASE_URL=https://fortunehub.name.ng
  const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://fortunehub.name.ng';
  const baseUrl = PUBLIC_BASE.endsWith('/') ? PUBLIC_BASE : PUBLIC_BASE + '/';

  // Remove leading slash so URL(base, path) works consistently
  const cleanPath = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;

  // Use URL() to safely build/encode the final URL
  try {
    return new URL(cleanPath, baseUrl).toString();
  } catch (_) {
    return baseUrl + cleanPath;
  }
}

// ===================================================
// 11) EMAIL SENDER — SEND BOTH CUSTOMER & OWNER EMAILS
// ===================================================
async function sendPaymentEmails({ toEmail, reference, amountNaira, currency, paidAt, metadata }) {
  if (!toEmail) throw new Error('Missing customer email');
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is missing (cannot send email)');

  // --- Extract metadata fields (with safe fallbacks) ---
  const customerName   = metadata?.customer_name   || metadata?.custom_fields?.[0]?.value || 'Customer';
  const customerPhone  = metadata?.customer_phone  || '';
  const rawCartItems   = Array.isArray(metadata?.cart_items) ? metadata.cart_items : [];
  const shippingFee    = Number(metadata?.shipping_fee  || 0);   // naira

  // ✅ FIX: Enrich cart items with product images from DB.
  // During checkout, base64 images are intentionally stripped from cart metadata
  // to avoid Paystack's ~5KB metadata limit. Here we restore them from MongoDB
  // so the order confirmation email can show product images.
  const cartItems = await Promise.all(rawCartItems.map(async (item) => {
    if (!item.image && item.id) {
      try {
        // ✅ FIX: Strip the "db_" prefix that the frontend attaches to MongoDB _ids.
        // The API returns id as "db_<mongoId>" (e.g. "db_507f1f77bcf86cd799439011").
        // The raw mongoId (24-char hex) is what Product.findById() expects.
        const rawId  = String(item.id);
        const prodId = rawId.startsWith('db_') ? rawId.slice(3) : rawId;
        let prod = null;
        if (prodId.match(/^[a-f0-9]{24}$/i)) {
          prod = await Product.findById(prodId).select('image images').lean();
        }
        if (!prod) {
          // fallback: search by the virtual "id" field (for products.json items)
          prod = await Product.findOne({ _id: prodId }).select('image images').lean()
                 || await Product.findOne({ name: item.name }).select('image images').lean();
        }
        if (prod) {
          const img = (Array.isArray(prod.images) && prod.images[0]) || prod.image || '';
          return { ...item, image: img };
        }
      } catch(e) {
        console.warn('⚠️ Could not enrich cart item image for id', item.id, ':', e.message);
      }
    }
    return item;
  }));
  const shippingState  = metadata?.shipping_state  || '';

  // --- Subtotal from cart items (prices stored in NAIRA in the frontend cart) ---
  // NOTE: Frontend stores prices in Naira. Do NOT divide by 100.
  const subtotalNaira = cartItems.reduce((sum, item) => sum + Number(item.price || 0) * (Number(item.quantity) || 1), 0);

  // --- If shipping_fee not in metadata, derive from total - subtotal ---
  const derivedShippingFee = shippingFee > 0
    ? shippingFee
    : (cartItems.length > 0 ? Math.max(0, amountNaira - subtotalNaira) : 0);

  // --- Final subtotal to show: if cart available use it, else total - shipping ---
  const displaySubtotal = cartItems.length > 0 ? subtotalNaira : (amountNaira - derivedShippingFee);

  // --- Date formatted in WAT (Nigerian time, UTC+1) ---
  const dateFormatted = formatDateWAT(paidAt || new Date());
  const yearNow       = new Date().getFullYear();

  // --- Build items table rows with product images ---
  // IMPORTANT:
  // - Most email clients block `data:image/...` URLs.
  // - If product images are stored as base64 (data URLs), we embed them as inline
  //   CID attachments via Resend, so they can render inside the email.
  // Docs: https://resend.com/docs/dashboard/emails/embed-inline-images
  const inlineAttachments = [];

  function dataUrlToCidAttachment(dataUrl, contentId, fallbackExt = 'png') {
    const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    const mime = m[1] || 'image/png';
    const base64 = m[2] || '';

    // Safety: avoid huge emails
    // (Resend max email size is 40MB including base64 attachments)
    const approxBytes = Math.floor((base64.length * 3) / 4);
    if (approxBytes > 2_500_000) return null; // ~2.5MB per image cap

    const ext = (mime.split('/')[1] || fallbackExt).replace(/[^a-z0-9]/gi, '') || fallbackExt;

    return {
      filename: `product-${contentId}.${ext}`,
      content: base64,
      content_id: contentId  // ✅ FIX: Resend API requires snake_case 'content_id' for inline CID images.
                              // Using camelCase 'contentId' caused the image to be sent as a regular file
                              // attachment instead of an inline image, making it appear at the bottom
                              // of the email and NOT render inside the product table.
    };
  }

  const itemsHTML = cartItems.length > 0
    ? cartItems.map((item, idx) => {
        const itemPrice = Number(item.price || 0);  // already in Naira
        const qty       = Number(item.quantity || 1);
        const lineTotal = itemPrice * qty;

        const rawImagePath = String(item.image || '');
        const isDataUrl = rawImagePath.startsWith('data:');

        let imgHtml = '';

        if (isDataUrl) {
          const contentId = `prodimg-${idx + 1}`;
          const attachment = dataUrlToCidAttachment(rawImagePath, contentId);
          if (attachment) {
            inlineAttachments.push(attachment);
            imgHtml = `<img src="cid:${contentId}" alt="${item.name || 'Product'}"
                    style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid #e8e8e8;" />`;
          }
        }

        // If not data-url (or attachment was too big), use normal public URL.
        if (!imgHtml) {
          const absoluteImageUrl = resolveImageUrl(rawImagePath);
          imgHtml = absoluteImageUrl
            ? `<img src="${absoluteImageUrl}" alt="${item.name || 'Product'}"
                    style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid #e8e8e8;" />`
            : '<div style="width:60px;height:60px;background:#f5f0ff;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#8b5cf6;border:1px solid #e8e8e8;">🛍️</div>';
        }

        return `
          <tr>
            <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle;">${imgHtml}</td>
            <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle;font-size:14px;color:#333;">
              ${item.name || 'Item'}
            </td>
            <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle;text-align:center;font-size:14px;color:#333;">
              ${qty}
            </td>
            <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle;text-align:right;font-size:14px;font-weight:700;color:#333;">
              ${formatNaira(lineTotal)}
            </td>
          </tr>
        `;
      }).join('')
    : `
        <tr>
          <td colspan="4" style="padding:14px 8px;text-align:center;color:#888;font-size:13px;">
            Order items not available
          </td>
        </tr>
      `;

  // --- Shipping row label ---
  const shippingLabel = shippingState
    ? `Shipping Fee (${shippingState})`
    : 'Shipping Fee';

  // ========================================
  // CUSTOMER EMAIL (Existing template)
  // ========================================
  const customerEmailHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Order Confirmed – FortuneHub</title>
  <!--[if mso]>
  <style>table{border-collapse:collapse;}td,th{mso-line-height-rule:exactly;}</style>
  <![endif]-->
  <style>
    /* ── Reset ── */
    * { box-sizing: border-box; }
    body, table, td, p, a, li, blockquote {
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
    body  { margin:0; padding:0; background:#f0f2f5; font-family: 'Segoe UI', Arial, sans-serif; }
    table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img   { border:0; outline:none; text-decoration:none; display:block; max-width:100%; }
    a     { color: #4f46e5; text-decoration: none; }

    /* ── Wrapper ── */
    .email-wrapper  { width:100%; max-width:620px; margin:0 auto; }
    .email-body     { background:#ffffff; border-radius:12px; overflow:hidden;
                      box-shadow: 0 4px 24px rgba(0,0,0,0.10); }

    /* ── Header ── */
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 36px 24px 28px;
      text-align: center;
    }
    .header .checkmark { font-size: 40px; line-height:1; margin-bottom:10px; }
    .header h1 {
      margin: 0; padding: 0;
      color: #ffffff;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
    }
    .header p  {
      margin: 8px 0 0; padding: 0;
      color: rgba(255,255,255,0.88);
      font-size: 14px;
    }

    /* ── Content ── */
    .content { padding: 28px 28px 8px; }
    .greeting { font-size:16px; color:#1f2937; margin:0 0 6px; font-weight:600; }
    .intro    { font-size:14px; color:#6b7280; margin:0 0 22px; line-height:1.6; }

    /* ── Reference Box ── */
    .ref-box {
      background: linear-gradient(135deg, #f8faff 0%, #fef3ff 100%);
      border: 1px solid #e0e7ff;
      border-left: 4px solid #667eea;
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 22px;
    }
    .ref-box table { width:100%; }
    .ref-box td   { font-size:13px; padding:3px 0; color:#374151; }
    .ref-box .lbl { font-weight:700; color:#4b5563; width:130px; }

    /* ── Section heading ── */
    .section-title {
      font-size: 15px;
      font-weight: 700;
      color: #1f2937;
      margin: 0 0 10px;
      padding-bottom: 6px;
      border-bottom: 2px solid #f0f0f0;
      display:flex;
      align-items:center;
      gap:6px;
    }

    /* ── Items Table ── */
    .items-table { width:100%; border-collapse:collapse; margin-bottom:0; }
    .items-table thead tr { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    .items-table thead th {
      padding: 10px 8px;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      text-align: left;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .items-table thead th:nth-child(3) { text-align:center; }
    .items-table thead th:nth-child(4) { text-align:right;  }
    .items-table tbody tr:nth-child(even) td { background:#fafafa; }

    /* ── Totals ── */
    .totals-box {
      background: linear-gradient(135deg, #f8faff 0%, #fef3ff 100%);
      border: 1px solid #e9d5ff;
      border-radius: 8px;
      padding: 14px 16px;
      margin: 14px 0 22px;
    }
    .totals-box table { width:100%; }
    .totals-box td    { font-size:14px; padding:4px 0; color:#374151; }
    .totals-box .lbl  { font-weight:500; }
    .totals-box .val  { text-align:right; font-weight:600; }
    .total-row td     { font-size:17px !important; font-weight:800 !important;
                        color:#667eea !important; padding-top:10px !important;
                        border-top:2px solid #e9d5ff; }

    /* ── What's Next ── */
    .next-box {
      background: linear-gradient(135deg, #fef3ff 0%, #faf5ff 100%);
      border: 1px solid #e9d5ff;
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 24px;
    }
    .next-box p {
      margin: 0; font-size: 14px; color: #6b21a8; line-height: 1.6;
    }
    .next-box strong { color: #7c3aed; }

    /* ── Footer ── */
    .footer {
      background: linear-gradient(135deg, #f8faff 0%, #faf5ff 100%);
      border-top: 1px solid #e9d5ff;
      padding: 18px 24px;
      text-align: center;
    }
    .footer p  { margin:3px 0; font-size:12px; color:#9ca3af; }
    .footer .brand { font-size:13px; font-weight:700; color:#6b7280; }

    /* ── Responsive ── */
    @media only screen and (max-width: 480px) {
      .content     { padding: 20px 16px 8px !important; }
      .header      { padding: 28px 16px 22px !important; }
      .header h1   { font-size: 22px !important; }
      .items-table thead th,
      .items-table tbody td { font-size: 12px !important; padding: 8px 5px !important; }
      .items-table thead th:first-child { display:none; }
      .items-table tbody td:first-child { display:none; }
    }
  </style>
</head>
<body>
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f0f2f5; padding: 24px 12px;">
    <tr>
      <td align="center">
        <table class="email-wrapper" cellpadding="0" cellspacing="0" border="0"
               style="width:100%;max-width:620px;">
          <tr>
            <td>
              <div class="email-body">

                <!-- ══════════ HEADER ══════════ -->
                <table width="100%" cellpadding="0" cellspacing="0" border="0"
                       style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);background-color:#667eea;">
                  <tr>
                    <td align="center" style="padding:36px 24px 28px;text-align:center;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);background-color:#667eea;">
                      <!--[if mso]><table><tr><td style="background:#667eea;padding:36px 24px 28px;text-align:center;"><![endif]-->
                      <div style="font-size:40px;line-height:1;margin-bottom:10px;">✅</div>
                      <h1 style="margin:0;padding:0;color:#ffffff;font-size:26px;font-weight:800;letter-spacing:-0.5px;font-family:'Segoe UI',Arial,sans-serif;">Order Confirmed!</h1>
                      <p style="margin:8px 0 0;padding:0;color:rgba(255,255,255,0.88);font-size:14px;font-family:'Segoe UI',Arial,sans-serif;">Thank you for shopping with <strong style="color:#ffffff;">FortuneHub</strong></p>
                      <!--[if mso]></td></tr></table><![endif]-->
                    </td>
                  </tr>
                </table>

                <!-- ══════════ BODY ══════════ -->
                <div style="padding:28px 28px 8px;">
                  <p style="font-size:16px;color:#1f2937;margin:0 0 6px;font-weight:600;font-family:'Segoe UI',Arial,sans-serif;">Hi ${customerName},</p>
                  <p style="font-size:14px;color:#6b7280;margin:0 0 22px;line-height:1.6;font-family:'Segoe UI',Arial,sans-serif;">
                    Thank you for your purchase! Your payment was successful
                    and your order is being processed.
                    ${customerPhone ? `<br>We'll keep you updated on <strong>${customerPhone}</strong>.` : ''}
                  </p>

                  <!-- Reference Block -->
                  <div style="background:#f8faff;background:linear-gradient(135deg,#f8faff 0%,#fef3ff 100%);border:1px solid #e0e7ff;border-left:4px solid #667eea;border-radius:8px;padding:14px 16px;margin-bottom:22px;">
                    <table>
                      <tr>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-weight:700;color:#4b5563;width:130px;font-family:'Segoe UI',Arial,sans-serif;">Order Reference:</td>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-family:'Segoe UI',Arial,sans-serif;"><strong>${reference}</strong></td>
                      </tr>
                      <tr>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-weight:700;color:#4b5563;width:130px;font-family:'Segoe UI',Arial,sans-serif;">Date &amp; Time:</td>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-family:'Segoe UI',Arial,sans-serif;">${dateFormatted}</td>
                      </tr>
                      <tr>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-weight:700;color:#4b5563;width:130px;font-family:'Segoe UI',Arial,sans-serif;">Currency:</td>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-family:'Segoe UI',Arial,sans-serif;">${currency || 'NGN'}</td>
                      </tr>
                      <tr>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-weight:700;color:#4b5563;width:130px;font-family:'Segoe UI',Arial,sans-serif;">Status:</td>
                        <td>
                          <span style="display:inline-block;background-color:#d1fae5;color:#065f46;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700;font-family:'Segoe UI',Arial,sans-serif;">✔ CONFIRMED</span>
                        </td>
                      </tr>
                      ${shippingState ? `
                      <tr>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-weight:700;color:#4b5563;width:130px;font-family:'Segoe UI',Arial,sans-serif;">Delivery State:</td>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-family:'Segoe UI',Arial,sans-serif;">${shippingState}</td>
                      </tr>` : ''}
                    </table>
                  </div>

                  <!-- ── Items ── -->
                  <p style="font-size:15px;font-weight:700;color:#1f2937;margin:0 0 10px;padding-bottom:6px;border-bottom:2px solid #f0f0f0;font-family:'Segoe UI',Arial,sans-serif;">🛍️ Your Items</p>

                  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin-bottom:0;">
                    <thead>
                      <tr style="background-color:#667eea;">
                        <th style="width:70px;padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:left;text-transform:uppercase;letter-spacing:0.5px;background-color:#667eea;font-family:'Segoe UI',Arial,sans-serif;">Image</th>
                        <th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:left;text-transform:uppercase;letter-spacing:0.5px;background-color:#667eea;font-family:'Segoe UI',Arial,sans-serif;">Product</th>
                        <th style="width:50px;padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:center;text-transform:uppercase;letter-spacing:0.5px;background-color:#667eea;font-family:'Segoe UI',Arial,sans-serif;">Qty</th>
                        <th style="width:110px;padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:0.5px;background-color:#667eea;font-family:'Segoe UI',Arial,sans-serif;">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${itemsHTML}
                    </tbody>
                  </table>

                  <!-- ── Totals ── -->
                  <div style="background-color:#f8faff;border:1px solid #e9d5ff;border-radius:8px;padding:14px 16px;margin:14px 0 22px;">
                    <table>
                      ${cartItems.length > 0 ? `
                      <tr>
                        <td style="font-size:14px;padding:4px 0;color:#374151;font-weight:500;font-family:'Segoe UI',Arial,sans-serif;">Subtotal:</td>
                        <td style="font-size:14px;padding:4px 0;color:#374151;font-weight:600;text-align:right;font-family:'Segoe UI',Arial,sans-serif;">${formatNaira(displaySubtotal)}</td>
                      </tr>
                      <tr>
                        <td style="font-size:14px;padding:4px 0;color:#374151;font-weight:500;font-family:'Segoe UI',Arial,sans-serif;">${shippingLabel}:</td>
                        <td style="font-size:14px;padding:4px 0;color:#374151;font-weight:600;text-align:right;font-family:'Segoe UI',Arial,sans-serif;">${formatNaira(derivedShippingFee)}</td>
                      </tr>` : ''}
                      <tr>
                        <td style="font-size:17px;padding:10px 0 4px;color:#667eea;font-weight:800;border-top:2px solid #e9d5ff;font-family:'Segoe UI',Arial,sans-serif;">TOTAL PAID:</td>
                        <td style="font-size:17px;padding:10px 0 4px;color:#667eea;font-weight:800;text-align:right;border-top:2px solid #e9d5ff;font-family:'Segoe UI',Arial,sans-serif;">${formatNaira(amountNaira)}</td>
                      </tr>
                    </table>
                  </div>

                  <!-- ── What's Next ── -->
                  <div style="background-color:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:14px 16px;margin-bottom:24px;">
                    <p>
                      <strong style="color:#7c3aed;font-family:'Segoe UI',Arial,sans-serif;">📦 What's Next?</strong><br>
                      <span style="font-size:14px;color:#6b21a8;line-height:1.6;font-family:'Segoe UI',Arial,sans-serif;">Your order will be processed and shipped soon. We'll send you a tracking number once it's dispatched.</span>
                    </p>
                  </div>

                </div><!-- /.content-end -->

                <!-- ══════════ FOOTER ══════════ -->
                <div style="background-color:#f8faff;border-top:1px solid #e9d5ff;padding:18px 24px;text-align:center;">
                  <p style="margin:3px 0;font-size:12px;color:#9ca3af;font-family:'Segoe UI',Arial,sans-serif;">Need help? Reply to this email${OWNER_EMAIL ? ` or contact us at <a href="mailto:${OWNER_EMAIL}">${OWNER_EMAIL}</a>` : ''}.</p>
                  <p style="margin:3px 0;font-size:12px;color:#9ca3af;font-family:'Segoe UI',Arial,sans-serif;">Order Reference: <strong>${reference}</strong></p>
                  <p style="margin:3px 0;font-size:13px;font-weight:700;color:#6b7280;font-family:'Segoe UI',Arial,sans-serif;">© ${yearNow} FortuneHub. All rights reserved.</p>
                </div>

              </div><!-- /.email-body-end -->
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  // ========================================
  // OWNER EMAIL (New template with action buttons)
  // ========================================
  const whatsappNumber = customerPhone.replace(/\D/g, ''); // Remove non-digits
  const whatsappLink = `https://wa.me/234${whatsappNumber.substring(1)}?text=Hi%20${encodeURIComponent(customerName)},%20regarding%20your%20FortuneHub%20order%20${reference}`;
  const emailLink = `mailto:${toEmail}?subject=Your%20FortuneHub%20Order%20${reference}`;

  const ownerEmailHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Order Received – FortuneHub</title>
  <style>
    * { box-sizing: border-box; }
    body, table, td, p, a, li, blockquote {
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
    body  { margin:0; padding:0; background:#f0f2f5; font-family: 'Segoe UI', Arial, sans-serif; }
    table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img   { border:0; outline:none; text-decoration:none; display:block; max-width:100%; }
    a     { color: #4f46e5; text-decoration: none; }

    .email-wrapper  { width:100%; max-width:620px; margin:0 auto; }
    .email-body     { background:#ffffff; border-radius:12px; overflow:hidden;
                      box-shadow: 0 4px 24px rgba(0,0,0,0.10); }

    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 36px 24px 28px;
      text-align: center;
    }
    .header .icon { font-size: 40px; line-height:1; margin-bottom:10px; }
    .header h1 {
      margin: 0; padding: 0;
      color: #ffffff;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
    }
    .header p  {
      margin: 8px 0 0; padding: 0;
      color: rgba(255,255,255,0.88);
      font-size: 14px;
    }

    .content { padding: 28px 28px 8px; }
    .greeting { font-size:16px; color:#1f2937; margin:0 0 6px; font-weight:600; }
    .intro    { font-size:14px; color:#6b7280; margin:0 0 22px; line-height:1.6; }

    .info-box {
      background: linear-gradient(135deg, #f8faff 0%, #fef3ff 100%);
      border: 1px solid #e0e7ff;
      border-left: 4px solid #667eea;
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 22px;
    }
    .info-box table { width:100%; }
    .info-box td   { font-size:13px; padding:3px 0; color:#374151; }
    .info-box .lbl { font-weight:700; color:#4b5563; width:130px; }

    .section-title {
      font-size: 15px;
      font-weight: 700;
      color: #1f2937;
      margin: 22px 0 10px;
      padding-bottom: 6px;
      border-bottom: 2px solid #f0f0f0;
    }

    .items-table { width:100%; border-collapse:collapse; margin-bottom:0; }
    .items-table thead tr { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    .items-table thead th {
      padding: 10px 8px;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      text-align: left;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .items-table thead th:nth-child(3) { text-align:center; }
    .items-table thead th:nth-child(4) { text-align:right;  }
    .items-table tbody tr:nth-child(even) td { background:#fafafa; }

    .totals-box {
      background: linear-gradient(135deg, #f8faff 0%, #fef3ff 100%);
      border: 1px solid #e9d5ff;
      border-radius: 8px;
      padding: 14px 16px;
      margin: 14px 0 22px;
    }
    .totals-box table { width:100%; }
    .totals-box td    { font-size:14px; padding:4px 0; color:#374151; }
    .totals-box .lbl  { font-weight:500; }
    .totals-box .val  { text-align:right; font-weight:600; }
    .total-row td     { font-size:17px !important; font-weight:800 !important;
                        color:#667eea !important; padding-top:10px !important;
                        border-top:2px solid #e9d5ff; }

    .action-box {
      background: linear-gradient(135deg, #fff5f5 0%, #fef3f3 100%);
      border: 2px solid #fca5a5;
      border-radius: 8px;
      padding: 20px;
      margin: 22px 0;
      text-align: center;
    }
    .action-box h3 {
      margin: 0 0 12px;
      font-size: 16px;
      color: #991b1b;
    }
    .action-box p {
      margin: 0 0 16px;
      font-size: 13px;
      color: #7f1d1d;
      line-height: 1.5;
    }
    .action-buttons {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.3s;
    }
    .btn-whatsapp {
      background: #25D366;
      color: #ffffff !important;
    }
    .btn-whatsapp:hover {
      background: #128C7E;
    }
    .btn-email {
      background: #667eea;
      color: #ffffff !important;
    }
    .btn-email:hover {
      background: #5568d3;
    }

    .footer {
      background: linear-gradient(135deg, #f8faff 0%, #faf5ff 100%);
      border-top: 1px solid #e9d5ff;
      padding: 18px 24px;
      text-align: center;
    }
    .footer p  { margin:3px 0; font-size:12px; color:#9ca3af; }
    .footer .brand { font-size:13px; font-weight:700; color:#6b7280; }

    @media only screen and (max-width: 480px) {
      .content     { padding: 20px 16px 8px !important; }
      .header      { padding: 28px 16px 22px !important; }
      .header h1   { font-size: 22px !important; }
      .items-table thead th,
      .items-table tbody td { font-size: 12px !important; padding: 8px 5px !important; }
      .items-table thead th:first-child { display:none; }
      .items-table tbody td:first-child { display:none; }
      .action-buttons {
        flex-direction: column;
      }
      .btn {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f0f2f5; padding: 24px 12px;">
    <tr>
      <td align="center">
        <table class="email-wrapper" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              <div class="email-body">

                <!-- HEADER -->
                <div class="header">
                  <div class="icon">🔔</div>
                  <h1>New Order Received!</h1>
                  <p>You have a new customer order to process</p>
                </div>

                <!-- BODY -->
                <div style="padding:28px 28px 8px;">
                  <p class="greeting">Hello Admin,</p>
                  <p style="font-size:14px;color:#6b7280;margin:0 0 22px;line-height:1.6;font-family:'Segoe UI',Arial,sans-serif;">
                    A new order has been placed on FortuneHub. Please review the details below and contact the customer to arrange delivery.
                  </p>

                  <!-- Customer Information -->
                  <div class="section-title">👤 Customer Information</div>
                  <div class="info-box">
                    <table>
                      <tr>
                        <td class="lbl">Name:</td>
                        <td><strong>${customerName}</strong></td>
                      </tr>
                      <tr>
                        <td class="lbl">Email:</td>
                        <td><a href="mailto:${toEmail}">${toEmail}</a></td>
                      </tr>
                      <tr>
                        <td class="lbl">Phone:</td>
                        <td><strong>${customerPhone}</strong></td>
                      </tr>
                      ${shippingState ? `
                      <tr>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-weight:700;color:#4b5563;width:130px;font-family:'Segoe UI',Arial,sans-serif;">Delivery State:</td>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-family:'Segoe UI',Arial,sans-serif;">${shippingState}</td>
                      </tr>` : ''}
                    </table>
                  </div>

                  <!-- Order Details -->
                  <div class="section-title">📋 Order Details</div>
                  <div class="info-box">
                    <table>
                      <tr>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-weight:700;color:#4b5563;width:130px;font-family:'Segoe UI',Arial,sans-serif;">Order Reference:</td>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-family:'Segoe UI',Arial,sans-serif;"><strong>${reference}</strong></td>
                      </tr>
                      <tr>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-weight:700;color:#4b5563;width:130px;font-family:'Segoe UI',Arial,sans-serif;">Date &amp; Time:</td>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-family:'Segoe UI',Arial,sans-serif;">${dateFormatted}</td>
                      </tr>
                      <tr>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-weight:700;color:#4b5563;width:130px;font-family:'Segoe UI',Arial,sans-serif;">Currency:</td>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-family:'Segoe UI',Arial,sans-serif;">${currency || 'NGN'}</td>
                      </tr>
                      <tr>
                        <td style="font-size:13px;padding:3px 0;color:#374151;font-weight:700;color:#4b5563;width:130px;font-family:'Segoe UI',Arial,sans-serif;">Status:</td>
                        <td>
                          <span style="display:inline-block;background:#d1fae5;color:#065f46;
                                       padding:2px 10px;border-radius:20px;font-size:12px;
                                       font-weight:700;">
                            ✔ PAID
                          </span>
                        </td>
                      </tr>
                    </table>
                  </div>

                  <!-- Items Ordered -->
                  <div class="section-title">🛍️ Items Ordered</div>
                  <table class="items-table">
                    <thead>
                      <tr style="background-color:#667eea;">
                        <th style="width:70px;padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:left;text-transform:uppercase;letter-spacing:0.5px;background-color:#667eea;font-family:'Segoe UI',Arial,sans-serif;">Image</th>
                        <th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:left;text-transform:uppercase;letter-spacing:0.5px;background-color:#667eea;font-family:'Segoe UI',Arial,sans-serif;">Product</th>
                        <th style="width:50px;padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:center;text-transform:uppercase;letter-spacing:0.5px;background-color:#667eea;font-family:'Segoe UI',Arial,sans-serif;">Qty</th>
                        <th style="width:110px;padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:0.5px;background-color:#667eea;font-family:'Segoe UI',Arial,sans-serif;">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${itemsHTML}
                    </tbody>
                  </table>

                  <!-- Order Totals -->
                  <div style="background-color:#f8faff;border:1px solid #e9d5ff;border-radius:8px;padding:14px 16px;margin:14px 0 22px;">
                    <table>
                      ${cartItems.length > 0 ? `
                      <tr>
                        <td style="font-size:14px;padding:4px 0;color:#374151;font-weight:500;font-family:'Segoe UI',Arial,sans-serif;">Subtotal:</td>
                        <td style="font-size:14px;padding:4px 0;color:#374151;font-weight:600;text-align:right;font-family:'Segoe UI',Arial,sans-serif;">${formatNaira(displaySubtotal)}</td>
                      </tr>
                      <tr>
                        <td style="font-size:14px;padding:4px 0;color:#374151;font-weight:500;font-family:'Segoe UI',Arial,sans-serif;">${shippingLabel}:</td>
                        <td style="font-size:14px;padding:4px 0;color:#374151;font-weight:600;text-align:right;font-family:'Segoe UI',Arial,sans-serif;">${formatNaira(derivedShippingFee)}</td>
                      </tr>` : ''}
                      <tr>
                        <td style="font-size:17px;padding:10px 0 4px;color:#667eea;font-weight:800;border-top:2px solid #e9d5ff;font-family:'Segoe UI',Arial,sans-serif;">TOTAL PAID:</td>
                        <td style="font-size:17px;padding:10px 0 4px;color:#667eea;font-weight:800;text-align:right;border-top:2px solid #e9d5ff;font-family:'Segoe UI',Arial,sans-serif;">${formatNaira(amountNaira)}</td>
                      </tr>
                    </table>
                  </div>

                  <!-- Action Required -->
                  <div class="action-box">
                    <h3>⚡ Action Required</h3>
                    <p>
                      Contact <strong>${customerName}</strong> to arrange for delivery of the order.
                      Click the buttons below to reach out via WhatsApp or Email.
                    </p>
                    <div class="action-buttons">
                      <a href="${whatsappLink}" class="btn btn-whatsapp" target="_blank">
                        💬 WhatsApp Customer
                      </a>
                      <a href="${emailLink}" class="btn btn-email">
                        ✉️ Email Customer
                      </a>
                    </div>
                  </div>

                </div>

                <!-- FOOTER -->
                <div style="background-color:#f8faff;border-top:1px solid #e9d5ff;padding:18px 24px;text-align:center;">
                  <p>This is an automated notification from FortuneHub order system.</p>
                  <p style="margin:3px 0;font-size:12px;color:#9ca3af;font-family:'Segoe UI',Arial,sans-serif;">Order Reference: <strong>${reference}</strong></p>
                  <p style="margin:3px 0;font-size:13px;font-weight:700;color:#6b7280;font-family:'Segoe UI',Arial,sans-serif;">© ${yearNow} FortuneHub. All rights reserved.</p>
                </div>

              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  // Send customer email
  const customerEmailResp = await resend.emails.send({
    from:    MAIL_FROM,
    to:      [toEmail],
    subject: '✅ Order Confirmed! - FortuneHub',
    html:    customerEmailHTML,
    // If product images were base64, we embedded them as inline CID attachments.
    ...(inlineAttachments.length ? { attachments: inlineAttachments } : {})
  });

  console.log('✅ Customer email sent:', customerEmailResp?.id || '(no id)');

  // Send owner email (if owner email is configured)
  if (OWNER_EMAIL) {
    try {
      const ownerEmailResp = await resend.emails.send({
        from:    MAIL_FROM,
        to:      [OWNER_EMAIL],
        subject: `🔔 New Order #${reference} - ${customerName}`,
        html:    ownerEmailHTML,
        ...(inlineAttachments.length ? { attachments: inlineAttachments } : {})
      });
      console.log('✅ Owner email sent:', ownerEmailResp?.id || '(no id)');
    } catch (ownerEmailError) {
      console.error('❌ Owner email failed (but customer email sent):', ownerEmailError?.message || ownerEmailError);
      // Don't throw - customer email was successful
    }
  }

  return customerEmailResp;
}

// ===================================================
// 11) START SERVER
// ===================================================
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🚀 ================================');
  console.log('📊 Environment:', process.env.NODE_ENV || 'development');
  console.log('📧 Resend API Key:',  RESEND_API_KEY        ? '✅ Configured' : '❌ Missing');
  console.log('✉️  MAIL_FROM:',       MAIL_FROM);
  console.log('📮 Owner Email:',     OWNER_EMAIL           ? `✅ ${OWNER_EMAIL}` : '❌ Missing');
  console.log('🗄️  MongoDB URI:',     MONGODB_URI           ? '✅ Configured' : '❌ Missing');
  console.log('🔑 Paystack Public Key:', PAYSTACK_PUBLIC_KEY ? `✅ ${PAYSTACK_PUBLIC_KEY.substring(0, 18)}...` : '⚠️  Missing (set PAYSTACK_PUBLIC_KEY in Render env)');
  if (PAYSTACK_SECRET_KEY) {
    if (PAYSTACK_SECRET_KEY.startsWith('pk_')) {
      console.error('🚨 PAYSTACK_SECRET_KEY looks like a PUBLIC key (starts with pk_)! Use the SECRET key (sk_test_... or sk_live_...)');
    } else if (PAYSTACK_SECRET_KEY.startsWith('sk_test_')) {
      console.log('💳 Paystack Secret: ✅ Configured (TEST mode — use pk_test_... in frontend)');
    } else if (PAYSTACK_SECRET_KEY.startsWith('sk_live_')) {
      console.log('💳 Paystack Secret: ✅ Configured (LIVE mode — use pk_live_... in frontend)');
    } else {
      console.log('💳 Paystack Secret: ✅ Configured');
    }
  } else {
    console.error('💳 Paystack Secret: ❌ MISSING — Set PAYSTACK_SECRET_KEY in your environment variables!');
  }
  console.log('👤 Admin Username:',  ADMIN_USERNAME);

  if (MAIL_FROM.includes('@resend.dev') && !process.env.MAIL_FROM) {
    console.warn('');
    console.warn('⚠️  ============================================================');
    console.warn('⚠️  Sender is onboarding@resend.dev (Resend test domain).');
    console.warn('⚠️  Emails WILL go to SPAM for non-verified recipients.');
    console.warn('⚠️  Fix: Verify a custom domain in Resend and set MAIL_FROM.');
    console.warn('⚠️  ============================================================');
  }

  console.log('🚀 ================================');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT',  () => gracefulExit('SIGINT'));

function gracefulExit(signal) {
  console.log(`👋 ${signal} signal received: closing HTTP server`);
  mongoose.connection.close(() => {
    console.log('💤 MongoDB connection closed');
    process.exit(0);
  });
}
