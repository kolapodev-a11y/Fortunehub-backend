
// =====================================================================
// FortuneHub Backend — server.js  (Auth Edition)
// ✅ Google OAuth  + Email/Password Auth ADDED
// ✅ User model + Transaction model ADDED
// ✅ All original logic (Paystack, products, admin, email) PRESERVED
// =====================================================================

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();

// ─────────────────────────────────────────────────────────────────────
// SECURITY & PERFORMANCE HEADERS  (unchanged from original)
// ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://js.paystack.co https://accounts.google.com 'unsafe-inline'",
    "style-src 'self' https://cdnjs.cloudflare.com https://accounts.google.com 'unsafe-inline'",
    "font-src 'self' https://cdnjs.cloudflare.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://api.paystack.co https://fortunehub-backend.onrender.com https://accounts.google.com",
    "frame-src https://checkout.paystack.com https://accounts.google.com",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://js.paystack.co")');
  next();
});

const https = require('https');

// ─────────────────────────────────────────────────────────────────────
// 0) ENV + BASIC VALIDATION
// ─────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 10000;
const MONGODB_URI   = process.env.MONGODB_URI;
const JWT_SECRET    = process.env.JWT_SECRET || 'fortunehub_jwt_super_secret_2026_change_me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY ||
  process.env.PAYSTACK_ACK_SECRET ||
  process.env.PAYSTACK_SECRET || '';

const PAYSTACK_PUBLIC_KEY =
  process.env.PAYSTACK_PUBLIC_KEY ||
  process.env.PAYSTACK_ACK_PUB    ||
  process.env.PAYSTACK_PUB        || '';

const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const OWNER_EMAIL     = process.env.OWNER_EMAIL;
const ADMIN_USERNAME  = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || 'fortunehub2026';
const MAIL_FROM       = 'Fortunehub <hello@fortunehub.name.ng>';

