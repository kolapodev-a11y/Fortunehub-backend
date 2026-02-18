// ================================================================
// FORTUNEHUB E-COMMERCE BACKEND SERVER (RENDER + MONGODB + RESEND)
// FIXED VERSION - Mobile Responsive Emails + Image Display + Better Logging
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
  if (!raw) return '*';
  if (raw === '*') return '*';
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
      await mongoClient.db('admin').admin().ping();
      console.log('✅ Connected to MongoDB Atlas successfully!');

      db = mongoClient.db(DB_NAME);
      ordersCollection = db.collection('orders');
      transactionsCollection = db.collection('transactions');

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
    version: '2.0.2-FIXED',
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
  console.log('📦 Request body:', JSON.stringify(req.body, null, 2));

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
    console.log('💳 Paystack response:', JSON.stringify(paymentData, null, 2));

    if (!paymentData) return res.status(500).json({ error: 'Invalid Paystack response (no data)' });
    if (paymentData.status !== 'success') {
      return res.status(400).json({ error: 'Payment verification failed', status: paymentData.status });
    }

    const metadata = paymentData.metadata || {};
    console.log('📋 Metadata received:', JSON.stringify(metadata, null, 2));

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

    const totalAmount = Number(paymentData.amount || 0);
    const subtotal = totalAmount - shippingFeeKobo;

    const products = normalizeProducts(metadata) || normalizeProducts({ products: getCustomField('products') }) || [];
    const cartItems = normalizeCartItems(metadata) || normalizeCartItems({ cart_items: getCustomField('cart_items') }) || [];

    console.log('🛒 Cart items extracted:', JSON.stringify(cartItems, null, 2));
    console.log('📧 Customer Email:', customerEmail);
    console.log('📧 Owner Email:', OWNER_EMAIL);
    console.log('📧 From Email:', RESEND_FROM_EMAIL);

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

    console.log('💾 Saving order to MongoDB...');
    const insertResult = await ordersCollection.insertOne(orderData);
    const orderId = insertResult.insertedId;
    console.log('✅ Order saved with ID:', orderId.toString());

    // Send emails async
    console.log('📧 Initiating email sending...');
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
    }).catch(err => {
      console.error('❌ Email send failed:', err.message);
      console.error('❌ Email error details:', err);
    });

    return res.json({
      success: true,
      message: 'Payment verified and order saved successfully! Emails are being sent.',
      reference,
      orderId: orderId.toString()
    });
  } catch (error) {
    console.error('❌ Verification error:', error?.response?.data || error.message);
    console.error('❌ Full error:', error);
    return res.status(500).json({
      error: 'Payment verification failed',
      details: error?.response?.data || error.message
    });
  }
});

