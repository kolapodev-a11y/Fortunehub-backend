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
// MONGODB CONNECTION (Atlas)
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
  maxPoolSize: 50,
  minPoolSize: 10,
  retryWrites: true,
  w: 'majority'
});

async function connectToDatabase() {
  try {
    console.log('🔄 Connecting to MongoDB Atlas...');
    await mongoClient.connect();
    console.log('✅ Connected to MongoDB Atlas');
    
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
    
    console.log('✅ Database indexes created');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    if (IS_PRODUCTION) {
      console.log('🔄 Retrying connection in 5 seconds...');
      setTimeout(connectToDatabase, 5000);
    } else {
      process.exit(1);
    }
  }
}

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
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
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
// SEARCH ORDERS BY EMAIL OR REFERENCE (Public)
// ================================================================
app.post('/api/orders/search', async (req, res) => {
  const { email, orderReference } = req.body;

  if (!email && !orderReference) {
    return res.status(400).json({
      error: 'Please provide either email or order reference'
    });
  }

  try {
    if (orderReference) {
      const order = await ordersCollection.findOne({ order_reference: orderReference });
      return res.json({
        success: true,
        count: order ? 1 : 0,
        orders: order ? [order] : []
      });
    }

    const orders = await ordersCollection
      .find({ customer_email: email })
      .sort({ created_at: -1 })
      .toArray();

    res.json({ success: true, count: orders.length, orders });
  } catch (error) {
    console.error('❌ Error searching orders:', error);
    res.status(500).json({ error: 'Failed to search orders' });
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

    const [orders, total, stats] = await Promise.all([
      ordersCollection
        .find({})
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      ordersCollection.countDocuments({}),
      ordersCollection.aggregate([
        {
          $group: {
            _id: '$payment_status',
            count: { $sum: 1 },
            totalAmount: { $sum: '$total_amount' }
          }
        }
      ]).toArray()
    ]);

    res.json({
      success: true,
      count: orders.length,
      total,
      stats,
      pagination: {
        page,
        limit,
        totalPages: Math.ceil(total / limit)
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
    const [statusStats, recentStats] = await Promise.all([
      ordersCollection.aggregate([
        {
          $group: {
            _id: '$payment_status',
            count: { $sum: 1 },
            totalAmount: { $sum: '$total_amount' }
          }
        }
      ]).toArray(),
      
      ordersCollection.aggregate([
        { 
          $match: { 
            created_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          } 
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalAmount: { $sum: '$total_amount' }
          }
        }
      ]).toArray()
    ]);

    const totalOrders = await ordersCollection.countDocuments({});

    res.json({
      success: true,
      data: {
        totalOrders,
        byStatus: statusStats,
        last24Hours: recentStats[0] || { count: 0, totalAmount: 0 }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// ================================================================
// TRANSACTION ROUTES (From your original MongoDB code)
// ================================================================

// Create Transaction
app.post('/api/transactions', async (req, res) => {
  try {
    const { userId, amount, type, status, description, metadata } = req.body;

    if (!userId || !amount || !type) {
      return res.status(400).json({ error: 'userId, amount, and type are required' });
    }

    const transaction = {
      userId,
      amount: parseFloat(amount),
      type,
      status: status || 'pending',
      description: description || '',
      reference: generateReference(),
      metadata: metadata || {},
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false
    };

    const result = await transactionsCollection.insertOne(transaction);

    res.status(201).json({
      success: true,
      message: 'Transaction created successfully',
      data: {
        transactionId: result.insertedId,
        reference: transaction.reference,
        ...transaction
      }
    });
  } catch (error) {
    console.error('❌ Error creating transaction:', error);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

// Get All Transactions (with pagination)
app.get('/api/transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const query = { deleted: { $ne: true } };
    if (req.query.userId) query.userId = req.query.userId;
    if (req.query.type) query.type = req.query.type;
    if (req.query.status) query.status = req.query.status;

    const [transactions, total] = await Promise.all([
      transactionsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      transactionsCollection.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Error fetching transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Get Single Transaction
app.get('/api/transactions/:id', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid transaction ID' });
    }

    const transaction = await transactionsCollection.findOne({
      _id: new ObjectId(req.params.id),
      deleted: { $ne: true }
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json({ success: true, data: transaction });
  } catch (error) {
    console.error('❌ Error fetching transaction:', error);
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

// Update Transaction
app.patch('/api/transactions/:id', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid transaction ID' });
    }

    const updateData = { updatedAt: new Date() };
    const allowedFields = ['status', 'metadata', 'description'];
    
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    const result = await transactionsCollection.updateOne(
      { _id: new ObjectId(req.params.id), deleted: { $ne: true } },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json({
      success: true,
      message: 'Transaction updated successfully'
    });
  } catch (error) {
    console.error('❌ Error updating transaction:', error);
    res.status(500).json({ error: 'Failed to update transaction' });
  }
});

// ================================================================
// TEST EMAIL ENDPOINT
// ================================================================
app.post('/api/test-email', async (req, res) => {
  const { testEmail } = req.body;

  if (!testEmail) {
    return res.status(400).json({ error: 'testEmail is required' });
  }

  try {
    if (!resend || !RESEND_FROM_EMAIL) {
      return res.status(500).json({
        success: false,
        error: 'Resend is not configured (missing RESEND_API_KEY or RESEND_FROM_EMAIL)'
      });
    }

    const result = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: testEmail,
      subject: '✅ Test Email from FortuneHub Backend (Resend)',
      html: `
        <div style="font-family: Arial; padding: 20px;">
          <h2>✅ Resend Working!</h2>
          <p>This is a test email from your FortuneHub backend server.</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          <p style="color: #25D366;">Your email service is configured correctly! 🎉</p>
        </div>
      `
    });

    res.json({
      success: true,
      message: 'Test email sent successfully via Resend!',
      emailId: result.id,
      recipient: testEmail
    });
  } catch (error) {
    console.error('❌ Test email failed:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to send test email',
      details: error.message
    });
  }
});

// ================================================================
// ERROR HANDLING
// ================================================================
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: IS_PRODUCTION ? 'Something went wrong' : err.message
  });
});

// ================================================================
// START SERVER
// ================================================================
async function startServer() {
  try {
    await connectToDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('🚀 ================================');
      console.log('🚀 FortuneHub Backend Server Started!');
      console.log('🚀 ================================');
      console.log(`📡 Port: ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🗄️  Database: MongoDB Atlas - ${db ? '✅ Connected' : '❌ Disconnected'}`);
      console.log(`✉️  Email: Resend - ${resend ? '✅ Configured' : '⚠️ Not Configured'}`);
      console.log(`💳 Payment: Paystack - ${PAYSTACK_SECRET_KEY ? '✅ Configured' : '⚠️ Not Configured'}`);
      console.log(`🌐 Health: http://localhost:${PORT}/health`);
      console.log('🚀 ================================');
      console.log('');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// ================================================================
// GRACEFUL SHUTDOWN
// ================================================================
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received: Starting graceful shutdown...`);
  
  try {
    if (mongoClient) {
      await mongoClient.close();
      console.log('✅ MongoDB connection closed');
    }
    
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server
startServer().catch(error => {
  console.error('❌ Fatal error during startup:', error);
  process.exit(1);
});
