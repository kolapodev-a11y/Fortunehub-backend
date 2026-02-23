// ============================================================
// FortuneHub Backend - server.js
// Express + PostgreSQL + Cloudinary + Paystack + Resend
// ============================================================
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg");
const { Resend } = require("resend");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================================
// CORS
// ============================================================
const allowedOrigins = [
  "https://kolapodev-a11y.github.io",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(null, true); // Allow all for now; restrict in production
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ============================================================
// PostgreSQL
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// ============================================================
// Initialize Database Tables
// ============================================================
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price BIGINT NOT NULL DEFAULT 0,
        category VARCHAR(100) NOT NULL DEFAULT 'general',
        description TEXT DEFAULT '',
        image TEXT DEFAULT '',
        images JSONB DEFAULT '[]',
        tag VARCHAR(50) DEFAULT 'none',
        out_of_stock BOOLEAN DEFAULT false,
        sold BOOLEAN DEFAULT false,
        status_indicator VARCHAR(50) DEFAULT 'available',
        cloudinary_public_ids JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        reference VARCHAR(255) UNIQUE NOT NULL,
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        customer_phone VARCHAR(50),
        cart_items JSONB DEFAULT '[]',
        amount BIGINT NOT NULL,
        shipping_fee BIGINT DEFAULT 0,
        shipping_state VARCHAR(100),
        status VARCHAR(50) DEFAULT 'pending',
        paystack_data JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("✅ Database tables initialized");
  } catch (err) {
    console.error("❌ DB init error:", err.message);
  }
}

initDB();

// ============================================================
// Cloudinary Config
// ============================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Cloudinary Multer Storage
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "fortunehub/products",
    allowed_formats: ["jpg", "jpeg", "png", "webp", "gif"],
    transformation: [
      { width: 800, height: 800, crop: "limit", quality: "auto" },
    ],
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp|gif/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error("Only image files (JPG, PNG, WebP, GIF) are allowed"));
    }
  },
});

// ============================================================
// Resend Email
// ============================================================
const resend = new Resend(process.env.RESEND_API_KEY);

// ============================================================
// Admin Auth Middleware
// ============================================================
function adminAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    app: "FortuneHub Backend",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    res.status(500).json({ status: "error", database: "disconnected" });
  }
});

// ============================================================
// ADMIN: Verify Token
// ============================================================
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true, token: process.env.ADMIN_TOKEN });
  } else {
    res.status(401).json({ success: false, message: "Invalid password" });
  }
});

// ============================================================
// PRODUCTS API (Public - GET)
// ============================================================
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        id,
        name,
        price,
        category,
        description,
        image,
        images,
        tag,
        out_of_stock AS "outOfStock",
        sold,
        status_indicator AS "statusIndicator",
        created_at
       FROM products 
       ORDER BY created_at DESC`
    );
    res.json({ success: true, products: result.rows });
  } catch (err) {
    console.error("❌ Get products error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch products" });
  }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT 
        id, name, price, category, description, image, images, tag,
        out_of_stock AS "outOfStock", sold, status_indicator AS "statusIndicator"
       FROM products WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error("❌ Get product error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch product" });
  }
});

// ============================================================
// PRODUCTS API (Admin - POST/PUT/DELETE)
// ============================================================

// Add Product with Images
app.post(
  "/api/admin/products",
  adminAuth,
  upload.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "image2", maxCount: 1 },
    { name: "image3", maxCount: 1 },
    { name: "image4", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        name,
        price,
        category,
        description,
        tag = "none",
        outOfStock = false,
        sold = false,
      } = req.body;

      if (!name || !price || !category) {
        return res
          .status(400)
          .json({ success: false, message: "Name, price, and category are required" });
      }

      // Collect uploaded images
      const allImages = [];
      const publicIds = [];

      const fields = ["mainImage", "image2", "image3", "image4"];
      fields.forEach((field) => {
        if (req.files && req.files[field] && req.files[field][0]) {
          const file = req.files[field][0];
          allImages.push(file.path); // Cloudinary URL
          publicIds.push(file.filename); // Cloudinary public_id
        }
      });

      const mainImage = allImages[0] || "";
      const statusIndicator =
        sold === "true" || sold === true
          ? "sold"
          : outOfStock === "true" || outOfStock === true
          ? "outofstock"
          : tag === "new"
          ? "new"
          : tag === "sale"
          ? "sale"
          : "available";

      const result = await pool.query(
        `INSERT INTO products 
          (name, price, category, description, image, images, tag, out_of_stock, sold, status_indicator, cloudinary_public_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          name,
          parseInt(price),
          category,
          description || "",
          mainImage,
          JSON.stringify(allImages),
          tag,
          outOfStock === "true" || outOfStock === true,
          sold === "true" || sold === true,
          statusIndicator,
          JSON.stringify(publicIds),
        ]
      );

      const product = result.rows[0];
      res.json({
        success: true,
        message: "Product added successfully",
        product: {
          id: product.id,
          name: product.name,
          price: product.price,
          category: product.category,
          description: product.description,
          image: product.image,
          images: product.images,
          tag: product.tag,
          outOfStock: product.out_of_stock,
          sold: product.sold,
          statusIndicator: product.status_indicator,
        },
      });
    } catch (err) {
      console.error("❌ Add product error:", err);
      res.status(500).json({ success: false, message: "Failed to add product: " + err.message });
    }
  }
);

