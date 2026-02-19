const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB Connection (Fixed - removed deprecated options)
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('🔗 Mongoose connected to MongoDB');
    console.log('✅ MongoDB Connected Successfully');
    console.log('📊 Database:', mongoose.connection.name);
  })
  .catch((err) => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });

// Payment Schema
const paymentSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, default: 'pending' },
  currency: { type: String, default: 'NGN' },
  metadata: { type: Object },
  paymentDate: { type: Date, default: Date.now },
  webhookReceived: { type: Boolean, default: false },
  emailSent: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Payment = mongoose.model('Payment', paymentSchema);

// Health Check Route
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'FortuneHub Backend API is running',
    timestamp: new Date().toISOString(),
    endpoints: {
      verify: '/api/payment/verify?reference=xxx',
      webhook: '/api/payment/webhook/paystack',
      health: '/health'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    resend: process.env.RESEND_API_KEY ? 'configured' : 'missing',
    paystack: process.env.PAYSTACK_SECRET_KEY ? 'configured' : 'missing'
  });
});

// Payment Verification Route
app.get('/api/payment/verify', async (req, res) => {
  try {
    const { reference } = req.query;
    
    console.log('🔍 Verifying payment:', reference);
    
    if (!reference) {
      return res.status(400).json({
        success: false,
        message: 'Payment reference is required'
      });
    }

    // Check if already verified
    const existingPayment = await Payment.findOne({ reference });
    if (existingPayment && existingPayment.status === 'success') {
      console.log('✅ Payment already verified:', reference);
      return res.status(200).json({
        success: true,
        message: 'Payment already verified',
        data: {
          reference: existingPayment.reference,
          amount: existingPayment.amount,
          email: existingPayment.email,
          status: existingPayment.status,
          paymentDate: existingPayment.paymentDate
        }
      });
    }

    // Verify payment with Paystack
    const paystackResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
      }
    );

    const paymentData = await paystackResponse.json();
    console.log('📦 Paystack response:', paymentData.status);

    if (!paymentData.status || paymentData.data.status !== 'success') {
      console.log('❌ Payment verification failed:', paymentData.message);
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed',
        error: paymentData.message
      });
    }

    // Extract customer details
    const { customer, amount, currency, metadata, paid_at } = paymentData.data;
    
    console.log('💰 Payment details:', {
      email: customer.email,
      amount: amount / 100,
      currency
    });

    // Save to database
    const payment = await Payment.findOneAndUpdate(
      { reference },
      {
        reference,
        email: customer.email,
        amount: amount / 100, // Convert from kobo to naira
        currency: currency || 'NGN',
        status: 'success',
        metadata,
        paymentDate: paid_at ? new Date(paid_at) : new Date()
      },
      { upsert: true, new: true }
    );

    console.log('💾 Payment saved to database:', payment._id);

    // Send confirmation email using Resend
    let emailSent = false;
    try {
      const emailResponse = await resend.emails.send({
        from: 'FortuneHub <onboarding@resend.dev>', // Use verified Resend domain
        to: customer.email,
        cc: process.env.OWNER_EMAIL,
        subject: '✅ Payment Successful - FortuneHub',
        html: `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <style>
                body { 
                  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                  line-height: 1.6; 
                  color: #333; 
                  margin: 0;
                  padding: 0;
                  background-color: #f4f4f4;
                }
                .container { 
                  max-width: 600px; 
                  margin: 20px auto; 
                  background-color: #ffffff;
                  border-radius: 10px;
                  overflow: hidden;
                  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                }
                .header { 
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white; 
                  padding: 40px 20px; 
                  text-align: center; 
                }
                .header h1 {
                  margin: 0;
                  font-size: 28px;
                }
                .checkmark {
                  width: 80px;
                  height: 80px;
                  border-radius: 50%;
                  display: inline-block;
                  background-color: rgba(255,255,255,0.2);
                  padding: 15px;
                  margin-bottom: 20px;
                }
                .content { 
                  padding: 40px 30px; 
                }
                .content h2 {
                  color: #667eea;
                  margin-top: 0;
                }
                .payment-details {
                  background-color: #f8f9fa;
                  border-left: 4px solid #667eea;
                  padding: 20px;
                  margin: 20px 0;
                  border-radius: 5px;
                }
                .payment-details ul {
                  list-style: none;
                  padding: 0;
                  margin: 0;
                }
                .payment-details li {
                  padding: 8px 0;
                  border-bottom: 1px solid #e0e0e0;
                }
                .payment-details li:last-child {
                  border-bottom: none;
                }
                .amount { 
                  font-size: 32px; 
                  font-weight: bold; 
                  color: #667eea;
                  display: block;
                  margin: 10px 0;
                }
                .footer { 
                  background-color: #f8f9fa;
                  text-align: center; 
                  padding: 20px; 
                  font-size: 12px; 
                  color: #666; 
                }
                .button {
                  display: inline-block;
                  padding: 12px 30px;
                  background-color: #667eea;
                  color: white;
                  text-decoration: none;
                  border-radius: 5px;
                  margin-top: 20px;
                  font-weight: bold;
                }
                .button:hover {
                  background-color: #5568d3;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <div class="checkmark">
                    <svg width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                  <h1>✅ Payment Successful!</h1>
                </div>
                
                <div class="content">
                  <h2>Thank You for Your Payment!</h2>
                  <p>Dear Customer,</p>
                  <p>Your payment has been successfully processed and confirmed. We've received your payment and your transaction is complete.</p>
                  
                  <div class="payment-details">
                    <p><strong>📋 Payment Details:</strong></p>
                    <ul>
                      <li>
                        <strong>Amount Paid:</strong> 
                        <span class="amount">₦${(amount / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</span>
                      </li>
                      <li><strong>Reference:</strong> ${reference}</li>
                      <li><strong>Email:</strong> ${customer.email}</li>
                      <li><strong>Date:</strong> ${new Date().toLocaleString('en-NG', { 
                        dateStyle: 'full', 
                        timeStyle: 'short' 
                      })}</li>
                      <li><strong>Status:</strong> <span style="color: #10b981; font-weight: bold;">CONFIRMED ✓</span></li>
                    </ul>
                  </div>

                  <p style="margin-top: 30px;">
                    <strong>What's Next?</strong><br>
                    You will receive further instructions via email shortly. Please keep this email for your records.
                  </p>

                  <p style="margin-top: 20px;">
                    If you have any questions or concerns about this transaction, please don't hesitate to contact us at 
                    <a href="mailto:${process.env.OWNER_EMAIL}" style="color: #667eea; text-decoration: none;">
                      ${process.env.OWNER_EMAIL}
                    </a>
                  </p>

                  <div style="text-align: center;">
                    <a href="https://kolapodev-a11y.github.io/Fortunehub-frontend/" class="button">
                      Visit FortuneHub
                    </a>
                  </div>
                </div>
                
                <div class="footer">
                  <p><strong>FortuneHub</strong></p>
                  <p>&copy; ${new Date().getFullYear()} FortuneHub. All rights reserved.</p>
                  <p style="margin-top: 10px; color: #999;">
                    This is an automated email. Please do not reply to this message.
                  </p>
                </div>
              </div>
            </body>
          </html>
        `,
      });

      console.log('✅ Email sent successfully:', emailResponse.id);
      emailSent = true;

      // Update payment record
      await Payment.findOneAndUpdate(
        { reference },
        { emailSent: true }
      );

    } catch (emailError) {
      console.error('❌ Email sending failed:', emailError);
      console.error('Email error details:', emailError.message);
      // Don't fail the whole transaction if email fails
    }

    // Return success response
    return res.status(200).json({
      success: true,
      message: 'Payment verified successfully',
      emailSent,
      data: {
        reference,
        amount: amount / 100,
        currency: currency || 'NGN',
        email: customer.email,
        status: 'success',
        paymentDate: paid_at || new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Payment verification error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while verifying payment',
      error: error.message
    });
  }
});

