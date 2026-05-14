const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { OAuth2Client } = require('google-auth-library');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();
app.disable('x-powered-by');
app.use(compression({ threshold: 1024 }));

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'fortunehub_jwt_super_secret_2026_change_me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const OWNER_EMAIL = process.env.OWNER_EMAIL || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'fortunehub2026';
const ADMIN_DISPLAY_NAME = process.env.ADMIN_DISPLAY_NAME || 'FortuneHub Admin';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim();
const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || 'https://fortunehub.name.ng').trim();
const ADMIN_PANEL_URL = (process.env.ADMIN_PANEL_URL || `${FRONTEND_BASE_URL.replace(/\/$/, '')}/admin/`).trim();
const OPAY_BANK_NAME = process.env.OPAY_BANK_NAME || 'OPay';
const OPAY_ACCOUNT_NAME = process.env.OPAY_ACCOUNT_NAME || 'FortuneHub';
const OPAY_ACCOUNT_NUMBER = process.env.OPAY_ACCOUNT_NUMBER || process.env.OPAY_ACCOUNT_PHONE || '';
const OPAY_ACCOUNT_PHONE = OPAY_ACCOUNT_NUMBER;
const OPAY_WHATSAPP_NUMBER = process.env.OPAY_WHATSAPP_NUMBER || OPAY_ACCOUNT_NUMBER || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Fortunehub <hello@fortunehub.name.ng>';
const NAIRA_SYMBOL = '\u20A6';

function firstExistingPath(paths = []) {
  return paths.find((filePath) => filePath && fs.existsSync(filePath)) || '';
}

const PDF_FONT_REGULAR_PATH = firstExistingPath([
  path.join(__dirname, 'assets', 'fonts', 'DejaVuSans.ttf'),
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'
]);
const PDF_FONT_BOLD_PATH = firstExistingPath([
  path.join(__dirname, 'assets', 'fonts', 'DejaVuSans-Bold.ttf'),
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
  PDF_FONT_REGULAR_PATH
]);
const PDF_FONT_REGULAR = PDF_FONT_REGULAR_PATH ? 'FortuneHubSans' : 'Helvetica';
const PDF_FONT_BOLD = PDF_FONT_BOLD_PATH ? 'FortuneHubSansBold' : 'Helvetica-Bold';