// Update Product
app.put(
  "/api/admin/products/:id",
  adminAuth,
  upload.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "image2", maxCount: 1 },
    { name: "image3", maxCount: 1 },
    { name: "image4", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        name,
        price,
        category,
        description,
        tag = "none",
        outOfStock = false,
        sold = false,
      } = req.body;

      // Get existing product
      const existing = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
      if (existing.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Product not found" });
      }

      const oldProduct = existing.rows[0];
      let allImages = oldProduct.images || [];
      let publicIds = oldProduct.cloudinary_public_ids || [];

      // If new images uploaded, replace them
      const fields = ["mainImage", "image2", "image3", "image4"];
      const newImages = [];
      const newPublicIds = [];

      fields.forEach((field) => {
        if (req.files && req.files[field] && req.files[field][0]) {
          const file = req.files[field][0];
          newImages.push(file.path);
          newPublicIds.push(file.filename);
        }
      });

      if (newImages.length > 0) {
        // Delete old images from Cloudinary
        if (publicIds.length > 0) {
          for (const pid of publicIds) {
            try {
              await cloudinary.uploader.destroy(pid);
            } catch (e) {
              console.warn("Could not delete old cloudinary image:", pid);
            }
          }
        }
        allImages = newImages;
        publicIds = newPublicIds;
      }

      const mainImage = allImages[0] || oldProduct.image || "";
      const statusIndicator =
        sold === "true" || sold === true
          ? "sold"
          : outOfStock === "true" || outOfStock === true
          ? "outofstock"
          : tag === "new"
          ? "new"
          : tag === "sale"
          ? "sale"
          : "available";

      const result = await pool.query(
        `UPDATE products SET
          name = $1, price = $2, category = $3, description = $4,
          image = $5, images = $6, tag = $7, out_of_stock = $8,
          sold = $9, status_indicator = $10, cloudinary_public_ids = $11,
          updated_at = NOW()
         WHERE id = $12 RETURNING *`,
        [
          name || oldProduct.name,
          parseInt(price) || oldProduct.price,
          category || oldProduct.category,
          description !== undefined ? description : oldProduct.description,
          mainImage,
          JSON.stringify(allImages),
          tag,
          outOfStock === "true" || outOfStock === true,
          sold === "true" || sold === true,
          statusIndicator,
          JSON.stringify(publicIds),
          id,
        ]
      );

      const product = result.rows[0];
      res.json({
        success: true,
        message: "Product updated successfully",
        product: {
          id: product.id,
          name: product.name,
          price: product.price,
          category: product.category,
          description: product.description,
          image: product.image,
          images: product.images,
          tag: product.tag,
          outOfStock: product.out_of_stock,
          sold: product.sold,
          statusIndicator: product.status_indicator,
        },
      });
    } catch (err) {
      console.error("❌ Update product error:", err);
      res.status(500).json({ success: false, message: "Failed to update product: " + err.message });
    }
  }
);

