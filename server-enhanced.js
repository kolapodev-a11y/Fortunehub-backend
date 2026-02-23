const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// Product Schema
const productSchema = new mongoose.Schema({
  id: { type: Number, unique: true, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, required: true },
  description: { type: String, required: true },
  image: { type: String, required: true },
  images: { type: [String], required: true },
  tag: { type: String, enum: ['new', 'sale', 'none'], default: 'none' },
  outOfStock: { type: Boolean, default: false },
  sold: { type: Boolean, default: false },
  statusIndicator: { type: String, enum: ['new', 'sale', 'available', 'outofstock'], default: 'available' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);

// Configure multer for image uploads with base64 support
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
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

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper function to save base64 image
function saveBase64Image(base64String, filename) {
  try {
    // Remove data URL prefix if present
    const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    const filepath = path.join(uploadsDir, filename);
    fs.writeFileSync(filepath, buffer);
    
    return `/uploads/${filename}`;
  } catch (error) {
    console.error('Error saving base64 image:', error);
    throw error;
  }
}

// ==================== PRODUCT MANAGEMENT ENDPOINTS ====================

// Get all products
app.get('/api/products', async (req, res) => {
  try {
    const { category, tag, search, sort } = req.query;
    
    let query = {};
    
    if (category && category !== 'all') {
      query.category = category;
    }
    
    if (tag && tag !== 'all') {
      query.tag = tag;
    }
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }
    
    let sortOption = { createdAt: -1 };
    if (sort === 'price-asc') sortOption = { price: 1 };
    if (sort === 'price-desc') sortOption = { price: -1 };
    if (sort === 'name') sortOption = { name: 1 };
    
    const products = await Product.find(query).sort(sortOption);
    
    res.json({
      success: true,
      data: products,
      count: products.length
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.message
    });
  }
});

// Get single product by ID
app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findOne({ id: parseInt(req.params.id) });
    
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
      message: 'Failed to fetch product',
      error: error.message
    });
  }
});

// Create new product with image upload
app.post('/api/products', async (req, res) => {
  try {
    const { name, price, category, description, tag, outOfStock, images: base64Images } = req.body;
    
    // Validation
    if (!name || !price || !category || !description) {
      return res.status(400).json({
        success: false,
        message: 'Name, price, category, and description are required'
      });
    }
    
    if (!base64Images || base64Images.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one image is required'
      });
    }
    
    if (base64Images.length !== 3) {
      return res.status(400).json({
        success: false,
        message: 'Exactly 3 images are required'
      });
    }
    
    // Get next ID
    const lastProduct = await Product.findOne().sort({ id: -1 });
    const newId = lastProduct ? lastProduct.id + 1 : 1;
    
    // Save images
    const timestamp = Date.now();
    const imagePaths = [];
    
    for (let i = 0; i < base64Images.length; i++) {
      const suffix = i === 0 ? '' : String.fromCharCode(98 + i - 1); // '', 'b', 'c'
      const filename = `product${newId}${suffix}.jpg`;
      const imagePath = saveBase64Image(base64Images[i], filename);
      imagePaths.push(imagePath);
    }
    
    // Determine status indicator
    let statusIndicator = 'available';
    if (tag === 'new') statusIndicator = 'new';
    else if (tag === 'sale') statusIndicator = 'sale';
    else if (outOfStock) statusIndicator = 'outofstock';
    
    // Create product
    const product = new Product({
      id: newId,
      name,
      price: parseInt(price),
      category,
      description,
      image: imagePaths[0],
      images: imagePaths,
      tag: tag || 'none',
      outOfStock: outOfStock || false,
      sold: false,
      statusIndicator
    });
    
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
      message: 'Failed to create product',
      error: error.message
    });
  }
});

