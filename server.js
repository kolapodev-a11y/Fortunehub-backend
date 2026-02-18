// ================================================================
// FORTUNEHUB E-COMMERCE BACKEND SERVER (RENDER + MONGODB + RESEND)
// - Orders & Transactions stored in MongoDB Atlas
// - Resend for owner + customer emails
// - Admin panel for transaction history
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
// MIDDLEWARE
// ================================================================
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ================================================================
// MONGODB CONNECTION (Atlas) - FIXED VERSION
// ================================================================
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set. Please configure MongoDB Atlas connection string.');
  process.exit(1);
}

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
      
      // Test connection
      await mongoClient.db('admin').admin().ping();
      console.log('✅ Connected to MongoDB Atlas successfully!');
      
      db = mongoClient.db('fortunehub');
      ordersCollection = db.collection('orders');
      transactionsCollection = db.collection('transactions');
      
      // Create indexes for better performance
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
      
      console.log(`🔄 Retrying in 5 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  try {
    await mongoClient.close();
    console.log('✅ MongoDB connection closed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error closing MongoDB connection:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  try {
    await mongoClient.close();
    console.log('✅ MongoDB connection closed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error closing MongoDB connection:', error);
    process.exit(1);
  }
});

// ================================================================
// RESEND EMAIL SERVICE
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
// BASIC AUTH MIDDLEWARE (Admin Protection)
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
    
    if (username === validUsername && password === validPassword) {
      next();
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(401).json({ error: 'Invalid authorization header' });
  }
}

// ================================================================
// HELPER FUNCTIONS
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

function generateReference() {
  return `TRX-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
}

// ================================================================
// HEALTHCHECK
// ================================================================
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'FortuneHub E-Commerce API',
    version: '2.0.0',
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
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// ================================================================
// PAYMENT VERIFICATION & ORDER CREATION
// ================================================================
app.post('/api/verify-payment', async (req, res) => {
  console.log('📨 Payment verification request received');

  try {
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' });
    }

    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY is not configured' });
    }

    console.log('🔍 Verifying payment reference:', reference);

    const paystackResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    const paymentData = paystackResponse.data?.data;

    if (!paymentData) {
      return res.status(500).json({ error: 'Invalid Paystack response (no data)' });
    }

    if (paymentData.status !== 'success') {
      return res.status(400).json({
        error: 'Payment verification failed',
        status: paymentData.status
      });
    }

    // ============================================================
    // METADATA EXTRACTION
    // ============================================================
    const metadata = paymentData.metadata || {};
    const customFields = Array.isArray(metadata.custom_fields) ? metadata.custom_fields : [];

    const getCustomField = (key) => {
      const f = customFields.find(x => x?.variable_name === key || x?.display_name === key);
      return f?.value;
    };

    const customerName =
      metadata.customer_name || getCustomField('customer_name') || 'Unknown Customer';

    const customerEmail =
      metadata.customer_email ||
      getCustomField('customer_email') ||
      paymentData.customer?.email ||
      'unknown@email';

    const customerPhone =
      metadata.customer_phone || getCustomField('customer_phone') || 'N/A';

    const shippingState =
      metadata.shipping_state || getCustomField('shipping_state') || 'Unknown';

    const shippingFee =
      (metadata.shipping_fee ?? getCustomField('shipping_fee') ?? 0);

    const shippingFeeNaira = parseInt(shippingFee, 10) || 0;
    const shippingFeeKobo = shippingFeeNaira * 100;

    const totalAmount = Number(paymentData.amount || 0); // KOBO
    const subtotal = totalAmount - shippingFeeKobo;

    const products =
      normalizeProducts(metadata) ||
      normalizeProducts({ products: getCustomField('products') }) ||
      [];

    const cartItems =
      normalizeCartItems(metadata) ||
      normalizeCartItems({ cart_items: getCustomField('cart_items') }) ||
      [];

    console.log('💾 Saving order to MongoDB...');
    console.log('📧 Customer Email extracted:', customerEmail);

    // Save order to MongoDB
    const orderData = {
      order_reference: reference,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
      shipping_state: shippingState,
      shipping_fee: shippingFeeNaira,
      subtotal: subtotal,
      total_amount: totalAmount,
      products: products,
      cart_items: cartItems,
      payment_status: 'success',
      created_at: new Date(),
      updated_at: new Date()
    };

    const insertResult = await ordersCollection.insertOne(orderData);
    const orderId = insertResult.insertedId;

    console.log('✅ Order saved successfully with ID:', orderId);

    // Send emails (async)
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
    });

    res.json({
      success: true,
      message: 'Payment verified and order saved successfully! Emails are being sent.',
      reference,
      orderId: orderId.toString()
    });
  } catch (error) {
    console.error('❌ Verification error:', error?.response?.data || error.message);
    res.status(500).json({
      error: 'Payment verification failed',
      details: error?.response?.data || error.message
    });
  }
});

