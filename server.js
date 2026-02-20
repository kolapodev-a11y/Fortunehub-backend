// ===================================
// FORTUNEHUB BACKEND - FIXED VERSION
// ===================================

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 10000;

// ===================================
// MIDDLEWARE
// ===================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://kolapodev-a11y.github.io'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ===================================
// ENVIRONMENT VALIDATION
// ===================================
const requiredEnvVars = [
  'MONGODB_URI',
  'PAYSTACK_SECRET_KEY',
  'RESEND_API_KEY',
  'OWNER_EMAIL'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars);
  process.exit(1);
}

// ===================================
// RESEND EMAIL CLIENT INITIALIZATION
// ===================================
const resend = new Resend(process.env.RESEND_API_KEY);

// Default sender email - IMPORTANT: Change this after domain verification
const MAIL_FROM = process.env.MAIL_FROM || 'FortuneHub <onboarding@resend.dev>';

// ===================================
// MONGODB CONNECTION
// ===================================
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  console.log('🔗 Mongoose connected to MongoDB');
  console.log('✅ MongoDB Connected Successfully');
  console.log('📊 Database:', mongoose.connection.db.databaseName);
})
.catch((err) => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// ===================================
// MONGOOSE SCHEMA & MODEL
// ===================================
const paymentSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true,
    default: 'NGN'
  },
  reference: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    required: true,
    enum: ['success', 'failed', 'pending'],
    default: 'pending'
  },
  paymentMethod: {
    type: String,
    default: 'paystack'
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  emailSent: {
    type: Boolean,
    default: false
  },
  emailSentAt: {
    type: Date
  },
  emailError: {
    type: String
  }
}, {
  timestamps: true
});

const Payment = mongoose.model('Payment', paymentSchema);

