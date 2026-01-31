// ================================================================
// FORTUNEHUB E-COMMERCE BACKEND SERVER (WITH TRANSACTION HISTORY & CUSTOMER EMAILS)
// ================================================================

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Use DB_PATH from .env or fallback to local
const DB_PATH = process.env.DB_PATH || './orders.db';

// ================================================================
// MIDDLEWARE
// ================================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================================================================
// DATABASE (SQLite)
// ================================================================
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
  } else {
    console.log('✅ Connected to SQLite database at:', DB_PATH);
  }
});

db.run(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_reference TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    shipping_state TEXT NOT NULL,
    shipping_fee INTEGER NOT NULL,
    subtotal INTEGER NOT NULL,
    total_amount INTEGER NOT NULL,
    products TEXT NOT NULL,
    cart_items TEXT NOT NULL,
    payment_status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) console.error('❌ Error creating table:', err.message);
  else console.log('✅ Orders table ready');
});

// ================================================================
// EMAIL CONFIGURATION
// ================================================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  },
  // Optional: Add debug for email issues
  debug: false,
  logger: false
});

// ================================================================
// PAYSTACK CONFIGURATION
// ================================================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!PAYSTACK_SECRET_KEY) {
  console.warn('⚠️ PAYSTACK_SECRET_KEY is missing in environment variables!');
}

// ================================================================
// API ENDPOINTS
// ================================================================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 FortuneHub Backend Server is Running!',
    status: 'active',
    timestamp: new Date().toISOString(),
    dbPath: DB_PATH
  });
});

