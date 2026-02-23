const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const { Resend } = require('resend');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'product-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'));
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Product Schema
const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  category: {
    type: String,
    required: true,
    enum: ['phones', 'accessories', 'laptops', 'tablets', 'wearables', 'audio', 'other']
  },
  description: {
    type: String,
    required: true
  },
  image: {
    type: String,
    required: true
  },
  images: [{
    type: String
  }],
  tag: {
    type: String,
    enum: ['new', 'sale', 'featured', 'none'],
    default: 'none'
  },
  outOfStock: {
    type: Boolean,
    default: false
  },
  sold: {
    type: Boolean,
    default: false
  },
  statusIndicator: {
    type: String,
    default: 'none'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const Product = mongoose.model('Product', productSchema);

// Order Schema (for existing functionality)
const orderSchema = new mongoose.Schema({
  customerName: String,
  email: String,
  phone: String,
  address: String,
  products: [{
    productId: mongoose.Schema.Types.ObjectId,
    productName: String,
    price: Number,
    quantity: Number
  }],
  totalAmount: Number,
  paymentStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  },
  orderStatus: {
    type: String,
    enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
    default: 'pending'
  },
  paymentReference: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const Order = mongoose.model('Order', orderSchema);

// ===================== PRODUCT API ENDPOINTS =====================

// Get all products
app.get('/api/products', async (req, res) => {
  try {
    const { category, tag, search } = req.query;
    let query = {};

    if (category && category !== 'all') {
      query.category = category;
    }

    if (tag) {
      query.tag = tag;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const products = await Product.find(query).sort({ createdAt: -1 });
    res.json(products);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Get single product by ID
app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// Create new product (with multiple images upload)
app.post('/api/products', upload.array('images', 5), async (req, res) => {
  try {
    const { name, price, category, description, tag, outOfStock } = req.body;

    if (!name || !price || !category || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'At least one product image is required' });
    }

    // Get uploaded file paths
    const imagePaths = req.files.map(file => `/uploads/${file.filename}`);

    const product = new Product({
      name,
      price: parseFloat(price),
      category,
      description,
      image: imagePaths[0], // Main image
      images: imagePaths, // All images
      tag: tag || 'none',
      outOfStock: outOfStock === 'true',
      statusIndicator: tag || 'none'
    });

    const savedProduct = await product.save();
    res.status(201).json(savedProduct);
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product
app.put('/api/products/:id', upload.array('images', 5), async (req, res) => {
  try {
    const { name, price, category, description, tag, outOfStock, sold } = req.body;
    
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Update fields
    if (name) product.name = name;
    if (price) product.price = parseFloat(price);
    if (category) product.category = category;
    if (description) product.description = description;
    if (tag !== undefined) {
      product.tag = tag;
      product.statusIndicator = tag;
    }
    if (outOfStock !== undefined) product.outOfStock = outOfStock === 'true';
    if (sold !== undefined) product.sold = sold === 'true';

    // Handle new images if uploaded
    if (req.files && req.files.length > 0) {
      // Delete old images
      product.images.forEach(imagePath => {
        const fullPath = path.join(__dirname, 'public', imagePath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      });

      // Add new images
      const newImagePaths = req.files.map(file => `/uploads/${file.filename}`);
      product.image = newImagePaths[0];
      product.images = newImagePaths;
    }

    product.updatedAt = Date.now();
    const updatedProduct = await product.save();
    res.json(updatedProduct);
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product
app.delete('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Delete associated images
    product.images.forEach(imagePath => {
      const fullPath = path.join(__dirname, 'public', imagePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    });

    await Product.findByIdAndDelete(req.params.id);
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ===================== ORDER API ENDPOINTS =====================

// Create order
app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, email, phone, address, products, totalAmount } = req.body;

    const order = new Order({
      customerName,
      email,
      phone,
      address,
      products,
      totalAmount
    });

    const savedOrder = await order.save();

    // Send order confirmation email
    if (process.env.RESEND_API_KEY) {
      try {
        await resend.emails.send({
          from: 'FortuneHub <onboarding@resend.dev>',
          to: email,
          subject: 'Order Confirmation - FortuneHub',
          html: `
            <h2>Thank you for your order!</h2>
            <p>Hi ${customerName},</p>
            <p>Your order has been received and is being processed.</p>
            <p><strong>Order ID:</strong> ${savedOrder._id}</p>
            <p><strong>Total Amount:</strong> ₦${(totalAmount / 100).toLocaleString()}</p>
            <p>We'll notify you when your order is shipped.</p>
          `
        });
      } catch (emailError) {
        console.error('Email sending error:', emailError);
      }
    }

    res.status(201).json(savedOrder);
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Get all orders (admin)
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Update order status
app.put('/api/orders/:id', async (req, res) => {
  try {
    const { orderStatus, paymentStatus } = req.body;
    
    const updateData = {};
    if (orderStatus) updateData.orderStatus = orderStatus;
    if (paymentStatus) updateData.paymentStatus = paymentStatus;

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(order);
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// ===================== STATS ENDPOINT =====================

app.get('/api/stats', async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments();
    const totalOrders = await Order.countDocuments();
    const totalRevenue = await Order.aggregate([
      { $match: { paymentStatus: 'completed' } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);

    const stats = {
      totalProducts,
      totalOrders,
      totalRevenue: totalRevenue[0]?.total || 0,
      outOfStock: await Product.countDocuments({ outOfStock: true }),
      pendingOrders: await Order.countDocuments({ orderStatus: 'pending' })
    };

    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'FortuneHub API is running' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Something went wrong!' });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