const resend = new Resend(RESEND_API_KEY);
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const uploadsDir = path.join(__dirname, 'uploads');
const proofsDir = path.join(uploadsDir, 'proofs');
const receiptsDir = path.join(uploadsDir, 'receipts');
const emailAssetsDir = path.join(uploadsDir, 'email-assets');
for (const dir of [uploadsDir, proofsDir, receiptsDir, emailAssetsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

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

app.use(cors({
  origin(origin, cb) {
    if (!origin || origin === 'null') return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    try {
      const url = new URL(origin);
      if (
        url.hostname.endsWith('.fortunehub.name.ng') ||
        url.hostname.endsWith('.vercel.app') ||
        url.hostname.endsWith('.github.io')
      ) {
        return cb(null, true);
      }
    } catch (_) {}
    return cb(new Error(`CORS blocked origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
}));

app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '30d',
  immutable: true,
  index: false
}));

app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ success: false, message: 'Request payload too large.' });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, message: 'Invalid JSON payload.' });
  }
  return next(err);
});

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
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10
    });
    console.log('✅ MongoDB connected');

    try {
      const productsCollection = mongoose.connection.db.collection('products');
      const indexes = await productsCollection.indexes();
      if (indexes.some((idx) => idx.name === 'id_1')) {
        await productsCollection.dropIndex('id_1');
        console.log('🧹 Dropped stale products.id_1 index');
      }
    } catch (error) {
      console.log('ℹ️ Products index cleanup skipped:', error.message);
    }
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    setTimeout(() => {
      connecting = false;
      connectMongo();
    }, 5000);
    return;
  }
  connecting = false;
}

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected. Retrying...');
  connectMongo();
});

mongoose.connection.on('error', (error) => {
  console.log('⚠️ Mongo runtime error:', error.message);
});

connectMongo();

const userSchema = new mongoose.Schema({
  googleId: { type: String, sparse: true, default: null },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  picture: { type: String, default: '' },
  password: { type: String, default: null },
  authProvider: { type: String, enum: ['google', 'email'], required: true },
  phone: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, required: true },
  description: { type: String, default: '' },
  image: { type: String, default: '' },
  images: [{ type: String }],
  tag: { type: String, default: 'none' },
  outOfStock: { type: Boolean, default: false },
  sold: { type: Boolean, default: false },
  statusIndicator: { type: String, default: 'available' },
  createdAt: { type: Date, default: Date.now }
});

productSchema.index({ createdAt: -1 });
productSchema.index({ category: 1, createdAt: -1 });
productSchema.index({ sold: 1, outOfStock: 1, tag: 1, createdAt: -1 });

const orderItemSchema = new mongoose.Schema({
  productId: { type: String, default: '' },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true, default: 1 },
  image: { type: String, default: '' }
}, { _id: false });

const orderTimelineSchema = new mongoose.Schema({
  status: { type: String, required: true },
  label: { type: String, required: true },
  note: { type: String, default: '' },
  by: { type: String, default: '' },
  at: { type: Date, default: Date.now }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  email: { type: String, required: true, lowercase: true, trim: true },
  customerName: { type: String, required: true, trim: true },
  customerPhone: { type: String, required: true, trim: true },
  shippingState: { type: String, default: '' },
  shippingFee: { type: Number, default: 0 },
  subtotal: { type: Number, required: true },
  amount: { type: Number, required: true },
  items: { type: [orderItemSchema], default: [] },
  paymentMethod: { type: String, enum: ['opay_manual'], default: 'opay_manual' },
  status: {
    type: String,
    enum: ['pending_payment', 'awaiting_verification', 'paid', 'failed', 'cancelled'],
    default: 'pending_payment'
  },
  orderRef: { type: String, required: true, unique: true },
  proofUrl: { type: String, default: '' },
  proofFileName: { type: String, default: '' },
  transactionId: { type: String, default: '' },
  verifiedAt: { type: Date, default: null },
  verifiedBy: { type: String, default: '' },
  receiptPdfUrl: { type: String, default: '' },
  hiddenFromAdmin: { type: Boolean, default: false },
  statusTimeline: { type: [orderTimelineSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

orderSchema.pre('save', function saveUpdatedAt(next) {
  this.updatedAt = new Date();
  next();
});

const User = mongoose.model('User', userSchema);
const Product = mongoose.model('Product', productSchema);
const Order = mongoose.model('Order', orderSchema);

async function ensureProductIndexes() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await Product.syncIndexes();
    console.log('✅ Product indexes synced');
  } catch (error) {
    console.log('ℹ️ Product index sync skipped:', error.message);
  }
}

mongoose.connection.once('connected', () => {
  ensureProductIndexes().catch(() => {});
});
if (mongoose.connection.readyState === 1) {
  ensureProductIndexes().catch(() => {});
}

function issueJWT(user) {
  return jwt.sign({
    id: user._id,
    email: user.email,
    name: user.name,
    picture: user.picture || '',
    authProvider: user.authProvider
  }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (_) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

function issueAdminJWT() {
  return jwt.sign({
    role: 'admin',
    username: ADMIN_USERNAME,
    name: ADMIN_DISPLAY_NAME
  }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Admin authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error('Not admin');
    req.admin = decoded;
    return next();
  } catch (_) {
    return res.status(401).json({ success: false, message: 'Invalid or expired admin token' });
  }
}

function formatNaira(amount) {
  return `₦${Number(amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatDateWAT(date) {
  return new Date(date).toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'file';
}

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, '');
  if (req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    return `${protocol}://${req.get('host')}`;
  }
  return `http://localhost:${PORT}`;
}

function buildPublicFileUrl(relativePath, req) {
  return `${getPublicBaseUrl(req)}${relativePath.startsWith('/') ? relativePath : `/${relativePath}`}`;
}

function buildFrontendAssetUrl(assetPath = '') {
  const base = FRONTEND_BASE_URL.replace(/\/$/, '');
  if (!assetPath) return base;
  return `${base}/${String(assetPath).replace(/^\//, '')}`;
}

function materializeEmailAsset(dataUrl = '') {
  const value = String(dataUrl || '').trim();
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return '';

  const mimeType = String(match[1] || '').toLowerCase();
  if (!mimeType.startsWith('image/')) return '';

  const extByMime = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg'
  };

  const payload = String(match[2] || '').replace(/\s+/g, '');
  const fileHash = crypto.createHash('sha1').update(payload).digest('hex');
  const extension = extByMime[mimeType] || mimeType.split('/')[1] || 'png';
  const fileName = `${fileHash}.${extension}`;
  const outputPath = path.join(emailAssetsDir, fileName);

  if (!fs.existsSync(outputPath)) {
    fs.writeFileSync(outputPath, Buffer.from(payload, 'base64'));
  }

  return `/uploads/email-assets/${fileName}`;
}

function resolveDisplayImage(url, req) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:/i.test(value)) return value;
  if (/^data:/i.test(value)) {
    const materializedPath = materializeEmailAsset(value);
    return materializedPath ? buildPublicFileUrl(materializedPath, req) : '';
  }
  if (value.startsWith('/uploads/')) return buildPublicFileUrl(value, req);
  if (value.startsWith('/')) return buildFrontendAssetUrl(value);
  return buildFrontendAssetUrl(value);
}

function getProductImageValue(product) {
  if (!product) return '';
  const galleryImage = Array.isArray(product.images) ? product.images.find(Boolean) : '';
  return String(product.image || galleryImage || '').trim();
}

async function hydrateOrderItems(items = []) {
  const normalizedItems = Array.isArray(items) ? items.map((item) => ({
    productId: String(item.productId || item.id || '').trim(),
    name: String(item.name || '').trim(),
    price: Number(item.price || 0),
    quantity: Math.max(1, Number(item.quantity || 1)),
    image: String(item.image || '').trim()
  })).filter((item) => item.name && item.price >= 0) : [];

  const productIds = [...new Set(normalizedItems
    .map((item) => item.productId.replace(/^db_/, ''))
    .filter(Boolean))];

  const productMap = new Map();
  if (productIds.length) {
    const docs = await Product.find({ _id: { $in: productIds } }).select('_id name image images').lean();
    docs.forEach((product) => productMap.set(String(product._id), product));
  }

  return normalizedItems.map((item) => {
    const normalizedId = item.productId.replace(/^db_/, '');
    const product = productMap.get(normalizedId) || [...productMap.values()].find((candidate) => String(candidate.name || '').trim().toLowerCase() === item.name.toLowerCase());
    const resolvedImage = item.image || getProductImageValue(product);
    return {
      productId: item.productId || normalizedId,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      image: resolvedImage
    };
  });
}

function mapProduct(product) {
  return {
    id: `db_${product._id}`,
    _id: product._id,
    name: product.name,
    price: product.price,
    category: product.category,
    description: product.description,
    image: product.image,
    images: product.images && product.images.length ? product.images : [product.image, product.image, product.image],
    tag: product.tag,
    outOfStock: product.outOfStock,
    sold: product.sold,
    statusIndicator: product.statusIndicator
  };
}

function clampPositiveInt(value, fallback, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\$&');
}

function buildProductFilter(query = {}) {
  const filter = {};
  const category = String(query.category || '').trim().toLowerCase();
  const status = String(query.status || '').trim().toLowerCase();
  const searchTerm = String(query.q || '').trim();

  if (category && category !== 'all') {
    filter.category = category;
  }

  if (status === 'instock') {
    filter.outOfStock = { $ne: true };
    filter.sold = { $ne: true };
  } else if (status === 'outofstock') {
    filter.outOfStock = true;
  } else if (status === 'sold') {
    filter.sold = true;
  } else if (status === 'new') {
    filter.tag = 'new';
  } else if (status === 'sale') {
    filter.tag = 'sale';
  }

  if (searchTerm) {
    const safeTerm = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: safeTerm, $options: 'i' } },
      { category: { $regex: safeTerm, $options: 'i' } },
      { description: { $regex: safeTerm, $options: 'i' } }
    ];
  }

  return filter;
}

async function getProductSummary() {
  const [totalProducts, inStock, outOfStock, sold] = await Promise.all([
    Product.countDocuments({}),
    Product.countDocuments({ sold: { $ne: true }, outOfStock: { $ne: true } }),
    Product.countDocuments({ sold: { $ne: true }, outOfStock: true }),
    Product.countDocuments({ sold: true })
  ]);

  return { totalProducts, inStock, outOfStock, sold };
}

async function getCategoryCounts() {
  const rows = await Product.aggregate([
    { $group: { _id: '$category', count: { $sum: 1 } } }
  ]);

  return rows.reduce((acc, row) => {
    const key = String(row._id || 'other').toLowerCase();
    acc[key] = Number(row.count || 0);
    return acc;
  }, {});
}

function serializeOrder(order, req) {
  const timeline = Array.isArray(order.statusTimeline) ? order.statusTimeline.map((entry) => ({
    status: entry.status,
    label: entry.label,
    note: entry.note || '',
    by: entry.by || '',
    at: entry.at
  })) : [];

  return {
    id: String(order._id),
    _id: String(order._id),
    orderRef: order.orderRef,
    reference: order.orderRef,
    paymentMethod: order.paymentMethod,
    status: order.status,
    email: order.email,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    amount: order.amount,
    subtotal: order.subtotal,
    shippingFee: order.shippingFee,
    shippingState: order.shippingState,
    items: order.items,
    transactionId: order.transactionId || '',
    proofUrl: order.proofUrl ? buildPublicFileUrl(order.proofUrl, req) : '',
    receiptPdfUrl: order.receiptPdfUrl ? buildPublicFileUrl(order.receiptPdfUrl, req) : '',
    verifiedAt: order.verifiedAt,
    verifiedBy: order.verifiedBy,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    paymentDate: order.verifiedAt || order.createdAt,
    statusTimeline: timeline,
    metadata: {
      customer_name: order.customerName,
      customer_phone: order.customerPhone,
      shipping_state: order.shippingState,
      shipping_fee: order.shippingFee,
      cart_items: order.items,
      transaction_id: order.transactionId || '',
      proof_url: order.proofUrl ? buildPublicFileUrl(order.proofUrl, req) : '',
      receipt_pdf_url: order.receiptPdfUrl ? buildPublicFileUrl(order.receiptPdfUrl, req) : ''
    }
  };
}

function pushTimeline(order, status, label, by = '', note = '') {
  order.statusTimeline = Array.isArray(order.statusTimeline) ? order.statusTimeline : [];
  order.statusTimeline.push({ status, label, by, note, at: new Date() });
}

async function generateUniqueOrderRef() {
  const date = new Date();
  const datePart = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  for (let i = 0; i < 10; i += 1) {
    const randomPart = crypto.randomBytes(4).toString('hex').slice(0, 8).toUpperCase();
    const orderRef = `FORTUNE-${datePart}-${randomPart}`;
    const existing = await Order.findOne({ orderRef }).select('_id').lean();
    if (!existing) return orderRef;
  }
  throw new Error('Could not generate unique order reference');
}

function emailShell({ title, eyebrow, body, accent = '#667eea' }) {
  const logoUrl = buildFrontendAssetUrl('/favicon.png');
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:Segoe UI,Arial,sans-serif;color:#1f2937;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;background:#ffffff;border-radius:22px;overflow:hidden;box-shadow:0 16px 42px rgba(17,24,39,.12);">
            <tr>
              <td style="padding:24px 28px 18px;background:linear-gradient(135deg, ${accent} 0%, #764ba2 100%);color:#fff;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <table cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td style="width:60px;height:60px;border-radius:18px;background:rgba(255,255,255,.14);padding:8px;text-align:center;vertical-align:middle;">
                            <img src="${logoUrl}" alt="FortuneHub logo" width="44" height="44" style="display:block;width:44px;height:44px;object-fit:contain;margin:0 auto;" />
                          </td>
                          <td style="padding-left:14px;vertical-align:middle;">
                            <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.92;font-weight:700;">${eyebrow}</div>
                            <h1 style="margin:10px 0 0;font-size:28px;line-height:1.2;">${title}</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">${body}</td>
            </tr>
            <tr>
              <td style="padding:18px 28px;background:#f8f9ff;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.7;">
                FortuneHub order and bank transfer notification service<br/>
                ${OWNER_EMAIL ? `Need help? Reply to this email or contact <a href="mailto:${OWNER_EMAIL}" style="color:${accent};text-decoration:none;">${OWNER_EMAIL}</a>.` : 'Need help? Reply to this email.'}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

function timelineHtml(order) {
  const steps = [
    { key: 'pending_payment', label: 'Order created' },
    { key: 'awaiting_verification', label: 'Proof uploaded' },
    { key: 'paid', label: 'Payment verified' },
    { key: 'cancelled', label: 'Order cancelled' }
  ];
  const doneStatuses = new Set((order.statusTimeline || []).map((entry) => entry.status));
  return `<div style="margin:18px 0 0;">
    ${steps.map((step, index) => {
      const done = doneStatuses.has(step.key) || (step.key === 'pending_payment');
      return `<div style="display:flex;align-items:flex-start;gap:12px;${index < steps.length - 1 ? 'margin-bottom:12px;' : ''}">
        <div style="width:14px;height:14px;border-radius:999px;margin-top:4px;background:${done ? '#10b981' : '#d1d5db'};"></div>
        <div>
          <div style="font-weight:700;color:#111827;">${step.label}</div>
          <div style="font-size:12px;color:#6b7280;">${done ? 'Completed' : 'Waiting'}</div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function itemRowsHtml(order, req) {
  return (order.items || []).map((item) => {
    const imageUrl = resolveDisplayImage(item.image || '', req);
    const thumb = imageUrl
      ? `<td style="padding-right:12px;vertical-align:top;"><img src="${imageUrl}" alt="${item.name}" width="54" height="54" style="display:block;width:54px;height:54px;border-radius:14px;object-fit:cover;border:1px solid #e5e7eb;background:#fff;" /></td>`
      : `<td style="padding-right:12px;vertical-align:top;"><div style="width:54px;height:54px;border-radius:14px;background:linear-gradient(135deg,rgba(102,126,234,.12),rgba(118,75,162,.12));display:flex;align-items:center;justify-content:center;color:#4361ee;border:1px dashed rgba(102,126,234,.2);font-size:22px;">📦</div></td>`;
    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #eef2f7;vertical-align:top;">
        <table cellpadding="0" cellspacing="0" border="0">
          <tr>
            ${thumb}
            <td style="vertical-align:top;"><div style="font-weight:700;color:#111827;line-height:1.45;">${item.name}</div></td>
          </tr>
        </table>
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #eef2f7;text-align:center;vertical-align:top;">${item.quantity}</td>
      <td style="padding:12px 0;border-bottom:1px solid #eef2f7;text-align:right;vertical-align:top;">${formatNaira(Number(item.price) * Number(item.quantity || 1))}</td>
    </tr>`;
  }).join('');
}

function buildOrderSummaryCard(order, tone = 'amber') {
  const palette = tone === 'green'
    ? { bg: '#ecfdf5', border: '#a7f3d0' }
    : { bg: '#fffaf0', border: '#fde68a' };
  const transactionHtml = order.transactionId
    ? `<div><strong>Txn ID / Narration:</strong> ${order.transactionId}</div>`
    : '';
  return `<div style="background:${palette.bg};border:1px solid ${palette.border};border-radius:16px;padding:18px;margin-bottom:18px;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;">
      <div><strong>Customer:</strong> ${order.customerName}</div>
      <div><strong>Email:</strong> ${order.email}</div>
      <div><strong>Phone:</strong> ${order.customerPhone}</div>
      <div><strong>Total:</strong> ${formatNaira(order.amount)}</div>
      <div><strong>Shipping fee:</strong> ${order.shippingState || 'N/A'}</div>
      ${transactionHtml}
    </div>
  </div>`;
}

function buildItemsTable(order, req) {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;font-size:14px;">
    <thead>
      <tr>
        <th style="text-align:left;padding:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;">Item</th>
        <th style="text-align:center;padding:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;">Qty</th>
        <th style="text-align:right;padding:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;">Amount</th>
      </tr>
    </thead>
    <tbody>${itemRowsHtml(order, req)}</tbody>
  </table>`;
}

function buildAdminProofEmail(order, req) {
  const proofLink = order.proofUrl ? buildPublicFileUrl(order.proofUrl, req) : '#';
  return emailShell({
    title: 'Payment proof uploaded',
    eyebrow: 'Admin notification',
    accent: '#f59e0b',
    body: `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">A customer has uploaded payment proof for order <strong>${order.orderRef}</strong> and the order is now awaiting verification.</p>
      ${buildOrderSummaryCard(order, 'amber')}
      ${buildItemsTable(order, req)}
      <div style="display:flex;flex-wrap:wrap;gap:12px;">
        <a href="${proofLink}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">View uploaded proof</a>
        <a href="${ADMIN_PANEL_URL}" style="display:inline-block;background:#f59e0b;color:#111827;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Open admin dashboard</a>
      </div>
      ${timelineHtml(order)}
    `
  });
}

function buildBuyerProofReceivedEmail(order, req) {
  return emailShell({
    title: 'We received your payment proof',
    eyebrow: 'Customer update',
    accent: '#4361ee',
    body: `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">Hi <strong>${order.customerName}</strong>, we have received the payment proof for order <strong>${order.orderRef}</strong>. Our team will verify it shortly and notify you once payment is confirmed.</p>
      ${buildOrderSummaryCard(order, 'amber')}
      ${buildItemsTable(order, req)}
      <div style="padding:16px 18px;border-radius:16px;background:#eef2ff;border:1px solid #c7d2fe;color:#312e81;font-size:14px;line-height:1.7;margin-bottom:18px;">
        Please keep your transaction details available in case our team needs to confirm the transfer narration or bank reference.
      </div>
      ${timelineHtml(order)}
    `
  });
}

function buildBuyerReceiptEmail(order, req) {
  const receiptLink = order.receiptPdfUrl ? buildPublicFileUrl(order.receiptPdfUrl, req) : '#';
  return emailShell({
    title: 'Your payment has been verified',
    eyebrow: 'Receipt enclosed',
    accent: '#10b981',
    body: `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">Hi <strong>${order.customerName}</strong>, your bank transfer for order <strong>${order.orderRef}</strong> has been verified successfully. Your receipt PDF is attached to this email.</p>
      ${buildOrderSummaryCard(order, 'green')}
      ${buildItemsTable(order, req)}
      <div style="display:grid;gap:10px;background:linear-gradient(180deg,#f8f9ff,#ffffff);border:1px solid #dbe4ff;border-radius:18px;padding:18px;margin-bottom:18px;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;font-weight:800;">Payment summary</div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;background:#ffffff;border:1px solid #e5e7eb;"><span style="font-size:13px;color:#6b7280;text-transform:uppercase;font-weight:800;">Subtotal</span><strong style="font-size:17px;color:#111827;">${formatNaira(order.subtotal)}</strong></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;background:#ffffff;border:1px solid #e5e7eb;"><span style="font-size:13px;color:#6b7280;text-transform:uppercase;font-weight:800;">Shipping fee</span><strong style="font-size:17px;color:#111827;">${formatNaira(order.shippingFee)}</strong></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-radius:16px;background:linear-gradient(135deg,#10b981,#059669);color:#ffffff;"><span style="font-size:13px;text-transform:uppercase;font-weight:900;letter-spacing:.08em;">Total paid</span><strong style="font-size:20px;color:#ffffff;">${formatNaira(order.amount)}</strong></div>
      </div>
      <a href="${receiptLink}" style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Download receipt PDF</a>
      ${timelineHtml(order)}
    `
  });
}


function buildBuyerCancelledEmail(order, req) {
  return emailShell({
    title: 'Your pending order was cancelled',
    eyebrow: 'Customer update',
    accent: '#ef4444',
    body: `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">Hi <strong>${order.customerName}</strong>, your pending bank transfer order <strong>${order.orderRef}</strong> has been cancelled successfully. If you still want these items, you can place a fresh order anytime.</p>
      ${buildOrderSummaryCard(order, 'amber')}
      ${buildItemsTable(order, req)}
      ${timelineHtml(order)}
    `
  });
}

function buildAdminCancelledEmail(order, req) {
  return emailShell({
    title: 'Pending order cancelled by buyer',
    eyebrow: 'Admin notification',
    accent: '#ef4444',
    body: `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">Order <strong>${order.orderRef}</strong> was cancelled by the buyer before payment proof was uploaded. The order has been removed from active admin processing.</p>
      ${buildOrderSummaryCard(order, 'amber')}
      ${buildItemsTable(order, req)}
      ${timelineHtml(order)}
    `
  });
}

async function sendEmail({ to, subject, html, attachments = [] }) {

  if (!RESEND_API_KEY || !to) return;
  try {
    await resend.emails.send({ from: MAIL_FROM, to, subject, html, attachments });
  } catch (error) {
    console.error(`❌ Email send failed (${subject}):`, error.message);
  }
}

async function generateReceiptPdf(order, req) {
  const safeRef = slugify(order.orderRef);
  const fileName = `${safeRef}.pdf`;
  const outputPath = path.join(receiptsDir, fileName);
  const publicPath = `/uploads/receipts/${fileName}`;

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42, size: 'A4' });
    const stream = fs.createWriteStream(outputPath);
    if (PDF_FONT_REGULAR_PATH) doc.registerFont(PDF_FONT_REGULAR, PDF_FONT_REGULAR_PATH);
    if (PDF_FONT_BOLD_PATH) doc.registerFont(PDF_FONT_BOLD, PDF_FONT_BOLD_PATH);
    doc.pipe(stream);

    const pageWidth = doc.page.width;
    const usableWidth = pageWidth - 84;
    const left = 42;
    const right = pageWidth - 42;

    const optionalDetailRows = order.transactionId
      ? [['Transaction ID / Narration', order.transactionId]]
      : [];

    doc.save();
    doc.roundedRect(left, 30, usableWidth, 104, 24).fill('#1d4ed8');
    doc.rect(left + usableWidth - 176, 30, 176, 104).fill('#dc2626');
    doc.rect(left, 30, 132, 104).fill('#f59e0b');
    doc.restore();

    doc.roundedRect(left + 12, 42, usableWidth - 24, 80, 20).fillOpacity(0.14).fill('#ffffff');
    doc.fillOpacity(1);
    doc.fillColor('#ffffff').fontSize(11).font(PDF_FONT_BOLD).text('OFFICIAL PAYMENT RECEIPT', left, 52, { width: usableWidth, align: 'center' });
    doc.fontSize(24).text('FortuneHub', left, 68, { width: usableWidth, align: 'center' });
    doc.font(PDF_FONT_REGULAR).fontSize(10.5).text(`Order Ref: ${order.orderRef}`, left, 96, { width: usableWidth, align: 'center' });
    doc.text(`Issued: ${formatDateWAT(order.verifiedAt || new Date())}`, left, 110, { width: usableWidth, align: 'center' });

    let y = 154;
    doc.fillColor('#111827').font(PDF_FONT_BOLD).fontSize(12).text('Customer details', left, y);
    y += 16;

    const detailRows = [
      ['Name', order.customerName],
      ['Email', order.email],
      ['Phone', order.customerPhone],
      ['Shipping fee', order.shippingState || 'N/A'],
      ['Payment method', `Bank transfer (${OPAY_BANK_NAME})`],
      ...optionalDetailRows
    ];

    detailRows.forEach(([label, value]) => {
      doc.roundedRect(left, y, usableWidth, 24, 8).fill('#f8fafc');
      doc.fillColor('#6b7280').font(PDF_FONT_BOLD).fontSize(9.5).text(label.toUpperCase(), left + 12, y + 8, { width: 150 });
      doc.fillColor('#111827').font(PDF_FONT_REGULAR).fontSize(10.5).text(String(value || '—'), left + 165, y + 7, { width: usableWidth - 177, align: 'left' });
      y += 30;
    });

    y += 6;
    doc.fillColor('#111827').font(PDF_FONT_BOLD).fontSize(12).text('Items purchased', left, y);
    y += 18;

    doc.roundedRect(left, y, usableWidth, 28, 10).fill('#eef2ff');
    doc.fillColor('#374151').font(PDF_FONT_BOLD).fontSize(10).text('Item', left + 14, y + 9, { width: 290 });
    doc.text('Qty', left + 312, y + 9, { width: 46, align: 'center' });
    doc.text('Amount', right - 116, y + 9, { width: 96, align: 'right' });
    y += 38;

    (order.items || []).forEach((item, index) => {
      const itemName = String(item.name || 'Item');
      const quantity = String(item.quantity || 1);
      const amount = formatNaira(Number(item.price || 0) * Number(item.quantity || 1));
      const nameHeight = doc.heightOfString(itemName, { width: 290, align: 'left' });
      const rowHeight = Math.max(24, nameHeight + 8);

      if (index % 2 === 0) {
        doc.roundedRect(left, y - 4, usableWidth, rowHeight + 8, 8).fill('#fcfcff');
      }
      doc.fillColor('#111827').font(PDF_FONT_REGULAR).fontSize(10.5).text(itemName, left + 14, y, { width: 290 });
      doc.fillColor('#374151').text(quantity, left + 312, y, { width: 46, align: 'center' });
      doc.fillColor('#111827').font(PDF_FONT_BOLD).text(amount, right - 116, y, { width: 96, align: 'right' });
      y += rowHeight + 8;
    });

    y += 6;
    const summaryWidth = 214;
    const summaryLeft = right - summaryWidth;
    doc.roundedRect(summaryLeft, y, summaryWidth, 118, 18).fill('#f8fafc');
    doc.fillColor('#4b5563').font(PDF_FONT_BOLD).fontSize(10).text('PAYMENT SUMMARY', summaryLeft + 16, y + 14, { width: summaryWidth - 32 });

    const drawSummaryRow = (label, value, rowY, emphasize = false) => {
      if (emphasize) {
        doc.roundedRect(summaryLeft + 12, rowY - 6, summaryWidth - 24, 36, 12).fill('#10b981');
        doc.fillColor('#ffffff').font(PDF_FONT_BOLD).fontSize(10).text(label.toUpperCase(), summaryLeft + 24, rowY + 7, { width: 88 });
        doc.fontSize(13).text(value, summaryLeft + 100, rowY + 5, { width: summaryWidth - 124, align: 'right' });
      } else {
        doc.fillColor('#6b7280').font(PDF_FONT_BOLD).fontSize(10).text(label.toUpperCase(), summaryLeft + 16, rowY, { width: 90 });
        doc.fillColor('#111827').font(PDF_FONT_BOLD).fontSize(11.5).text(value, summaryLeft + 98, rowY - 1, { width: summaryWidth - 114, align: 'right' });
      }
    };

    drawSummaryRow('Subtotal', formatNaira(order.subtotal), y + 42);
    drawSummaryRow('Shipping fee', formatNaira(order.shippingFee), y + 64);
    drawSummaryRow('Total paid', formatNaira(order.amount), y + 90, true);

    y += 142;
    doc.fillColor('#6b7280').font(PDF_FONT_REGULAR).fontSize(10).text(`Verified by: ${order.verifiedBy || 'Admin'}`, left, y);
    doc.text('Thank you for shopping with FortuneHub.', left, y + 16);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { outputPath, publicPath, publicUrl: buildPublicFileUrl(publicPath, req) };
}

const proofStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, proofsDir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${slugify(req.params.id)}-${Date.now()}${ext}`);
  }
});

const uploadProof = multer({
  storage: proofStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, WEBP, or PDF files are allowed.'), ok);
  }
});

app.get('/ping', (req, res) => res.json({ success: true, message: 'pong' }));
app.get('/', (req, res) => res.json({ success: true, message: 'FortuneHub backend running' }));
app.get('/health', (req, res) => res.json({ success: true, status: 'ok', dbState: mongoose.connection.readyState }));

app.get('/api/config/payment', (req, res) => {
  res.set('Cache-Control', 'public, max-age=900, s-maxage=900, stale-while-revalidate=86400');
  res.json({
    success: true,
    data: {
      paymentMethod: 'bank_transfer',
      paymentMethodLabel: 'Bank transfer',
      bankName: OPAY_BANK_NAME,
      accountName: OPAY_ACCOUNT_NAME,
      accountNumber: OPAY_ACCOUNT_NUMBER,
      opayAccountName: OPAY_ACCOUNT_NAME,
      opayAccountPhone: OPAY_ACCOUNT_NUMBER,
      whatsappHelpNumber: OPAY_WHATSAPP_NUMBER,
      whatsappHelpLink: OPAY_WHATSAPP_NUMBER
        ? `https://wa.me/${String(OPAY_WHATSAPP_NUMBER).replace(/\D/g, '')}`
        : '',
      instructions: [
        'Transfer the exact order amount to the bank account shown below.',
        'Use your order reference as payment narration if possible.',
        'After payment, upload your transfer proof for manual verification.'
      ]
    }
  });
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ success: false, message: 'Google credential required' });
    if (!GOOGLE_CLIENT_ID) return res.status(500).json({ success: false, message: 'GOOGLE_CLIENT_ID not configured on server' });

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload() || {};
    const { sub: googleId, email, name, picture } = payload;
    if (!email) return res.status(400).json({ success: false, message: 'Google account has no email' });

    let user = await User.findOne({ $or: [{ email: email.toLowerCase() }, { googleId }] });
    if (!user) {
      user = await User.create({
        googleId,
        email: email.toLowerCase(),
        name: name || email.split('@')[0],
        picture: picture || '',
        authProvider: 'google'
      });
    } else {
      user.googleId = googleId;
      user.name = name || user.name;
      user.picture = picture || user.picture;
      await user.save();
    }

    const token = issueJWT(user);
    return res.json({ success: true, token, user: {
      id: user._id,
      email: user.email,
      name: user.name,
      picture: user.picture || '',
      authProvider: user.authProvider,
      phone: user.phone || ''
    } });
  } catch (error) {
    console.error('❌ Google auth error:', error.message);
    return res.status(401).json({ success: false, message: 'Google authentication failed' });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ success: false, message: 'Name, email, and password are required' });
    if (String(password).length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    const existing = await User.findOne({ email: String(email).toLowerCase() });
    if (existing) return res.status(409).json({ success: false, message: 'An account with this email already exists. Please sign in.' });

    const user = await User.create({
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      password: await bcrypt.hash(String(password), 12),
      authProvider: 'email'
    });

    const token = issueJWT(user);
    return res.status(201).json({ success: true, token, user: {
      id: user._id,
      email: user.email,
      name: user.name,
      picture: '',
      authProvider: user.authProvider,
      phone: user.phone || ''
    } });
  } catch (error) {
    console.error('❌ Signup error:', error.message);
    return res.status(500).json({ success: false, message: 'Could not create account' });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user || !user.password) return res.status(401).json({ success: false, message: 'Invalid email or password' });

    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) return res.status(401).json({ success: false, message: 'Invalid email or password' });

    const token = issueJWT(user);
    return res.json({ success: true, token, user: {
      id: user._id,
      email: user.email,
      name: user.name,
      picture: user.picture || '',
      authProvider: user.authProvider,
      phone: user.phone || ''
    } });
  } catch (error) {
    console.error('❌ Signin error:', error.message);
    return res.status(500).json({ success: false, message: 'Could not sign in' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user.id).lean();
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  return res.json({ success: true, user: {
    id: user._id,
    email: user.email,
    name: user.name,
    picture: user.picture || '',
    authProvider: user.authProvider,
    phone: user.phone || ''
  } });
});

