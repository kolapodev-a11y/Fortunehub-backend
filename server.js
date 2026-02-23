require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const { Resend } = require('resend');

// Import Models
const Product = require('./models/Product');
const Order = require('./models/Order');
const Transaction = require('./models/Transaction');

const app = express();

// Initialize Resend
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fortunehub', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Connected Successfully'))
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// ===========================
// PRODUCT ROUTES
// ===========================

// Get all products with filtering, sorting, and pagination
app.get('/api/products', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      category,
      minPrice,
      maxPrice,
      search,
      sort = '-createdAt',
      status = 'active'
    } = req.query;

    // Build query
    const query = { status };
    
    if (category) query.category = category;
    
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }
    
    if (search) {
      query.$text = { $search: search };
    }

    // Execute query
    const products = await Product.find(query)
      .sort(sort)
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    const total = await Product.countDocuments(query);

    res.json({
      success: true,
      data: products,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products',
      error: error.message
    });
  }
});

// Get single product by ID
app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching product',
      error: error.message
    });
  }
});

// Create new product
app.post('/api/products', upload.array('images', 5), async (req, res) => {
  try {
    const productData = {
      ...req.body,
      price: Number(req.body.price),
      stock: Number(req.body.stock),
      discount: Number(req.body.discount) || 0
    };

    // Add uploaded image paths
    if (req.files && req.files.length > 0) {
      productData.images = req.files.map(file => `/uploads/${file.filename}`);
    }

    // Parse tags if sent as string
    if (typeof productData.tags === 'string') {
      productData.tags = productData.tags.split(',').map(tag => tag.trim());
    }

    const product = new Product(productData);
    await product.save();

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product
    });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating product',
      error: error.message
    });
  }
});

// Update product
app.put('/api/products/:id', upload.array('images', 5), async (req, res) => {
  try {
    const updateData = {
      ...req.body,
      price: Number(req.body.price),
      stock: Number(req.body.stock),
      discount: Number(req.body.discount) || 0
    };

    // Add new uploaded images
    if (req.files && req.files.length > 0) {
      const newImages = req.files.map(file => `/uploads/${file.filename}`);
      updateData.images = [...(req.body.existingImages || []), ...newImages];
    }

    // Parse tags if sent as string
    if (typeof updateData.tags === 'string') {
      updateData.tags = updateData.tags.split(',').map(tag => tag.trim());
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: product
    });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating product',
      error: error.message
    });
  }
});

// Delete product
app.delete('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting product',
      error: error.message
    });
  }
});

// Get product categories
app.get('/api/products/categories/list', async (req, res) => {
  try {
    const categories = await Product.distinct('category');
    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
});

// ===========================
// ORDER ROUTES
// ===========================

// Get all orders
app.get('/api/orders', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      paymentStatus
    } = req.query;

    const query = {};
    if (status) query.orderStatus = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    const orders = await Order.find(query)
      .populate('items.product')
      .sort('-createdAt')
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    const total = await Order.countDocuments(query);

    res.json({
      success: true,
      data: orders,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching orders',
      error: error.message
    });
  }
});

// Get single order
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('items.product');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    res.json({
      success: true,
      data: order
    });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching order',
      error: error.message
    });
  }
});

// Create new order
app.post('/api/orders', async (req, res) => {
  try {
    const { customer, items, shippingCost = 0, notes } = req.body;

    // Validate and calculate totals
    let totalAmount = 0;
    const orderItems = [];

    for (const item of items) {
      const product = await Product.findById(item.productId);
      
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product not found: ${item.productId}`
        });
      }

      if (product.stock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}`
        });
      }

      const subtotal = product.price * item.quantity;
      totalAmount += subtotal;

      orderItems.push({
        product: product._id,
        productName: product.name,
        quantity: item.quantity,
        price: product.price,
        subtotal
      });

      // Decrease product stock
      product.stock -= item.quantity;
      if (product.stock === 0) {
        product.status = 'out_of_stock';
      }
      await product.save();
    }

    totalAmount += Number(shippingCost);

    const order = new Order({
      customer,
      items: orderItems,
      totalAmount,
      shippingCost,
      notes,
      statusHistory: [{
        status: 'pending',
        timestamp: new Date()
      }]
    });

    await order.save();

    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      data: order
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating order',
      error: error.message
    });
  }
});

// Update order status
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { orderStatus, note } = req.body;

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    order.orderStatus = orderStatus;
    order.statusHistory.push({
      status: orderStatus,
      timestamp: new Date(),
      note
    });

    await order.save();

    // Send email notification if configured
    if (resend && order.customer.email) {
      try {
        await resend.emails.send({
          from: 'FortuneHub <noreply@fortunehub.com>',
          to: order.customer.email,
          subject: `Order ${order.orderNumber} - Status Update`,
          html: `
            <h2>Order Status Update</h2>
            <p>Hello ${order.customer.name},</p>
            <p>Your order <strong>${order.orderNumber}</strong> status has been updated to: <strong>${orderStatus}</strong></p>
            ${note ? `<p>Note: ${note}</p>` : ''}
            <p>Thank you for shopping with FortuneHub!</p>
          `
        });
      } catch (emailError) {
        console.error('Email notification failed:', emailError);
      }
    }

    res.json({
      success: true,
      message: 'Order status updated successfully',
      data: order
    });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating order status',
      error: error.message
    });
  }
});