// ===================================
// EMAIL TEMPLATES
// ===================================
function getCustomerEmailTemplate(email, amount, reference) {
  const amountInNaira = (amount / 100).toFixed(2);
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Confirmation</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td style="padding: 40px 0; text-align: center;">
        <table role="presentation" style="width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 28px;">🎉 Payment Successful!</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="color: #333333; font-size: 16px; line-height: 1.6; margin: 0 0 20px;">
                Dear Customer,
              </p>
              
              <p style="color: #333333; font-size: 16px; line-height: 1.6; margin: 0 0 30px;">
                Thank you for your payment! We've successfully received your transaction.
              </p>
              
              <!-- Payment Details Box -->
              <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px;">
                <tr>
                  <td style="background-color: #f8f9fa; border-radius: 8px; padding: 25px;">
                    <h2 style="color: #667eea; margin: 0 0 20px; font-size: 20px;">Payment Details</h2>
                    
                    <table role="presentation" style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td style="padding: 8px 0; color: #666666; font-size: 14px;">Amount Paid:</td>
                        <td style="padding: 8px 0; color: #333333; font-size: 16px; font-weight: bold; text-align: right;">₦${amountInNaira}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #666666; font-size: 14px;">Reference:</td>
                        <td style="padding: 8px 0; color: #333333; font-size: 14px; text-align: right; font-family: monospace;">${reference}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #666666; font-size: 14px;">Email:</td>
                        <td style="padding: 8px 0; color: #333333; font-size: 14px; text-align: right;">${email}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #666666; font-size: 14px;">Date:</td>
                        <td style="padding: 8px 0; color: #333333; font-size: 14px; text-align: right;">${new Date().toLocaleString()}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <p style="color: #666666; font-size: 14px; line-height: 1.6; margin: 0;">
                If you have any questions about this payment, please contact our support team.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="color: #666666; font-size: 14px; margin: 0 0 10px;">
                <strong>FortuneHub</strong>
              </p>
              <p style="color: #999999; font-size: 12px; margin: 0;">
                This is an automated email. Please do not reply to this message.
              </p>
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

function getOwnerEmailTemplate(email, amount, reference) {
  const amountInNaira = (amount / 100).toFixed(2);
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Payment Received</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td style="padding: 40px 0; text-align: center;">
        <table role="presentation" style="width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); padding: 40px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 28px;">💰 New Payment Received</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="color: #333333; font-size: 16px; line-height: 1.6; margin: 0 0 20px;">
                Hello Admin,
              </p>
              
              <p style="color: #333333; font-size: 16px; line-height: 1.6; margin: 0 0 30px;">
                You've received a new payment through FortuneHub!
              </p>
              
              <!-- Payment Details Box -->
              <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px;">
                <tr>
                  <td style="background-color: #f8f9fa; border-radius: 8px; padding: 25px;">
                    <h2 style="color: #11998e; margin: 0 0 20px; font-size: 20px;">Transaction Details</h2>
                    
                    <table role="presentation" style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td style="padding: 8px 0; color: #666666; font-size: 14px;">Customer Email:</td>
                        <td style="padding: 8px 0; color: #333333; font-size: 14px; text-align: right; font-weight: bold;">${email}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #666666; font-size: 14px;">Amount:</td>
                        <td style="padding: 8px 0; color: #11998e; font-size: 18px; text-align: right; font-weight: bold;">₦${amountInNaira}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #666666; font-size: 14px;">Reference:</td>
                        <td style="padding: 8px 0; color: #333333; font-size: 14px; text-align: right; font-family: monospace;">${reference}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #666666; font-size: 14px;">Date:</td>
                        <td style="padding: 8px 0; color: #333333; font-size: 14px; text-align: right;">${new Date().toLocaleString()}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #666666; font-size: 14px;">Status:</td>
                        <td style="padding: 8px 0; text-align: right;">
                          <span style="background-color: #d4edda; color: #155724; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: bold;">SUCCESS</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <p style="color: #666666; font-size: 14px; line-height: 1.6; margin: 0;">
                A confirmation email has been sent to the customer automatically.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="color: #666666; font-size: 14px; margin: 0 0 10px;">
                <strong>FortuneHub Admin Panel</strong>
              </p>
              <p style="color: #999999; font-size: 12px; margin: 0;">
                This is an automated notification from your payment system.
              </p>
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

// ===================================
// EMAIL SENDING FUNCTION - FIXED
// ===================================
async function sendPaymentEmails(email, amount, reference) {
  console.log('📧 Starting email send process...');
  console.log('📧 Customer email:', email);
  console.log('📧 Owner email:', process.env.OWNER_EMAIL);
  console.log('📧 Sender email:', MAIL_FROM);
  
  const results = {
    customerEmail: { sent: false, error: null, id: null },
    ownerEmail: { sent: false, error: null, id: null }
  };

  // Send customer email
  try {
    console.log('📤 Sending customer email...');
    const customerResponse = await resend.emails.send({
      from: MAIL_FROM,
      to: email,
      subject: '✅ Payment Confirmation - FortuneHub',
      html: getCustomerEmailTemplate(email, amount, reference)
    });

    console.log('📧 Customer email response:', JSON.stringify(customerResponse, null, 2));
    
    if (customerResponse.data && customerResponse.data.id) {
      results.customerEmail.sent = true;
      results.customerEmail.id = customerResponse.data.id;
      console.log('✅ Customer email sent successfully. ID:', customerResponse.data.id);
    } else if (customerResponse.id) {
      results.customerEmail.sent = true;
      results.customerEmail.id = customerResponse.id;
      console.log('✅ Customer email sent successfully. ID:', customerResponse.id);
    } else {
      console.warn('⚠️ Customer email sent but no ID returned:', customerResponse);
      results.customerEmail.sent = true;
      results.customerEmail.id = 'no-id-returned';
    }
  } catch (error) {
    console.error('❌ Customer email failed:', error.message);
    console.error('❌ Full error:', error);
    results.customerEmail.error = error.message;
  }

  // Send owner notification email
  try {
    console.log('📤 Sending owner notification email...');
    const ownerResponse = await resend.emails.send({
      from: MAIL_FROM,
      to: process.env.OWNER_EMAIL,
      subject: '💰 New Payment Received - FortuneHub',
      html: getOwnerEmailTemplate(email, amount, reference)
    });

    console.log('📧 Owner email response:', JSON.stringify(ownerResponse, null, 2));
    
    if (ownerResponse.data && ownerResponse.data.id) {
      results.ownerEmail.sent = true;
      results.ownerEmail.id = ownerResponse.data.id;
      console.log('✅ Owner email sent successfully. ID:', ownerResponse.data.id);
    } else if (ownerResponse.id) {
      results.ownerEmail.sent = true;
      results.ownerEmail.id = ownerResponse.id;
      console.log('✅ Owner email sent successfully. ID:', ownerResponse.id);
    } else {
      console.warn('⚠️ Owner email sent but no ID returned:', ownerResponse);
      results.ownerEmail.sent = true;
      results.ownerEmail.id = 'no-id-returned';
    }
  } catch (error) {
    console.error('❌ Owner email failed:', error.message);
    console.error('❌ Full error:', error);
    results.ownerEmail.error = error.message;
  }

  return results;
}

// ===================================
// ROUTES
// ===================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: 'FortuneHub Backend API is running',
    timestamp: new Date().toISOString(),
    endpoints: {
      verifyPayment: 'POST /api/verify-payment',
      payments: 'GET /api/payments',
      health: 'GET /api/health'
    }
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime()
  });
});

// Get all payments (optional - for admin dashboard)
app.get('/api/payments', async (req, res) => {
  try {
    const payments = await Payment.find()
      .sort({ createdAt: -1 })
      .limit(100);
    
    res.json({
      status: 'success',
      count: payments.length,
      data: payments
    });
  } catch (error) {
    console.error('❌ Error fetching payments:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch payments'
    });
  }
});