app.patch('/api/auth/me', authMiddleware, async (req, res) => {
  const { phone } = req.body || {};
  const user = await User.findByIdAndUpdate(req.user.id, { phone: String(phone || '').trim() }, { new: true });
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  return res.json({ success: true, user: {
    id: user._id,
    email: user.email,
    name: user.name,
    picture: user.picture || '',
    authProvider: user.authProvider,
    phone: user.phone || ''
  } });
});

app.post('/api/orders', authMiddleware, async (req, res) => {
  try {
    const { items, shippingState, shippingFee, customerPhone } = req.body || {};
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, message: 'Cart items are required' });
    if (!customerPhone) return res.status(400).json({ success: false, message: 'Customer phone is required' });

    const normalizedItems = await hydrateOrderItems(items);

    if (!normalizedItems.length) return res.status(400).json({ success: false, message: 'No valid cart items supplied' });

    const subtotal = normalizedItems.reduce((sum, item) => sum + (Number(item.price) * Number(item.quantity)), 0);
    const shipping = Math.max(0, Number(shippingFee || 0));
    const amount = subtotal + shipping;
    const orderRef = await generateUniqueOrderRef();

    const order = await Order.create({
      userId: user._id,
      email: user.email,
      customerName: user.name,
      customerPhone: String(customerPhone).trim(),
      shippingState: String(shippingState || '').trim(),
      shippingFee: shipping,
      subtotal,
      amount,
      items: normalizedItems,
      orderRef,
      paymentMethod: 'opay_manual',
      status: 'pending_payment',
      statusTimeline: [{ status: 'pending_payment', label: 'Order created', note: 'Awaiting bank transfer', by: user.email, at: new Date() }]
    });

    await User.findByIdAndUpdate(user._id, { phone: String(customerPhone).trim() }).catch(() => {});

    return res.status(201).json({ success: true, message: 'Order created successfully', data: serializeOrder(order, req) });
  } catch (error) {
    console.error('❌ Create order error:', error);
    return res.status(500).json({ success: false, message: 'Could not create order' });
  }
});