// ================================================================
// EMAIL SENDING (RESEND)
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

  // Render cart items table rows
  const items = Array.isArray(cartItems) ? cartItems : [];
  const cartItemsHtml = items.length
    ? items.map((item) => {
        const name = item?.name || 'Item';
        const qty = Number(item?.quantity || 1);
        const priceKobo = Number(item?.price || 0);
        return `
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee;">${name}</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: center;">${qty}</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">${formatCurrency(priceKobo)}</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">${formatCurrency(priceKobo * qty)}</td>
          </tr>
        `;
      }).join('')
    : `
      <tr>
        <td colspan="4" style="padding: 10px; text-align:center; color:#666;">
          (No cart items received)
        </td>
      </tr>
    `;

  // Products summary
  const productsList = Array.isArray(products) && products.length
    ? `<ul>${products.map(p => `<li>${p?.name || JSON.stringify(p)}</li>`).join('')}</ul>`
    : `<p style="color:#666;">No products field provided.</p>`;

  const ownerEmailHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color:#333;">
      <h2>🎉 New Order Received!</h2>
      <p><strong>Order Reference:</strong> ${orderReference}</p>
      <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>

      <h3>👤 Customer Details</h3>
      <p><strong>Name:</strong> ${customerName}</p>
      <p><strong>Email:</strong> ${customerEmail}</p>
      <p><strong>Phone:</strong> ${customerPhone}</p>
      <p><strong>Shipping State:</strong> ${shippingState}</p>

      <h3>🧾 Products (JSON)</h3>
      ${productsList}

      <h3>🛍️ Cart Items</h3>
      <table style="width:100%; border-collapse: collapse;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:10px; text-align:left;">Product</th>
            <th style="padding:10px; text-align:center;">Qty</th>
            <th style="padding:10px; text-align:right;">Price</th>
            <th style="padding:10px; text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${cartItemsHtml}
        </tbody>
      </table>

      <p><strong>Subtotal:</strong> ${formatCurrency(subtotal)}</p>
      <p><strong>Shipping Fee:</strong> ₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</p>
      <p style="font-size:18px;"><strong>TOTAL PAID:</strong> ${formatCurrency(totalAmount)}</p>

      <p>
        <a href="${whatsappLink}" style="display:inline-block; padding:12px 18px; background:#25D366; color:#fff; text-decoration:none; border-radius:6px;">
          💬 Contact Customer via WhatsApp
        </a>
      </p>
    </div>
  `;

  const customerEmailHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color:#333; max-width:600px; margin:0 auto;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0;">✅ Order Confirmed!</h1>
      </div>
      
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
        <p style="font-size: 16px;">Hi <strong>${customerName}</strong>,</p>
        <p>Thank you for your purchase! Your payment was successful and your order is being processed.</p>

        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Order Reference:</strong> <code style="background:#e3e3e3; padding:4px 8px; border-radius:4px;">${orderReference}</code></p>
          <p><strong>Date:</strong> ${new Date().toLocaleString('en-NG')}</p>
        </div>

        <h3>🧾 Your Items</h3>
        <table style="width:100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden;">
          <thead>
            <tr style="background:#667eea; color:#fff;">
              <th style="padding:12px; text-align:left;">Product</th>
              <th style="padding:12px; text-align:center;">Qty</th>
              <th style="padding:12px; text-align:right;">Price</th>
              <th style="padding:12px; text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${cartItemsHtml}
          </tbody>
        </table>

        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Subtotal:</strong> ${formatCurrency(subtotal)}</p>
          <p><strong>Shipping Fee (${shippingState}):</strong> ₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</p>
          <p style="font-size:20px; color:#667eea;"><strong>TOTAL PAID:</strong> ${formatCurrency(totalAmount)}</p>
        </div>

        <p>We will contact you shortly to confirm delivery details. Please keep this email for your records.</p>
        
        <p style="color:#666; font-size:12px; margin-top:30px; padding-top:20px; border-top: 1px solid #ddd;">
          Need help? Reply to this email or contact us.<br>
          Order Reference: ${orderReference}
        </p>
      </div>
    </div>
  `;

  try {
    // Send to OWNER
    if (OWNER_EMAIL) {
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: OWNER_EMAIL,
        subject: `🛒 New Order - ${orderReference} - ${customerName}`,
        html: ownerEmailHtml
      });
      console.log('✅ Owner email sent via Resend!');
    } else {
      console.warn('⚠️ OWNER_EMAIL not configured, skipping owner notification.');
    }

    // Send to CUSTOMER
    if (customerEmail && customerEmail !== 'unknown@email') {
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: customerEmail,
        subject: `✅ Order Confirmation - ${orderReference} - FortuneHub`,
        html: customerEmailHtml
      });
      console.log('✅ Customer email sent via Resend!');
    } else {
      console.warn('⚠️ Invalid customer email, skipping customer confirmation.');
    }
  } catch (error) {
    console.error('❌ Resend email error:', error.message);
    throw error;
  }
}

