const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB Connected Successfully'))
.catch((err) => console.error('❌ MongoDB Connection Error:', err));

// Order Schema
const orderSchema = new mongoose.Schema({
  customerName: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  address: { type: String, required: true },
  products: [{
    productId: String,
    name: String,
    price: Number,
    quantity: Number
  }],
  totalAmount: { type: Number, required: true },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', orderSchema);

// Helper function to generate responsive email HTML
function generateEmailHTML(order, isOwner = false) {
  const productRows = order.products.map(product => `
    <tr>
      <td style="padding: 15px; border-bottom: 1px solid #eee;">
        <div style="display: flex; align-items: center;">
          <img 
            src="https://fortunehub-backend.onrender.com/images/${product.productId}.jpg" 
            alt="${product.name}"
            style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px; margin-right: 15px;"
            onerror="this.src='https://via.placeholder.com/80x80?text=Product'"
          />
          <div>
            <strong style="display: block; margin-bottom: 5px;">${product.name}</strong>
            <span style="color: #666; font-size: 14px;">Qty: ${product.quantity}</span>
          </div>
        </div>
      </td>
      <td style="padding: 15px; border-bottom: 1px solid #eee; text-align: right;">
        <strong>₦${(product.price * product.quantity).toLocaleString()}</strong>
      </td>
    </tr>
  `).join('');

  const emailTitle = isOwner ? 'New Order Received!' : 'Order Confirmation';
  const emailMessage = isOwner 
    ? `You have received a new order from ${order.customerName}`
    : `Thank you for your order, ${order.customerName}!`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${emailTitle}</title>
  <style>
    /* Reset styles */
    body, table, td, div, p, a { 
      margin: 0; 
      padding: 0; 
      font-family: Arial, sans-serif; 
    }
    
    /* Mobile-first responsive styles */
    @media only screen and (max-width: 600px) {
      .container {
        width: 100% !important;
        padding: 10px !important;
      }
      .header {
        font-size: 20px !important;
        padding: 20px 10px !important;
      }
      .content {
        padding: 15px !important;
      }
      .product-image {
        width: 60px !important;
        height: 60px !important;
      }
      .product-info {
        font-size: 13px !important;
      }
      .total-row {
        font-size: 16px !important;
      }
    }
  </style>
</head>
<body style="background-color: #f4f4f4; padding: 20px;">
  <div class="container" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    
    <!-- Header -->
    <div class="header" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 24px;">${emailTitle}</h1>
      <p style="margin: 10px 0 0 0; opacity: 0.9;">${emailMessage}</p>
    </div>

    <!-- Content -->
    <div class="content" style="padding: 30px 20px;">
      
      <!-- Order Details -->
      <div style="margin-bottom: 25px;">
        <h2 style="color: #333; font-size: 18px; margin-bottom: 15px; border-bottom: 2px solid #667eea; padding-bottom: 10px;">
          Order Details
        </h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #666;">Order ID:</td>
            <td style="padding: 8px 0; text-align: right; font-weight: bold;">#${order._id.toString().substr(-8).toUpperCase()}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">Date:</td>
            <td style="padding: 8px 0; text-align: right;">${new Date(order.createdAt).toLocaleDateString('en-US', { 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric' 
            })}</td>
          </tr>
        </table>
      </div>

      <!-- Customer Information -->
      <div style="margin-bottom: 25px;">
        <h2 style="color: #333; font-size: 18px; margin-bottom: 15px; border-bottom: 2px solid #667eea; padding-bottom: 10px;">
          ${isOwner ? 'Customer Information' : 'Your Information'}
        </h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #666;">Name:</td>
            <td style="padding: 8px 0; text-align: right;">${order.customerName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">Email:</td>
            <td style="padding: 8px 0; text-align: right;">${order.email}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">Phone:</td>
            <td style="padding: 8px 0; text-align: right;">${order.phone}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666; vertical-align: top;">Address:</td>
            <td style="padding: 8px 0; text-align: right;">${order.address}</td>
          </tr>
        </table>
      </div>

      <!-- Products Table -->
      <div style="margin-bottom: 25px;">
        <h2 style="color: #333; font-size: 18px; margin-bottom: 15px; border-bottom: 2px solid #667eea; padding-bottom: 10px;">
          Products Ordered
        </h2>
        <table style="width: 100%; border-collapse: collapse; border: 1px solid #eee;">
          ${productRows}
          <tr class="total-row" style="background-color: #f9f9f9;">
            <td style="padding: 20px 15px; font-size: 18px; font-weight: bold;">
              Total Amount:
            </td>
            <td style="padding: 20px 15px; text-align: right; font-size: 20px; font-weight: bold; color: #667eea;">
              ₦${order.totalAmount.toLocaleString()}
            </td>
          </tr>
        </table>
      </div>

      ${!isOwner ? `
      <!-- Customer Message -->
      <div style="background-color: #f0f7ff; border-left: 4px solid #667eea; padding: 15px; margin-top: 25px; border-radius: 4px;">
        <p style="margin: 0; color: #333; line-height: 1.6;">
          Thank you for shopping with <strong>Fortunehub</strong>! Your order is being processed and we'll notify you once it's shipped.
        </p>
      </div>
      ` : `
      <!-- Owner Message -->
      <div style="background-color: #fff7e6; border-left: 4px solid #ffa500; padding: 15px; margin-top: 25px; border-radius: 4px;">
        <p style="margin: 0; color: #333; line-height: 1.6;">
          Please process this order and contact the customer at <strong>${order.email}</strong> or <strong>${order.phone}</strong>.
        </p>
      </div>
      `}

    </div>

    <!-- Footer -->
    <div style="background-color: #f9f9f9; padding: 20px; text-align: center; border-top: 1px solid #eee;">
      <p style="margin: 0; color: #666; font-size: 14px;">
        © ${new Date().getFullYear()} Fortunehub. All rights reserved.
      </p>
      <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">
        This is an automated email. Please do not reply.
      </p>
    </div>

  </div>
</body>
</html>
  `;
}

// API Routes
app.get('/', (req, res) => {
  res.json({ 
    message: 'Fortunehub Backend API is running!', 
    status: 'success',
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    resend: process.env.RESEND_API_KEY ? 'configured' : 'not configured'
  });
});

// Create Order Endpoint
app.post('/api/orders', async (req, res) => {
  try {
    console.log('📦 Receiving order:', req.body);

    const { customerName, email, phone, address, products, totalAmount } = req.body;

    // Validation
    if (!customerName || !email || !phone || !address || !products || !totalAmount) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields' 
      });
    }

    // Create order in database
    const newOrder = new Order({
      customerName,
      email,
      phone,
      address,
      products,
      totalAmount
    });

    const savedOrder = await newOrder.save();
    console.log('✅ Order saved to database:', savedOrder._id);

    // Send emails
    try {
      // Send email to customer
      const customerEmailResult = await resend.emails.send({
        from: 'Fortunehub <onboarding@resend.dev>', // Use verified domain in production
        to: email,
        subject: 'Order Confirmation - Fortunehub',
        html: generateEmailHTML(savedOrder, false)
      });

      console.log('✅ Customer email sent:', customerEmailResult.id);

      // Send email to owner
      const ownerEmail = process.env.OWNER_EMAIL;
      if (ownerEmail) {
        const ownerEmailResult = await resend.emails.send({
          from: 'Fortunehub <onboarding@resend.dev>',
          to: ownerEmail,
          subject: `New Order from ${customerName}`,
          html: generateEmailHTML(savedOrder, true)
        });

        console.log('✅ Owner email sent:', ownerEmailResult.id);
      } else {
        console.warn('⚠️ OWNER_EMAIL not configured in environment variables');
      }

    } catch (emailError) {
      console.error('❌ Email sending error:', emailError);
      // Don't fail the order if email fails
    }

    res.status(201).json({ 
      success: true, 
      message: 'Order placed successfully!',
      orderId: savedOrder._id
    });

  } catch (error) {
    console.error('❌ Error creating order:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create order',
      error: error.message 
    });
  }
});

// Get all orders (for admin)
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch orders',
      error: error.message 
    });
  }
});

// Serve static product images (if stored locally)
app.use('/images', express.static('public/images'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Route not found' 
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error',
    error: err.message 
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Resend API Key: ${process.env.RESEND_API_KEY ? 'Configured ✅' : 'Missing ❌'}`);
  console.log(`📮 Owner Email: ${process.env.OWNER_EMAIL || 'Not configured ⚠️'}`);
});
