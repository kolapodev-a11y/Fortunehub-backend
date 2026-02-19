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
if (!process.env.RESEND_API_KEY) {
  console.warn('⚠️ RESEND_API_KEY is not set. Emails will fail until configured.');
}

const resend = new Resend(process.env.RESEND_API_KEY);
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
    resendConfigured: !!process.env.RESEND_API_KEY && !!RESEND_FROM_EMAIL,
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
      console.error('❌ Email send failed:', err?.message || err);
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
// EMAIL SENDING (RESEND) - WITH PRODUCT IMAGES ✅
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

  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️ Resend not configured. Skipping email sending.');
    return;
  }

  const cleanPhone = String(customerPhone || '').trim();
  const whatsappNumber = cleanPhone && cleanPhone !== 'N/A'
    ? cleanPhone.replace(/^0/, '234').replace(/[^\d]/g, '')
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
          ? `<img src="${imageUrl}" alt="${name}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 4px; border: 1px solid #e5e7eb;" />`
          : `<div style="width: 60px; height: 60px; background: #f3f4f6; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #9ca3af; border: 1px solid #e5e7eb;">No Image</div>`;
        
        return `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">${imageCell}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">${name}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">${qty}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCurrency(priceKobo)}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: 600;">${formatCurrency(priceKobo * qty)}</td>
          </tr>
        `;
      }).join('')
    : `
      <tr>
        <td colspan="5" style="padding: 20px; text-align:center; color:#6b7280;">
          (No cart items received)
        </td>
      </tr>
    `;

  // ✅ Products summary with images (JSON)
  const productsList = Array.isArray(products) && products.length
    ? `
      <div style="display: flex; flex-wrap: wrap; gap: 12px; margin-top: 15px;">
        ${products.map(p => {
          const pName = p?.name || JSON.stringify(p);
          const pImage = p?.image || p?.imageUrl || p?.img || '';
          const pQty = p?.quantity || 1;
          return `
            <div style="border: 1px solid #e5e7eb; padding: 12px; border-radius: 8px; width: 160px; background: white;">
              ${pImage 
                ? `<img src="${pImage}" alt="${pName}" style="width: 100%; height: 140px; object-fit: cover; border-radius: 6px; margin-bottom: 10px;" />`
                : `<div style="width: 100%; height: 140px; background: #f3f4f6; border-radius: 6px; display: flex; align-items: center; justify-content: center; margin-bottom: 10px; font-size: 12px; color: #9ca3af;">No Image</div>`
              }
              <p style="margin: 0; font-size: 14px; text-align: center; font-weight: 500;">${pName}</p>
              <p style="margin: 5px 0 0 0; font-size: 12px; text-align: center; color: #6b7280;">Qty: ${pQty}</p>
            </div>
          `;
        }).join('')}
      </div>
    `
    : `<p style="color:#6b7280;">No products field provided.</p>`;

  // ================================================================
  // 👤 OWNER EMAIL HTML (WITH IMAGES)
  // ================================================================
  const ownerEmailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color:#1f2937; max-width: 800px; margin: 0 auto; background: #f9fafb;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 20px; border-radius: 12px 12px 0 0;">
        <h2 style="margin: 0; font-size: 28px; font-weight: 700;">🎉 New Order Received!</h2>
        <p style="margin: 10px 0 0 0; opacity: 0.9; font-size: 14px;">FortuneHub E-commerce Platform</p>
      </div>
      
      <div style="padding: 30px 20px; background: white; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 6px; margin-bottom: 25px;">
          <p style="margin: 0; font-weight: 600;"><strong>Order Reference:</strong> <span style="color: #d97706;">${orderReference}</span></p>
          <p style="margin: 8px 0 0 0;"><strong>Date:</strong> ${new Date().toLocaleString('en-NG')}</p>
        </div>

        <h3 style="border-bottom: 3px solid #667eea; padding-bottom: 10px; color: #667eea; margin-top: 0;">👤 Customer Information</h3>
        <table style="width: 100%; margin-bottom: 25px;">
          <tr>
            <td style="padding: 8px 0; font-weight: 600; width: 140px;">Name:</td>
            <td style="padding: 8px 0;">${customerName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: 600;">Email:</td>
            <td style="padding: 8px 0;"><a href="mailto:${customerEmail}" style="color: #667eea; text-decoration: none;">${customerEmail}</a></td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: 600;">Phone:</td>
            <td style="padding: 8px 0;">${customerPhone}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: 600;">Shipping State:</td>
            <td style="padding: 8px 0;">${shippingState}</td>
          </tr>
        </table>

        <h3 style="border-bottom: 3px solid #667eea; padding-bottom: 10px; color: #667eea;">🧾 Products Overview</h3>
        ${productsList}

        <h3 style="border-bottom: 3px solid #667eea; padding-bottom: 10px; color: #667eea; margin-top: 35px;">🛍️ Cart Items Detail</h3>
        <div style="overflow-x: auto;">
          <table style="width:100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
            <thead>
              <tr style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white;">
                <th style="padding:14px; text-align:left; font-weight: 600;">Image</th>
                <th style="padding:14px; text-align:left; font-weight: 600;">Product</th>
                <th style="padding:14px; text-align:center; font-weight: 600;">Qty</th>
                <th style="padding:14px; text-align:right; font-weight: 600;">Price</th>
                <th style="padding:14px; text-align:right; font-weight: 600;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${cartItemsHtml}
            </tbody>
          </table>
        </div>

        <div style="margin-top: 30px; padding: 25px; background: linear-gradient(to right, #f9fafb, #f3f4f6); border-radius: 10px; border: 1px solid #e5e7eb;">
          <table style="width: 100%;">
            <tr>
              <td style="padding: 8px 0; font-size: 16px;"><strong>Subtotal:</strong></td>
              <td style="padding: 8px 0; text-align: right; font-size: 16px;">${formatCurrency(subtotal)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-size: 16px;"><strong>Shipping Fee (${shippingState}):</strong></td>
              <td style="padding: 8px 0; text-align: right; font-size: 16px;">₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td>
            </tr>
            <tr style="border-top: 2px solid #667eea;">
              <td style="padding: 15px 0 0 0; font-size: 22px; font-weight: 700; color: #667eea;">TOTAL PAID:</td>
              <td style="padding: 15px 0 0 0; text-align: right; font-size: 22px; font-weight: 700; color: #667eea;">${formatCurrency(totalAmount)}</td>
            </tr>
          </table>
        </div>

        <div style="margin-top: 25px; text-align: center;">
          <a href="${whatsappLink}" style="display:inline-block; padding:16px 32px; background:#25D366; color:#fff; text-decoration:none; border-radius:10px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px rgba(37, 211, 102, 0.3);">
            💬 Contact Customer via WhatsApp
          </a>
        </div>

        <div style="margin-top: 30px; padding: 15px; background: #eff6ff; border-left: 4px solid #3b82f6; border-radius: 6px;">
          <p style="margin: 0; font-size: 13px; color: #1e40af;">
            <strong>📌 Action Required:</strong> Process this order and contact the customer to confirm delivery details.
          </p>
        </div>
      </div>
    </div>
  `;

  // ================================================================
  // 🛒 CUSTOMER EMAIL HTML (WITH IMAGES)
  // ================================================================
  const customerEmailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color:#1f2937; max-width: 800px; margin: 0 auto; background: #f9fafb;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 20px; border-radius: 12px 12px 0 0;">
        <h2 style="margin: 0; font-size: 28px; font-weight: 700;">✅ Thank You for Your Order!</h2>
        <p style="margin: 10px 0 0 0; opacity: 0.9; font-size: 14px;">FortuneHub - Your purchase is confirmed</p>
      </div>
      
      <div style="padding: 30px 20px; background: white; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <div style="background: #d1fae5; border-left: 4px solid #10b981; padding: 15px; border-radius: 6px; margin-bottom: 25px;">
          <p style="margin: 0; font-size: 16px; font-weight: 600; color: #047857;">
            🎉 Your payment was successful and your order is being processed!
          </p>
        </div>

        <div style="background: #fef3c7; padding: 20px; border-radius: 10px; margin: 20px 0; border: 1px solid #fbbf24;">
          <p style="margin: 0; font-weight: 600;"><strong>Order Reference:</strong></p>
          <p style="margin: 8px 0; font-size: 24px; color: #d97706; font-weight: 700; letter-spacing: 1px;">${orderReference}</p>
          <p style="margin: 10px 0 0 0; font-size: 13px; color: #92400e;"><strong>Date:</strong> ${new Date().toLocaleString('en-NG')}</p>
        </div>

        <h3 style="border-bottom: 3px solid #667eea; padding-bottom: 10px; color: #667eea;">🧾 Your Order Items</h3>
        <div style="overflow-x: auto;">
          <table style="width:100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
            <thead>
              <tr style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white;">
                <th style="padding:14px; text-align:left; font-weight: 600;">Image</th>
                <th style="padding:14px; text-align:left; font-weight: 600;">Product</th>
                <th style="padding:14px; text-align:center; font-weight: 600;">Qty</th>
                <th style="padding:14px; text-align:right; font-weight: 600;">Price</th>
                <th style="padding:14px; text-align:right; font-weight: 600;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${cartItemsHtml}
            </tbody>
          </table>
        </div>

        <div style="margin-top: 30px; padding: 25px; background: linear-gradient(to right, #f9fafb, #f3f4f6); border-radius: 10px; border: 1px solid #e5e7eb;">
          <table style="width: 100%;">
            <tr>
              <td style="padding: 8px 0; font-size: 16px;"><strong>Subtotal:</strong></td>
              <td style="padding: 8px 0; text-align: right; font-size: 16px;">${formatCurrency(subtotal)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-size: 16px;"><strong>Shipping Fee (${shippingState}):</strong></td>
              <td style="padding: 8px 0; text-align: right; font-size: 16px;">₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td>
            </tr>
            <tr style="border-top: 2px solid #667eea;">
              <td style="padding: 15px 0 0 0; font-size: 22px; font-weight: 700; color: #667eea;">TOTAL PAID:</td>
              <td style="padding: 15px 0 0 0; text-align: right; font-size: 22px; font-weight: 700; color: #667eea;">${formatCurrency(totalAmount)}</td>
            </tr>
          </table>
        </div>

        <div style="margin-top: 30px; padding: 20px; background: #eff6ff; border-left: 4px solid #3b82f6; border-radius: 6px;">
          <p style="margin: 0; font-size: 15px; color: #1e40af;">
            <strong>📦 What's Next?</strong><br/>
            We will contact you shortly via phone or email to confirm your delivery details and estimated delivery time.
          </p>
        </div>

        <div style="margin-top: 30px; padding: 20px; background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; text-align: center;">
          <p style="margin: 0; font-size: 15px; color: #166534; font-weight: 600;">
            🎁 Thank you for shopping with FortuneHub!
          </p>
          <p style="margin: 10px 0 0 0; font-size: 13px; color: #15803d;">
            We appreciate your business and look forward to serving you again.
          </p>
        </div>

        <p style="color:#6b7280; font-size: 12px; margin-top: 35px; text-align: center; padding-top: 20px; border-top: 1px solid #e5e7eb;">
          Please keep this email for your records.<br/>
          Order Reference: <strong style="color: #1f2937;">${orderReference}</strong><br/>
          <br/>
          Need help? Contact us: <a href="mailto:${RESEND_FROM_EMAIL}" style="color: #667eea; text-decoration: none;">${RESEND_FROM_EMAIL}</a>
        </p>
      </div>
    </div>
  `;

  // ================================================================
  // 📧 SEND EMAILS USING RESEND
  // ================================================================
  
  try {
    // OWNER EMAIL
    if (OWNER_EMAIL) {
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: OWNER_EMAIL,
        subject: `🛒 New Order #${orderReference} - ${customerName}`,
        html: ownerEmailHtml
      });
      console.log('✅ Owner email sent with product images via Resend!');
    } else {
      console.warn('⚠️ OWNER_EMAIL not configured, skipping owner notification email.');
    }

    // CUSTOMER EMAIL
    if (customerEmail && customerEmail !== 'unknown@email') {
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: customerEmail,
        subject: `✅ Order Confirmation #${orderReference} - FortuneHub`,
        html: customerEmailHtml
      });
      console.log('✅ Customer email sent with product images via Resend!');
    } else {
      console.warn('⚠️ Invalid customer email, skipping customer confirmation.');
    }
  } catch (error) {
    console.error('❌ Resend email error:', error?.message || error);
    throw error;
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
    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Resend is not configured (missing RESEND_API_KEY)'
      });
    }

    const result = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: testEmail,
      subject: '✅ Test Email from FortuneHub Backend (Resend)',
      html: `
        <div style="font-family: Arial; padding: 20px;">
          <h2>✅ Resend Email Working!</h2>
          <p>This is a test email from your FortuneHub backend server using Resend.</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          <p><strong>Email Service:</strong> Resend</p>
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
    console.error('❌ Test email failed:', error?.message || error);
    res.status(500).json({
      success: false,
      error: 'Failed to send test email',
      details: error?.message || error
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
