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

// Validate Environment Variables
const requiredEnvVars = ['MONGODB_URI', 'RESEND_API_KEY'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('❌ CRITICAL: Missing required environment variables:', missingEnvVars);
  console.error('⚠️  Please configure these in Render Dashboard > Environment');
}

// Initialize Resend with error handling
let resend;
try {
  if (process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY.trim()); // Trim any whitespace
    console.log('✅ Resend initialized successfully');
  } else {
    console.error('❌ RESEND_API_KEY is missing');
  }
} catch (error) {
  console.error('❌ Failed to initialize Resend:', error.message);
}

// MongoDB Connection with better error handling
const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI || process.env.MONGO_URI;
    
    if (!mongoURI) {
      throw new Error('MongoDB URI is not defined in environment variables');
    }

    await mongoose.connect(mongoURI.trim(), {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    
    console.log('✅ MongoDB Connected Successfully');
    console.log('📊 Database:', mongoose.connection.name);
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    console.error('💡 Check your MONGODB_URI in Render environment variables');
    console.error('💡 Ensure MongoDB Atlas allows connections from 0.0.0.0/0');
    // Don't exit process, let Render restart the service
  }
};

// Connect to database
connectDB();

// Handle MongoDB connection events
mongoose.connection.on('connected', () => {
  console.log('🔗 Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️  Mongoose disconnected');
});

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
            src="https://via.placeholder.com/80x80/667eea/ffffff?text=${encodeURIComponent(product.name.substring(0, 3))}" 
            alt="${product.name}"
            style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px; margin-right: 15px;"
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
    body, table, td, div, p, a { 
      margin: 0; 
      padding: 0; 
      font-family: Arial, sans-serif; 
    }
    
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
    }
  </style>