app.get('/api/orders/my', authMiddleware, async (req, res) => {
  const orders = await Order.find({ userId: req.user.id }).sort({ createdAt: -1 });
  return res.json({ success: true, count: orders.length, data: orders.map((order) => serializeOrder(order, req)) });
});

app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (String(order.userId) !== String(req.user.id)) return res.status(403).json({ success: false, message: 'Not authorized to view this order' });
  return res.json({ success: true, data: serializeOrder(order, req) });
});


app.post('/api/orders/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, hiddenFromAdmin: { $ne: true } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (String(order.userId) !== String(req.user.id)) return res.status(403).json({ success: false, message: 'Not authorized to update this order' });
    if (order.status !== 'pending_payment') {
      return res.status(400).json({ success: false, message: 'Only pending payment orders can be cancelled' });
    }

    order.status = 'cancelled';
    order.hiddenFromAdmin = true;
    pushTimeline(order, 'cancelled', 'Order cancelled', order.email, 'Buyer cancelled pending payment before admin processing');
    await order.save();

    await sendEmail({
      to: order.email,
      subject: `Your FortuneHub order ${order.orderRef} was cancelled`,
      html: buildBuyerCancelledEmail(order, req)
    });

    if (OWNER_EMAIL) {
      await sendEmail({
        to: OWNER_EMAIL,
        subject: `Buyer cancelled pending order ${order.orderRef}`,
        html: buildAdminCancelledEmail(order, req)
      });
    }

    return res.json({ success: true, message: 'Pending order cancelled successfully', data: serializeOrder(order, req) });
  } catch (error) {
    console.error('❌ Cancel order error:', error);
    return res.status(500).json({ success: false, message: 'Could not cancel order' });
  }
});