// Paystack Webhook Handler
app.post('/api/payment/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const crypto = require('crypto');
    
    // Verify webhook signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.log('❌ Invalid webhook signature');
      return res.status(401).send('Invalid signature');
    }

    const event = req.body;
    console.log('📨 Webhook received:', event.event);

    if (event.event === 'charge.success') {
      const { reference, customer, amount, currency } = event.data;
      
      // Update database
      await Payment.findOneAndUpdate(
        { reference },
        { 
          status: 'success',
          webhookReceived: true,
          email: customer.email,
          amount: amount / 100,
          currency: currency || 'NGN'
        },
        { upsert: true }
      );

      console.log(`✅ Webhook: Payment ${reference} confirmed`);
    }

    res.status(200).send('Webhook received');
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).send('Webhook processing failed');
  }
});

// Get all payments (for admin)
app.get('/api/payments', async (req, res) => {
  try {
    const payments = await Payment.find().sort({ createdAt: -1 }).limit(50);
    res.json({
      success: true,
      count: payments.length,
      data: payments
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🚀 ================================');
  console.log('📊 Environment:', process.env.NODE_ENV || 'development');
  console.log('📧 Resend API Key:', process.env.RESEND_API_KEY ? '✅ Configured' : '❌ Missing');
  console.log('📮 Owner Email:', process.env.OWNER_EMAIL ? `✅ ${process.env.OWNER_EMAIL}` : '❌ Missing');
  console.log('🗄️  MongoDB URI:', process.env.MONGODB_URI ? '✅ Configured' : '❌ Missing');
  console.log('💳 Paystack Secret:', process.env.PAYSTACK_SECRET_KEY ? '✅ Configured' : '❌ Missing');
  console.log('🚀 ================================');
  console.log('');
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM signal received: closing HTTP server');
  mongoose.connection.close(() => {
    console.log('💤 MongoDB connection closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('👋 SIGINT signal received: closing HTTP server');
  mongoose.connection.close(() => {
    console.log('💤 MongoDB connection closed');
    process.exit(0);
  });
});