// Update product
app.put('/api/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const { name, price, category, description, tag, outOfStock, sold, images: base64Images } = req.body;
    
    const product = await Product.findOne({ id: productId });
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    // Update basic fields
    if (name) product.name = name;
    if (price) product.price = parseInt(price);
    if (category) product.category = category;
    if (description) product.description = description;
    if (tag !== undefined) product.tag = tag;
    if (outOfStock !== undefined) product.outOfStock = outOfStock;
    if (sold !== undefined) product.sold = sold;
    
    // Update images if provided
    if (base64Images && base64Images.length === 3) {
      // Delete old images
      product.images.forEach(imagePath => {
        const filename = path.basename(imagePath);
        const filepath = path.join(uploadsDir, filename);
        if (fs.existsSync(filepath)) {
          fs.unlinkSync(filepath);
        }
      });
      
      // Save new images
      const imagePaths = [];
      for (let i = 0; i < base64Images.length; i++) {
        const suffix = i === 0 ? '' : String.fromCharCode(98 + i - 1);
        const filename = `product${productId}${suffix}.jpg`;
        const imagePath = saveBase64Image(base64Images[i], filename);
        imagePaths.push(imagePath);
      }
      
      product.image = imagePaths[0];
      product.images = imagePaths;
    }
    
    // Update status indicator
    if (product.tag === 'new') product.statusIndicator = 'new';
    else if (product.tag === 'sale') product.statusIndicator = 'sale';
    else if (product.outOfStock) product.statusIndicator = 'outofstock';
    else product.statusIndicator = 'available';
    
    product.updatedAt = Date.now();
    
    await product.save();
    
    res.json({
      success: true,
      message: 'Product updated successfully',
      data: product
    });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product',
      error: error.message
    });
  }
});

// Delete product
app.delete('/api/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const product = await Product.findOne({ id: productId });
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    // Delete product images
    product.images.forEach(imagePath => {
      const filename = path.basename(imagePath);
      const filepath = path.join(uploadsDir, filename);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    });
    
    await Product.deleteOne({ id: productId });
    
    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete product',
      error: error.message
    });
  }
});

// Get product statistics
app.get('/api/products/stats/summary', async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments();
    const inStock = await Product.countDocuments({ outOfStock: false });
    const outOfStock = await Product.countDocuments({ outOfStock: true });
    const sold = await Product.countDocuments({ sold: true });
    const newProducts = await Product.countDocuments({ tag: 'new' });
    const onSale = await Product.countDocuments({ tag: 'sale' });
    
    const categories = await Product.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } }
    ]);
    
    const totalValue = await Product.aggregate([
      { $match: { outOfStock: false } },
      { $group: { _id: null, total: { $sum: '$price' } } }
    ]);
    
    res.json({
      success: true,
      data: {
        totalProducts,
        inStock,
        outOfStock,
        sold,
        newProducts,
        onSale,
        categories,
        totalValue: totalValue[0]?.total || 0
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: error.message
    });
  }
});

// Bulk import products (for migration)
app.post('/api/products/bulk-import', async (req, res) => {
  try {
    const { products } = req.body;
    
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Products array is required'
      });
    }
    
    const results = [];
    
    for (const productData of products) {
      try {
        const existingProduct = await Product.findOne({ id: productData.id });
        if (!existingProduct) {
          const product = new Product(productData);
          await product.save();
          results.push({ id: productData.id, status: 'created' });
        } else {
          results.push({ id: productData.id, status: 'skipped' });
        }
      } catch (error) {
        results.push({ id: productData.id, status: 'error', error: error.message });
      }
    }
    
    res.json({
      success: true,
      message: 'Bulk import completed',
      results
    });
  } catch (error) {
    console.error('Error bulk importing:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to bulk import products',
      error: error.message
    });
  }
});

// ==================== KEEP YOUR EXISTING ENDPOINTS ====================
// Add your existing payment endpoints, order endpoints, etc. below this line
// This is just a placeholder - add your actual endpoints here

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  mongoose.connection.close();
  process.exit(0);
});