// ================================================================
// GET ALL ORDERS (Public - for customer tracking)
// ================================================================
app.get('/api/orders', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.email) query.customer_email = req.query.email;
    if (req.query.status) query.payment_status = req.query.status;

    const [orders, total] = await Promise.all([
      ordersCollection
        .find(query)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      ordersCollection.countDocuments(query)
    ]);

    res.json({
      success: true,
      count: orders.length,
      total,
      pagination: {
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNext: page  1
      },
      orders
    });
  } catch (error) {
    console.error('❌ Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ================================================================
// GET SINGLE ORDER BY REFERENCE (Public)
// ================================================================
app.get('/api/orders/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const order = await ordersCollection.findOne({ order_reference: reference });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error('❌ Error fetching order:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ================================================================
// ADMIN: GET ALL ORDERS (Protected)
// ================================================================
app.get('/api/admin/orders', basicAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
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
      ordersCollection
        .find(query)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      ordersCollection.countDocuments(query)
    ]);

    res.json({
      success: true,
      count: orders.length,
      total,
      pagination: {
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNext: page  1
      },
      orders
    });
  } catch (error) {
    console.error('❌ Error fetching admin orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ================================================================
// ADMIN: GET ORDER STATISTICS (Protected)
// ================================================================
app.get('/api/admin/stats', basicAuth, async (req, res) => {
  try {
    const [
      totalOrders,
      successfulOrders,
      totalRevenue,
      todayOrders
    ] = await Promise.all([
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

    res.json({
      success: true,
      stats: {
        totalOrders,
        successfulOrders,
        totalRevenue: totalRevenue[0]?.total || 0,
        todayOrders,
        revenueFormatted: formatCurrency(totalRevenue[0]?.total || 0)
      }
    });
  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// ================================================================
// ADMIN: DELETE ORDER (Protected)
// ================================================================
app.delete('/api/admin/orders/:id', basicAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    const result = await ordersCollection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, message: 'Order deleted successfully' });
  } catch (error) {
    console.error('❌ Error deleting order:', error);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// ================================================================
// 404 HANDLER
// ================================================================
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    availableEndpoints: {
      public: [
        'GET /',
        'GET /health',
        'POST /api/verify-payment',
        'GET /api/orders',
        'GET /api/orders/:reference'
      ],
      admin: [
        'GET /api/admin/orders',
        'GET /api/admin/stats',
        'DELETE /api/admin/orders/:id'
      ]
    }
  });
});

// ================================================================
// ERROR HANDLER
// ================================================================
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: IS_PRODUCTION ? 'Something went wrong' : err.message
  });
});

// ================================================================
// START SERVER (Wait for database connection first)
// ================================================================
async function startServer() {
  try {
    // Connect to database first
    await connectToDatabase();
    
    // Then start HTTP server
    app.listen(PORT, '0.0.0.0', () => {
      console.log('='.repeat(60));
      console.log('✅ FORTUNEHUB BACKEND SERVER STARTED SUCCESSFULLY!');
      console.log('='.repeat(60));
      console.log(🌐 Server running on port: ${PORT});
      console.log(🌍 Environment: ${process.env.NODE_ENV || 'development'});
      console.log(💾 Database: ${db ? 'Connected to MongoDB Atlas' : 'Disconnected'});
      console.log(📧 Email service: ${resend ? 'Resend Enabled' : 'Resend Disabled'});
      console.log(💳 Payment: ${PAYSTACK_SECRET_KEY ? 'Paystack Enabled' : 'Paystack Disabled'});
      console.log('='.repeat(60));
      console.log('\n📋 Available Endpoints:');
      console.log('   PUBLIC:');
      console.log('   - GET  /');
      console.log('   - GET  /health');
      console.log('   - POST /api/verify-payment');
      console.log('   - GET  /api/orders');
      console.log('   - GET  /api/orders/:reference');
      console.log('\n   ADMIN (Basic Auth Required):');
      console.log('   - GET    /api/admin/orders');
      console.log('   - GET    /api/admin/stats');
      console.log('   - DELETE /api/admin/orders/:id');
      console.log('='.repeat(60));
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Start the server
startServer();
