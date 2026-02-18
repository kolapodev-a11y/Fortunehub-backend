// ===================================================
// FortuneHub Backend - FIXED for Resend + Owner Email
// ===================================================

const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

// ===================================================
// 1) MIDDLEWARE
// ===================================================
app.use(cors({
  origin: [
    "https://kolapodev-a11y.github.io",
    "https://fortunehub-frontend.onrender.com",
    "http://localhost:3000"
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===================================================
// 2) RESEND SETUP
// ===================================================
const resend = new Resend(process.env.RESEND_API_KEY);

// ⚠️ CRITICAL: Use your verified domain email
const SENDER_EMAIL = process.env.SENDER_EMAIL || "onboarding@resend.dev";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "victorolapo09@gmail.com";

// ===================================================
// 3) POSTGRES SETUP
// ===================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===================================================
// 4) CREATE ORDERS TABLE
// ===================================================
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        reference VARCHAR(255) UNIQUE NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255) NOT NULL,
        customer_phone VARCHAR(50) NOT NULL,
        shipping_state VARCHAR(100) NOT NULL,
        shipping_fee INTEGER NOT NULL,
        products JSONB NOT NULL,
        total_amount INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ Database table ready");
  } catch (err) {
    console.error("❌ Database setup error:", err.message);
  }
})();

// ===================================================
// 5) EMAIL TEMPLATES
// ===================================================

