// ================================================================
// FORTUNEHUB E-COMMERCE BACKEND SERVER (RENDER + POSTGRES + RESEND)
// - Orders stored in Postgres (JSONB products + JSONB cart_items)
// - Resend for owner + customer emails WITH PRODUCT IMAGES
// ================================================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const { Resend } = require('resend');
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
// POSTGRES (Render)
// ================================================================
if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL is not set. On Render, attach a Postgres DB and use its DATABASE_URL.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_reference TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      shipping_state TEXT NOT NULL,

      shipping_fee INTEGER NOT NULL,          -- NAIRA
      subtotal BIGINT NOT NULL,               -- KOBO
      total_amount BIGINT NOT NULL,           -- KOBO

      products JSONB NOT NULL,                -- ✅ JSON products with images
      cart_items JSONB NOT NULL,              -- ✅ JSON cart items with images

      payment_status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ================================================================
// RESEND EMAIL SERVICE
// ================================================================
const resend = process.env.RESEND_API_KEY 
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

if (!resend) {
  console.warn('⚠️ RESEND_API_KEY is not set. Emails will fail until configured.');
}

// Use Resend's default onboarding domain or your verified domain
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const OWNER_EMAIL = process.env.OWNER_EMAIL;

// ================================================================
// PAYSTACK
// ================================================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ================================================================
// HEALTHCHECK
// ================================================================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 FortuneHub Backend Server is Running!',
    status: 'active',
    timestamp: new Date().toISOString(),
    postgresConfigured: !!process.env.DATABASE_URL,
    resendConfigured: !!resend && !!RESEND_FROM_EMAIL,
    ownerEmailConfigured: !!OWNER_EMAIL,
    emailService: 'Resend'
  });
});

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
    // METADATA EXTRACTION (supports direct keys + custom_fields)
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

    // ✅ Extract products and cart_items WITH IMAGES
    const products =
      normalizeProducts(metadata) ||
      normalizeProducts({ products: getCustomField('products') }) ||
      [];

    const cartItems =
      normalizeCartItems(metadata) ||
      normalizeCartItems({ cart_items: getCustomField('cart_items') }) ||
      [];

    console.log('💾 Saving order to Postgres...');
    console.log('📧 Customer Email extracted:', customerEmail);
    console.log('🖼️ Products with images:', products.length);
    console.log('🛒 Cart items with images:', cartItems.length);

    const insertResult = await pool.query(
      `
        INSERT INTO orders (
          order_reference, customer_name, customer_email, customer_phone,
          shipping_state, shipping_fee, subtotal, total_amount,
          products, cart_items, payment_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id
      `,
      [
        reference,
        customerName,
        customerEmail,
        customerPhone,
        shippingState,
        shippingFeeNaira,
        subtotal,
        totalAmount,
        JSON.stringify(products),
        JSON.stringify(cartItems),
        'success'
      ]
    );

    const orderId = insertResult.rows[0]?.id;

    // Send emails (async but awaited to report errors clearly)
    sendOrderEmail({
      orderReference: reference,
      customerName,
      customerEmail,
      customerPhone,
      shippingState,
      shippingFee: shippingFeeNaira, // NAIRA
      subtotal, // KOBO
      totalAmount, // KOBO
      products,
      cartItems
    }).catch(err => {
      console.error('❌ Email send failed:', err?.response?.body || err.message);
    });

    res.json({
      message: 'Payment verified and order saved successfully! Emails are being sent.',
      reference,
      orderId
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
// EMAIL SENDING (Resend) - WITH PRODUCT IMAGES ✅
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
    products,
    cartItems
  } = orderData;

  if (!resend || !RESEND_FROM_EMAIL) {
    console.warn('⚠️ Resend not configured. Skipping email sending.');
    return;
  }

  const cleanPhone = String(customerPhone || '').trim();
  const whatsappNumber = cleanPhone && cleanPhone !== 'N/A'
    ? cleanPhone.replace(/^0/, '234').replace(/\s/g, '')
    : '';

  const whatsappLink = whatsappNumber ? `https://wa.me/${whatsappNumber}` : '#';

  // ✅ Render cart items table rows WITH IMAGES
  const items = Array.isArray(cartItems) ? cartItems : [];
  const cartItemsHtml = items.length
    ? items.map((item) => {
        const name = item?.name || 'Item';
        const qty = Number(item?.quantity || 1);
        const priceKobo = Number(item?.price || 0);
        const imageUrl = item?.image || item?.imageUrl || item?.img || '';
        
        // ✅ Image cell with fallback placeholder
        const imageCell = imageUrl 
          ? `<img src="${imageUrl}" alt="${name}" style="width:60px;height:60px;object-fit:cover;border-radius:4px;">`
          : `<span style="color:#999;">No Image</span>`;
        
        return `
          <tr>
            <td style="padding:12px;text-align:center;border-bottom:1px solid #e0e0e0;">${imageCell}</td>
            <td style="padding:12px;border-bottom:1px solid #e0e0e0;">${name}</td>
            <td style="padding:12px;text-align:center;border-bottom:1px solid #e0e0e0;">${qty}</td>
            <td style="padding:12px;text-align:right;border-bottom:1px solid #e0e0e0;">${formatCurrency(priceKobo)}</td>
            <td style="padding:12px;text-align:right;border-bottom:1px solid #e0e0e0;font-weight:600;">${formatCurrency(priceKobo * qty)}</td>
          </tr>
        `;
      }).join('')
    : `
      <tr>
        <td colspan="5" style="padding:20px;text-align:center;color:#999;">
          (No cart items received)
        </td>
      </tr>
    `;

  // ✅ Products summary with images (JSON)
  const productsList = Array.isArray(products) && products.length
    ? `
      <ul style="list-style:none;padding:0;">
        ${products.map(p => {
          const pName = p?.name || JSON.stringify(p);
          const pImage = p?.image || p?.imageUrl || p?.img || '';
          const pQty = p?.quantity || 1;
          return `
            <li style="margin-bottom:10px;display:flex;align-items:center;gap:10px;">
              ${pImage 
                ? `<img src="${pImage}" alt="${pName}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;">`
                : `<span style="color:#999;font-size:12px;">No Image</span>`
              }
              <span><strong>${pName}</strong> <em>(Qty: ${pQty})</em></span>
            </li>
          `;
        }).join('')}
      </ul>
    `
    : `<p style="color:#999;">No products field provided.</p>`;

  // ================================================================
  // 👤 OWNER EMAIL HTML (WITH IMAGES)
  // ================================================================
  const ownerEmailHtml = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;background:#ffffff;border:1px solid #e0e0e0;">
      <div style="background:#4CAF50;color:#fff;padding:20px;text-align:center;">
        <h1 style="margin:0;font-size:24px;">🎉 New Order Received!</h1>
        <p style="margin:5px 0 0;font-size:14px;">FortuneHub E-commerce Platform</p>
      </div>
      <div style="padding:30px;">
        <div style="background:#f5f5f5;padding:15px;border-left:4px solid #4CAF50;margin-bottom:20px;">
          <strong>Order Reference:</strong> ${orderReference}<br>
          <strong>Date:</strong> ${new Date().toLocaleString('en-NG')}
        </div>

        <h2 style="color:#333;border-bottom:2px solid #4CAF50;padding-bottom:10px;">👤 Customer Information</h2>
        <table style="width:100%;margin-bottom:20px;">
          <tr>
            <td style="padding:8px 0;color:#666;width:150px;"><strong>Name:</strong></td>
            <td style="padding:8px 0;">${customerName}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#666;"><strong>Email:</strong></td>
            <td style="padding:8px 0;">${customerEmail}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#666;"><strong>Phone:</strong></td>
            <td style="padding:8px 0;">${customerPhone}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#666;"><strong>Shipping State:</strong></td>
            <td style="padding:8px 0;">${shippingState}</td>
          </tr>
        </table>

        <h2 style="color:#333;border-bottom:2px solid #4CAF50;padding-bottom:10px;">🧾 Products Overview</h2>
        ${productsList}

        <h2 style="color:#333;border-bottom:2px solid #4CAF50;padding-bottom:10px;">🛍️ Cart Items Detail</h2>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <thead>
              <tr style="background:#4CAF50;color:#fff;">
                <th style="padding:12px;text-align:center;">Image</th>
                <th style="padding:12px;text-align:left;">Product</th>
                <th style="padding:12px;text-align:center;">Qty</th>
                <th style="padding:12px;text-align:right;">Price</th>
                <th style="padding:12px;text-align:right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${cartItemsHtml}
            </tbody>
          </table>
        </div>

        <div style="background:#f9f9f9;padding:20px;border-radius:8px;margin-bottom:20px;">
          <table style="width:100%;">
            <tr>
              <td style="padding:8px 0;color:#666;">Subtotal:</td>
              <td style="padding:8px 0;text-align:right;font-size:16px;">${formatCurrency(subtotal)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#666;">Shipping Fee (${shippingState}):</td>
              <td style="padding:8px 0;text-align:right;font-size:16px;">₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td>
            </tr>
            <tr style="border-top:2px solid #4CAF50;">
              <td style="padding:12px 0;color:#333;font-weight:bold;font-size:18px;">TOTAL PAID:</td>
              <td style="padding:12px 0;text-align:right;font-weight:bold;font-size:18px;color:#4CAF50;">${formatCurrency(totalAmount)}</td>
            </tr>
          </table>
        </div>

        <div style="text-align:center;margin:30px 0;">
          <a href="${whatsappLink}" style="display:inline-block;background:#25D366;color:#fff;padding:15px 30px;text-decoration:none;border-radius:5px;font-weight:bold;">
            💬 Contact Customer via WhatsApp
          </a>
        </div>

        <div style="background:#fff3cd;border-left:4px solid #ffc107;padding:15px;margin-top:20px;">
          <strong>📌 Action Required:</strong> Process this order and contact the customer to confirm delivery details.
        </div>
      </div>
    </div>
  `;

  // ================================================================
  // 🛒 CUSTOMER EMAIL HTML (WITH IMAGES)
  // ================================================================
  const customerEmailHtml = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;background:#ffffff;border:1px solid #e0e0e0;">
      <div style="background:#4CAF50;color:#fff;padding:20px;text-align:center;">
        <h1 style="margin:0;font-size:24px;">✅ Thank You for Your Order!</h1>
        <p style="margin:5px 0 0;font-size:14px;">FortuneHub - Your purchase is confirmed</p>
      </div>
      <div style="padding:30px;">
        <div style="background:#d4edda;border-left:4px solid #28a745;padding:15px;margin-bottom:20px;">
          <p style="margin:0;font-size:16px;">
            🎉 Your payment was successful and your order is being processed!
          </p>
        </div>

        <div style="background:#f5f5f5;padding:15px;margin-bottom:20px;">
          <strong>Order Reference:</strong>
          <span style="font-size:18px;color:#4CAF50;font-weight:bold;">${orderReference}</span><br>
          <strong>Date:</strong> ${new Date().toLocaleString('en-NG')}
        </div>

        <h2 style="color:#333;border-bottom:2px solid #4CAF50;padding-bottom:10px;">🧾 Your Order Items</h2>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <thead>
              <tr style="background:#4CAF50;color:#fff;">
                <th style="padding:12px;text-align:center;">Image</th>
                <th style="padding:12px;text-align:left;">Product</th>
                <th style="padding:12px;text-align:center;">Qty</th>
                <th style="padding:12px;text-align:right;">Price</th>
                <th style="padding:12px;text-align:right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${cartItemsHtml}
            </tbody>
          </table>
        </div>

        <div style="background:#f9f9f9;padding:20px;border-radius:8px;margin-bottom:20px;">
          <table style="width:100%;">
            <tr>
              <td style="padding:8px 0;color:#666;">Subtotal:</td>
              <td style="padding:8px 0;text-align:right;font-size:16px;">${formatCurrency(subtotal)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#666;">Shipping Fee (${shippingState}):</td>
              <td style="padding:8px 0;text-align:right;font-size:16px;">₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td>
            </tr>
            <tr style="border-top:2px solid #4CAF50;">
              <td style="padding:12px 0;color:#333;font-weight:bold;font-size:18px;">TOTAL PAID:</td>
              <td style="padding:12px 0;text-align:right;font-weight:bold;font-size:18px;color:#4CAF50;">${formatCurrency(totalAmount)}</td>
            </tr>
          </table>
        </div>

        <div style="background:#e7f3ff;border-left:4px solid #2196F3;padding:15px;margin-bottom:20px;">
          <h3 style="margin:0 0 10px;color:#1976D2;">📦 What's Next?</h3>
          <p style="margin:0;">We will contact you shortly via phone or email to confirm your delivery details and estimated delivery time.</p>
        </div>

        <div style="text-align:center;padding:30px 0;border-top:1px solid #e0e0e0;margin-top:20px;">
          <p style="font-size:18px;color:#4CAF50;font-weight:bold;margin:0 0 10px;">
            🎁 Thank you for shopping with FortuneHub!
          </p>
          <p style="color:#666;margin:0;">
            We appreciate your business and look forward to serving you again.
          </p>
        </div>

        <div style="background:#f5f5f5;padding:15px;font-size:12px;color:#666;text-align:center;">
          Please keep this email for your records.<br>
          Order Reference: <strong>${orderReference}</strong>
          <br><br>
          Need help? Contact us: ${RESEND_FROM_EMAIL}
        </div>
      </div>
    </div>
  `;

  // ================================================================
  // 📧 SEND EMAILS WITH RESEND
  // ================================================================
  
  // OWNER EMAIL
  if (OWNER_EMAIL) {
    try {
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: OWNER_EMAIL,
        subject: `🛒 New Order #${orderReference} - ${customerName}`,
        html: ownerEmailHtml
      });
      console.log('✅ Owner email sent with product images via Resend!');
    } catch (error) {
      console.error('❌ Owner email failed:', error.message);
    }
  } else {
    console.warn('⚠️ OWNER_EMAIL not configured, skipping owner notification email.');
  }

  // CUSTOMER EMAIL
  if (customerEmail && customerEmail !== 'unknown@email') {
    try {
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: customerEmail,
        subject: `✅ Order Confirmation #${orderReference} - FortuneHub`,
        html: customerEmailHtml
      });
      console.log('✅ Customer email sent with product images via Resend!');
    } catch (error) {
      console.error('❌ Customer email failed:', error.message);
    }
  } else {
    console.warn('⚠️ Invalid customer email, skipping customer confirmation.');
  }
}

