// ================================================================
// FORTUNEHUB E-COMMERCE BACKEND SERVER (RENDER + MONGODB + RESEND)
// - Orders stored in MongoDB Atlas
// - Resend for owner + customer emails
// - Product images included in emails
// ================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { MongoClient, ObjectId } = require('mongodb');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 10000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ================================================================
// CORS
// ================================================================
function buildCorsOrigin() {
  const raw = (process.env.ALLOWED_ORIGINS || '').trim();

  // If not set, allow all
  if (!raw) return '*';

  // If user sets "*", allow all
  if (raw === '*') return '*';

  // Otherwise treat as comma-separated list
  const list = raw.split(',').map(x => x.trim()).filter(Boolean);
  return list.length ? list : '*';
}

app.use(cors({
  origin: buildCorsOrigin(),
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ================================================================
// MONGODB CONNECTION
// ================================================================
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set. Please configure MongoDB Atlas connection string.');
  process.exit(1);
}

const DB_NAME = process.env.MONGODB_DB_NAME || 'fortunehub';

let db;
let ordersCollection;
let transactionsCollection;

const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  maxPoolSize: 50,
  minPoolSize: 5,
  retryWrites: true,
  w: 'majority'
});

async function connectToDatabase() {
  let retries = 0;
  const maxRetries = 5;

  while (retries < maxRetries) {
    try {
      console.log(`🔄 Connecting to MongoDB Atlas... (Attempt ${retries + 1}/${maxRetries})`);
      await mongoClient.connect();

      // Ping test
      await mongoClient.db('admin').admin().ping();
      console.log('✅ Connected to MongoDB Atlas successfully!');

      db = mongoClient.db(DB_NAME);
      ordersCollection = db.collection('orders');
      transactionsCollection = db.collection('transactions');

      // Indexes (safe to run repeatedly; Mongo handles it)
      await ordersCollection.createIndex({ order_reference: 1 }, { unique: true });
      await ordersCollection.createIndex({ customer_email: 1 });
      await ordersCollection.createIndex({ created_at: -1 });
      await ordersCollection.createIndex({ payment_status: 1 });

      await transactionsCollection.createIndex({ userId: 1, createdAt: -1 });
      await transactionsCollection.createIndex({ reference: 1 }, { unique: true, sparse: true });
      await transactionsCollection.createIndex({ status: 1 });

      console.log('✅ Database indexes created successfully');
      return true;
    } catch (error) {
      retries++;
      console.error(`❌ MongoDB connection error (Attempt ${retries}/${maxRetries}):`, error.message);

      if (retries >= maxRetries) {
        console.error('❌ Failed to connect after maximum retries');
        throw error;
      }

      console.log('🔄 Retrying in 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

async function closeMongo() {
  try {
    await mongoClient.close();
    console.log('✅ MongoDB connection closed');
  } catch (e) {
    console.error('❌ Error closing MongoDB connection:', e.message);
  }
}

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  await closeMongo();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  await closeMongo();
  process.exit(0);
});

function requireDb(req, res, next) {
  if (!db || !ordersCollection) {
    return res.status(503).json({
      error: 'Database not connected yet',
      hint: 'Check Render logs + MongoDB Atlas connection string and network access'
    });
  }
  next();
}

// ================================================================
// RESEND
// ================================================================
if (!process.env.RESEND_API_KEY) {
  console.warn('⚠️ RESEND_API_KEY is not set. Emails will fail until configured.');
}
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const OWNER_EMAIL = process.env.OWNER_EMAIL;

// Base URL for your frontend assets (used to convert relative image paths to absolute URLs)
// Example: https://kolapodev-a11y.github.io/Fortunehub-frontend/
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://kolapodev-a11y.github.io/Fortunehub-frontend/';

// ================================================================
// PAYSTACK
// ================================================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ================================================================
// BASIC AUTH (Admin)
// ================================================================
function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');

    // NOTE: avoid ":" in ADMIN_PASSWORD because this split uses ":" separator
    const [username, password] = credentials.split(':');

    const validUsername = process.env.ADMIN_USERNAME || 'admin';
    const validPassword = process.env.ADMIN_PASSWORD || 'admin123';

    if (username === validUsername && password === validPassword) return next();
    return res.status(401).json({ error: 'Invalid credentials' });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid authorization header' });
  }
}