// 🎨 CUSTOMER EMAIL TEMPLATE (Responsive + Absolute Image URLs)
function generateCustomerEmailHTML(orderData) {
  const { customerName, orderReference, orderDate, products, subtotal, shippingFee, total, shippingState } = orderData;

  const productRows = products.map(item => {
    // ✅ FIX: Use absolute URL for images
    const imageUrl = item.image.startsWith('http') 
      ? item.image 
      : `https://kolapodev-a11y.github.io/Fortunehub-frontend/${item.image.replace(/^\//, '')}`;

    return `
      <tr>
        <td style="padding:10px;text-align:center;">
          <img src="${imageUrl}" alt="${item.name}" width="80" height="80" style="border-radius:8px;object-fit:cover;display:block;margin:0 auto;">
        </td>
        <td style="padding:10px;text-align:left;">${item.name}</td>
        <td style="padding:10px;text-align:center;">${item.quantity}</td>
        <td style="padding:10px;text-align:right;">₦${(item.price / 100).toLocaleString()}</td>
      </tr>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Order Confirmed</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f4f4f4;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f4;">
    <tr>
      <td align="center" style="padding:20px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:30px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:28px;">✅ Order Confirmed!</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:30px;">
              <p style="margin:0 0 20px;font-size:16px;color:#333;">Hi <strong>${customerName}</strong>,</p>
              <p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.6;">
                Thank you for your purchase! Your payment was successful and your order is being processed.
              </p>

              <!-- Order Info -->
              <table width="100%" cellpadding="5" cellspacing="0" border="0" style="margin:20px 0;background-color:#f9f9f9;border-radius:5px;padding:15px;">
                <tr>
                  <td style="font-size:14px;color:#555;"><strong>Order Reference:</strong></td>
                  <td style="font-size:14px;color:#333;text-align:right;">${orderReference}</td>
                </tr>
                <tr>
                  <td style="font-size:14px;color:#555;"><strong>Date:</strong></td>
                  <td style="font-size:14px;color:#333;text-align:right;">${orderDate}</td>
                </tr>
              </table>

              <!-- Products Table -->
              <h2 style="margin:30px 0 15px;font-size:18px;color:#333;border-bottom:2px solid #667eea;padding-bottom:5px;">📦 Your Items</h2>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
                <thead>
                  <tr style="background-color:#667eea;color:#fff;">
                    <th style="padding:12px;text-align:center;font-size:14px;">Image</th>
                    <th style="padding:12px;text-align:left;font-size:14px;">Product</th>
                    <th style="padding:12px;text-align:center;font-size:14px;">Qty</th>
                    <th style="padding:12px;text-align:right;font-size:14px;">Price</th>
                  </tr>
                </thead>
                <tbody>
                  ${productRows}
                </tbody>
              </table>

              <!-- Totals -->
              <table width="100%" cellpadding="8" cellspacing="0" border="0" style="margin-top:20px;">
                <tr>
                  <td style="font-size:15px;color:#555;text-align:right;padding-right:10px;">Subtotal:</td>
                  <td style="font-size:15px;color:#333;text-align:right;font-weight:600;">₦${(subtotal / 100).toLocaleString()}</td>
                </tr>
                <tr>
                  <td style="font-size:15px;color:#555;text-align:right;padding-right:10px;">Shipping Fee (${shippingState}):</td>
                  <td style="font-size:15px;color:#333;text-align:right;font-weight:600;">₦${(shippingFee / 100).toLocaleString()}</td>
                </tr>
                <tr style="border-top:2px solid #667eea;">
                  <td style="font-size:18px;color:#333;text-align:right;padding:15px 10px 0 0;font-weight:700;">TOTAL PAID:</td>
                  <td style="font-size:20px;color:#667eea;text-align:right;padding-top:15px;font-weight:700;">₦${(total / 100).toLocaleString()}</td>
                </tr>
              </table>

              <!-- What's Next -->
              <table width="100%" cellpadding="15" cellspacing="0" border="0" style="margin-top:30px;background-color:#fff9e6;border-left:4px solid #ffc107;border-radius:5px;">
                <tr>
                  <td style="font-size:14px;color:#333;">
                    <strong style="color:#f57c00;">📦 What's Next?</strong><br>
                    <span style="color:#555;line-height:1.6;">
                      Your order will be processed and shipped soon. We'll send you a tracking number once it's dispatched.
                    </span>
                  </td>
                </tr>
              </table>

              <p style="margin:30px 0 0;font-size:13px;color:#777;text-align:center;">
                Need help? Reply to this email or contact us at <a href="mailto:${OWNER_EMAIL}" style="color:#667eea;text-decoration:none;">${OWNER_EMAIL}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f4f4f4;padding:20px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#999;">© ${new Date().getFullYear()} FortuneHub. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// 🎨 OWNER NOTIFICATION EMAIL TEMPLATE
function generateOwnerEmailHTML(orderData) {
  const { customerName, customerEmail, customerPhone, orderReference, orderDate, products, subtotal, shippingFee, total, shippingState } = orderData;

  const productRows = products.map(item => {
    const imageUrl = item.image.startsWith('http') 
      ? item.image 
      : `https://kolapodev-a11y.github.io/Fortunehub-frontend/${item.image.replace(/^\//, '')}`;

    return `
      <tr>
        <td style="padding:10px;text-align:center;">
          <img src="${imageUrl}" alt="${item.name}" width="60" height="60" style="border-radius:5px;object-fit:cover;">
        </td>
        <td style="padding:10px;">${item.name}</td>
        <td style="padding:10px;text-align:center;">${item.quantity}</td>
        <td style="padding:10px;text-align:right;">₦${(item.price / 100).toLocaleString()}</td>
      </tr>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Order - ${orderReference}</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f4f4f4;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center" style="padding:20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:650px;background-color:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.15);">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#11998e 0%,#38ef7d 100%);padding:25px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:26px;">🔔 New Order Received!</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:30px;">
              <p style="margin:0 0 20px;font-size:16px;color:#333;">Hi <strong>FortuneHub Team</strong>,</p>
              <p style="margin:0 0 25px;font-size:14px;color:#555;">A new order has been placed. Please process it as soon as possible.</p>

              <!-- Order Details -->
              <table width="100%" cellpadding="10" cellspacing="0" border="0" style="margin-bottom:25px;background-color:#f9f9f9;border-radius:8px;">
                <tr>
                  <td colspan="2" style="background-color:#11998e;color:#fff;padding:12px;font-size:15px;font-weight:600;border-radius:8px 8px 0 0;">📋 Order Information</td>
                </tr>
                <tr>
                  <td style="padding:10px;font-size:14px;color:#555;width:40%;"><strong>Order Reference:</strong></td>
                  <td style="padding:10px;font-size:14px;color:#333;">${orderReference}</td>
                </tr>
                <tr style="background-color:#fff;">
                  <td style="padding:10px;font-size:14px;color:#555;"><strong>Order Date:</strong></td>
                  <td style="padding:10px;font-size:14px;color:#333;">${orderDate}</td>
                </tr>
              </table>

              <!-- Customer Info -->
              <table width="100%" cellpadding="10" cellspacing="0" border="0" style="margin-bottom:25px;background-color:#fff3cd;border-radius:8px;border:2px solid #ffc107;">
                <tr>
                  <td colspan="2" style="background-color:#ffc107;color:#333;padding:12px;font-size:15px;font-weight:600;border-radius:6px 6px 0 0;">👤 Customer Details</td>
                </tr>
                <tr>
                  <td style="padding:10px;font-size:14px;color:#555;width:40%;"><strong>Name:</strong></td>
                  <td style="padding:10px;font-size:14px;color:#333;"><strong>${customerName}</strong></td>
                </tr>
                <tr style="background-color:#fff;">
                  <td style="padding:10px;font-size:14px;color:#555;"><strong>Email:</strong></td>
                  <td style="padding:10px;font-size:14px;"><a href="mailto:${customerEmail}" style="color:#11998e;text-decoration:none;">${customerEmail}</a></td>
                </tr>
                <tr>
                  <td style="padding:10px;font-size:14px;color:#555;"><strong>Phone:</strong></td>
                  <td style="padding:10px;font-size:14px;"><a href="tel:${customerPhone}" style="color:#11998e;text-decoration:none;">${customerPhone}</a></td>
                </tr>
                <tr style="background-color:#fff;">
                  <td style="padding:10px;font-size:14px;color:#555;"><strong>Shipping State:</strong></td>
                  <td style="padding:10px;font-size:14px;color:#333;">${shippingState}</td>
                </tr>
              </table>

              <!-- Products -->
              <h3 style="margin:25px 0 15px;font-size:17px;color:#333;border-bottom:2px solid #11998e;padding-bottom:8px;">📦 Ordered Items</h3>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;border:1px solid #ddd;border-radius:5px;overflow:hidden;">
                <thead>
                  <tr style="background-color:#11998e;color:#fff;">
                    <th style="padding:12px;text-align:center;font-size:13px;">Image</th>
                    <th style="padding:12px;text-align:left;font-size:13px;">Product</th>
                    <th style="padding:12px;text-align:center;font-size:13px;">Qty</th>
                    <th style="padding:12px;text-align:right;font-size:13px;">Price</th>
                  </tr>
                </thead>
                <tbody>
                  ${productRows}
                </tbody>
              </table>

              <!-- Totals -->
              <table width="100%" cellpadding="8" cellspacing="0" border="0" style="margin-top:20px;background-color:#f4f4f4;border-radius:5px;padding:10px;">
                <tr>
                  <td style="font-size:15px;color:#555;text-align:right;padding-right:15px;">Subtotal:</td>
                  <td style="font-size:15px;color:#333;text-align:right;font-weight:600;width:150px;">₦${(subtotal / 100).toLocaleString()}</td>
                </tr>
                <tr>
                  <td style="font-size:15px;color:#555;text-align:right;padding-right:15px;">Shipping Fee:</td>
                  <td style="font-size:15px;color:#333;text-align:right;font-weight:600;">₦${(shippingFee / 100).toLocaleString()}</td>
                </tr>
                <tr style="border-top:2px solid #11998e;">
                  <td style="font-size:17px;color:#333;text-align:right;padding:12px 15px 0 0;font-weight:700;">TOTAL:</td>
                  <td style="font-size:19px;color:#11998e;text-align:right;padding-top:12px;font-weight:700;">₦${(total / 100).toLocaleString()}</td>
                </tr>
              </table>

              <!-- Action Prompt -->
              <table width="100%" cellpadding="15" cellspacing="0" border="0" style="margin-top:30px;background-color:#d4edda;border-left:5px solid #28a745;border-radius:5px;">
                <tr>
                  <td style="font-size:14px;color:#155724;">
                    <strong>⚡ Action Required:</strong><br>
                    Please prepare this order for shipment and contact the customer to confirm delivery details.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #dee2e6;">
              <p style="margin:0;font-size:12px;color:#6c757d;">FortuneHub Order Management System</p>
              <p style="margin:5px 0 0;font-size:11px;color:#adb5bd;">Automated notification - Do not reply</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// ===================================================
// 6) VERIFY PAYMENT ENDPOINT
// ===================================================
app.post("/api/verify-payment", async (req, res) => {
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ error: "Reference is required" });
  }

  try {
    console.log(`🔍 Verifying payment: ${reference}`);

    // Verify with Paystack
    const paystackResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const paystackData = await paystackResponse.json();

    if (!paystackData.status || paystackData.data.status !== "success") {
      console.log("❌ Payment verification failed");
      return res.status(400).json({ error: "Payment verification failed" });
    }

    console.log("✅ Payment verified successfully");

    // Extract metadata
    const metadata = paystackData.data.metadata || {};
    const customerName = metadata.customer_name || "Customer";
    const customerEmail = paystackData.data.customer.email;
    const customerPhone = metadata.customer_phone || "N/A";
    const shippingState = metadata.shipping_state || "N/A";
    const shippingFee = (metadata.shipping_fee || 0) * 100; // Convert to kobo
    const products = metadata.products || [];
    const totalAmount = paystackData.data.amount;
    const subtotal = totalAmount - shippingFee;

    // Save to database
    try {
      await pool.query(
        `INSERT INTO orders (reference, customer_name, customer_email, customer_phone, shipping_state, shipping_fee, products, total_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [reference, customerName, customerEmail, customerPhone, shippingState, shippingFee, JSON.stringify(products), totalAmount]
      );
      console.log("✅ Order saved to database");
    } catch (dbErr) {
      console.error("❌ Database error:", dbErr.message);
    }

    // Prepare email data
    const orderDate = new Date().toLocaleString("en-NG", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });

    const orderData = {
      customerName,
      customerEmail,
      customerPhone,
      orderReference: reference,
      orderDate,
      products,
      subtotal,
      shippingFee,
      total: totalAmount,
      shippingState
    };

     // ✅ SEND EMAILS (CUSTOMER + OWNER)
    try {
      console.log("📧 Sending emails...");

      // Send customer email
      const customerEmailResult = await resend.emails.send({
        from: SENDER_EMAIL,
        to: customerEmail,
        subject: ✅ Order Confirmed - ${reference},
        html: generateCustomerEmailHTML(orderData)
      });

      console.log("✅ Customer email sent:", customerEmailResult.id);

      // ⭐ SEND OWNER EMAIL (THIS IS THE CRITICAL FIX!)
      const ownerEmailResult = await resend.emails.send({
        from: SENDER_EMAIL,
        to: OWNER_EMAIL,
        subject: 🔔 New Order: ${reference} - ${customerName},
        html: generateOwnerEmailHTML(orderData)
      });

      console.log("✅ Owner email sent:", ownerEmailResult.id);

    } catch (emailErr) {
      console.error("❌ Email sending error:", emailErr);
      // Don't fail the request if email fails
    }

    // Return success response
    res.status(200).json({
      message: "Payment verified and order processed",
      reference,
      orderId: reference,
      customerEmail,
      totalAmount
    });

  } catch (err) {
    console.error("❌ Verification error:", err);
    res.status(500).json({ error: "Payment verification failed" });
  }
});

// ===================================================
// 7) HEALTH CHECK
// ===================================================
app.get("/", (req, res) => {
  res.json({ message: "✅ FortuneHub Backend Running", timestamp: new Date().toISOString() });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "healthy", database: "connected" });
});

// ===================================================
// 8) START SERVER
// ===================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(🚀 Server running on port ${PORT});
  console.log(📧 Owner email: ${OWNER_EMAIL});
  console.log(📧 Sender email: ${SENDER_EMAIL});
});