</head>
<body style="background-color: #f4f4f4; padding: 20px;">
  <div class="container" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    
    <div class="header" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 24px;">${emailTitle}</h1>
      <p style="margin: 10px 0 0 0; opacity: 0.9;">${emailMessage}</p>
    </div>

    <div class="content" style="padding: 30px 20px;">
      
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

      <div style="margin-bottom: 25px;">
        <h2 style="color: #333; font-size: 18px; margin-bottom: 15px; border-bottom: 2px solid #667eea; padding-bottom: 10px;">
          Products Ordered
        </h2>
        <table style="width: 100%; border-collapse: collapse; border: 1px solid #eee;">
          ${productRows}
          <tr style="background-color: #f9f9f9;">
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
      <div style="background-color: #f0f7ff; border-left: 4px solid #667eea; padding: 15px; margin-top: 25px; border-radius: 4px;">
        <p style="margin: 0; color: #333; line-height: 1.6;">
          Thank you for shopping with <strong>Fortunehub</strong>! Your order is being processed and we'll notify you once it's shipped.
        </p>
      </div>
      ` : `
      <div style="background-color: #fff7e6; border-left: 4px solid #ffa500; padding: 15px; margin-top: 25px; border-radius: 4px;">
        <p style="margin: 0; color: #333; line-height: 1.6;">
          Please process this order and contact the customer at <strong>${order.email}</strong> or <strong>${order.phone}</strong>.
        </p>
      </div>
      `}

    </div>

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
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Health check endpoint - IMPROVED
app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: {
      status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      readyState: mongoose.connection.readyState,
      host: mongoose.connection.host || 'N/A',
      name: mongoose.connection.name || 'N/A'
    },
    resend: {
      configured: !!process.env.RESEND_API_KEY,
      apiKeyPresent: process.env.RESEND_API_KEY ? '✅ Present' : '❌ Missing'
    },
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: process.env.PORT || 5000,
      ownerEmail: process.env.OWNER_EMAIL ? '✅ Configured' : '⚠️  Not set'
    }
  };
  
  res.json(health);
});

// Test email endpoint - ADDED
app.post('/api/test-email', async (req, res) => {
  try {
    const { testEmail } = req.body;
    
    if (!testEmail) {
      return res.status(400).json({
        success: false,
        message: 'Please provide testEmail in request body'
      });
    }

    if (!resend) {
      return res.status(500).json({
        success: false,
        message: 'Resend is not initialized. Check RESEND_API_KEY environment variable'
      });
    }

    console.log('📧 Sending test email to:', testEmail);

    const result = await resend.emails.send({
      from: 'Fortunehub <onboarding@resend.dev>',
      to: testEmail,
      subject: 'Test Email from Fortunehub',
      html: `
        <h1>Email Configuration Test</h1>
        <p>If you're seeing this, your Resend email configuration is working correctly!</p>
        <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
      `
    });

    console.log('✅ Test email sent successfully:', result.id);

    res.json({
      success: true,
      message: 'Test email sent successfully',
      emailId: result.id
    });

  } catch (error) {
    console.error('❌ Test email error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send test email',
      error: error.message
    });
  }
});

// Create Order Endpoint - IMPROVED
app.post('/api/orders', async (req, res) => {
  try {
    console.log('📦 Receiving order:', {
      customerName: req.body.customerName,
      email: req.body.email,
      productsCount: req.body.products?.length,
      totalAmount: req.body.totalAmount
    });

    const { customerName, email, phone, address, products, totalAmount } = req.body;

    // Validation
    if (!customerName || !email || !phone || !address || !products || !totalAmount) {
      console.error('❌ Validation failed - Missing fields');
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields',
        required: ['customerName', 'email', 'phone', 'address', 'products', 'totalAmount']
      });
    }

    // Check MongoDB connection
    if (mongoose.connection.readyState !== 1) {
      console.error('❌ MongoDB not connected');
      return res.status(503).json({
        success: false,
        message: 'Database connection unavailable. Please try again.'
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

    // Send emails with better error handling
    const emailResults = {
      customer: { sent: false, error: null },
      owner: { sent: false, error: null }
    };

    if (resend) {
      try {
        // Send email to customer
        console.log('📧 Sending customer email to:', email);
        const customerEmailResult = await resend.emails.send({
          from: 'Fortunehub <onboarding@resend.dev>',
          to: email,
          subject: 'Order Confirmation - Fortunehub',
          html: generateEmailHTML(savedOrder, false)
        });

        emailResults.customer.sent = true;
        emailResults.customer.emailId = customerEmailResult.id;
        console.log('✅ Customer email sent successfully:', customerEmailResult.id);

      } catch (customerEmailError) {
        console.error('❌ Customer email failed:', customerEmailError.message);
        emailResults.customer.error = customerEmailError.message;
      }

      // Send email to owner
      const ownerEmail = process.env.OWNER_EMAIL?.trim();
      if (ownerEmail) {
        try {
          console.log('📧 Sending owner email to:', ownerEmail);
          const ownerEmailResult = await resend.emails.send({
            from: 'Fortunehub <onboarding@resend.dev>',
            to: ownerEmail,
            subject: `New Order #${savedOrder._id.toString().substr(-8).toUpperCase()} from ${customerName}`,
            html: generateEmailHTML(savedOrder, true)
          });

          emailResults.owner.sent = true;
          emailResults.owner.emailId = ownerEmailResult.id;
          console.log('✅ Owner email sent successfully:', ownerEmailResult.id);

        } catch (ownerEmailError) {
          console.error('❌ Owner email failed:', ownerEmailError.message);
          emailResults.owner.error = ownerEmailError.message;
        }
      } else {
        console.warn('⚠️  OWNER_EMAIL not configured - skipping owner notification');
        emailResults.owner.error = 'OWNER_EMAIL not configured';
      }
    } else {
      console.error('❌ Resend not initialized - emails not sent');
      emailResults.customer.error = 'Resend not initialized';
      emailResults.owner.error = 'Resend not initialized';
    }

    // Return success even if emails fail (order is saved)
    res.status(201).json({ 
      success: true, 
      message: 'Order placed successfully!',
      orderId: savedOrder._id,
      emailStatus: emailResults
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
    console.log(`📊 Retrieved ${orders.length} orders`);
    res.json({ 
      success: true, 
      count: orders.length,
      orders 
    });
  } catch (error) {
    console.error('❌ Error fetching orders:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch orders',
      error: error.message 
    });
  }
});

// Get single order by ID
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    res.json({
      success: true,
      order
    });
  } catch (error) {
    console.error('❌ Error fetching order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order',
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
    message: `Route not found: ${req.method} ${req.path}` 
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('💥 Server error:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('\n🚀 ================================');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🚀 ================================');
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📧 Resend API Key: ${process.env.RESEND_API_KEY ? '✅ Configured' : '❌ MISSING'}`);
  console.log(`📮 Owner Email: ${process.env.OWNER_EMAIL ? '✅ ' + process.env.OWNER_EMAIL : '⚠️  Not configured'}`);
  console.log(`🗄️  MongoDB URI: ${process.env.MONGODB_URI ? '✅ Configured' : '❌ MISSING'}`);
  console.log('🚀 ================================\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM signal received: closing HTTP server');
  mongoose.connection.close();
  process.exit(0);
});