// ===========================
// PAYMENT ROUTES (PAYSTACK)
// ===========================

// Initialize payment
app.post('/api/payments/initialize', async (req, res) => {
  try {
    const { email, amount, orderId, metadata } = req.body;

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Paystack not configured'
      });
    }

    // Create transaction record
    const transaction = new Transaction({
      reference: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      order: orderId,
      amount,
      customerEmail: email,
      metadata
    });
    await transaction.save();

    // Initialize Paystack payment
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amount * 100, // Convert to kobo
        reference: transaction.reference,
        callback_url: `${process.env.FRONTEND_URL}/payment/verify`,
        metadata
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      success: true,
      message: 'Payment initialized',
      data: {
        authorizationUrl: response.data.data.authorization_url,
        accessCode: response.data.data.access_code,
        reference: transaction.reference
      }
    });
  } catch (error) {
    console.error('Payment initialization error:', error.response?.data || error);
    res.status(500).json({
      success: false,
      message: 'Error initializing payment',
      error: error.response?.data?.message || error.message
    });
  }
});

// Verify payment
app.get('/api/payments/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Paystack not configured'
      });
    }

    // Verify with Paystack
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const paystackData = response.data.data;

    // Update transaction
    const transaction = await Transaction.findOne({ reference });
    
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    transaction.status = paystackData.status === 'success' ? 'success' : 'failed';
    transaction.gatewayResponse = paystackData;
    if (paystackData.status === 'success') {
      transaction.paidAt = new Date(paystackData.paid_at);
    }
    await transaction.save();

    // Update order payment status
    if (transaction.order && paystackData.status === 'success') {
      const order = await Order.findById(transaction.order);
      if (order) {
        order.paymentStatus = 'paid';
        order.paymentReference = reference;
        order.orderStatus = 'processing';
        order.statusHistory.push({
          status: 'processing',
          timestamp: new Date(),
          note: 'Payment confirmed'
        });
        await order.save();

        // Send confirmation email
        if (resend && order.customer.email) {
          try {
            await resend.emails.send({
              from: 'FortuneHub <noreply@fortunehub.com>',
              to: order.customer.email,
              subject: `Payment Confirmed - Order ${order.orderNumber}`,
              html: `
                <h2>Payment Successful!</h2>
                <p>Hello ${order.customer.name},</p>
                <p>Your payment for order <strong>${order.orderNumber}</strong> has been confirmed.</p>
                <p>Amount Paid: ₦${(order.totalAmount).toLocaleString()}</p>
                <p>We'll start processing your order right away.</p>
                <p>Thank you for shopping with FortuneHub!</p>
              `
            });
          } catch (emailError) {
            console.error('Email notification failed:', emailError);
          }
        }
      }
    }

    res.json({
      success: true,
      message: 'Payment verification completed',
      data: {
        status: transaction.status,
        amount: transaction.amount,
        paidAt: transaction.paidAt
      }
    });
  } catch (error) {
    console.error('Payment verification error:', error.response?.data || error);
    res.status(500).json({
      success: false,
      message: 'Error verifying payment',
      error: error.response?.data?.message || error.message
    });
  }
});

// Paystack webhook
app.post('/api/payments/webhook', async (req, res) => {
  try {
    const hash = require('crypto')
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({
        success: false,
        message: 'Invalid signature'
      });
    }

    const event = req.body;

    if (event.event === 'charge.success') {
      const { reference, status } = event.data;
      
      const transaction = await Transaction.findOne({ reference });
      if (transaction) {
        transaction.status = 'success';
        transaction.gatewayResponse = event.data;
        transaction.paidAt = new Date();
        await transaction.save();

        // Update order
        if (transaction.order) {
          await Order.findByIdAndUpdate(transaction.order, {
            paymentStatus: 'paid',
            paymentReference: reference,
            orderStatus: 'processing'
          });
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({
      success: false,
      message: 'Webhook processing error'
    });
  }
});

// ===========================
// ANALYTICS & DASHBOARD
// ===========================

app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments();
    const activeProducts = await Product.countDocuments({ status: 'active' });
    const totalOrders = await Order.countDocuments();
    const pendingOrders = await Order.countDocuments({ orderStatus: 'pending' });
    
    const revenueResult = await Order.aggregate([
      { $match: { paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);
    const totalRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;

    res.json({
      success: true,
      data: {
        totalProducts,
        activeProducts,
        totalOrders,
        pendingOrders,
        totalRevenue
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching dashboard stats',
      error: error.message
    });
  }
});

// ===========================
// HEALTH CHECK
// ===========================

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'FortuneHub API is running',
    timestamp: new Date(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Welcome to FortuneHub API',
    version: '1.0.0',
    endpoints: {
      products: '/api/products',
      orders: '/api/orders',
      payments: '/api/payments',
      dashboard: '/api/dashboard/stats',
      health: '/api/health'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err : {}
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 FortuneHub Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 API URL: http://localhost:${PORT}`);
});

module.exports = app;