// Verify payment endpoint - MAIN ROUTE
app.post('/api/verify-payment', async (req, res) => {
  const { reference } = req.body;

  console.log('🔍 Verifying payment:', reference);
  console.log('🌐 Request origin:', req.headers.origin);
  console.log('📥 Request method:', req.method);

  if (!reference) {
    return res.status(400).json({
      status: 'error',
      message: 'Payment reference is required'
    });
  }

  try {
    // 1. Check if payment already exists in database
    const existingPayment = await Payment.findOne({ reference });
    if (existingPayment) {
      console.log('⚠️ Payment already verified:', reference);
      return res.json({
        status: 'success',
        message: 'Payment already verified',
        data: existingPayment
      });
    }

    // 2. Verify with Paystack
    console.log('📡 Calling Paystack verify endpoint...');
    const paystackResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('📦 Paystack response status:', paystackResponse.data.status);
    console.log('📦 Paystack payment status:', paystackResponse.data.data.status);

    const { data } = paystackResponse.data;

    if (data.status !== 'success') {
      return res.status(400).json({
        status: 'error',
        message: 'Payment verification failed',
        paymentStatus: data.status
      });
    }

    // 3. Extract payment details
    const amountInKobo = data.amount;
    const amountInNaira = amountInKobo / 100;
    const customerEmail = data.customer.email;
    const currency = data.currency;

    console.log('💰 Payment details:', {
      email: customerEmail,
      amountNaira: amountInNaira,
      currency: currency
    });

    // 4. Save to database
    const payment = new Payment({
      email: customerEmail,
      amount: amountInKobo,
      currency: currency,
      reference: reference,
      status: data.status,
      metadata: {
        channel: data.channel,
        cardType: data.authorization?.card_type,
        bank: data.authorization?.bank,
        transactionDate: data.transaction_date,
        paidAt: data.paid_at
      }
    });

    const savedPayment = await payment.save();
    console.log('💾 Payment saved to database:', savedPayment._id);

    // 5. Send emails
    const emailResults = await sendPaymentEmails(customerEmail, amountInKobo, reference);

    // 6. Update payment record with email status
    const emailsSent = emailResults.customerEmail.sent && emailResults.ownerEmail.sent;
    const emailError = !emailsSent ? 
      `Customer: ${emailResults.customerEmail.error || 'OK'}, Owner: ${emailResults.ownerEmail.error || 'OK'}` : 
      null;

    await Payment.findByIdAndUpdate(savedPayment._id, {
      emailSent: emailsSent,
      emailSentAt: emailsSent ? new Date() : null,
      emailError: emailError
    });

    console.log('📧 Email results:', emailResults);

    // 7. Send response
    return res.json({
      status: 'success',
      message: 'Payment verified successfully',
      data: {
        payment: savedPayment,
        emailStatus: {
          customerEmailSent: emailResults.customerEmail.sent,
          ownerEmailSent: emailResults.ownerEmail.sent,
          customerEmailId: emailResults.customerEmail.id,
          ownerEmailId: emailResults.ownerEmail.id
        }
      }
    });

  } catch (error) {
    console.error('❌ Payment verification error:', error.message);
    console.error('❌ Full error:', error);
    
    return res.status(500).json({
      status: 'error',
      message: 'Payment verification failed',
      error: error.message
    });
  }
});

// ===================================
// ERROR HANDLERS
// ===================================
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Route not found'
  });
});

app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ===================================
// START SERVER
// ===================================
const server = app.listen(PORT, () => {
  console.log('\n🚀 ================================');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🚀 ================================');
  console.log('📊 Environment:', process.env.NODE_ENV || 'development');
  console.log('📧 Resend API Key:', process.env.RESEND_API_KEY ? '✅ Configured' : '❌ Missing');
  console.log('✉️  MAIL_FROM:', MAIL_FROM);
  console.log('📮 Owner Email:', process.env.OWNER_EMAIL ? `✅ ${process.env.OWNER_EMAIL}` : '❌ Missing');
  console.log('🗄️  MongoDB URI:', process.env.MONGODB_URI ? '✅ Configured' : '❌ Missing');
  console.log('💳 Paystack Secret:', process.env.PAYSTACK_SECRET_KEY ? '✅ Configured' : '❌ Missing');
  
  if (MAIL_FROM.includes('onboarding@resend.dev')) {
    console.log('⚠️  Resend sender is set to onboarding@resend.dev.');
    console.log('⚠️  If customers are not receiving emails, verify a domain in Resend and set MAIL_FROM.');
  }
  
  console.log('🚀 ================================\n');
});

// ===================================
// GRACEFUL SHUTDOWN - FIXED
// ===================================
const gracefulExit = async () => {
  console.log('\n👋 SIGTERM signal received: closing HTTP server');
  
  server.close(() => {
    console.log('🔌 HTTP server closed');
  });

  try {
    // FIXED: Remove callback parameter - use promise instead
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error closing MongoDB connection:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulExit();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulExit();
});