// ================================================================
// EMAIL SENDING (RESEND) - MOBILE RESPONSIVE + IMAGE FIX
// ================================================================
async function sendOrderEmail(orderData) {
  console.log('📧 sendOrderEmail called');
  
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
    console.warn('⚠️ RESEND_API_KEY:', process.env.RESEND_API_KEY ? 'SET' : 'NOT SET');
    console.warn('⚠️ RESEND_FROM_EMAIL:', RESEND_FROM_EMAIL);
    return;
  }

  console.log('📧 Resend is configured, preparing emails...');

  const cleanPhone = String(customerPhone || '').trim();
  const whatsappNumber = cleanPhone && cleanPhone !== 'N/A'
    ? cleanPhone.replace(/^0/, '234').replace(/[^\d]/g, '')
    : '';
  const whatsappLink = whatsappNumber ? `https://wa.me/${whatsappNumber}` : '#';

  const items = Array.isArray(cartItems) && cartItems.length > 0 ? cartItems : [];
  
  console.log('🛒 Processing cart items for email:', items.length, 'items');
  
  // FIXED: Check multiple possible image property names
  const cartItemsHtml = items.length
    ? items.map((item, index) => {
      const name = item?.name || item?.productName || `Item ${index + 1}`;
      const qty = Number(item?.quantity || item?.qty || 1);
      const priceKobo = Number(item?.price || item?.priceKobo || 0);
      
      // FIX: Check multiple possible image properties
      const imageUrl = item?.image || item?.imageUrl || item?.img || item?.product_image || item?.thumbnail || '';
      
      console.log(`🖼️ Item ${index + 1} - Name: ${name}, Image URL: ${imageUrl || 'NO IMAGE'}`);
      
      // Responsive image with fallback
      const imageCell = imageUrl 
        ? `<img src="${imageUrl}" alt="${name}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px; border: 1px solid #e0e0e0; display: block;" />`
        : `<div style="width: 60px; height: 60px; background: linear-gradient(135deg, #f5f5f5 0%, #e0e0e0 100%); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #999; font-size: 10px; text-align: center;">No<br>Image</div>`;
      
      return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #eee;">${imageCell}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee; font-size: 14px;">${name}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center; font-size: 14px;">${qty}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px; white-space: nowrap;">${formatCurrency(priceKobo)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px; font-weight: 600; white-space: nowrap;">${formatCurrency(priceKobo * qty)}</td>
        </tr>
      `;
    }).join('')
    : `
      <tr>
        <td colspan="5" style="padding: 20px; text-align:center; color:#666; font-style: italic;">
          No cart items received
        </td>
      </tr>
    `;

  const productsList = Array.isArray(products) && products.length
    ? `<ul style="margin: 10px 0; padding-left: 20px;">${products.map(p => `<li style="margin: 5px 0;">${p?.name || JSON.stringify(p)}</li>`).join('')}</ul>`
    : `<p style="color:#666; font-style: italic;">No products field provided.</p>`;

  // OWNER EMAIL - Mobile Responsive
  const ownerEmailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="X-UA-Compatible" content="IE=edge">
      <title>New Order Received</title>
      <style>
        body { margin: 0; padding: 0; font-family: Arial, sans-serif; }
        table { border-collapse: collapse; }
        @media only screen and (max-width: 600px) {
          .email-container { width: 100% !important; }
          .content-padding { padding: 15px !important; }
          .responsive-table { font-size: 12px !important; }
          .responsive-table th, .responsive-table td { padding: 6px !important; }
          .hide-mobile { display: none !important; }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f4f4f4;">
      <div style="width: 100%; max-width: 650px; margin: 0 auto; background-color: #ffffff;" class="email-container">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 25px; text-align: center;" class="content-padding">
          <h1 style="color: white; margin: 0; font-size: 24px;">🎉 New Order Received!</h1>
        </div>
        
        <div style="padding: 25px;" class="content-padding">
          <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
            <p style="margin: 5px 0;"><strong>Order Reference:</strong> <code style="background:#e3e3e3; padding: 3px 6px; border-radius: 3px; font-size: 13px;">${orderReference}</code></p>
            <p style="margin: 5px 0;"><strong>Date:</strong> ${new Date().toLocaleString('en-NG')}</p>
          </div>

          <h3 style="color: #333; border-bottom: 2px solid #667eea; padding-bottom: 8px;">👤 Customer Details</h3>
          <p style="margin: 8px 0;"><strong>Name:</strong> ${customerName}</p>
          <p style="margin: 8px 0;"><strong>Email:</strong> <a href="mailto:${customerEmail}" style="color: #667eea;">${customerEmail}</a></p>
          <p style="margin: 8px 0;"><strong>Phone:</strong> ${customerPhone}</p>
          <p style="margin: 8px 0;"><strong>Shipping State:</strong> ${shippingState}</p>

          <h3 style="color: #333; border-bottom: 2px solid #667eea; padding-bottom: 8px; margin-top: 25px;">🧾 Products (JSON)</h3>
          ${productsList}

          <h3 style="color: #333; border-bottom: 2px solid #667eea; padding-bottom: 8px; margin-top: 25px;">🛒 Cart Items</h3>
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; min-width: 500px;" class="responsive-table">
              <thead>
                <tr style="background:#667eea; color: white;">
                  <th style="padding:12px 8px; text-align:left; font-size: 13px;">Image</th>
                  <th style="padding:12px 8px; text-align:left; font-size: 13px;">Product</th>
                  <th style="padding:12px 8px; text-align:center; font-size: 13px;">Qty</th>
                  <th style="padding:12px 8px; text-align:right; font-size: 13px;">Price</th>
                  <th style="padding:12px 8px; text-align:right; font-size: 13px;">Total</th>
                </tr>
              </thead>
              <tbody>${cartItemsHtml}</tbody>
            </table>
          </div>

          <div style="background: #f0f4ff; padding: 15px; border-radius: 8px; margin-top: 20px;">
            <p style="margin: 8px 0; font-size: 15px;"><strong>Subtotal:</strong> ${formatCurrency(subtotal)}</p>
            <p style="margin: 8px 0; font-size: 15px;"><strong>Shipping Fee:</strong> ₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</p>
            <p style="margin: 8px 0; font-size: 20px; color: #667eea;"><strong>TOTAL PAID:</strong> ${formatCurrency(totalAmount)}</p>
          </div>

          <div style="text-align: center; margin-top: 25px;">
            <a href="${whatsappLink}" style="display: inline-block; padding: 14px 28px; background: #25D366; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px;">
              💬 Contact Customer via WhatsApp
            </a>
          </div>

          <p style="color: #999; font-size: 11px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; text-align: center;">
            FortuneHub Order Notification System
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  // CUSTOMER EMAIL - Mobile Responsive
  const customerEmailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="X-UA-Compatible" content="IE=edge">
      <title>Order Confirmation</title>
      <style>
        body { margin: 0; padding: 0; font-family: Arial, sans-serif; }
        table { border-collapse: collapse; }
        @media only screen and (max-width: 600px) {
          .email-container { width: 100% !important; }
          .content-padding { padding: 20px 15px !important; }
          .header-padding { padding: 25px 15px !important; }
          .responsive-table { font-size: 12px !important; }
          .responsive-table th, .responsive-table td { padding: 6px 4px !important; }
          .mobile-small { font-size: 13px !important; }
          h1 { font-size: 22px !important; }
          h3 { font-size: 16px !important; }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f4f4f4;">
      <div style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff;" class="email-container">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 35px 20px; text-align: center;" class="header-padding">
          <h1 style="color: white; margin: 0; font-size: 26px;">✅ Order Confirmed!</h1>
        </div>

        <div style="padding: 30px 20px;" class="content-padding">
          <p style="font-size: 16px; color: #333; margin-bottom: 8px;" class="mobile-small">Hi <strong>${customerName}</strong>,</p>
          <p style="font-size: 15px; color: #555; line-height: 1.6;" class="mobile-small">Thank you for your purchase! Your payment was successful and your order is being processed.</p>

          <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 5px 0; font-size: 14px;"><strong>Order Reference:</strong> <br><code style="background:#e3e3e3; padding: 4px 8px; border-radius: 4px; font-size: 13px; word-break: break-all;">${orderReference}</code></p>
            <p style="margin: 5px 0; font-size: 14px;"><strong>Date:</strong> ${new Date().toLocaleString('en-NG')}</p>
          </div>

          <h3 style="color: #333; border-bottom: 2px solid #667eea; padding-bottom: 8px; margin-top: 25px;">🧾 Your Items</h3>
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; min-width: 450px;" class="responsive-table">
              <thead>
                <tr style="background: #667eea; color: #fff;">
                  <th style="padding: 12px 8px; text-align: left; font-size: 13px;">Image</th>
                  <th style="padding: 12px 8px; text-align: left; font-size: 13px;">Product</th>
                  <th style="padding: 12px 8px; text-align: center; font-size: 13px;">Qty</th>
                  <th style="padding: 12px 8px; text-align: right; font-size: 13px;">Price</th>
                  <th style="padding: 12px 8px; text-align: right; font-size: 13px;">Total</th>
                </tr>
              </thead>
              <tbody>${cartItemsHtml}</tbody>
            </table>
          </div>

          <div style="background: #f0f4ff; padding: 18px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 6px 0; font-size: 15px;"><strong>Subtotal:</strong> ${formatCurrency(subtotal)}</p>
            <p style="margin: 6px 0; font-size: 15px;"><strong>Shipping Fee (${shippingState}):</strong> ₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</p>
            <p style="margin: 10px 0 6px 0; font-size: 22px; color: #667eea;"><strong>TOTAL PAID:</strong> ${formatCurrency(totalAmount)}</p>
          </div>

          <div style="background: #fff9e6; border-left: 4px solid #ffc107; padding: 12px 15px; border-radius: 4px; margin: 20px 0;">
            <p style="margin: 0; font-size: 13px; color: #856404;">
              📦 <strong>What's Next?</strong><br>
              Your order will be processed and shipped soon. We'll send you a tracking number once it's dispatched.
            </p>
          </div>

          <p style="color: #666; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; text-align: center; line-height: 1.5;">
            Need help? Reply to this email.<br>
            <strong>Order Reference:</strong> ${orderReference}
          </p>
        </div>

        <div style="background: #f9f9f9; padding: 15px; text-align: center; border-top: 1px solid #e0e0e0;">
          <p style="margin: 0; color: #999; font-size: 11px;">© ${new Date().getFullYear()} FortuneHub. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    // SEND OWNER EMAIL
    if (OWNER_EMAIL) {
      console.log('📧 Sending owner email to:', OWNER_EMAIL);
      const ownerResult = await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: OWNER_EMAIL,
        subject: `🛒 New Order - ${orderReference} - ${customerName}`,
        html: ownerEmailHtml
      });
      console.log('✅ Owner email sent successfully!', ownerResult);
    } else {
      console.warn('⚠️ OWNER_EMAIL not configured, skipping owner notification.');
    }

    // SEND CUSTOMER EMAIL
    if (customerEmail && customerEmail !== 'unknown@email') {
      console.log('📧 Sending customer email to:', customerEmail);
      const customerResult = await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: customerEmail,
        subject: `✅ Order Confirmation - ${orderReference} - FortuneHub`,
        html: customerEmailHtml
      });
      console.log('✅ Customer email sent successfully!', customerResult);
    } else {
      console.warn('⚠️ Invalid customer email:', customerEmail, '- skipping customer confirmation.');
    }
  } catch (emailError) {
    console.error('❌ Error sending emails:', emailError.message);
    console.error('❌ Email error details:', JSON.stringify(emailError, null, 2));
    throw emailError;
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
// START SERVER
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
      console.log(`📧 From Email: ${RESEND_FROM_EMAIL}`);
      console.log(`📧 Owner Email: ${OWNER_EMAIL || 'NOT SET'}`);
      console.log(`💳 Payment: ${PAYSTACK_SECRET_KEY ? 'Paystack Enabled' : 'Paystack Disabled'}`);
      console.log('='.repeat(60));
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();
