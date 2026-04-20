const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
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
const OPAY_ACCOUNT_NAME = process.env.OPAY_ACCOUNT_NAME || 'FortuneHub';
const OPAY_ACCOUNT_PHONE = process.env.OPAY_ACCOUNT_PHONE || '';
const OPAY_WHATSAPP_NUMBER = process.env.OPAY_WHATSAPP_NUMBER || OPAY_ACCOUNT_PHONE || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Fortunehub <hello@fortunehub.name.ng>';

const resend = new Resend(RESEND_API_KEY);
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const uploadsDir = path.join(__dirname, 'uploads');
const proofsDir = path.join(uploadsDir, 'proofs');
const receiptsDir = path.join(uploadsDir, 'receipts');
for (const dir of [uploadsDir, proofsDir, receiptsDir]) {
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
app.use('/uploads', express.static(uploadsDir));

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
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 12px 40px rgba(17,24,39,.12);">
            <tr>
              <td style="padding:28px 28px 18px;background:linear-gradient(135deg, ${accent} 0%, #764ba2 100%);color:#fff;">
                <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.92;font-weight:700;">${eyebrow}</div>
                <h1 style="margin:10px 0 0;font-size:28px;line-height:1.2;">${title}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">${body}</td>
            </tr>
            <tr>
              <td style="padding:18px 28px;background:#f8f9ff;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.6;">
                FortuneHub manual Opay transfer system<br/>
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
    { key: 'paid', label: 'Payment verified' }
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

function buildAdminProofEmail(order, req) {
  const proofLink = order.proofUrl ? buildPublicFileUrl(order.proofUrl, req) : '#';
  const itemsRows = order.items.map((item) => `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #eef2f7;">${item.name}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eef2f7;text-align:center;">${item.quantity}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eef2f7;text-align:right;">${formatNaira(Number(item.price) * Number(item.quantity || 1))}</td>
    </tr>`).join('');

  return emailShell({
    title: 'Payment proof uploaded',
    eyebrow: 'Admin notification',
    accent: '#f59e0b',
    body: `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">A customer has uploaded payment proof for order <strong>${order.orderRef}</strong> and the order is now awaiting verification.</p>
      <div style="background:#fffaf0;border:1px solid #fde68a;border-radius:14px;padding:18px;margin-bottom:18px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;">
          <div><strong>Customer:</strong> ${order.customerName}</div>
          <div><strong>Email:</strong> ${order.email}</div>
          <div><strong>Phone:</strong> ${order.customerPhone}</div>
          <div><strong>Total:</strong> ${formatNaira(order.amount)}</div>
          <div><strong>Shipping:</strong> ${order.shippingState || 'N/A'}</div>
          <div><strong>Txn ID:</strong> ${order.transactionId || 'Not provided'}</div>
        </div>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;font-size:14px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;">Item</th>
            <th style="text-align:center;padding:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;">Qty</th>
            <th style="text-align:right;padding:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;">Amount</th>
          </tr>
        </thead>
        <tbody>${itemsRows}</tbody>
      </table>
      <div style="display:flex;flex-wrap:wrap;gap:12px;">
        <a href="${proofLink}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">View uploaded proof</a>
        <a href="${ADMIN_PANEL_URL}" style="display:inline-block;background:#f59e0b;color:#111827;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Open admin dashboard</a>
      </div>
      ${timelineHtml(order)}
    `
  });
}

function buildBuyerReceiptEmail(order, req) {
  const receiptLink = order.receiptPdfUrl ? buildPublicFileUrl(order.receiptPdfUrl, req) : '#';
  const itemsRows = order.items.map((item) => `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #eef2f7;">${item.name}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eef2f7;text-align:center;">${item.quantity}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eef2f7;text-align:right;">${formatNaira(Number(item.price) * Number(item.quantity || 1))}</td>
    </tr>`).join('');

  return emailShell({
    title: 'Your payment has been verified',
    eyebrow: 'Receipt enclosed',
    accent: '#10b981',
    body: `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">Hi <strong>${order.customerName}</strong>, your Opay transfer for order <strong>${order.orderRef}</strong> has been verified successfully. Your receipt PDF is attached to this email.</p>
      <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:14px;padding:18px;margin-bottom:18px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;">
          <div><strong>Status:</strong> Paid</div>
          <div><strong>Verified:</strong> ${order.verifiedAt ? formatDateWAT(order.verifiedAt) : '—'}</div>
          <div><strong>Total:</strong> ${formatNaira(order.amount)}</div>
          <div><strong>Order ref:</strong> ${order.orderRef}</div>
          <div><strong>Shipping:</strong> ${order.shippingState || 'N/A'}</div>
          <div><strong>Transaction ID:</strong> ${order.transactionId || 'Not provided'}</div>
        </div>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;font-size:14px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;">Item</th>
            <th style="text-align:center;padding:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;">Qty</th>
            <th style="text-align:right;padding:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;">Amount</th>
          </tr>
        </thead>
        <tbody>${itemsRows}</tbody>
      </table>
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;background:#f8f9ff;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin-bottom:18px;">
        <div><div style="font-size:12px;color:#6b7280;text-transform:uppercase;">Subtotal</div><div style="font-size:18px;font-weight:800;">${formatNaira(order.subtotal)}</div></div>
        <div><div style="font-size:12px;color:#6b7280;text-transform:uppercase;">Shipping</div><div style="font-size:18px;font-weight:800;">${formatNaira(order.shippingFee)}</div></div>
        <div><div style="font-size:12px;color:#6b7280;text-transform:uppercase;">Total paid</div><div style="font-size:18px;font-weight:800;color:#10b981;">${formatNaira(order.amount)}</div></div>
      </div>
      <a href="${receiptLink}" style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Download receipt PDF</a>
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
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.fontSize(24).fillColor('#1f2937').text('FortuneHub Receipt', { align: 'center' });
    doc.moveDown(0.6);
    doc.fontSize(12).fillColor('#6b7280').text(`Order Ref: ${order.orderRef}`, { align: 'center' });
    doc.text(`Issued: ${formatDateWAT(order.verifiedAt || new Date())}`, { align: 'center' });
    doc.moveDown(1.5);

    doc.fontSize(14).fillColor('#111827').text('Customer Details');
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor('#374151');
    doc.text(`Name: ${order.customerName}`);
    doc.text(`Email: ${order.email}`);
    doc.text(`Phone: ${order.customerPhone}`);
    doc.text(`Shipping State: ${order.shippingState || 'N/A'}`);
    doc.text(`Payment Method: Opay manual transfer`);
    doc.text(`Transaction ID: ${order.transactionId || 'Not provided'}`);
    doc.moveDown(1.2);

    doc.fontSize(14).fillColor('#111827').text('Items');
    doc.moveDown(0.5);

    const startY = doc.y;
    doc.fontSize(11).fillColor('#6b7280');
    doc.text('Item', 50, startY);
    doc.text('Qty', 320, startY, { width: 50, align: 'center' });
    doc.text('Price', 400, startY, { width: 140, align: 'right' });
    doc.moveTo(50, startY + 18).lineTo(545, startY + 18).strokeColor('#e5e7eb').stroke();

    let y = startY + 28;
    order.items.forEach((item) => {
      doc.fontSize(11).fillColor('#111827');
      doc.text(item.name, 50, y, { width: 250 });
      doc.text(String(item.quantity || 1), 320, y, { width: 50, align: 'center' });
      doc.text(formatNaira(Number(item.price || 0) * Number(item.quantity || 1)), 400, y, { width: 140, align: 'right' });
      y += 24;
    });

    y += 10;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#e5e7eb').stroke();
    y += 15;
    doc.fontSize(12).fillColor('#374151');
    doc.text(`Subtotal: ${formatNaira(order.subtotal)}`, 340, y, { width: 200, align: 'right' });
    y += 20;
    doc.text(`Shipping: ${formatNaira(order.shippingFee)}`, 340, y, { width: 200, align: 'right' });
    y += 20;
    doc.fontSize(14).fillColor('#10b981').text(`Total Paid: ${formatNaira(order.amount)}`, 320, y, { width: 220, align: 'right' });

    y += 40;
    doc.fontSize(11).fillColor('#6b7280').text(`Verified by: ${order.verifiedBy || 'Admin'}`, 50, y);
    doc.text('Thank you for shopping with FortuneHub.', 50, y + 20);

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
  res.json({
    success: true,
    data: {
      paymentMethod: 'opay_manual',
      opayAccountName: OPAY_ACCOUNT_NAME,
      opayAccountPhone: OPAY_ACCOUNT_PHONE,
      whatsappHelpNumber: OPAY_WHATSAPP_NUMBER,
      whatsappHelpLink: OPAY_WHATSAPP_NUMBER
        ? `https://wa.me/${String(OPAY_WHATSAPP_NUMBER).replace(/\D/g, '')}`
        : '',
      instructions: [
        'Transfer the exact order amount to the Opay account/phone shown below.',
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

    const normalizedItems = items.map((item) => ({
      productId: String(item.id || item.productId || ''),
      name: String(item.name || '').trim(),
      price: Number(item.price || 0),
      quantity: Math.max(1, Number(item.quantity || 1)),
      image: String(item.image || '')
    })).filter((item) => item.name && item.price >= 0);

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
  const [productCount, pendingCount, paidCount, awaitingCount, revenueAgg] = await Promise.all([
    Product.countDocuments(),
    Order.countDocuments({ status: 'pending_payment' }),
    Order.countDocuments({ status: 'paid' }),
    Order.countDocuments({ status: 'awaiting_verification' }),
    Order.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
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
  const orders = await Order.find({ status: 'awaiting_verification' }).sort({ updatedAt: -1 });
  return res.json({ success: true, count: orders.length, data: orders.map((order) => serializeOrder(order, req)) });
});

app.get('/api/admin/orders', verifyAdmin, async (req, res) => {
  const { status = '', q = '' } = req.query;
  const filter = {};
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
  const order = await Order.findById(req.params.id);
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

app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=60');
    return res.json({ success: true, count: products.length, data: products.map(mapProduct) });
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
