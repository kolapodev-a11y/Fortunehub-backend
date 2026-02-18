require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 10000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// =====================
// MongoDB Connection
// =====================
let db;
let transactionsCollection;
let usersCollection;

const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  maxPoolSize: 50,
  minPoolSize: 10,
  retryWrites: true,
  w: 'majority'
});

async function connectToDatabase() {
  try {
    console.log('🔄 Connecting to MongoDB Atlas...');
    await mongoClient.connect();
    console.log('✅ Connected to MongoDB Atlas');
    
    db = mongoClient.db('fortunehub');
    transactionsCollection = db.collection('transactions');
    usersCollection = db.collection('users');
    
    // Create indexes for better performance
    await transactionsCollection.createIndex({ userId: 1, createdAt: -1 });
    await transactionsCollection.createIndex({ createdAt: -1 });
    await transactionsCollection.createIndex({ status: 1 });
    await transactionsCollection.createIndex({ type: 1 });
    await transactionsCollection.createIndex({ reference: 1 }, { unique: true, sparse: true });
    
    console.log('✅ Database indexes created');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    // In production, we want to retry connection
    if (IS_PRODUCTION) {
      console.log('🔄 Retrying connection in 5 seconds...');
      setTimeout(connectToDatabase, 5000);
    } else {
      process.exit(1);
    }
  }
}

// =====================
// Middleware Configuration
// =====================

// Security headers
app.use(helmet({
  contentSecurityPolicy: IS_PRODUCTION,
  crossOriginEmbedderPolicy: IS_PRODUCTION
}));

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['*'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting - stricter in production
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: IS_PRODUCTION ? 100 : 1000,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Request logging (only in development or with errors)
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  if (!IS_PRODUCTION) {
    console.log(`${timestamp} - ${req.method} ${req.path}`);
  }
  next();
});

// Database connection check middleware
app.use((req, res, next) => {
  if (!db && req.path !== '/' && req.path !== '/health') {
    return res.status(503).json({ 
      error: 'Database connection not ready',
      message: 'Please try again in a moment'
    });
  }
  next();
});

// =====================
// Basic Auth Middleware
// =====================
function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');
    
    const validUsername = process.env.ADMIN_USERNAME || 'admin';
    const validPassword = process.env.ADMIN_PASSWORD || 'admin123';
    
    if (username === validUsername && password === validPassword) {
      next();
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(401).json({ error: 'Invalid authorization header' });
  }
}

