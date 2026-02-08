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

// ================================================================
// MIDDLEWARE
// ================================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================================================================
// DATABASE (SQLite)
// ================================================================
const db = new sqlite3.Database('./orders.db', (err) => {
  if (err) console.error('❌ Database connection error:', err.message);
  else console.log('✅ Connected to SQLite database');
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
// EMAIL CONFIGURATION - ✅ PRODUCTION-READY
// ================================================================
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false, // Use TLS
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  },
  tls: {
    rejectUnauthorized: false // Allow self-signed certificates in production
  }
});

// ✅ Verify email configuration on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email configuration error:', error);
    console.error('⚠️  Please check your EMAIL_USER and EMAIL_PASSWORD environment variables');
  } else {
    console.log('✅ Email server is ready to send messages');
  }
});

// ================================================================
// PAYSTACK CONFIGURATION
// ================================================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ================================================================
// API ENDPOINTS
// ================================================================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 FortuneHub Backend Server is Running!',
    status: 'active',
    timestamp: new Date().toISOString(),
    emailConfigured: !!process.env.EMAIL_USER && !!process.env.EMAIL_PASSWORD,
    ownerEmailConfigured: !!process.env.OWNER_EMAIL
  });
});

// ================================================================
// PAYMENT VERIFICATION ENDPOINT
// ================================================================
app.post('/api/verify-payment', async (req, res) => {
  console.log('📨 Payment verification request received');
  console.log('📧 Email User:', process.env.EMAIL_USER ? 'Configured ✅' : 'Missing ❌');
  console.log('📧 Owner Email:', process.env.OWNER_EMAIL ? 'Configured ✅' : 'Missing ❌');

  try {
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' });
    }

    console.log('🔍 Verifying payment reference:', reference);

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
    // ✅ METADATA EXTRACTION (supports both direct keys + custom_fields)
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
    console.log('📧 Customer Email extracted:', customerEmail);

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

      // 📧 Send emails to BOTH owner and customer (async - non-blocking)
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
        message: 'Payment verified and order saved successfully! Confirmation emails are being sent.',
        reference,
        orderId: this.lastID
      });
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
// EMAIL SENDING FUNCTION - ✅ FIXED TO SEND TO BOTH OWNER & CUSTOMER
// ================================================================
async function sendOrderEmail(orderData) {
  const {
    orderReference,
    customerName,
    customerEmail,
    customerPhone,
    shippingState,
    shippingFee,  // NAIRA
    subtotal,     // KOBO
    totalAmount,  // KOBO
    cartItems
  } = orderData;

  console.log('📧 Starting email sending process...');
  console.log('📧 Owner Email:', process.env.OWNER_EMAIL);
  console.log('📧 Customer Email:', customerEmail);

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

  // WhatsApp link safety
  const cleanPhone = String(customerPhone || '').trim();
  const whatsappNumber = cleanPhone && cleanPhone !== 'N/A'
    ? cleanPhone.replace(/^0/, '234').replace(/[^\d]/g, '')
    : '';

  const whatsappLink = whatsappNumber ? `https://wa.me/${whatsappNumber}` : '#';

  // ============================================================
  // 📧 OWNER EMAIL (Admin Notification)
  // ============================================================
  const ownerEmailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .order-box { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; }
        .label { font-weight: bold; color: #667eea; }
        .table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        .total-row { background: #667eea; color: white; font-weight: bold; }
        .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .button.disabled { background: #999; pointer-events: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🎉 New Order Received!</h1>
          <p>FortuneHub E-Commerce</p>
        </div>

        <div class="content">
          <div class="order-box">
            <h2>📦 Order Details</h2>
            <div class="info-row">
              <span class="label">Order Reference:</span>
              <span>${orderReference}</span>
            </div>
            <div class="info-row">
              <span class="label">Order Date:</span>
              <span>${new Date().toLocaleString()}</span>
            </div>
          </div>

          <div class="order-box">
            <h2>👤 Customer Information</h2>
            <div class="info-row">
              <span class="label">Name:</span>
              <span>${customerName}</span>
            </div>
            <div class="info-row">
              <span class="label">Email:</span>
              <span>${customerEmail}</span>
            </div>
            <div class="info-row">
              <span class="label">Phone (WhatsApp):</span>
              <span>${customerPhone}</span>
            </div>
            <div class="info-row">
              <span class="label">Shipping State:</span>
              <span>${shippingState}</span>
            </div>
          </div>

          <div class="order-box">
            <h2>🛍️ Order Items</h2>
            <table class="table">
              <thead>
                <tr style="background: #f5f5f5;">
                  <th style="padding: 10px; text-align: left;">Product</th>
                  <th style="padding: 10px; text-align: center;">Quantity</th>
                  <th style="padding: 10px; text-align: right;">Price</th>
                  <th style="padding: 10px; text-align: right;">Total</th>
                </tr>
              </thead>
              <tbody>
                ${cartItemsHtml}
              </tbody>
            </table>

            <div class="info-row">
              <span class="label">Subtotal:</span>
              <span>${formatCurrency(subtotal)}</span>
            </div>
            <div class="info-row">
              <span class="label">Shipping Fee:</span>
              <span>₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</span>
            </div>
            <div class="info-row total-row" style="padding: 15px; font-size: 18px;">
              <span>TOTAL PAID:</span>
              <span>${formatCurrency(totalAmount)}</span>
            </div>
          </div>

          <div style="text-align: center; margin-top: 30px;">
            <p><strong>⚡ Action Required:</strong></p>
            <p>Please contact the customer via WhatsApp or email to arrange delivery.</p>

            <a href="${whatsappLink}" class="button ${whatsappNumber ? '' : 'disabled'}">
              💬 Contact via WhatsApp
            </a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  // ============================================================
  // 📧 CUSTOMER EMAIL (Order Confirmation)
  // ============================================================
  const customerEmailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background: #f4f4f4; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 20px; text-align: center; }
        .header h1 { margin: 0; font-size: 28px; }
        .header p { margin: 10px 0 0; font-size: 16px; opacity: 0.9; }
        .content { padding: 30px; }
        .success-badge { background: #10b981; color: white; display: inline-block; padding: 8px 20px; border-radius: 20px; font-weight: bold; margin-bottom: 20px; }
        .order-box { background: #f9fafb; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #667eea; }
        .info-row { display: flex; justify-content: space-between; padding: 8px 0; }
        .label { font-weight: 600; color: #666; }
        .value { color: #333; font-weight: 500; }
        .table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        .table th { background: #667eea; color: white; padding: 12px; text-align: left; }
        .table td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
        .total-section { background: #667eea; color: white; padding: 20px; border-radius: 8px; margin-top: 20px; }
        .total-row { display: flex; justify-content: space-between; padding: 5px 0; }
        .grand-total { font-size: 24px; font-weight: bold; padding-top: 10px; border-top: 2px solid rgba(255,255,255,0.3); margin-top: 10px; }
        .footer { background: #f9fafb; padding: 30px; text-align: center; color: #666; }
        .support-box { background: white; padding: 20px; border-radius: 8px; margin-top: 20px; border: 1px solid #e5e7eb; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>✨ Thank You for Your Order!</h1>
          <p>Your order has been confirmed and is being processed</p>
        </div>

        <div class="content">
          <div style="text-align: center;">
            <span class="success-badge">✅ Payment Successful</span>
          </div>

          <div class="order-box">
            <h2 style="margin-top: 0; color: #667eea;">📦 Order Information</h2>
            <div class="info-row">
              <span class="label">Order Reference:</span>
              <span class="value">${orderReference}</span>
            </div>
            <div class="info-row">
              <span class="label">Order Date:</span>
              <span class="value">${new Date().toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' })}</span>
            </div>
            <div class="info-row">
              <span class="label">Customer Name:</span>
              <span class="value">${customerName}</span>
            </div>
            <div class="info-row">
              <span class="label">Email:</span>
              <span class="value">${customerEmail}</span>
            </div>
            <div class="info-row">
              <span class="label">Phone:</span>
              <span class="value">${customerPhone}</span>
            </div>
            <div class="info-row">
              <span class="label">Shipping State:</span>
              <span class="value">${shippingState}</span>
            </div>
          </div>

          <h2 style="color: #667eea;">🛍️ Order Items</h2>
          <table class="table">
            <thead>
              <tr>
                <th>Product</th>
                <th style="text-align: center;">Qty</th>
                <th style="text-align: right;">Price</th>
                <th style="text-align: right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${cartItemsHtml}
            </tbody>
          </table>

          <div class="total-section">
            <div class="total-row">
              <span>Subtotal:</span>
              <span>${formatCurrency(subtotal)}</span>
            </div>
            <div class="total-row">
              <span>Shipping Fee (${shippingState}):</span>
              <span>₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</span>
            </div>
            <div class="total-row grand-total">
              <span>TOTAL PAID:</span>
              <span>${formatCurrency(totalAmount)}</span>
            </div>
          </div>

          <div class="support-box">
            <h3 style="margin-top: 0; color: #667eea;">📞 What's Next?</h3>
            <p>Our team will contact you shortly via WhatsApp or phone to confirm your delivery details.</p>
            <p><strong>Estimated Delivery:</strong> 2-5 business days (depending on your location)</p>
            <p style="margin-bottom: 0;">If you have any questions, please don't hesitate to reach out!</p>
          </div>
        </div>

        <div class="footer">
          <p style="margin: 0 0 10px;"><strong>FortuneHub E-Commerce</strong></p>
          <p style="margin: 0; font-size: 14px;">Thank you for shopping with us! 🎉</p>
          <p style="margin: 10px 0 0; font-size: 12px; color: #999;">
            Keep this email for your records. Order Reference: ${orderReference}
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  // ============================================================
  // 📤 SEND EMAIL TO OWNER (Admin)
  // ============================================================
  try {
    if (process.env.OWNER_EMAIL) {
      console.log('📤 Sending email to owner:', process.env.OWNER_EMAIL);
      
      const ownerMailOptions = {
        from: `"FortuneHub Orders" <${process.env.EMAIL_USER}>`,
        to: process.env.OWNER_EMAIL,
        subject: `🛒 New Order - ${orderReference} - ${customerName}`,
        html: ownerEmailHtml
      };

      const ownerInfo = await transporter.sendMail(ownerMailOptions);
      console.log('✅ Owner email sent successfully!');
      console.log('   Message ID:', ownerInfo.messageId);
    } else {
      console.error('❌ OWNER_EMAIL not configured in environment variables');
    }
  } catch (error) {
    console.error('❌ Failed to send owner email:', error.message);
    console.error('   Error details:', error);
  }

  // ============================================================
  // 📤 SEND CONFIRMATION EMAIL TO CUSTOMER
  // ============================================================
  try {
    if (customerEmail && customerEmail !== 'unknown@email') {
      console.log('📤 Sending confirmation email to customer:', customerEmail);
      
      const customerMailOptions = {
        from: `"FortuneHub" <${process.env.EMAIL_USER}>`,
        to: customerEmail,
        subject: `✅ Order Confirmation - ${orderReference} - FortuneHub`,
        html: customerEmailHtml
      };

      const customerInfo = await transporter.sendMail(customerMailOptions);
      console.log('✅ Customer confirmation email sent successfully!');
      console.log('   Message ID:', customerInfo.messageId);
      console.log('   Sent to:', customerEmail);
    } else {
      console.error('❌ Invalid customer email address:', customerEmail);
    }
  } catch (error) {
    console.error('❌ Failed to send customer email:', error.message);
    console.error('   Error details:', error);
  }
}

// ================================================================
// GET ALL ORDERS
// ================================================================
app.get('/api/orders', (req, res) => {
  db.all('SELECT * FROM orders ORDER BY created_at DESC', [], (err, rows) => {
    if (err) {
      console.error('❌ Database error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch orders' });
    }
    res.json({ success: true, count: rows.length, orders: rows });
  });
});

// ================================================================
// GET SINGLE ORDER BY REFERENCE
// ================================================================
app.get('/api/orders/:reference', (req, res) => {
  const { reference } = req.params;

  db.get('SELECT * FROM orders WHERE order_reference = ?', [reference], (err, row) => {
    if (err) {
      console.error('❌ Database error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch order' });
    }
    if (!row) return res.status(404).json({ error: 'Order not found' });

    res.json({ success: true, order: row });
  });
});

// ================================================================
// 🆕 GET ORDERS BY EMAIL OR REFERENCE (For Transaction History)
// ================================================================
app.post('/api/orders/search', (req, res) => {
  const { email, orderReference } = req.body;

  if (!email && !orderReference) {
    return res.status(400).json({ 
      error: 'Please provide either email or order reference' 
    });
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
    if (err) {
      console.error('❌ Database error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch orders' });
    }

    res.json({ 
      success: true, 
      count: rows.length, 
      orders: rows 
    });
  });
});

// ================================================================
// 🆕 TEST EMAIL ENDPOINT (for debugging)
// ================================================================
app.post('/api/test-email', async (req, res) => {
  const { testEmail } = req.body;
  
  if (!testEmail) {
    return res.status(400).json({ error: 'testEmail is required' });
  }

  try {
    console.log('🧪 Testing email to:', testEmail);
    
    const mailOptions = {
      from: `"FortuneHub Test" <${process.env.EMAIL_USER}>`,
      to: testEmail,
      subject: '✅ Test Email from FortuneHub Backend',
      html: `
        <div style="font-family: Arial; padding: 20px;">
          <h2>✅ Email Configuration Working!</h2>
          <p>This is a test email from your FortuneHub backend server.</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          <p>If you received this, your email configuration is correct! 🎉</p>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Test email sent:', info.messageId);
    
    res.json({
      success: true,
      message: 'Test email sent successfully!',
      messageId: info.messageId,
      recipient: testEmail
    });
  } catch (error) {
    console.error('❌ Test email failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send test email',
      details: error.message
    });
  }
});

// ================================================================
// START SERVER - ✅ FIXED TEMPLATE LITERALS
// ================================================================
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log('🚀 FortuneHub Backend Server Started!');
  console.log('🚀 ================================');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  console.log('💾 Database: orders.db');
  console.log('📧 Email User:', process.env.EMAIL_USER || 'NOT CONFIGURED ❌');
  console.log('📧 Owner Email:', process.env.OWNER_EMAIL || 'NOT CONFIGURED ❌');
  console.log('✉️  Email notifications: Enabled (Owner + Customer)');
  console.log('📜 Transaction history: Enabled');
  console.log('🚀 ================================');
  console.log('');
});

// ================================================================
// GRACEFUL SHUTDOWN
// ================================================================
process.on('SIGINT', () => {
  console.log('\n⏳ Shutting down gracefully...');
  db.close((err) => {
    if (err) console.error('❌ Error closing database:', err.message);
    else console.log('✅ Database connection closed');
    process.exit(0);
  });
});    