// ================================================================
// HELPERS
// ================================================================
function formatCurrency(amountInKobo) {
  return `₦${(Number(amountInKobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

function toAbsoluteAssetUrl(urlOrPath) {
  const v = String(urlOrPath || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;

  try {
    // Remove leading slash so URL(base, path) works consistently
    const p = v.startsWith('/') ? v.slice(1) : v;
    return new URL(p, FRONTEND_BASE_URL).toString();
  } catch (_) {
    return '';
  }
}

function normalizeProducts(metadata) {
  const p = metadata?.products ?? metadata?.product_names ?? metadata?.product ?? null;
  if (Array.isArray(p)) return p;
  if (p && typeof p === 'object') return [p];
  if (typeof p === 'string' && p.trim()) {
    return p.split(',').map(x => ({ name: x.trim() })).filter(x => x.name);
  }
  return [];
}

function normalizeCartItems(metadata) {
  const c = metadata?.cart_items ?? null;
  if (Array.isArray(c)) return c;
  if (c && typeof c === 'object') return [c];
  return [];
}

function paginate(total, page, limit) {
  const totalPages = Math.ceil(total / limit) || 1;
  return {
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1
  };
}

// ================================================================
// HEALTHCHECK
// ================================================================
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'FortuneHub E-Commerce API',
    version: '2.0.1',
    timestamp: new Date().toISOString(),
    database: db ? '✅ MongoDB Connected' : '❌ MongoDB Disconnected',
    email: resend ? '✅ Resend Configured' : '⚠️ Resend Not Configured',
    payment: PAYSTACK_SECRET_KEY ? '✅ Paystack Configured' : '⚠️ Paystack Not Configured',
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/health', async (req, res) => {
  try {
    const dbHealth = db ? await db.admin().ping() : null;

    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: dbHealth ? 'connected' : 'disconnected',
      memory: {
        used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
        total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`
      }
    });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message });
  }
});

// ================================================================
// VERIFY PAYMENT + CREATE ORDER
// ================================================================
app.post('/api/verify-payment', requireDb, async (req, res) => {
  console.log('📨 Payment verification request received');

  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: 'Payment reference is required' });
    if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY is not configured' });

    console.log('🔍 Verifying payment reference:', reference);

    const paystackResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    const paymentData = paystackResponse.data?.data;
    if (!paymentData) return res.status(500).json({ error: 'Invalid Paystack response (no data)' });
    if (paymentData.status !== 'success') {
      return res.status(400).json({ error: 'Payment verification failed', status: paymentData.status });
    }

    const metadata = paymentData.metadata || {};
    const customFields = Array.isArray(metadata.custom_fields) ? metadata.custom_fields : [];

    const getCustomField = (key) => {
      const f = customFields.find(x => x?.variable_name === key || x?.display_name === key);
      return f?.value;
    };

    const customerName = metadata.customer_name || getCustomField('customer_name') || 'Unknown Customer';
    const customerEmail =
      metadata.customer_email ||
      getCustomField('customer_email') ||
      paymentData.customer?.email ||
      'unknown@email';

    const customerPhone = metadata.customer_phone || getCustomField('customer_phone') || 'N/A';
    const shippingState = metadata.shipping_state || getCustomField('shipping_state') || 'Unknown';

    const shippingFee = (metadata.shipping_fee ?? getCustomField('shipping_fee') ?? 0);
    const shippingFeeNaira = parseInt(shippingFee, 10) || 0;
    const shippingFeeKobo = shippingFeeNaira * 100;

    const totalAmount = Number(paymentData.amount || 0); // KOBO
    const subtotal = totalAmount - shippingFeeKobo;

    const products = normalizeProducts(metadata) || normalizeProducts({ products: getCustomField('products') }) || [];
    const cartItems = normalizeCartItems(metadata) || normalizeCartItems({ cart_items: getCustomField('cart_items') }) || [];

    console.log('💾 Saving order to MongoDB...');
    console.log('📧 Customer Email extracted:', customerEmail);

    const orderData = {
      order_reference: reference,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
      shipping_state: shippingState,
      shipping_fee: shippingFeeNaira,
      subtotal,
      total_amount: totalAmount,
      products,
      cart_items: cartItems,
      payment_status: 'success',
      created_at: new Date(),
      updated_at: new Date()
    };

    const insertResult = await ordersCollection.insertOne(orderData);
    const orderId = insertResult.insertedId;

    // Send emails async (don't block response)
    sendOrderEmail({
      orderReference: reference,
      customerName,
      customerEmail,
      customerPhone,
      shippingState,
      shippingFee: shippingFeeNaira,
      subtotal,
      totalAmount,
      products,
      cartItems
    }).catch(err => console.error('❌ Email send failed:', err.message));

    return res.json({
      success: true,
      message: 'Payment verified and order saved successfully! Emails are being sent.',
      reference,
      orderId: orderId.toString()
    });
  } catch (error) {
    console.error('❌ Verification error:', error?.response?.data || error.message);
    return res.status(500).json({
      error: 'Payment verification failed',
      details: error?.response?.data || error.message
    });
  }
});