// =====================
// Utility Functions
// =====================
function generateReference() {
  return `TRX-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
}

function validateTransaction(data) {
  const errors = [];
  
  if (!data.userId) errors.push('userId is required');
  if (!data.amount) errors.push('amount is required');
  if (isNaN(parseFloat(data.amount))) errors.push('amount must be a number');
  if (!data.type) errors.push('type is required');
  if (!['deposit', 'withdrawal', 'transfer'].includes(data.type)) {
    errors.push('type must be: deposit, withdrawal, or transfer');
  }
  
  return errors;
}

// =====================
// Health Check Routes
// =====================
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'FortuneHub API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    database: db ? '✅ connected' : '❌ disconnected',
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/health', async (req, res) => {
  try {
    // Check database connection
    const dbHealth = db ? await db.admin().ping() : null;
    
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: dbHealth ? 'connected' : 'disconnected',
      memory: {
        used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
        total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// =====================
// Transaction Routes
// =====================

/**
 * POST /api/transactions
 * Create a new transaction
 */
app.post('/api/transactions', async (req, res) => {
  try {
    // Validate input
    const validationErrors = validateTransaction(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        error: 'Validation failed',
        details: validationErrors 
      });
    }
    
    const transaction = {
      userId: req.body.userId,
      amount: parseFloat(req.body.amount),
      type: req.body.type,
      status: req.body.status || 'pending',
      paymentMethod: req.body.paymentMethod || null,
      description: req.body.description || '',
      reference: req.body.reference || generateReference(),
      metadata: req.body.metadata || {},
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false
    };
    
    const result = await transactionsCollection.insertOne(transaction);
    
    res.status(201).json({
      success: true,
      message: 'Transaction created successfully',
      data: {
        transactionId: result.insertedId,
        reference: transaction.reference,
        ...transaction
      }
    });
  } catch (error) {
    console.error('❌ Error creating transaction:', error);
    
    // Handle duplicate reference error
    if (error.code === 11000) {
      return res.status(409).json({ 
        error: 'Transaction reference already exists',
        details: 'Please use a unique reference'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to create transaction',
      message: IS_PRODUCTION ? 'Internal server error' : error.message
    });
  }
});

/**
 * GET /api/transactions
 * Get all transactions with pagination and filters
 */
app.get('/api/transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    
    // Build query filters
    const query = { deleted: { $ne: true } };
    
    if (req.query.userId) query.userId = req.query.userId;
    if (req.query.type) query.type = req.query.type;
    if (req.query.status) query.status = req.query.status;
    if (req.query.reference) query.reference = req.query.reference;
    
    // Date range filter
    if (req.query.startDate || req.query.endDate) {
      query.createdAt = {};
      if (req.query.startDate) {
        query.createdAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        query.createdAt.$lte = new Date(req.query.endDate);
      }
    }
    
    // Amount range filter
    if (req.query.minAmount || req.query.maxAmount) {
      query.amount = {};
      if (req.query.minAmount) {
        query.amount.$gte = parseFloat(req.query.minAmount);
      }
      if (req.query.maxAmount) {
        query.amount.$lte = parseFloat(req.query.maxAmount);
      }
    }
    
    const [transactions, total] = await Promise.all([
      transactionsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      transactionsCollection.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('❌ Error fetching transactions:', error);
    res.status(500).json({ 
      error: 'Failed to fetch transactions',
      message: IS_PRODUCTION ? 'Internal server error' : error.message
    });
  }
});

/**
 * GET /api/transactions/:id
 * Get single transaction by ID
 */
app.get('/api/transactions/:id', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid transaction ID format' });
    }
    
    const transaction = await transactionsCollection.findOne({
      _id: new ObjectId(req.params.id),
      deleted: { $ne: true }
    });
    
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    console.error('❌ Error fetching transaction:', error);
    res.status(500).json({ 
      error: 'Failed to fetch transaction',
      message: IS_PRODUCTION ? 'Internal server error' : error.message
    });
  }
});

/**
 * GET /api/users/:userId/transactions
 * Get all transactions for a specific user
 */
app.get('/api/users/:userId/transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    
    const query = { 
      userId: req.params.userId,
      deleted: { $ne: true }
    };
    
    // Optional status filter
    if (req.query.status) {
      query.status = req.query.status;
    }
    
    const [transactions, total] = await Promise.all([
      transactionsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      transactionsCollection.countDocuments(query)
    ]);
    
    // Calculate user summary
    const summary = await transactionsCollection.aggregate([
      { $match: { userId: req.params.userId, deleted: { $ne: true } } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      }
    ]).toArray();
    
    res.json({
      success: true,
      data: transactions,
      summary,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Error fetching user transactions:', error);
    res.status(500).json({ 
      error: 'Failed to fetch user transactions',
      message: IS_PRODUCTION ? 'Internal server error' : error.message
    });
  }
});

/**
 * PATCH /api/transactions/:id
 * Update transaction (limited fields)
 */
app.patch('/api/transactions/:id', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid transaction ID format' });
    }
    
    const updateData = {
      updatedAt: new Date()
    };
    
    // Only allow updating specific fields
    const allowedFields = ['status', 'metadata', 'description'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });
    
    if (Object.keys(updateData).length === 1) {
      return res.status(400).json({ 
        error: 'No valid fields to update',
        allowedFields 
      });
    }
    
    const result = await transactionsCollection.updateOne(
      { _id: new ObjectId(req.params.id), deleted: { $ne: true } },
      { $set: updateData }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    res.json({
      success: true,
      message: 'Transaction updated successfully',
      updated: updateData
    });
  } catch (error) {
    console.error('❌ Error updating transaction:', error);
    res.status(500).json({ 
      error: 'Failed to update transaction',
      message: IS_PRODUCTION ? 'Internal server error' : error.message
    });
  }
});

// =====================
// Admin Routes (Protected)
// =====================

/**
 * GET /api/admin/stats
 * Get transaction statistics (requires authentication)
 */
app.get('/api/admin/stats', basicAuth, async (req, res) => {
  try {
    const [statusStats, typeStats, recentStats] = await Promise.all([
      // Stats by status
      transactionsCollection.aggregate([
        { $match: { deleted: { $ne: true } } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' }
          }
        }
      ]).toArray(),
      
      // Stats by type
      transactionsCollection.aggregate([
        { $match: { deleted: { $ne: true } } },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' }
          }
        }
      ]).toArray(),
      
      // Recent 24h stats
      transactionsCollection.aggregate([
        { 
          $match: { 
            deleted: { $ne: true },
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          } 
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' }
          }
        }
      ]).toArray()
    ]);
    
    const totalTransactions = await transactionsCollection.countDocuments({ deleted: { $ne: true } });
    
    res.json({
      success: true,
      data: {
        totalTransactions,
        byStatus: statusStats,
        byType: typeStats,
        last24Hours: recentStats[0] || { count: 0, totalAmount: 0 }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({ 
      error: 'Failed to fetch statistics',
      message: IS_PRODUCTION ? 'Internal server error' : error.message
    });
  }
});

/**
 * GET /api/admin/transactions
 * Get all transactions including deleted (requires authentication)
 */
app.get('/api/admin/transactions', basicAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    
    const query = {};
    if (req.query.includeDeleted !== 'true') {
      query.deleted = { $ne: true };
    }
    
    const [transactions, total] = await Promise.all([
      transactionsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      transactionsCollection.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Error fetching admin transactions:', error);
    res.status(500).json({ 
      error: 'Failed to fetch transactions',
      message: IS_PRODUCTION ? 'Internal server error' : error.message
    });
  }
});

/**
 * DELETE /api/admin/transactions/:id
 * Soft delete a transaction (requires authentication)
 */
app.delete('/api/admin/transactions/:id', basicAuth, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid transaction ID format' });
    }
    
    const result = await transactionsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { 
        $set: { 
          deleted: true, 
          deletedAt: new Date(),
          deletedBy: 'admin'
        } 
      }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    res.json({
      success: true,
      message: 'Transaction deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting transaction:', error);
    res.status(500).json({ 
      error: 'Failed to delete transaction',
      message: IS_PRODUCTION ? 'Internal server error' : error.message
    });
  }
});

// =====================
// Error Handling
// =====================
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  
  // CORS errors
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'CORS error',
      message: 'Origin not allowed'
    });
  }
  
  res.status(500).json({ 
    error: 'Internal server error',
    message: IS_PRODUCTION ? 'Something went wrong' : err.message,
    timestamp: new Date().toISOString()
  });
});

// =====================
// Server Startup
// =====================
async function startServer() {
  try {
    // Connect to database first
    await connectToDatabase();
    
    // Then start HTTP server
    app.listen(PORT, '0.0.0.0', () => {
      console.log('=================================');
      console.log('🚀 FortuneHub API Server Started');
      console.log('=================================');
      console.log(`📍 Port: ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🗄️  Database: ${db ? '✅ Connected' : '❌ Disconnected'}`);
      console.log(`🌐 Health: http://localhost:${PORT}/health`);
      console.log(`📝 Docs: http://localhost:${PORT}/`);
      console.log('=================================');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// =====================
// Graceful Shutdown
// =====================
async function gracefulShutdown(signal) {
  console.log(\n${signal} received: Starting graceful shutdown...);
  
  try {
    // Close MongoDB connection
    if (mongoClient) {
      await mongoClient.close();
      console.log('✅ MongoDB connection closed');
    }
    
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server
startServer().catch(error => {
  console.error('❌ Fatal error during startup:', error);
  process.exit(1);
});