app.post('/api/orders/:id/proof', authMiddleware, (req, res, next) => {
  uploadProof.single('proof')(req, res, (error) => {
    if (error) return res.status(400).json({ success: false, message: error.message });
    return next();
  });
}, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (String(order.userId) !== String(req.user.id)) return res.status(403).json({ success: false, message: 'Not authorized to update this order' });
    if (!req.file) return res.status(400).json({ success: false, message: 'Payment proof file is required' });
    if (!['pending_payment', 'failed'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'This order is not accepting payment proof uploads' });
    }

    order.status = 'awaiting_verification';
    order.transactionId = String(req.body.transactionId || '').trim();
    order.proofUrl = `/uploads/proofs/${req.file.filename}`;
    order.proofFileName = req.file.originalname;
    pushTimeline(order, 'awaiting_verification', 'Proof uploaded', order.email, order.transactionId ? `Transaction ID: ${order.transactionId}` : 'Payment proof submitted');
    await order.save();

    if (OWNER_EMAIL) {
      await sendEmail({
        to: OWNER_EMAIL,
        subject: `Proof uploaded for ${order.orderRef}`,
        html: buildAdminProofEmail(order, req)
      });
    }

    return res.json({ success: true, message: 'Payment proof uploaded. Awaiting verification.', data: serializeOrder(order, req) });
  } catch (error) {
    console.error('❌ Upload proof error:', error);
    return res.status(500).json({ success: false, message: 'Could not upload payment proof' });
  }
});

