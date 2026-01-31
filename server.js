// ================================================================
// FORTUNEHUB E-COMMERCE BACKEND SERVER (RENDER PRODUCTION READY)
// ================================================================

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ================================================================
// MIDDLEWARE
// ================================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================================================================
// DATABASE (RENDER SAFE PATH)
// ================================================================
const DB_PATH = process.env.DB_PATH || '/tmp/orders.db';

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('❌ Database connection error:', err.message);
  else console.log('✅ Connected to SQLite database at:', DB_PATH);
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
`, err => {
  if (err) console.error('❌ Error creating table:', err.message);
  else console.log('✅ Orders table ready');
});

// ================================================================
// EMAIL CONFIGURATION (RENDER SAFE)
// ================================================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Verify email on startup (important for Render)
transporter.verify(err => {
  if (err) console.error('❌ Email setup failed:', err.message);
  else console.log('✅ Email service ready');
});

// ================================================================
// PAYSTACK CONFIGURATION
// ================================================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'FortuneHub Backend',
    time: new Date().toISOString()
  });
});

// ================================================================
// PAYMENT VERIFICATION
// ================================================================
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference required' });
    }

    const paystackResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
      }
    );

    const paymentData = paystackResponse.data?.data;

    if (!paymentData || paymentData.status !== 'success') {
      return res.status(400).json({ error: 'Payment not successful' });
    }

    const metadata = paymentData.metadata || {};
    const cartItems = metadata.cart_items || [];

    const customerName = metadata.customer_name || 'Customer';
    const customerEmail = metadata.customer_email || paymentData.customer?.email || 'unknown@email';
    const customerPhone = metadata.customer_phone || 'N/A';
    const shippingState = metadata.shipping_state || 'Unknown';
    const shippingFee = Number(metadata.shipping_fee || 0);

    const totalAmount = paymentData.amount;
    const subtotal = totalAmount - shippingFee * 100;

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
      shippingFee,
      subtotal,
      totalAmount,
      metadata.products || 'Products',
      JSON.stringify(cartItems),
      'success'
    ], err => {
      if (err) return res.status(500).json({ error: 'Database save failed' });

      sendOrderEmail({
        orderReference: reference,
        customerName,
        customerEmail,
        customerPhone,
        shippingState,
        shippingFee,
        subtotal,
        totalAmount,
        cartItems
      });

      res.json({ success: true, reference });
    });

  } catch (err) {
    console.error('❌ Paystack verify error:', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ================================================================
// EMAIL FUNCTION
// ================================================================
function sendOrderEmail(data) {
  const ownerMail = {
    from: process.env.EMAIL_USER,
    to: process.env.OWNER_EMAIL,
    subject: `New Order - ${data.orderReference}`,
    html: `<h2>New Order Received</h2><p>${data.customerName} paid ₦${(data.totalAmount/100).toLocaleString()}</p>`
  };

  const customerMail = {
    from: process.env.EMAIL_USER,
    to: data.customerEmail,
    subject: `Order Confirmation - FortuneHub`,
    html: `<h2>Thank you for your order</h2><p>Reference: ${data.orderReference}</p>`
  };

  transporter.sendMail(ownerMail);
  transporter.sendMail(customerMail);
}

// ================================================================
// ORDERS API
// ================================================================
app.get('/api/orders', (req, res) => {
  db.all('SELECT * FROM orders ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// ================================================================
// START SERVER (RENDER STYLE)
// ================================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💾 Database path: ${DB_PATH}`);
});

// ================================================================
// CLEAN SHUTDOWN
// ================================================================
process.on('SIGTERM', () => db.close());
process.on('SIGINT', () => db.close());