// ================================================================
// EMAIL SENDING (RESEND) - WITH PRODUCT IMAGES
// ================================================================
async function sendOrderEmail(orderData) {
  const {
    orderReference,
    customerName,
    customerEmail,
    customerPhone,
    shippingState,
    shippingFee,
    subtotal,
    totalAmount,
    products,
    cartItems
  } = orderData;

  if (!resend || !RESEND_FROM_EMAIL) {
    console.warn('⚠️ Resend not configured. Skipping email sending.');
    return;
  }

  const cleanPhone = String(customerPhone || '').trim();
  const whatsappNumber = cleanPhone && cleanPhone !== 'N/A'
    ? cleanPhone.replace(/^0/, '234').replace(/[^\d]/g, '')
    : '';
  const whatsappLink = whatsappNumber ? `https://wa.me/${whatsappNumber}` : '#';

  const items = Array.isArray(cartItems) ? cartItems : [];

  // Build MOBILE-FRIENDLY cart items HTML (stacked cards)
  // Wide 5-column tables often break on phones in Gmail.
  const cartItemsHtml = items.length
    ? items.map((item) => {
      const name = item?.name || 'Item';
      const qty = Number(item?.quantity || 1);
      const priceKobo = Number(item?.price || 0);

      // Convert relative image paths (e.g. images/product1.jpg) to absolute URLs
      const rawImage = item?.image || item?.imageUrl || '';
      const imageUrl = toAbsoluteAssetUrl(rawImage);

      const imageBlock = imageUrl
        ? `
          <img
            src="${imageUrl}"
            alt="${name}"
            width="80"
            height="80"
            style="display:block;width:80px;height:80px;object-fit:cover;border-radius:10px;border:1px solid #e6e6e6;background:#fff;"
          />
        `
        : `
          <div style="width:80px;height:80px;border-radius:10px;border:1px solid #e6e6e6;background:#f3f4f6;color:#6b7280;font-size:12px;line-height:80px;text-align:center;">
            No Image
          </div>
        `;

      return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#ffffff;border:1px solid #eeeeee;border-radius:12px;margin:0 0 12px 0;">
          <tr>
            <td style="padding:12px;vertical-align:top;width:92px;">
              ${imageBlock}
            </td>
            <td style="padding:12px;vertical-align:top;">
              <div style="font-size:15px;font-weight:700;color:#111827;margin:0 0 6px 0;">${name}</div>
              <div style="font-size:13px;color:#6b7280;margin:0 0 6px 0;">Qty: <strong style="color:#111827;">${qty}</strong></div>
              <div style="font-size:13px;color:#6b7280;margin:0 0 6px 0;">Price: <strong style="color:#111827;">${formatCurrency(priceKobo)}</strong></div>
              <div style="font-size:14px;color:#111827;margin:0;">Line Total: <strong>${formatCurrency(priceKobo * qty)}</strong></div>
            </td>
          </tr>
        </table>
      `;
    }).join('')
    : `
      <div style="padding:12px;background:#fff;border:1px solid #eee;border-radius:12px;color:#666;text-align:center;">
        (No cart items received)
      </div>
    `;

  const productsList = Array.isArray(products) && products.length
    ? `<ul>${products.map(p => `<li>${p?.name || JSON.stringify(p)}</li>`).join('')}</ul>`
    : `<p style="color:#666;">No products field provided.</p>`;

  const ownerEmailHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.55; color:#111827; background:#f3f4f6; padding:16px;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
        <div style="padding:18px 18px 14px;background:#111827;color:#ffffff;">
          <div style="font-size:18px;font-weight:800;">🎉 New Order Received!</div>
          <div style="font-size:13px;opacity:0.9;">FortuneHub Admin Notification</div>
        </div>

        <div style="padding:18px;">
          <p style="margin:0 0 8px 0;"><strong>Order Reference:</strong> <span style="font-family:monospace;">${orderReference}</span></p>
          <p style="margin:0 0 14px 0;"><strong>Date:</strong> ${new Date().toLocaleString()}</p>

          <div style="padding:12px;border:1px solid #eee;border-radius:12px;background:#fafafa;margin:0 0 14px 0;">
            <div style="font-weight:800;margin:0 0 8px 0;">👤 Customer Details</div>
            <div style="font-size:14px;"><strong>Name:</strong> ${customerName}</div>
            <div style="font-size:14px;"><strong>Email:</strong> ${customerEmail}</div>
            <div style="font-size:14px;"><strong>Phone:</strong> ${customerPhone}</div>
            <div style="font-size:14px;"><strong>Shipping State:</strong> ${shippingState}</div>
          </div>

          <div style="margin:0 0 14px 0;">
            <div style="font-weight:800;margin:0 0 8px 0;">🛒 Cart Items</div>
            ${cartItemsHtml}
          </div>

          <div style="padding:12px;border:1px solid #eee;border-radius:12px;background:#ffffff;margin:0 0 14px 0;">
            <div style="display:flex;justify-content:space-between;gap:10px;font-size:14px;margin:0 0 6px 0;"><span>Subtotal</span><strong>${formatCurrency(subtotal)}</strong></div>
            <div style="display:flex;justify-content:space-between;gap:10px;font-size:14px;margin:0 0 6px 0;"><span>Shipping Fee</span><strong>₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</strong></div>
            <div style="display:flex;justify-content:space-between;gap:10px;font-size:16px;margin:0;"><span>TOTAL PAID</span><strong>${formatCurrency(totalAmount)}</strong></div>
          </div>

          <div style="margin:0 0 14px 0;">
            <div style="font-weight:800;margin:0 0 8px 0;">🧾 Products (JSON)</div>
            ${productsList}
          </div>

          <p style="margin:0;">
            <a href="${whatsappLink}" style="display:inline-block; padding:12px 16px; background:#25D366; color:#fff; text-decoration:none; border-radius:10px; font-weight:700;">
              💬 Contact Customer on WhatsApp
            </a>
          </p>
        </div>
      </div>
    </div>
  `;

  const customerEmailHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.55; color:#111827; background:#f3f4f6; padding:16px;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
        <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:22px 18px;text-align:center;">
          <div style="font-size:22px;font-weight:900;color:#fff;">✅ Order Confirmed!</div>
          <div style="font-size:13px;color:#eef2ff;">Thank you for shopping with FortuneHub</div>
        </div>

        <div style="padding:18px;">
          <p style="margin:0 0 10px 0;font-size:15px;">Hi <strong>${customerName}</strong>,</p>
          <p style="margin:0 0 14px 0;">Your payment was successful and your order is being processed.</p>

          <div style="padding:12px;border:1px solid #eee;border-radius:12px;background:#fafafa;margin:0 0 14px 0;">
            <div style="font-size:13px;"><strong>Order Reference:</strong> <span style="font-family:monospace;">${orderReference}</span></div>
            <div style="font-size:13px;"><strong>Date:</strong> ${new Date().toLocaleString('en-NG')}</div>
          </div>

          <div style="margin:0 0 14px 0;">
            <div style="font-weight:800;margin:0 0 8px 0;">🧾 Your Items</div>
            ${cartItemsHtml}
          </div>

          <div style="padding:12px;border:1px solid #eee;border-radius:12px;background:#ffffff;margin:0 0 14px 0;">
            <div style="display:flex;justify-content:space-between;gap:10px;font-size:14px;margin:0 0 6px 0;"><span>Subtotal</span><strong>${formatCurrency(subtotal)}</strong></div>
            <div style="display:flex;justify-content:space-between;gap:10px;font-size:14px;margin:0 0 6px 0;"><span>Shipping Fee (${shippingState})</span><strong>₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</strong></div>
            <div style="display:flex;justify-content:space-between;gap:10px;font-size:16px;margin:0;"><span>TOTAL PAID</span><strong style="color:#667eea;">${formatCurrency(totalAmount)}</strong></div>
          </div>

          <p style="margin:0;color:#6b7280;font-size:12px;padding-top:14px;border-top:1px solid #eee;">
            Need help? Reply to this email.<br>
            Reference: ${orderReference}
          </p>
        </div>
      </div>
    </div>
  `;

  async function sendEmailSafe({ to, subject, html }) {
    const result = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to,
      subject,
      html,
      // replyTo: 'support@yourdomain.com', // optional when you get a domain
    });

    // resends SDK returns { data, error }
    if (result?.error) {
      throw new Error(result.error.message || 'Resend error');
    }

    return result?.data;
  }

  // OWNER
  if (OWNER_EMAIL) {
    await sendEmailSafe({
      to: OWNER_EMAIL,
      subject: `🛒 New Order - ${orderReference} - ${customerName}`,
      html: ownerEmailHtml
    });
    console.log('✅ Owner email sent via Resend!');
  } else {
    console.warn('⚠️ OWNER_EMAIL not configured, skipping owner notification.');
  }

  // CUSTOMER
  if (customerEmail && customerEmail !== 'unknown@email') {
    await sendEmailSafe({
      to: customerEmail,
      subject: `✅ Order Confirmation - ${orderReference} - FortuneHub`,
      html: customerEmailHtml
    });
    console.log('✅ Customer email sent via Resend!');
  } else {
    console.warn('⚠️ Invalid customer email, skipping customer confirmation.');
  }
}

// ================================================================
// PUBLIC: GET ORDERS
// ================================================================
app.get('/api/orders', requireDb, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.email) query.customer_email = req.query.email;
    if (req.query.status) query.payment_status = req.query.status;

    const [orders, total] = await Promise.all([
      ordersCollection.find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      ordersCollection.countDocuments(query)
    ]);

    return res.json({
      success: true,
      count: orders.length,
      total,
      pagination: paginate(total, page, limit),
      orders
    });
  } catch (error) {
    console.error('❌ Error fetching orders:', error.message);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ================================================================
// PUBLIC: GET ORDER BY REFERENCE
// ================================================================
app.get('/api/orders/:reference', requireDb, async (req, res) => {
  try {
    const { reference } = req.params;
    const order = await ordersCollection.findOne({ order_reference: reference });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    return res.json({ success: true, order });
  } catch (error) {
    console.error('❌ Error fetching order:', error.message);
    return res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ================================================================
// ADMIN: GET ALL ORDERS
// ================================================================
app.get('/api/admin/orders', requireDb, basicAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.status) query.payment_status = req.query.status;
    if (req.query.email) query.customer_email = new RegExp(req.query.email, 'i');
    if (req.query.search) {
      query.$or = [
        { customer_name: new RegExp(req.query.search, 'i') },
        { customer_email: new RegExp(req.query.search, 'i') },
        { order_reference: new RegExp(req.query.search, 'i') }
      ];
    }

    const [orders, total] = await Promise.all([
      ordersCollection.find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      ordersCollection.countDocuments(query)
    ]);

    return res.json({
      success: true,
      count: orders.length,
      total,
      pagination: paginate(total, page, limit),
      orders
    });
  } catch (error) {
    console.error('❌ Error fetching admin orders:', error.message);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ================================================================
// ADMIN: STATS
// ================================================================
app.get('/api/admin/stats', requireDb, basicAuth, async (req, res) => {
  try {
    const [totalOrders, successfulOrders, totalRevenueArr, todayOrders] = await Promise.all([
      ordersCollection.countDocuments(),
      ordersCollection.countDocuments({ payment_status: 'success' }),
      ordersCollection.aggregate([
        { $match: { payment_status: 'success' } },
        { $group: { _id: null, total: { $sum: '$total_amount' } } }
      ]).toArray(),
      ordersCollection.countDocuments({
        created_at: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
      })
    ]);

    const totalRevenue = totalRevenueArr[0]?.total || 0;

    return res.json({
      success: true,
      stats: {
        totalOrders,
        successfulOrders,
        totalRevenue,
        todayOrders,
        revenueFormatted: formatCurrency(totalRevenue)
      }
    });
  } catch (error) {
    console.error('❌ Error fetching stats:', error.message);
    return res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// ================================================================
// ADMIN: DELETE ORDER
// ================================================================
app.delete('/api/admin/orders/:id', requireDb, basicAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid order ID' });

    const result = await ordersCollection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Order not found' });

    return res.json({ success: true, message: 'Order deleted successfully' });
  } catch (error) {
    console.error('❌ Error deleting order:', error.message);
    return res.status(500).json({ error: 'Failed to delete order' });
  }
});

// ================================================================
// 404
// ================================================================
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path, method: req.method });
});

// ================================================================
// START SERVER - FIXED TEMPLATE LITERAL
// ================================================================
async function startServer() {
  try {
    await connectToDatabase();

    app.listen(PORT, '0.0.0.0', () => {
      console.log('='.repeat(60));
      console.log('✅ FORTUNEHUB BACKEND SERVER STARTED SUCCESSFULLY!');
      console.log('='.repeat(60));
      console.log(`🌐 Server running on port: ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`💾 Database: ${db ? 'Connected to MongoDB Atlas' : 'Disconnected'}`);
      console.log(`📧 Email service: ${resend ? 'Resend Enabled' : 'Resend Disabled'}`);
      console.log(`💳 Payment: ${PAYSTACK_SECRET_KEY ? 'Paystack Enabled' : 'Paystack Disabled'}`);
      console.log('='.repeat(60));
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();