// ================================================================
// PAYMENT VERIFICATION ENDPOINT
// ================================================================
app.post('/api/verify-payment', async (req, res) => {
  console.log('📨 Payment verification request received');

  try {
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' });
    }

    console.log('🔍 Verifying payment reference:', reference);

    // ✅ FIXED: Removed space before ${reference}
    const paystackResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const paymentData = paystackResponse.data?.data;
    console.log('✅ Paystack verification successful');

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
    // ✅ METADATA EXTRACTION
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
      metadata.customer_email || getCustomField('customer_email') || paymentData.customer?.email || 'unknown@email';

    const customerPhone =
      metadata.customer_phone || getCustomField('customer_phone') || 'N/A';

    const shippingState =
      metadata.shipping_state || getCustomField('shipping_state') || 'Unknown';

    const shippingFee =
      (metadata.shipping_fee ?? getCustomField('shipping_fee') ?? 0);

    const productNames =
      metadata.product_names || metadata.products || getCustomField('product_names') || getCustomField('products') || 'Unknown Products';

    const cartItems =
      metadata.cart_items || getCustomField('cart_items') || [];

    const totalAmount = paymentData.amount;

    const shippingFeeNaira = parseInt(shippingFee, 10) || 0;
    const shippingFeeKobo = shippingFeeNaira * 100;
    const subtotal = totalAmount - shippingFeeKobo;

    const cartItemsJson = JSON.stringify(Array.isArray(cartItems) ? cartItems : []);

    console.log('💾 Saving order to database...');

    const insertQuery = `
      INSERT INTO orders (
        order_reference, customer_name, customer_email, customer_phone,
        shipping_state, shipping_fee, subtotal, total_amount,
        products, cart_items, payment_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(insertQuery, [
      reference,
      customerName,
      customerEmail,
      customerPhone,
      shippingState,
      shippingFeeNaira,
      subtotal,
      totalAmount,
      productNames,
      cartItemsJson,
      'success'
    ], function (err) {
      if (err) {
        console.error('❌ Database error:', err.message);
        return res.status(500).json({ error: 'Failed to save order' });
      }

      console.log('✅ Order saved with ID:', this.lastID);

      // 📧 Send emails
      sendOrderEmail({
        orderReference: reference,
        customerName,
        customerEmail,
        customerPhone,
        shippingState,
        shippingFee: shippingFeeNaira,
        subtotal,
        totalAmount,
        cartItems: Array.isArray(cartItems) ? cartItems : []
      });

      res.json({
        message: 'Payment verified and order saved successfully! Confirmation email sent.',
        reference,
        orderId: this.lastID
      });
    });

  } catch (error) {
    console.error('❌ Verification error:', error?.response?.data || error.message);
    res.status(500).json({
      error: 'Payment verification failed',
      details: error?.response?.data?.message || error.message
    });
  }
});

// ================================================================
// EMAIL SENDING FUNCTION
// ================================================================
function sendOrderEmail(orderData) {
  const {
    orderReference,
    customerName,
    customerEmail,
    customerPhone,
    shippingState,
    shippingFee,
    subtotal,
    totalAmount,
    cartItems
  } = orderData;

  const formatCurrency = (amountInKobo) => {
    return `₦${(amountInKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  };

  let cartItemsHtml = '';
  if (cartItems && cartItems.length > 0) {
    cartItems.forEach(item => {
      const name = item?.name || 'Item';
      const qty = Number(item?.quantity || 1);
      const priceKobo = Number(item?.price || 0);
      cartItemsHtml += `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #eee;">${name}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: center;">${qty}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">${formatCurrency(priceKobo)}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">${formatCurrency(priceKobo * qty)}</td>
        </tr>
      `;
    });
  } else {
    cartItemsHtml = `
      <tr>
        <td colspan="4" style="padding: 10px; text-align:center; color:#666;">
          (No cart items received)
        </td>
      </tr>
    `;
  }

  const cleanPhone = String(customerPhone || '').trim();
  const whatsappNumber = cleanPhone && cleanPhone !== 'N/A'
    ? cleanPhone.replace(/^0/, '234').replace(/[^\d]/g, '')
    : '';

  const whatsappLink = whatsappNumber ? `https://wa.me/${whatsappNumber}` : '#';

  // Owner email
  const ownerEmailHtml = `...`; // (Keep your existing HTML — no change needed)

  // Customer email
  const customerEmailHtml = `...`; // (Keep your existing HTML — no change needed)

  // Send to owner
  const ownerMailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.OWNER_EMAIL,
    subject: `🛒 New Order - ${orderReference} - ${customerName}`,
    html: ownerEmailHtml
  };

  transporter.sendMail(ownerMailOptions, (error, info) => {
    if (error) console.error('❌ Owner email failed:', error);
    else console.log('✅ Owner email sent:', info.response);
  });

  // Send to customer
  const customerMailOptions = {
    from: process.env.EMAIL_USER,
    to: customerEmail,
    subject: `✅ Order Confirmation - ${orderReference} - FortuneHub`,
    html: customerEmailHtml
  };

  transporter.sendMail(customerMailOptions, (error, info) => {
    if (error) console.error('❌ Customer email failed:', error);
    else console.log('✅ Customer email sent to:', customerEmail);
  });
}

// ================================================================
// OTHER ENDPOINTS (unchanged)
// ================================================================

app.get('/api/orders', (req, res) => {
  db.all('SELECT * FROM orders ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch orders' });
    res.json({ success: true, count: rows.length, orders: rows });
  });
});

app.get('/api/orders/:reference', (req, res) => {
  const { reference } = req.params;
  db.get('SELECT * FROM orders WHERE order_reference = ?', [reference], (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch order' });
    if (!row) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, order: row });
  });
});

app.post('/api/orders/search', (req, res) => {
  const { email, orderReference } = req.body;
  if (!email && !orderReference) {
    return res.status(400).json({ error: 'Please provide either email or order reference' });
  }

  let query = '';
  let params = [];

  if (orderReference) {
    query = 'SELECT * FROM orders WHERE order_reference = ?';
    params = [orderReference];
  } else {
    query = 'SELECT * FROM orders WHERE customer_email = ? ORDER BY created_at DESC';
    params = [email];
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch orders' });
    res.json({ success: true, count: rows.length, orders: rows });
  });
});

// ================================================================
// START SERVER
// ================================================================
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log('🚀 FortuneHub Backend Server Started!');
  console.log('🚀 ================================');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  console.log(`💾 Database: ${DB_PATH}`);
  console.log('✉️  Email notifications: Enabled (Owner + Customer)');
  console.log('📜 Transaction history: Enabled');
  console.log('🚀 ================================');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n⏳ Shutting down gracefully...');
  db.close((err) => {
    if (err) console.error('❌ Error closing database:', err.message);
    else console.log('✅ Database connection closed');
    process.exit(0);
  });
});