app.get('/api/transactions/my', authMiddleware, async (req, res) => {
  const orders = await Order.find({ userId: req.user.id }).sort({ createdAt: -1 });
  return res.json({ success: true, count: orders.length, data: orders.map((order) => serializeOrder(order, req)) });
});

app.get('/api/transactions/receipt/:reference', authMiddleware, async (req, res) => {
  const order = await Order.findOne({ orderRef: req.params.reference, userId: req.user.id });
  if (!order) return res.status(404).json({ success: false, message: 'Receipt not found' });
  return res.json({ success: true, data: serializeOrder(order, req) });
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid admin credentials' });
  }
  return res.json({ success: true, token: issueAdminJWT(), admin: { username: ADMIN_USERNAME, name: ADMIN_DISPLAY_NAME } });
});

app.get('/api/admin/summary', verifyAdmin, async (req, res) => {
  const visibleFilter = { hiddenFromAdmin: { $ne: true } };
  const [productCount, pendingCount, paidCount, awaitingCount, revenueAgg] = await Promise.all([
    Product.countDocuments(),
    Order.countDocuments({ ...visibleFilter, status: 'pending_payment' }),
    Order.countDocuments({ ...visibleFilter, status: 'paid' }),
    Order.countDocuments({ ...visibleFilter, status: 'awaiting_verification' }),
    Order.aggregate([{ $match: { ...visibleFilter, status: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
  ]);
  return res.json({ success: true, data: {
    productCount,
    pendingPaymentCount: pendingCount,
    awaitingVerificationCount: awaitingCount,
    paidOrderCount: paidCount,
    totalRevenue: revenueAgg[0]?.total || 0
  } });
});

app.get('/api/admin/orders/pending', verifyAdmin, async (req, res) => {
  const orders = await Order.find({ hiddenFromAdmin: { $ne: true }, status: 'awaiting_verification' }).sort({ updatedAt: -1 });
  return res.json({ success: true, count: orders.length, data: orders.map((order) => serializeOrder(order, req)) });
});

app.get('/api/admin/orders', verifyAdmin, async (req, res) => {
  const { status = '', q = '' } = req.query;
  const filter = { hiddenFromAdmin: { $ne: true } };
  if (status) filter.status = status;
  if (q) {
    const regex = new RegExp(String(q).trim(), 'i');
    filter.$or = [
      { orderRef: regex },
      { email: regex },
      { customerName: regex },
      { customerPhone: regex },
      { transactionId: regex }
    ];
  }
  const orders = await Order.find(filter).sort({ updatedAt: -1, createdAt: -1 }).limit(200);
  return res.json({ success: true, count: orders.length, data: orders.map((order) => serializeOrder(order, req)) });
});

app.get('/api/admin/orders/:id', verifyAdmin, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, hiddenFromAdmin: { $ne: true } });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  return res.json({ success: true, data: serializeOrder(order, req) });
});

app.put('/api/admin/orders/:id/verify', verifyAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status === 'paid') return res.json({ success: true, message: 'Order already verified', data: serializeOrder(order, req) });
    if (order.status !== 'awaiting_verification') {
      return res.status(400).json({ success: false, message: 'Only awaiting_verification orders can be marked paid' });
    }

    order.status = 'paid';
    order.verifiedAt = new Date();
    order.verifiedBy = req.admin.username || ADMIN_USERNAME;
    pushTimeline(order, 'paid', 'Payment verified', order.verifiedBy, 'Admin marked order as paid');

    const receipt = await generateReceiptPdf(order, req);
    order.receiptPdfUrl = receipt.publicPath;
    await order.save();

    const pdfBase64 = fs.readFileSync(receipt.outputPath).toString('base64');
    await sendEmail({
      to: order.email,
      subject: `Your FortuneHub receipt for ${order.orderRef}`,
      html: buildBuyerReceiptEmail(order, req),
      attachments: [{ filename: path.basename(receipt.outputPath), content: pdfBase64 }]
    });

    return res.json({ success: true, message: 'Order verified successfully', data: serializeOrder(order, req) });
  } catch (error) {
    console.error('❌ Verify order error:', error);
    return res.status(500).json({ success: false, message: 'Could not verify order' });
  }
});