// Update Product Status Only (Quick toggle)
app.patch("/api/admin/products/:id/status", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { outOfStock, sold, tag } = req.body;

    const statusIndicator =
      sold === true ? "sold"
      : outOfStock === true ? "outofstock"
      : tag === "new" ? "new"
      : tag === "sale" ? "sale"
      : "available";

    await pool.query(
      `UPDATE products SET out_of_stock = $1, sold = $2, tag = $3, status_indicator = $4, updated_at = NOW() WHERE id = $5`,
      [outOfStock, sold, tag || "none", statusIndicator, id]
    );

    res.json({ success: true, message: "Status updated" });
  } catch (err) {
    console.error("❌ Status update error:", err);
    res.status(500).json({ success: false, message: "Failed to update status" });
  }
});

// Delete Product
app.delete("/api/admin/products/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get product first to delete Cloudinary images
    const existing = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const product = existing.rows[0];
    const publicIds = product.cloudinary_public_ids || [];

    // Delete images from Cloudinary
    for (const pid of publicIds) {
      try {
        await cloudinary.uploader.destroy(pid);
      } catch (e) {
        console.warn("Could not delete cloudinary image:", pid);
      }
    }

    await pool.query("DELETE FROM products WHERE id = $1", [id]);
    res.json({ success: true, message: "Product deleted successfully" });
  } catch (err) {
    console.error("❌ Delete product error:", err);
    res.status(500).json({ success: false, message: "Failed to delete product" });
  }
});

// Admin: Get dashboard stats
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const totalResult = await pool.query("SELECT COUNT(*) FROM products");
    const outOfStockResult = await pool.query("SELECT COUNT(*) FROM products WHERE out_of_stock = true");
    const soldResult = await pool.query("SELECT COUNT(*) FROM products WHERE sold = true");
    const ordersResult = await pool.query("SELECT COUNT(*) FROM orders");
    const revenueResult = await pool.query("SELECT SUM(amount) FROM orders WHERE status = 'success'");

    res.json({
      success: true,
      stats: {
        totalProducts: parseInt(totalResult.rows[0].count),
        outOfStock: parseInt(outOfStockResult.rows[0].count),
        sold: parseInt(soldResult.rows[0].count),
        totalOrders: parseInt(ordersResult.rows[0].count),
        revenue: parseInt(revenueResult.rows[0].sum || 0),
      },
    });
  } catch (err) {
    console.error("❌ Stats error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
});

// ============================================================
// PAYMENT - Paystack Verify
// ============================================================
app.post("/api/payment/verify", async (req, res) => {
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ success: false, message: "Reference is required" });
  }

  try {
    console.log("🔄 Verifying payment reference:", reference);

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const data = response.data;

    if (!data.status || data.data.status !== "success") {
      return res.json({
        success: false,
        message: data.data?.gateway_response || "Payment not successful",
      });
    }

    const { amount, reference: ref, customer, metadata } = data.data;
    const cartItems = metadata?.cart_items || [];
    const shippingFee = metadata?.shipping_fee || 0;
    const shippingState = metadata?.shipping_state || "";
    const customerName = metadata?.customer_name || customer.first_name || "Customer";
    const customerPhone = metadata?.customer_phone || "";

    // Save order to database
    try {
      await pool.query(
        `INSERT INTO orders 
          (reference, customer_name, customer_email, customer_phone, cart_items, amount, shipping_fee, shipping_state, status, paystack_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (reference) DO UPDATE SET status = 'success'`,
        [
          ref,
          customerName,
          customer.email,
          customerPhone,
          JSON.stringify(cartItems),
          amount,
          shippingFee * 100,
          shippingState,
          "success",
          JSON.stringify(data.data),
        ]
      );
    } catch (dbErr) {
      console.warn("⚠️ Order save warning:", dbErr.message);
    }

    // Send confirmation emails
    try {
      await sendPaymentConfirmationEmail({
        amount,
        reference: ref,
        customer,
        cartItems,
        shippingFee,
        shippingState,
        customerName,
        customerPhone,
      });
    } catch (emailErr) {
      console.warn("⚠️ Email sending warning:", emailErr.message);
    }

    return res.json({
      success: true,
      message: "Payment verified and confirmed",
      reference: ref,
      amount,
    });
  } catch (error) {
    console.error("❌ Payment verification error:", error.message);

    if (error.response) {
      return res.status(error.response.status || 500).json({
        success: false,
        message: error.response.data?.message || "Payment verification failed",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Payment verification failed. Please contact support.",
    });
  }
});

