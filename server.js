
// ================================================================
// FORTUNEHUB E-COMMERCE BACKEND SERVER (RENDER + POSTGRES + SENDGRID)
// - Orders stored in Postgres (JSONB products + JSONB cart_items)
// - SendGrid for owner + customer emails WITH PRODUCT IMAGES
// ================================================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const sgMail = require('@sendgrid/mail');
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
// SENDGRID
// ================================================================
if (!process.env.SENDGRID_API_KEY) {
  console.warn('⚠️ SENDGRID_API_KEY is not set. Emails will fail until configured.');
} else {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL; // must be verified in SendGrid
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
    sendgridConfigured: !!process.env.SENDGRID_API_KEY && !!SENDGRID_FROM_EMAIL,
    ownerEmailConfigured: !!OWNER_EMAIL
  });
});

// ================================================================
// HELPERS
// ================================================================
function formatCurrency(amountInKobo) {
  return ₦${(Number(amountInKobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })};
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
      https://api.paystack.co/transaction/verify/${reference},
      { headers: { Authorization: Bearer ${PAYSTACK_SECRET_KEY} } }
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
// EMAIL SENDING (SendGrid) - WITH PRODUCT IMAGES ✅
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

  if (!process.env.SENDGRID_API_KEY || !SENDGRID_FROM_EMAIL) {
    console.warn('⚠️ SendGrid not configured. Skipping email sending.');
    return;
  }

  const cleanPhone = String(customerPhone || '').trim();
  const whatsappNumber = cleanPhone && cleanPhone !== 'N/A'
    ? cleanPhone.replace(/^0/, '234').replace(//g, '')
    : '';

  const whatsappLink = whatsappNumber ? https://wa.me/${whatsappNumber} : '#';

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
          ? ``
          : No Image;
        
        return `
          
            ${imageCell}
            ${name}
            ${qty}
            ${formatCurrency(priceKobo)}
            ${formatCurrency(priceKobo * qty)}
          
        `;
      }).join('')
    : `
      
        
          (No cart items received)
        
      
    `;

  // ✅ Products summary with images (JSON)
  const productsList = Array.isArray(products) && products.length
    ? `
      
        ${products.map(p => {
          const pName = p?.name || JSON.stringify(p);
          const pImage = p?.image || p?.imageUrl || p?.img || '';
          const pQty = p?.quantity || 1;
          return `
            
              ${pImage 
                ? ``
                : No Image
              }
              ${pName}
              Qty: ${pQty}
            
          `;
        }).join('')}
      
    `
    : No products field provided.;

  // ================================================================
  // 👤 OWNER EMAIL HTML (WITH IMAGES)
  // ================================================================
  const ownerEmailHtml = `
    
      
        🎉 New Order Received!
        FortuneHub E-commerce Platform
      
      
      
        
          Order Reference: ${orderReference}
          Date: ${new Date().toLocaleString('en-NG')}
        

        👤 Customer Information
        
          
            Name:
            ${customerName}
          
          
            Email:
            ${customerEmail}
          
          
            Phone:
            ${customerPhone}
          
          
            Shipping State:
            ${shippingState}
          
        

        🧾 Products Overview
        ${productsList}

        🛍️ Cart Items Detail
        
          
            
              
                Image
                Product
                Qty
                Price
                Total
              
            
            
              ${cartItemsHtml}
            
          
        

        
          
            
              Subtotal:
              ${formatCurrency(subtotal)}
            
            
              Shipping Fee (${shippingState}):
              ₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}
            
            
              TOTAL PAID:
              ${formatCurrency(totalAmount)}
            
          
        

        
          
            💬 Contact Customer via WhatsApp
          
        

        
          
            📌 Action Required: Process this order and contact the customer to confirm delivery details.
          
        
      
    
  `;

  // ================================================================
  // 🛒 CUSTOMER EMAIL HTML (WITH IMAGES)
  // ================================================================
  const customerEmailHtml = `
    
      
        ✅ Thank You for Your Order!
        FortuneHub - Your purchase is confirmed
      
      
      
        
          
            🎉 Your payment was successful and your order is being processed!
          
        

        
          Order Reference:
          ${orderReference}
          Date: ${new Date().toLocaleString('en-NG')}
        

        🧾 Your Order Items
        
          
            
              
                Image
                Product
                Qty
                Price
                Total
              
            
            
              ${cartItemsHtml}
            
          
        

        
          
            
              Subtotal:
              ${formatCurrency(subtotal)}
            
            
              Shipping Fee (${shippingState}):
              ₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}
            
            
              TOTAL PAID:
              ${formatCurrency(totalAmount)}
            
          
        

        
          
            📦 What's Next?
            We will contact you shortly via phone or email to confirm your delivery details and estimated delivery time.
          
        

        
          
            🎁 Thank you for shopping with FortuneHub!
          
          
            We appreciate your business and look forward to serving you again.
          
        

        
          Please keep this email for your records.
          Order Reference: ${orderReference}
          
          Need help? Contact us: ${SENDGRID_FROM_EMAIL}
        
      
    
  `;

  // ================================================================
  // 📧 SEND EMAILS
  // ================================================================
  
  // OWNER EMAIL
  if (OWNER_EMAIL) {
    await sgMail.send({
      to: OWNER_EMAIL,
      from: SENDGRID_FROM_EMAIL,
      subject: 🛒 New Order #${orderReference} - ${customerName},
      html: ownerEmailHtml
    });
    console.log('✅ Owner email sent with product images!');
  } else {
    console.warn('⚠️ OWNER_EMAIL not configured, skipping owner notification email.');
  }

  // CUSTOMER EMAIL
  if (customerEmail && customerEmail !== 'unknown@email') {
    await sgMail.send({
      to: customerEmail,
      from: SENDGRID_FROM_EMAIL,
      subject: ✅ Order Confirmation #${orderReference} - FortuneHub,
      html: customerEmailHtml
    });
    console.log('✅ Customer email sent with product images!');
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
    if (!process.env.SENDGRID_API_KEY || !SENDGRID_FROM_EMAIL) {
      return res.status(500).json({
        success: false,
        error: 'SendGrid is not configured (missing SENDGRID_API_KEY or SENDGRID_FROM_EMAIL)'
      });
    }

    const info = await sgMail.send({
      to: testEmail,
      from: SENDGRID_FROM_EMAIL,
      subject: '✅ Test Email from FortuneHub Backend (SendGrid)',
      html: `
        
          ✅ SendGrid Working!
          This is a test email from your FortuneHub backend server.
          Timestamp: ${new Date().toISOString()}
        
      `
    });

    res.json({
      success: true,
      message: 'Test email sent successfully!',
      sendgridResponse: Array.isArray(info) ? info[0]?.statusCode : 'ok',
      recipient: testEmail
    });
  } catch (error) {
    console.error('❌ Test email failed:', error?.response?.body || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to send test email',
      details: error?.response?.body || error.message
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
      console.log(📡 Server running on port ${PORT});
      console.log('🗄️ Database: Postgres (Render)');
      console.log('✉️  Email: SendGrid WITH IMAGES ✅');
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