app.delete('/api/admin/orders/:id', verifyAdmin, async (req, res) => {
  try {
    const order = await Order.findOneAndDelete({ _id: req.params.id, hiddenFromAdmin: { $ne: true } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    return res.json({ success: true, message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error('❌ Delete order error:', error);
    return res.status(500).json({ success: false, message: 'Could not delete order' });
  }
});

app.delete('/api/admin/orders', verifyAdmin, async (req, res) => {
  try {
    const { status = '' } = req.query;
    const filter = { hiddenFromAdmin: { $ne: true } };
    if (status) filter.status = status;
    const result = await Order.deleteMany(filter);
    return res.json({ success: true, message: `${result.deletedCount} transaction${result.deletedCount === 1 ? '' : 's'} deleted`, deletedCount: result.deletedCount });
  } catch (error) {
    console.error('❌ Clear orders error:', error);
    return res.status(500).json({ success: false, message: 'Could not clear transactions' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const page = clampPositiveInt(req.query.page, 1, 10000);
    const limit = clampPositiveInt(req.query.limit, 24, 100);
    const filter = buildProductFilter(req.query);
    const includeCategoryCounts = String(req.query.includeCategoryCounts || '').toLowerCase() === 'true';
    const includeSummary = String(req.query.includeSummary || '').toLowerCase() === 'true' || String(req.query.adminView || '') === '1';

    const [total, categoryCounts, summary] = await Promise.all([
      Product.countDocuments(filter),
      includeCategoryCounts ? getCategoryCounts() : Promise.resolve(null),
      includeSummary ? getProductSummary() : Promise.resolve(null)
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const skip = (safePage - 1) * limit;

    const products = await Product.find(filter)
      .select('name price category description image images tag outOfStock sold statusIndicator createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    if (req.query.q || req.query.category || req.query.status || String(req.query.adminView || '') === '1') {
      res.set('Cache-Control', 'no-store');
    } else {
      res.set('Cache-Control', 'public, max-age=600, s-maxage=600, stale-while-revalidate=86400');
    }

    const payload = {
      success: true,
      count: products.length,
      data: products.map(mapProduct),
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages,
        hasPrev: safePage > 1,
        hasNext: safePage < totalPages
      }
    };

    if (categoryCounts) payload.categoryCounts = categoryCounts;
    if (summary) payload.summary = summary;

    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    return res.json({ success: true, data: product });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/products', verifyAdmin, async (req, res) => {
  try {
    const { name, price, category, description, image, images, tag, outOfStock, sold, statusIndicator } = req.body || {};
    if (!name || !price || !category) return res.status(400).json({ success: false, message: 'name, price, and category are required' });
    const product = await Product.create({
      name,
      price: Number(price),
      category: String(category).toLowerCase(),
      description: description || '',
      image: image || '',
      images: Array.isArray(images) ? images : (image ? [image] : []),
      tag: tag || 'none',
      outOfStock: Boolean(outOfStock),
      sold: Boolean(sold),
      statusIndicator: statusIndicator || 'available'
    });
    return res.status(201).json({ success: true, message: 'Product created successfully', data: product });
  } catch (error) {
    console.error('❌ Product create error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const { name, price, category, description, image, images, tag, outOfStock, sold, statusIndicator } = req.body || {};
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (price !== undefined) updateData.price = Number(price);
    if (category !== undefined) updateData.category = String(category).toLowerCase();
    if (description !== undefined) updateData.description = description;
    if (image !== undefined) updateData.image = image;
    if (images !== undefined) updateData.images = Array.isArray(images) ? images : (image ? [image] : []);
    if (tag !== undefined) updateData.tag = tag;
    if (outOfStock !== undefined) updateData.outOfStock = Boolean(outOfStock);
    if (sold !== undefined) updateData.sold = Boolean(sold);
    if (statusIndicator !== undefined) updateData.statusIndicator = statusIndicator;

    const product = await Product.findByIdAndUpdate(req.params.id, updateData, { new: true });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    return res.json({ success: true, message: 'Product updated successfully', data: product });
  } catch (error) {
    console.error('❌ Product update error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    return res.json({ success: true, message: `Product "${product.name}" deleted successfully` });
  } catch (error) {
    console.error('❌ Product delete error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  return res.status(500).json({ success: false, message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 FortuneHub backend listening on port ${PORT}`);
});

function gracefulExit(signal) {
  console.log(`\n${signal} received. Closing server...`);
  mongoose.connection.close(false).finally(() => process.exit(0));
}

process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