const resend       = new Resend(RESEND_API_KEY || '');
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ─────────────────────────────────────────────────────────────────────
// 1) CORS (unchanged + allows Google auth origins)
// ─────────────────────────────────────────────────────────────────────
const DEFAULT_ALLOWED_ORIGINS = [
  'https://kolapodev-a11y.github.io',
  'https://fortunehub.name.ng',
  'https://www.fortunehub.name.ng',
  'https://fortunehub-frontend.vercel.app',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:5501',
];
const EXTRA_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]));

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || origin === 'null') return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    try {
      const o    = new URL(origin);
      const host = o.hostname.toLowerCase();
      if (host.endsWith('.fortunehub.name.ng') || host.endsWith('.vercel.app') || host.endsWith('.github.io'))
        return cb(null, true);
    } catch (_) {}
    return cb(new Error(`CORS blocked origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Paystack-Signature'],
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.set('trust proxy', 1);

// ─────────────────────────────────────────────────────────────────────
// 2) PAYMENT MODEL (unchanged)
// ─────────────────────────────────────────────────────────────────────
const paymentSchema = new mongoose.Schema({
  reference:       { type: String, required: true, unique: true },
  email:           { type: String, required: true },
  amount:          { type: Number, required: true },
  status:          { type: String, default: 'pending' },
  currency:        { type: String, default: 'NGN' },
  metadata:        { type: Object },
  paymentDate:     { type: Date, default: Date.now },
  webhookReceived: { type: Boolean, default: false },
  emailSent:       { type: Boolean, default: false },
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // ✅ NEW
  createdAt:       { type: Date, default: Date.now },
});
const Payment = mongoose.model('Payment', paymentSchema);

// ─────────────────────────────────────────────────────────────────────
// ✅ NEW — USER MODEL
// ─────────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  googleId:     { type: String, sparse: true, default: null },
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  name:         { type: String, required: true, trim: true },
  picture:      { type: String, default: '' },
  password:     { type: String, default: null },   // null for Google users
  authProvider: { type: String, enum: ['google', 'email'], required: true },
  phone:        { type: String, default: '' },
  createdAt:    { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

// ─────────────────────────────────────────────────────────────────────
// PRODUCT MODEL (unchanged)
// ─────────────────────────────────────────────────────────────────────
const productSchema = new mongoose.Schema({
  name:            { type: String, required: true },
  price:           { type: Number, required: true },
  category:        { type: String, required: true },
  description:     { type: String, default: '' },
  image:           { type: String, default: '' },
  images:          [{ type: String }],
  tag:             { type: String, default: 'none' },
  outOfStock:      { type: Boolean, default: false },
  sold:            { type: Boolean, default: false },
  statusIndicator: { type: String, default: 'available' },
  createdAt:       { type: Date, default: Date.now },
});
const Product = mongoose.model('Product', productSchema);

// ─────────────────────────────────────────────────────────────────────
// 3) WEBHOOK — MUST BE BEFORE express.json()
// ─────────────────────────────────────────────────────────────────────
app.post(
  '/api/payment/webhook/paystack',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) return res.status(500).send('Server misconfigured');
      const signature    = req.headers['x-paystack-signature'];
      const rawBody      = req.body;
      const computedHash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
      if (!signature || computedHash !== signature) return res.status(401).send('Invalid signature');

      const event = JSON.parse(rawBody.toString('utf8'));
      console.log('📨 Paystack webhook received:', event.event);

      if (event.event === 'charge.success') {
        const { reference, customer, amount, currency, paid_at, metadata } = event.data;
        const email       = customer?.email;
        const amountNaira = amount / 100;

        // Try to link to user
        let userId = null;
        if (email) {
          const foundUser = await User.findOne({ email: email.toLowerCase() });
          if (foundUser) userId = foundUser._id;
        }

        const updated = await Payment.findOneAndUpdate(
          { reference },
          {
            reference, email, amount: amountNaira, currency: currency || 'NGN',
            status: 'success', metadata,
            paymentDate: paid_at ? new Date(paid_at) : new Date(),
            webhookReceived: true,
            ...(userId && { userId }),
          },
          { upsert: true, new: true }
        );
        console.log(`✅ Webhook: Payment ${reference} confirmed`);

        if (!updated.emailSent) {
          try {
            await sendPaymentEmails({ toEmail: email, reference, amountNaira, currency: currency || 'NGN', paidAt: paid_at ? new Date(paid_at) : new Date(), metadata: metadata || {} });
            await Payment.findOneAndUpdate({ reference }, { emailSent: true });
          } catch (e) { console.error('❌ Webhook email failed:', e?.message || e); }
        }
      }
      return res.status(200).send('Webhook received');
    } catch (error) {
      console.error('❌ Webhook error:', error);
      return res.status(500).send('Webhook processing failed');
    }
  }
);

// ─────────────────────────────────────────────────────────────────────
// 4) BODY PARSERS (after webhook)
// ─────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413))
    return res.status(413).json({ success: false, message: 'Payload too large.' });
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err)
    return res.status(400).json({ success: false, message: 'Invalid JSON payload.' });
  return next(err);
});

// ─────────────────────────────────────────────────────────────────────
// 5) MONGODB CONNECTION (unchanged)
// ─────────────────────────────────────────────────────────────────────
let connecting = false;
async function connectMongo() {
  if (connecting) return;
  if (!MONGODB_URI) { console.error('❌ MONGODB_URI is missing'); process.exit(1); }
  connecting = true;
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 45000, maxPoolSize: 10 });
    console.log('🔗 MongoDB Connected to:', mongoose.connection.name);
    try {
      const productsCol = mongoose.connection.db.collection('products');
      const indexes     = await productsCol.indexes();
      if (indexes.some(idx => idx.name === 'id_1')) {
        await productsCol.dropIndex('id_1');
        console.log('🧹 Dropped stale id_1 index');
      }
    } catch (e) { /* non-fatal */ }
  } catch (err) {
    console.error('❌ MongoDB error:', err.message);
    setTimeout(() => { connecting = false; connectMongo(); }, 5000);
    return;
  }
  connecting = false;
}
mongoose.connection.on('disconnected', () => { console.log('⚠️ MongoDB disconnected. Reconnecting…'); connectMongo(); });
connectMongo();

// ─────────────────────────────────────────────────────────────────────
// 6) PAYSTACK HELPER (unchanged)
// ─────────────────────────────────────────────────────────────────────
function paystackRequest(path, method, bodyObj = null) {
  return new Promise((resolve, reject) => {
    if (!PAYSTACK_SECRET_KEY) return reject(new Error('PAYSTACK_SECRET_KEY is missing'));
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const req  = https.request(
      { hostname: 'api.paystack.co', path, method,
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }
      },
      (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          let parsed;
          try { parsed = data ? JSON.parse(data) : {}; } catch (e) { parsed = { raw: data }; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────
// ✅ NEW — AUTH MIDDLEWARE  (JWT)
// ─────────────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

function issueJWT(user) {
  return jwt.sign(
    { id: user._id, email: user.email, name: user.name, picture: user.picture, authProvider: user.authProvider },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// ─────────────────────────────────────────────────────────────────────
// ✅ NEW — AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────

// POST /api/auth/google  — verify Google ID token, create or login user
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ success: false, message: 'Google credential required' });

    if (!GOOGLE_CLIENT_ID)
      return res.status(500).json({ success: false, message: 'GOOGLE_CLIENT_ID not configured on server' });

    // Verify the ID token with Google
    const ticket  = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();

    const { sub: googleId, email, name, picture } = payload;
    if (!email) return res.status(400).json({ success: false, message: 'Google account has no email' });

    // Upsert user — find by email or googleId
    let user = await User.findOne({ $or: [{ email: email.toLowerCase() }, { googleId }] });

    if (!user) {
      user = await User.create({ googleId, email: email.toLowerCase(), name, picture: picture || '', authProvider: 'google' });
      console.log(`✅ New Google user registered: ${email}`);
    } else {
      // Sync latest Google profile
      user.googleId = googleId;
      user.picture  = picture || user.picture;
      user.name     = name    || user.name;
      if (user.authProvider !== 'google' && !user.password) user.authProvider = 'google'; // upgrade if no password
      await user.save();
    }

    const token = issueJWT(user);
    return res.json({
      success: true,
      token,
      user: { id: user._id, email: user.email, name: user.name, picture: user.picture, authProvider: user.authProvider, phone: user.phone },
    });
  } catch (err) {
    console.error('❌ Google auth error:', err.message);
    return res.status(401).json({ success: false, message: 'Google authentication failed: ' + err.message });
  }
});

// POST /api/auth/signup  — email + password sign-up
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'Name, email, and password are required' });
    if (password.length < 6)
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ success: false, message: 'An account with this email already exists. Please sign in.' });

    const hashed = await bcrypt.hash(password, 12);
    const user   = await User.create({ email: email.toLowerCase(), name, password: hashed, authProvider: 'email' });
    console.log(`✅ New email user registered: ${email}`);

    const token = issueJWT(user);
    return res.status(201).json({
      success: true,
      token,
      user: { id: user._id, email: user.email, name: user.name, picture: '', authProvider: 'email', phone: '' },
    });
  } catch (err) {
    console.error('❌ Signup error:', err.message);
    return res.status(500).json({ success: false, message: 'Signup failed: ' + err.message });
  }
});

// POST /api/auth/signin  — email + password sign-in
app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ success: false, message: 'Email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.password)
      return res.status(401).json({ success: false, message: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(401).json({ success: false, message: 'Invalid email or password' });

    const token = issueJWT(user);
    return res.json({
      success: true,
      token,
      user: { id: user._id, email: user.email, name: user.name, picture: user.picture || '', authProvider: user.authProvider, phone: user.phone || '' },
    });
  } catch (err) {
    console.error('❌ Signin error:', err.message);
    return res.status(500).json({ success: false, message: 'Signin failed: ' + err.message });
  }
});

// GET /api/auth/me  — return current user (protected)
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/auth/me  — update phone number (protected)
app.patch('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { phone } = req.body;
    const user = await User.findByIdAndUpdate(req.user.id, { phone: phone || '' }, { new: true }).select('-password');
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ✅ NEW — TRANSACTION HISTORY ROUTES
// ─────────────────────────────────────────────────────────────────────

// GET /api/transactions/my  — authenticated user's order history
app.get('/api/transactions/my', authMiddleware, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));

    const query = { userId: req.user.id, status: 'success' };
    const total = await Payment.countDocuments(query);
    const transactions = await Payment.find(query)
      .sort({ paymentDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      data: transactions,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/transactions/receipt/:reference  — get a single receipt (protected)
app.get('/api/transactions/receipt/:reference', authMiddleware, async (req, res) => {
  try {
    const payment = await Payment.findOne({
      reference: req.params.reference,
      $or: [{ userId: req.user.id }, { email: req.user.email }],
    }).lean();
    if (!payment) return res.status(404).json({ success: false, message: 'Receipt not found' });
    return res.json({ success: true, data: payment });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// 6) STANDARD ROUTES (ping, health, etc.)  — unchanged
// ─────────────────────────────────────────────────────────────────────
app.get('/ping',   (req, res) => res.json({ pong: true, timestamp: new Date().toISOString() }));
app.get('/',       (req, res) => res.json({ status: 'OK', message: 'FortuneHub Backend API is running', timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({
  status: 'healthy',
  mongodb:  mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  resend:   RESEND_API_KEY     ? 'configured' : 'missing',
  paystack: PAYSTACK_SECRET_KEY ? 'configured' : 'missing',
  google:   GOOGLE_CLIENT_ID   ? 'configured' : 'missing',
  auth:     'jwt',
}));

// ─────────────────────────────────────────────────────────────────────
// PAYMENT ROUTES (unchanged — but verify now links userId)
// ─────────────────────────────────────────────────────────────────────
app.get('/api/payment/verify',  async (req, res) => handlePaymentVerification(req, res));
app.post('/api/payment/verify', async (req, res) => handlePaymentVerification(req, res));

app.post('/api/payment/initialize', async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY)
      return res.status(500).json({ success: false, message: 'Server misconfigured: PAYSTACK_SECRET_KEY missing' });

    const email        = String(req.body?.email || '').trim();
    const amountNaira  = Number(req.body?.amount);
    const rawMetadata  = req.body?.metadata || {};

    function sanitizeMetadataForPaystack(meta) {
      const out = Object.assign({}, meta);
      if (Array.isArray(out.cart_items)) {
        out.cart_items = out.cart_items.map(item => {
          const img = String(item.image || '');
          return Object.assign({}, item, { image: (img.startsWith('data:') || img.length > 300) ? '' : img });
        });
      }
      return out;
    }

    const metadata = sanitizeMetadataForPaystack(rawMetadata);
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
    if (!Number.isFinite(amountNaira) || amountNaira <= 0)
      return res.status(400).json({ success: false, message: 'Amount must be > 0 (Naira)' });

    const amountKobo = Math.round(amountNaira * 100);
    const initRes    = await paystackRequest('/transaction/initialize', 'POST', { email, amount: amountKobo, currency: 'NGN', metadata });
    const initData   = initRes.data || {};

    if (!initRes.ok || !initData.status)
      return res.status(400).json({ success: false, message: initData.message || 'Failed to initialize', error: initData });

    const reference  = initData.data?.reference;
    const access_code = initData.data?.access_code;

    if (reference) {
      // Link userId if the buyer is authenticated
      const authHeader = req.headers.authorization || '';
      let userId = null;
      if (authHeader.startsWith('Bearer ')) {
        try { const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET); userId = decoded.id; } catch (_) {}
      }
      try {
        await Payment.findOneAndUpdate(
          { reference },
          { reference, email, amount: amountNaira, currency: 'NGN', status: 'pending', metadata, paymentDate: new Date(), ...(userId && { userId }) },
          { upsert: true, new: true }
        );
      } catch (e) { console.log('ℹ️ Initialize: non-fatal DB error:', e.message); }
    }

    return res.json({ success: true, message: 'Transaction initialized', reference, access_code, public_key: PAYSTACK_PUBLIC_KEY });
  } catch (err) {
    console.error('❌ Initialize error:', err);
    return res.status(500).json({ success: false, message: 'Failed to initialize', error: err.message });
  }
});

async function handlePaymentVerification(req, res) {
  try {
    const reference = req.query.reference || req.body?.reference;
    if (!reference) return res.status(400).json({ success: false, message: 'Reference required' });

    const existing = await Payment.findOne({ reference });
    if (existing && existing.status === 'success') {
      if (existing.emailSent)
        return res.status(200).json({ success: true, message: 'Payment already verified', emailSent: true, data: existing });
      let resent = false;
      try {
        await sendPaymentEmails({ toEmail: existing.email, reference: existing.reference, amountNaira: existing.amount, currency: existing.currency || 'NGN', paidAt: existing.paymentDate || new Date(), metadata: existing.metadata || {} });
        await Payment.findOneAndUpdate({ reference }, { emailSent: true });
        resent = true;
      } catch (e) { console.error('❌ Email re-send failed:', e?.message); }
      return res.status(200).json({ success: true, message: resent ? 'Verified, email re-sent' : 'Verified, email pending', emailSent: resent, data: existing });
    }

    if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ success: false, message: 'PAYSTACK_SECRET_KEY missing' });

    const paystackResp = await paystackRequest(`/transaction/verify/${reference}`, 'GET');
    if (!paystackResp.ok)
      return res.status(400).json({ success: false, message: 'Failed to verify with Paystack', error: `HTTP ${paystackResp.status}` });

    const paymentData = paystackResp.data;
    if (!paymentData.status || paymentData.data.status !== 'success')
      return res.status(400).json({ success: false, message: paymentData.message || 'Verification failed' });

    const { customer, amount, currency, metadata, paid_at } = paymentData.data;
    const customerEmail = customer?.email;
    const amountNaira   = amount / 100;

    // Link userId
    let userId = null;
    if (customerEmail) {
      const u = await User.findOne({ email: customerEmail.toLowerCase() });
      if (u) userId = u._id;
    }

    const payment = await Payment.findOneAndUpdate(
      { reference },
      { reference, email: customerEmail, amount: amountNaira, currency: currency || 'NGN', status: 'success', metadata, paymentDate: paid_at ? new Date(paid_at) : new Date(), ...(userId && { userId }) },
      { upsert: true, new: true }
    );

    let emailSent = false;
    try {
      await sendPaymentEmails({ toEmail: customerEmail, reference, amountNaira, currency: currency || 'NGN', paidAt: paid_at ? new Date(paid_at) : new Date(), metadata: metadata || {} });
      emailSent = true;
      await Payment.findOneAndUpdate({ reference }, { emailSent: true });
    } catch (e) { console.error('❌ Email failed:', e); }

    return res.status(200).json({
      success: true,
      message: emailSent ? 'Payment verified, email sent' : 'Payment verified (email pending)',
      emailSent,
      data: { reference, amount: amountNaira, currency: currency || 'NGN', email: customerEmail, status: 'success', paymentDate: paid_at || new Date().toISOString() },
    });
  } catch (error) {
    console.error('❌ Verification error:', error);
    return res.status(500).json({ success: false, message: 'Verification error', error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────
// ADMIN ROUTES (unchanged)
// ─────────────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD)
      return res.json({ success: true, message: 'Login successful', token: Buffer.from(`${username}:${password}`).toString('base64') });
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No authorization header' });
  const token   = authHeader.replace('Basic ', '');
  const decoded = Buffer.from(token, 'base64').toString('utf-8');
  const [username, password] = decoded.split(':');
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) return next();
  return res.status(401).json({ success: false, message: 'Unauthorized' });
}

app.get('/api/admin/payments', verifyAdmin, async (req, res) => {
  try {
    const page  = parseInt(req.query.page  || '1');
    const limit = parseInt(req.query.limit || '50');
    const query = {};
    if (req.query.status && req.query.status !== 'all') query.status = req.query.status;
    if (req.query.search) query.$or = [{ reference: { $regex: req.query.search, $options: 'i' } }, { email: { $regex: req.query.search, $options: 'i' } }];
    if (req.query.startDate || req.query.endDate) {
      query.createdAt = {};
      if (req.query.startDate) query.createdAt.$gte = new Date(req.query.startDate);
      if (req.query.endDate) { const end = new Date(req.query.endDate); end.setHours(23, 59, 59, 999); query.createdAt.$lte = end; }
    }
    const total    = await Payment.countDocuments(query);
    const payments = await Payment.find(query).sort({ createdAt: -1 }).limit(limit).skip((page - 1) * limit);
    const stats    = await Payment.aggregate([{ $match: query }, { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalCount: { $sum: 1 }, successCount: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } }, pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } }, failedCount: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } } } }]);
    res.json({ success: true, data: payments, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }, stats: stats[0] || { totalAmount: 0, successCount: 0, pendingCount: 0 } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/admin/payments/:id', verifyAdmin, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
    const paymentObj = payment.toObject();
    const cartItems  = paymentObj?.metadata?.cart_items;
    if (Array.isArray(cartItems) && cartItems.length) {
      const enriched = await Promise.all(cartItems.map(async (item) => {
        if (item.image) return item;
        let prod = null;
        try {
          if (item.id) { const rawId = String(item.id).replace(/^db_/, ''); if (mongoose.Types.ObjectId.isValid(rawId)) prod = await Product.findById(rawId).select('image images').lean(); }
          if (!prod && item.name) prod = await Product.findOne({ name: item.name }).select('image images').lean();
        } catch (e) { /* non-fatal */ }
        if (prod) { const img = (Array.isArray(prod.images) && prod.images.find(Boolean)) || prod.image || ''; return Object.assign({}, item, { image: img }); }
        return item;
      }));
      if (paymentObj.metadata) paymentObj.metadata.cart_items = enriched;
    }
    res.json({ success: true, data: paymentObj });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/admin/payments/clear-all', verifyAdmin, async (req, res) => {
  try {
    const result = await Payment.deleteMany({});
    res.json({ success: true, message: `Cleared ${result.deletedCount} transaction(s)`, deletedCount: result.deletedCount });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/admin/payments/:id', verifyAdmin, async (req, res) => {
  try {
    const payment = await Payment.findByIdAndDelete(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Transaction not found' });
    res.json({ success: true, message: 'Transaction deleted' });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/payments', async (req, res) => {
  try {
    const payments = await Payment.find().sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, count: payments.length, data: payments });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// PRODUCT ROUTES (unchanged)
// ─────────────────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const dbProducts = await Product.find().sort({ createdAt: -1 });
    const mapped     = dbProducts.map(p => ({
      id: `db_${p._id}`, _id: p._id, name: p.name, price: p.price, category: p.category,
      description: p.description, image: p.image,
      images: p.images && p.images.length ? p.images : [p.image, p.image, p.image],
      tag: p.tag, outOfStock: p.outOfStock, sold: p.sold, statusIndicator: p.statusIndicator,
    }));
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=60');
    res.json({ success: true, count: mapped.length, data: mapped });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, data: product });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/products', verifyAdmin, async (req, res) => {
  try {
    const { name, price, category, description, image, images, tag, outOfStock, sold, statusIndicator } = req.body;
    if (!name || !price || !category) return res.status(400).json({ success: false, message: 'name, price, and category are required' });
    const product = new Product({ name, price: Number(price), category: category.toLowerCase(), description: description || '', image: image || '', images: Array.isArray(images) ? images : (image ? [image] : []), tag: tag || 'none', outOfStock: Boolean(outOfStock), sold: Boolean(sold), statusIndicator: statusIndicator || 'available' });
    await product.save();
    res.status(201).json({ success: true, message: 'Product created', data: product });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

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
    res.json({ success: true, message: 'Product updated', data: product });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, message: `Product "${product.name}" deleted` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS (unchanged)
// ─────────────────────────────────────────────────────────────────────
function formatNaira(amount) {
  return '₦' + Number(amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatDateWAT(date) {
  return new Date(date).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function resolveImageUrl(imagePath) {
  if (!imagePath) return '';
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('data:') || imagePath.startsWith('blob:')) return imagePath;
  const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://fortunehub.name.ng';
  const baseUrl     = PUBLIC_BASE.endsWith('/') ? PUBLIC_BASE : PUBLIC_BASE + '/';
  const cleanPath   = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
  try { return new URL(cleanPath, baseUrl).toString(); } catch (_) { return baseUrl + cleanPath; }
}

function dataUrlToCidAttachment(dataUrl, contentId, fallbackExt = 'jpg') {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  const match   = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const content  = match[2];
  const ext      = mimeType.split('/')[1]?.split('+')[0] || fallbackExt;
  return { filename: `${contentId}.${ext}`, content, type: mimeType, disposition: 'inline', content_id: contentId };
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL SENDER (unchanged — same rich HTML as original)
// ─────────────────────────────────────────────────────────────────────
async function sendPaymentEmails({ toEmail, reference, amountNaira, currency, paidAt, metadata }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');

  const customerName  = metadata?.customer_name  || metadata?.name        || 'Valued Customer';
  const customerPhone = metadata?.customer_phone || metadata?.phone        || 'N/A';
  const shippingState = metadata?.shipping_state || metadata?.state        || 'N/A';
  const cartItems     = metadata?.cart_items     || metadata?.items        || [];
  const shippingFee   = Number(metadata?.shipping_fee || 0);
  const subtotal      = Number(amountNaira) - shippingFee;
  const paidAtDate    = paidAt ? formatDateWAT(paidAt) : formatDateWAT(new Date());
  const currencySymbol = currency === 'NGN' ? '₦' : currency;

  const attachments = [];
  const itemsHtml   = cartItems.map((item, i) => {
    let imgHtml = '';
    const rawImg = item.image || '';
    if (rawImg.startsWith('data:')) {
      const cid = `product_img_${i}`;
      const att = dataUrlToCidAttachment(rawImg, cid);
      if (att) { attachments.push(att); imgHtml = `<img src="cid:${cid}" alt="${item.name}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #eee;">`; }
    } else if (rawImg) {
      const absImg = resolveImageUrl(rawImg);
      imgHtml = `<img src="${absImg}" alt="${item.name}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #eee;">`;
    }
    return `<tr><td style="padding:10px;border-bottom:1px solid #f0f0f0;">${imgHtml}</td><td style="padding:10px;border-bottom:1px solid #f0f0f0;"><strong>${item.name}</strong><br><span style="color:#666;font-size:13px;">${item.category || ''}</span></td><td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;">${item.quantity || 1}</td><td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:bold;">${currencySymbol}${Number(item.price || 0).toLocaleString()}</td></tr>`;
  }).join('');

  const customerEmailHtml = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Order Confirmation</title></head>
<body style="margin:0;padding:0;background:#f5f7ff;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
<div style="max-width:600px;margin:30px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
  <div style="background:linear-gradient(135deg,#1D2386,#BA1921);padding:32px;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:28px;font-weight:900;">Fortune's Hub</h1>
    <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:16px;">Order Confirmation ✅</p>
  </div>
  <div style="padding:32px;">
    <h2 style="color:#1D2386;margin:0 0 8px;">Hi ${customerName}! 👋</h2>
    <p style="color:#555;margin:0 0 24px;">Your payment was received and your order is confirmed.</p>
    <div style="background:#f8f9ff;border-radius:12px;padding:20px;margin-bottom:24px;border-left:4px solid #1D2386;">
      <h3 style="margin:0 0 14px;color:#1D2386;">📋 Order Details</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#555;">Reference</td><td style="padding:6px 0;text-align:right;font-weight:bold;font-family:monospace;">${reference}</td></tr>
        <tr><td style="padding:6px 0;color:#555;">Date</td><td style="padding:6px 0;text-align:right;">${paidAtDate} (WAT)</td></tr>
        <tr><td style="padding:6px 0;color:#555;">Shipping To</td><td style="padding:6px 0;text-align:right;">${shippingState}</td></tr>
        <tr><td style="padding:6px 0;color:#555;">WhatsApp</td><td style="padding:6px 0;text-align:right;">${customerPhone}</td></tr>
      </table>
    </div>
    ${cartItems.length > 0 ? `
    <h3 style="color:#1D2386;margin:0 0 14px;">🛒 Items Ordered</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <thead><tr style="background:#f0f2ff;"><th style="padding:10px;text-align:left;font-size:13px;color:#666;">Image</th><th style="padding:10px;text-align:left;font-size:13px;color:#666;">Product</th><th style="padding:10px;text-align:center;font-size:13px;color:#666;">Qty</th><th style="padding:10px;text-align:right;font-size:13px;color:#666;">Price</th></tr></thead>
      <tbody>${itemsHtml}</tbody>
    </table>` : ''}
    <div style="background:#1D2386;border-radius:12px;padding:20px;color:#fff;margin-bottom:24px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 0;opacity:0.85;">Subtotal</td><td style="text-align:right;padding:4px 0;">${currencySymbol}${subtotal.toLocaleString()}</td></tr>
        <tr><td style="padding:4px 0;opacity:0.85;">Shipping</td><td style="text-align:right;padding:4px 0;">${currencySymbol}${shippingFee.toLocaleString()}</td></tr>
        <tr style="border-top:1px solid rgba(255,255,255,0.3);"><td style="padding-top:10px;font-size:18px;font-weight:900;">Total Paid</td><td style="text-align:right;padding-top:10px;font-size:20px;font-weight:900;">${currencySymbol}${Number(amountNaira).toLocaleString()}</td></tr>
      </table>
    </div>
    <p style="color:#555;font-size:14px;text-align:center;">Questions? Contact us via WhatsApp: <a href="https://wa.me/2349033489520" style="color:#1D2386;">09033489520</a> or email: <a href="mailto:fortunehabib9@gmail.com" style="color:#1D2386;">fortunehabib9@gmail.com</a></p>
  </div>
  <div style="background:#f0f2ff;padding:16px;text-align:center;"><p style="margin:0;color:#888;font-size:12px;">© 2026 Fortune's Hub • Aloba complex, Idiope Awule Road, Akure • Mon–Sat: 9am–6pm</p></div>
</div></body></html>`;

  await resend.emails.send({ from: MAIL_FROM, to: [toEmail], subject: `✅ Order Confirmed — ${reference} | Fortune's Hub`, html: customerEmailHtml, attachments: attachments.length ? attachments : undefined });

  if (OWNER_EMAIL) {
    const ownerHtml = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;"><h2 style="color:#1D2386;">💰 New Order Received!</h2><p><strong>Customer:</strong> ${customerName}</p><p><strong>Email:</strong> ${toEmail}</p><p><strong>Phone:</strong> ${customerPhone}</p><p><strong>Shipping State:</strong> ${shippingState}</p><p><strong>Reference:</strong> <code>${reference}</code></p><p><strong>Total:</strong> ${currencySymbol}${Number(amountNaira).toLocaleString()}</p><p><strong>Date:</strong> ${paidAtDate} (WAT)</p><hr><p style="color:#666;">Items: ${cartItems.map(i => `${i.name} ×${i.quantity}`).join(', ')}</p></div>`;
    await resend.emails.send({ from: MAIL_FROM, to: [OWNER_EMAIL], subject: `💰 New Order — ${formatNaira(amountNaira)} from ${customerName}`, html: ownerHtml });
  }
}

// ─────────────────────────────────────────────────────────────────────
// KEEP-ALIVE SELF-PING (unchanged)
// ─────────────────────────────────────────────────────────────────────
function startSelfPing() {
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    https.get(`${SELF_URL}/ping`).on('error', () => {});
  }, 14 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 FortuneHub Backend running on port ${PORT}`);
  console.log(`📧 Resend:          ${RESEND_API_KEY  ? '✅ configured' : '❌ MISSING'}`);
  console.log(`💳 Paystack:        ${PAYSTACK_SECRET_KEY ? '✅ configured' : '❌ MISSING'}`);
  console.log(`🔑 Google OAuth:    ${GOOGLE_CLIENT_ID ? '✅ configured' : '⚠️  MISSING (set GOOGLE_CLIENT_ID)'}`);
  console.log(`🔐 JWT Secret:      ${JWT_SECRET !== 'fortunehub_jwt_super_secret_2026_change_me' ? '✅ custom' : '⚠️  using default (set JWT_SECRET in prod)'}`);
  console.log(`📦 MongoDB URI:     ${MONGODB_URI  ? '✅ configured' : '❌ MISSING'}\n`);
  if (process.env.NODE_ENV === 'production') startSelfPing();
});

process.on('SIGTERM', async () => { await mongoose.connection.close(); process.exit(0); });
process.on('SIGINT',  async () => { await mongoose.connection.close(); process.exit(0); });