// ================================================================
// GET ALL ORDERS
// ================================================================
app.get('/api/orders', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json({ success: true, count: rows.length, orders: rows });
  } catch (err) {
    console.error('❌ Database error:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ================================================================
// GET SINGLE ORDER BY REFERENCE
// ================================================================
app.get('/api/orders/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE order_reference = $1',
      [reference]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, order: rows[0] });
  } catch (err) {
    console.error('❌ Database error:', err.message);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ================================================================
// SEARCH ORDERS BY EMAIL OR REFERENCE
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
      const { rows } = await pool.query(
        'SELECT * FROM orders WHERE order_reference = $1',
        [orderReference]
      );
      return res.json({ success: true, count: rows.length, orders: rows });
    }

    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC',
      [email]
    );
    res.json({ success: true, count: rows.length, orders: rows });
  } catch (err) {
    console.error('❌ Database error:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
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
        <div style="font-family:Arial,sans-serif;padding:20px;">
          <h1>✅ Resend Working!</h1>
          <p>This is a test email from your FortuneHub backend server.</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        </div>
      `
    });

    res.json({
      success: true,
      message: 'Test email sent successfully via Resend!',
      resendResponse: result,
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
// START SERVER
// ================================================================
ensureTables()
  .then(() => {
    console.log('✅ Postgres tables ready');

    app.listen(PORT, () => {
      console.log('');
      console.log('🚀 ================================');
      console.log('🚀 FortuneHub Backend Server Started!');
      console.log('🚀 ================================');
      console.log(`📡 Server running on port ${PORT}`);
      console.log('🗄️ Database: Postgres (Render)');
      console.log('✉️  Email: Resend WITH IMAGES ✅');
      console.log('🚀 ================================');
      console.log('');
    });
  })
  .catch((err) => {
    console.error('❌ Failed to init database tables:', err.message);
    process.exit(1);
  });

// ================================================================
// GRACEFUL SHUTDOWN
// ================================================================
process.on('SIGINT', async () => {
  console.log('\n⏳ Shutting down gracefully...');
  try {
    await pool.end();
    console.log('✅ Postgres pool closed');
  } catch (err) {
    console.error('❌ Error closing Postgres pool:', err.message);
  }
  process.exit(0);
});