// ============================================================
// EMAIL FUNCTIONS
// ============================================================
async function sendPaymentConfirmationEmail({
  amount,
  reference,
  customer,
  cartItems,
  shippingFee,
  shippingState,
  customerName,
  customerPhone,
}) {
  const formattedAmount = `₦${(amount / 100).toLocaleString("en-NG", {
    minimumFractionDigits: 2,
  })}`;
  const formattedShipping = shippingFee
    ? `₦${Number(shippingFee).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`
    : "₦0.00";

  const cartHTML = cartItems
    .map(
      (item) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${item.name || "Product"}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center;">${item.quantity || 1}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">₦${((item.price || 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}</td>
      </tr>`
    )
    .join("");

  const customerEmailHTML = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 15px rgba(0,0,0,0.1);">
      <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:40px 30px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:28px;">✅ Payment Confirmed!</h1>
        <p style="color:rgba(255,255,255,0.9);margin:10px 0 0;font-size:16px;">Thank you for your order</p>
      </div>
      <div style="padding:30px;">
        <p style="color:#333;font-size:16px;">Dear <strong>${customerName}</strong>,</p>
        <p style="color:#555;line-height:1.6;">Your payment has been successfully processed and confirmed. We've received your payment and your transaction is complete.</p>
        <div style="background:#f8f9ff;border-radius:8px;padding:20px;margin:20px 0;">
          <h3 style="margin:0 0 15px;color:#333;">📋 Payment Details</h3>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#666;width:50%;">Amount Paid:</td><td style="padding:6px 0;color:#333;font-weight:bold;">${formattedAmount}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Shipping Fee:</td><td style="padding:6px 0;color:#333;">${formattedShipping}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Shipping To:</td><td style="padding:6px 0;color:#333;">${shippingState || "N/A"}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Reference:</td><td style="padding:6px 0;color:#667eea;font-weight:bold;">${reference}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Email:</td><td style="padding:6px 0;color:#333;">${customer.email}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Phone:</td><td style="padding:6px 0;color:#333;">${customerPhone || "N/A"}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Date:</td><td style="padding:6px 0;color:#333;">${new Date().toLocaleString("en-NG", { dateStyle: "full", timeStyle: "short" })}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Status:</td><td style="padding:6px 0;color:#22c55e;font-weight:bold;">CONFIRMED ✓</td></tr>
          </table>
        </div>
        ${
          cartHTML
            ? `
        <div style="margin:20px 0;">
          <h3 style="color:#333;margin:0 0 10px;">🛒 Order Items</h3>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
            <thead><tr style="background:#f8f9ff;">
              <th style="padding:10px 12px;text-align:left;color:#555;">Product</th>
              <th style="padding:10px 12px;text-align:center;color:#555;">Qty</th>
              <th style="padding:10px 12px;text-align:right;color:#555;">Price</th>
            </tr></thead>
            <tbody>${cartHTML}</tbody>
          </table>
        </div>`
            : ""
        }
        <div style="background:#fff3cd;border-radius:8px;padding:15px;margin:20px 0;border-left:4px solid #ffc107;">
          <p style="margin:0;color:#856404;font-size:14px;"><strong>📦 What's Next?</strong><br>You will receive further delivery instructions shortly. Please keep this email for your records.</p>
        </div>
        <p style="color:#555;font-size:14px;">If you have any questions, contact us at <a href="mailto:${process.env.OWNER_EMAIL}" style="color:#667eea;">${process.env.OWNER_EMAIL}</a></p>
      </div>
      <div style="background:#f8f9ff;padding:20px;text-align:center;border-top:1px solid #e5e7eb;">
        <p style="margin:0;color:#999;font-size:12px;">© ${new Date().getFullYear()} FortuneHub. All rights reserved.</p>
      </div>
    </div>
  </body>
  </html>`;

  const ownerEmailHTML = `
  <!DOCTYPE html>
  <html>
  <body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:20px;border-radius:10px;text-align:center;margin-bottom:20px;">
      <h2 style="color:#fff;margin:0;">💰 New Order Received!</h2>
    </div>
    <div style="background:#f8f9ff;padding:20px;border-radius:8px;margin-bottom:15px;">
      <h3 style="margin:0 0 10px;color:#333;">Customer Details</h3>
      <p style="margin:5px 0;"><strong>Name:</strong> ${customerName}</p>
      <p style="margin:5px 0;"><strong>Email:</strong> ${customer.email}</p>
      <p style="margin:5px 0;"><strong>Phone:</strong> ${customerPhone || "N/A"}</p>
      <p style="margin:5px 0;"><strong>State:</strong> ${shippingState || "N/A"}</p>
    </div>
    <div style="background:#f0fff4;padding:20px;border-radius:8px;margin-bottom:15px;">
      <h3 style="margin:0 0 10px;color:#333;">Payment Details</h3>
      <p style="margin:5px 0;"><strong>Amount:</strong> <span style="color:#22c55e;font-size:18px;">${formattedAmount}</span></p>
      <p style="margin:5px 0;"><strong>Shipping:</strong> ${formattedShipping} (${shippingState})</p>
      <p style="margin:5px 0;"><strong>Reference:</strong> <code>${reference}</code></p>
      <p style="margin:5px 0;"><strong>Date:</strong> ${new Date().toLocaleString("en-NG")}</p>
    </div>
    ${
      cartItems.length
        ? `<div style="background:#fff;padding:20px;border-radius:8px;border:1px solid #e5e7eb;">
      <h3 style="margin:0 0 10px;color:#333;">Items Ordered</h3>
      <ul>${cartItems.map((i) => `<li>${i.name} × ${i.quantity} — ₦${((i.price || 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}</li>`).join("")}</ul>
    </div>`
        : ""
    }
  </body>
  </html>`;

  // Send to customer
  await resend.emails.send({
    from: process.env.FROM_EMAIL || "FortuneHub <onboarding@resend.dev>",
    to: customer.email,
    subject: `✅ Payment Confirmed - Order #${reference.slice(-8).toUpperCase()}`,
    html: customerEmailHTML,
  });

  // Send to owner
  if (process.env.OWNER_EMAIL) {
    await resend.emails.send({
      from: process.env.FROM_EMAIL || "FortuneHub <onboarding@resend.dev>",
      to: process.env.OWNER_EMAIL,
      subject: `💰 New Order: ${formattedAmount} from ${customerName}`,
      html: ownerEmailHTML,
    });
  }

  console.log(`✅ Emails sent for order ${reference}`);
}

// ============================================================
// ORDERS - Admin view
// ============================================================
app.get("/api/admin/orders", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM orders ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ success: true, orders: result.rows });
  } catch (err) {
    console.error("❌ Orders fetch error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
});

// ============================================================
// ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err.message);
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ success: false, message: "File too large. Max 10MB." });
  }
  res.status(500).json({ success: false, message: err.message || "Internal server error" });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 FortuneHub Backend running on port ${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || "development"}`);
});

module.exports = app;
