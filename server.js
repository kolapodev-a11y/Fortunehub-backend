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
// EMAIL CONFIGURATION
// ================================================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
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
    timestamp: new Date().toISOString()
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

    const paystackResponse = await axios.get(
      https://api.paystack.co/transaction/verify/${reference},
      {
        headers: {
          Authorization: Bearer ${PAYSTACK_SECRET_KEY}
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

      // 📧 Send emails to BOTH owner and customer
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
      details: error?.response?.data || error.message
    });
  }
});

// ================================================================
// EMAIL SENDING FUNCTION (SENDS TO BOTH OWNER & CUSTOMER)
// ================================================================
function sendOrderEmail(orderData) {
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

  const formatCurrency = (amountInKobo) => {
    return ₦${(amountInKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })};
  };

  let cartItemsHtml = '';
  if (cartItems && cartItems.length > 0) {
    cartItems.forEach(item => {
      const name = item?.name || 'Item';
      const qty = Number(item?.quantity || 1);
      const priceKobo = Number(item?.price || 0);
      cartItemsHtml += `
        
          ${name}
          ${qty}
          ${formatCurrency(priceKobo)}
          ${formatCurrency(priceKobo * qty)}
        
      `;
    });
  } else {
    cartItemsHtml = `
      
        
          (No cart items received)
        
      
    `;
  }

  // WhatsApp link safety
  const cleanPhone = String(customerPhone || '').trim();
  const whatsappNumber = cleanPhone && cleanPhone !== 'N/A'
    ? cleanPhone.replace(/^0/, '234').replace(//g, '')
    : '';

  const whatsappLink = whatsappNumber ? https://wa.me/${whatsappNumber} : '#';

  // ============================================================
  // 📧 OWNER EMAIL (Admin Notification)
  // ============================================================
  const ownerEmailHtml = `
    
    
    
      
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
      
    
    
      
        
          🎉 New Order Received!
          FortuneHub E-Commerce
        

        
          
            📦 Order Details
            
              Order Reference:
              ${orderReference}
            
            
              Order Date:
              ${new Date().toLocaleString()}
            
          

          
            👤 Customer Information
            
              Name:
              ${customerName}
            
            
              Email:
              ${customerEmail}
            
            
              Phone (WhatsApp):
              ${customerPhone}
            
            
              Shipping State:
              ${shippingState}
            
          

          
            🛍️ Order Items
            
              
                
                  Product
                  Quantity
                  Price
                  Total
                
              
              
                ${cartItemsHtml}
              
            

            
              Subtotal:
              ${formatCurrency(subtotal)}
            
            
              Shipping Fee:
              ₦${Number(shippingFee).toLocaleString('en-NG', { minimumFractionDigits: 2 })}
            
            
              TOTAL PAID:
              ${formatCurrency(totalAmount)}
            
          

          
            ⚡ Action Required:
            Please contact the customer via WhatsApp or email to arrange delivery.

            
              💬 Contact via WhatsApp
            
          
        
      
    
    
  `;

  // ============================================================
  // 📧 CUSTOMER EMAIL (Order Confirmation)
  // ============================================================
  const customerEmailHtml = `
    
    
    
      
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
      
    
    
      
        
          ✨ Thank You for Your Order!
          Your order has been confirmed and is being processed
        

        
          
            ✅ Payment Successful
          

          
            📦 Order Information
            
              Order Reference:
              ${orderReference}
            
            
              Order Date:
              ${new Date().toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' })}
            
            
              Customer Name:
              ${customerName}
            
            
              Email:
              ${customerEmail}
            
            
              Phone:
              ${customerPhone}
            
            
              Shipping State:
              ${shippingState}
            
          

          🛍️ Order Items
          
            
              
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
            
          

          
            📞 What's Next?
            Our team will contact you shortly via WhatsApp or phone to confirm your delivery details.
            Estimated Delivery: 2-5 business days (depending on your location)
            If you have any questions, please don't hesitate to reach out!
          
        

        
          FortuneHub E-Commerce
          Thank you for shopping with us! 🎉
          
            Keep this email for your records. Order Reference: ${orderReference}
          
        
      
    
    
  `;

  // ============================================================
  // 📤 SEND EMAIL TO OWNER
  // ============================================================
  const ownerMailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.OWNER_EMAIL,
    subject: 🛒 New Order - ${orderReference} - ${customerName},
    html: ownerEmailHtml
  };

  transporter.sendMail(ownerMailOptions, (error, info) => {
    if (error) console.error('❌ Owner email failed:', error);
    else console.log('✅ Owner email sent:', info.response);
  });

  // ============================================================
  // 📤 SEND CONFIRMATION EMAIL TO CUSTOMER
  // ============================================================
  const customerMailOptions = {
    from: process.env.EMAIL_USER,
    to: customerEmail,
    subject: ✅ Order Confirmation - ${orderReference} - FortuneHub,
    html: customerEmailHtml
  };

  transporter.sendMail(customerMailOptions, (error, info) => {
    if (error) console.error('❌ Customer email failed:', error);
    else console.log('✅ Customer confirmation email sent to:', customerEmail);
  });
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
// START SERVER - ✅ FIXED TEMPLATE LITERALS
// ================================================================
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log('🚀 FortuneHub Backend Server Started!');
  console.log('🚀 ================================');
  console.log(📡 Server running on port ${PORT});  // ✅ FIXED
  console.log(🌐 Local: http://localhost:${PORT}); // ✅ FIXED
  console.log('💾 Database: orders.db');
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
