const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();

// ===================================================
// 0) ENV + BASIC VALIDATION
// ===================================================
const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OWNER_EMAIL = process.env.OWNER_EMAIL;

// IMPORTANT:
// If you use the default `onboarding@resend.dev` sender without verifying a domain,
// Resend may restrict delivery (e.g., only allow sending to your own verified email).
// To send to any customer email, set MAIL_FROM to a verified sender like:
//   MAIL_FROM="FortuneHub <no-reply@yourdomain.com>"
const MAIL_FROM = process.env.MAIL_FROM || 'FortuneHub <onboarding@resend.dev>';

// Initialize Resend (safe even if key is missing; sending will fail with a clear message)
const resend = new Resend(RESEND_API_KEY || '');

// ===================================================
// 1) CORS
// ===================================================
const corsOptions = {
  origin: [
    'https://kolapodev-a11y.github.io',
    'http://localhost:3000',
    'http://localhost:5000',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Paystack-Signature'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.set('trust proxy', 1);

// ===================================================
// 2) PAYMENTS MODEL
// ===================================================
const paymentSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  amount: { type: Number, required: true }, // stored in NAIRA (not kobo)
  status: { type: String, default: 'pending' },
  currency: { type: String, default: 'NGN' },
  metadata: { type: Object },
  paymentDate: { type: Date, default: Date.now },
  webhookReceived: { type: Boolean, default: false },
  emailSent: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Payment = mongoose.model('Payment', paymentSchema);

// ===================================================
// 3) WEBHOOK (MUST BE BEFORE express.json())
//    - Paystack signature verification requires the RAW body bytes.
//    - If express.json() runs first, signature verification will fail.
// ===================================================
app.post(
  '/api/payment/webhook/paystack',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        console.error('❌ PAYSTACK_SECRET_KEY is missing (webhook cannot be verified)');
        return res.status(500).send('Server misconfigured');
      }

      const signature = req.headers['x-paystack-signature'];
      const rawBody = req.body; // Buffer

      const computedHash = crypto
        .createHmac('sha512', PAYSTACK_SECRET_KEY)
        .update(rawBody)
        .digest('hex');

      if (!signature || computedHash !== signature) {
        console.log('❌ Invalid Paystack webhook signature');
        return res.status(401).send('Invalid signature');
      }

      const event = JSON.parse(rawBody.toString('utf8'));
      console.log('📨 Paystack webhook received:', event.event);

      if (event.event === 'charge.success') {
        const { reference, customer, amount, currency, paid_at, metadata } = event.data;
        const email = customer?.email;
        const amountNaira = amount / 100;

        const updated = await Payment.findOneAndUpdate(
          { reference },
          {
            reference,
            email,
            amount: amountNaira,
            currency: currency || 'NGN',
            status: 'success',
            metadata,
            paymentDate: paid_at ? new Date(paid_at) : new Date(),
            webhookReceived: true
          },
          { upsert: true, new: true }
        );

        console.log(`✅ Webhook: Payment ${reference} confirmed (saved: ${updated._id})`);

        // OPTIONAL but recommended:
        // Send email here too, so customers still get emails even if the frontend
        // never calls /api/payment/verify (e.g., user closes the Paystack popup).
        if (!updated.emailSent) {
          try {
            const emailResp = await sendPaymentEmail({
              toEmail: email,
              reference,
              amountNaira,
              currency: currency || 'NGN',
              paidAt: paid_at ? new Date(paid_at) : new Date()
            });

            await Payment.findOneAndUpdate({ reference }, { emailSent: true });
            console.log('✅ Webhook email sent:', emailResp?.id || '(no id)');
          } catch (e) {
            console.error('❌ Webhook email failed:', e?.message || e);
            // do not fail webhook
          }
        }
      }

      return res.status(200).send('Webhook received');
    } catch (error) {
      console.error('❌ Webhook error:', error);
      return res.status(500).send('Webhook processing failed');
    }
  }
);

// ===================================================
// 4) BODY PARSERS (AFTER WEBHOOK)
// ===================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===================================================
// 5) MONGODB CONNECTION (WITH RETRY)
// ===================================================
let connecting = false;
async function connectMongo() {
  if (connecting) return;
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI is missing');
    process.exit(1);
  }

  connecting = true;
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10
    });

    console.log('🔗 Mongoose connected to MongoDB');
    console.log('✅ MongoDB Connected Successfully');
    console.log('📊 Database:', mongoose.connection.name);
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    console.log('⏳ Retrying MongoDB connection in 5s...');
    setTimeout(() => {
      connecting = false;
      connectMongo();
    }, 5000);
    return;
  }
  connecting = false;
}

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected. Attempting to reconnect...');
  connectMongo();
});

mongoose.connection.on('error', (err) => {
  console.log('⚠️ MongoDB runtime error:', err?.message || err);
});

connectMongo();

// ===================================================
// 6) ROUTES
// ===================================================
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'FortuneHub Backend API is running',
    timestamp: new Date().toISOString(),
    endpoints: {
      verify: '/api/payment/verify?reference=xxx',
      webhook: '/api/payment/webhook/paystack',
      payments: '/api/payments',
      health: '/health'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    resend: RESEND_API_KEY ? 'configured' : 'missing',
    mailFrom: MAIL_FROM,
    paystack: PAYSTACK_SECRET_KEY ? 'configured' : 'missing'
  });
});

// Handles both GET + POST
app.get('/api/payment/verify', async (req, res) => handlePaymentVerification(req, res));
app.post('/api/payment/verify', async (req, res) => handlePaymentVerification(req, res));

async function handlePaymentVerification(req, res) {
  try {
    const reference = req.query.reference || req.body?.reference;

    console.log('🔍 Verifying payment:', reference);
    console.log('🌐 Request origin:', req.headers.origin);
    console.log('📥 Request method:', req.method);

    if (!reference) {
      return res.status(400).json({ success: false, message: 'Payment reference is required' });
    }

    // If payment is already success, do NOT exit early unless email was sent.
    // This fixes the "first email failed, and now it never retries" problem.
    const existingPayment = await Payment.findOne({ reference });
    if (existingPayment && existingPayment.status === 'success') {
      if (existingPayment.emailSent) {
        console.log('✅ Payment already verified and email already sent:', reference);
        return res.status(200).json({
          success: true,
          message: 'Payment already verified',
          emailSent: true,
          data: {
            reference: existingPayment.reference,
            amount: existingPayment.amount,
            email: existingPayment.email,
            status: existingPayment.status,
            paymentDate: existingPayment.paymentDate
          }
        });
      }

      // Try sending email again (no need to call Paystack again)
      let resent = false;
      try {
        const emailResp = await sendPaymentEmail({
          toEmail: existingPayment.email,
          reference: existingPayment.reference,
          amountNaira: existingPayment.amount,
          currency: existingPayment.currency || 'NGN',
          paidAt: existingPayment.paymentDate || new Date()
        });
        await Payment.findOneAndUpdate({ reference }, { emailSent: true });
        console.log('✅ Email re-sent successfully:', emailResp?.id || '(no id)');
        resent = true;
      } catch (e) {
        console.error('❌ Email re-send failed:', e?.message || e);
      }

      return res.status(200).json({
        success: true,
        message: resent
          ? 'Payment verified and email was sent successfully'
          : 'Payment verified but email is still not sent (check backend logs / Resend settings)',
        emailSent: resent,
        data: {
          reference: existingPayment.reference,
          amount: existingPayment.amount,
          currency: existingPayment.currency || 'NGN',
          email: existingPayment.email,
          status: existingPayment.status,
          paymentDate: existingPayment.paymentDate
        }
      });
    }

    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Server misconfigured: PAYSTACK_SECRET_KEY is missing'
      });
    }

    console.log('📡 Calling Paystack verify endpoint...');

    const paystackResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!paystackResponse.ok) {
      console.error('❌ Paystack API error:', paystackResponse.status, paystackResponse.statusText);
      return res.status(400).json({
        success: false,
        message: 'Failed to verify payment with Paystack',
        error: `API returned ${paystackResponse.status}`
      });
    }

    const paymentData = await paystackResponse.json();
    console.log('📦 Paystack response status:', paymentData.status);
    console.log('📦 Paystack payment status:', paymentData.data?.status);

    if (!paymentData.status || paymentData.data.status !== 'success') {
      console.log('❌ Payment verification failed:', paymentData.message);
      return res.status(400).json({
        success: false,
        message: paymentData.message || 'Payment verification failed',
        error: paymentData.message
      });
    }

    const { customer, amount, currency, metadata, paid_at } = paymentData.data;
    const customerEmail = customer?.email;
    const amountNaira = amount / 100;

    console.log('💰 Payment details:', {
      email: customerEmail,
      amountNaira,
      currency
    });

    const payment = await Payment.findOneAndUpdate(
      { reference },
      {
        reference,
        email: customerEmail,
        amount: amountNaira,
        currency: currency || 'NGN',
        status: 'success',
        metadata,
        paymentDate: paid_at ? new Date(paid_at) : new Date()
      },
      { upsert: true, new: true }
    );

    console.log('💾 Payment saved to database:', payment._id);

    // Send confirmation email
    let emailSent = false;
    try {
      const emailResp = await sendPaymentEmail({
        toEmail: customerEmail,
        reference,
        amountNaira,
        currency: currency || 'NGN',
        paidAt: paid_at ? new Date(paid_at) : new Date()
      });

      console.log('✅ Email sent successfully:', emailResp?.id || '(no id)');
      emailSent = true;
      await Payment.findOneAndUpdate({ reference }, { emailSent: true });
    } catch (e) {
      console.error('❌ Email sending failed:', e);
      console.error('Email error details:', e?.message || e);
      // Do not fail the payment verification if email fails
    }

    return res.status(200).json({
      success: true,
      message: emailSent
        ? 'Payment verified and email sent successfully'
        : 'Payment verified successfully (email not sent — check Resend configuration)',
      emailSent,
      data: {
        reference,
        amount: amountNaira,
        currency: currency || 'NGN',
        email: customerEmail,
        status: 'success',
        paymentDate: paid_at || new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Payment verification error:', error);
    console.error('Error stack:', error.stack);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while verifying payment',
      error: error.message
    });
  }
}

// Admin: list last 50 payments
app.get('/api/payments', async (req, res) => {
  try {
    const payments = await Payment.find().sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, count: payments.length, data: payments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===================================================
// 7) EMAIL SENDER (SHARED)
// ===================================================
async function sendPaymentEmail({ toEmail, reference, amountNaira, currency, paidAt }) {
  if (!toEmail) throw new Error('Missing customer email');
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is missing (cannot send email)');
  }

  const amountFormatted = Number(amountNaira || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  // If OWNER_EMAIL missing, we just skip CC.
  const cc = OWNER_EMAIL ? [OWNER_EMAIL] : undefined;

  // NOTE: if you keep MAIL_FROM as onboarding@resend.dev without verifying a domain,
  // Resend may NOT deliver emails to random recipients.
  return resend.emails.send({
    from: MAIL_FROM,
    to: [toEmail],
    cc,
    subject: '✅ Payment Successful - FortuneHub',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #222; margin:0; background:#f4f4f4; }
            .wrap { max-width: 620px; margin: 24px auto; background:#fff; border-radius: 10px; overflow:hidden; box-shadow: 0 4px 14px rgba(0,0,0,0.08); }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color:#fff; padding: 28px 20px; text-align:center; }
            .header h1 { margin: 0; font-size: 22px; }
            .content { padding: 22px 22px 6px; }
            .box { background:#f8f9fa; border-left: 4px solid #667eea; padding: 14px 14px; border-radius: 6px; }
            .row { margin: 6px 0; }
            .label { color:#555; font-weight: 700; }
            .amount { font-size: 26px; font-weight: 800; color:#667eea; }
            .footer { padding: 14px 20px; background:#f8f9fa; text-align:center; color:#666; font-size: 12px; }
            a { color:#667eea; }
          </style>
        </head>
        <body>
          <div class="wrap">
            <div class="header">
              <h1>Payment Successful</h1>
              <div style="margin-top:8px; opacity:0.9;">Thank you for shopping with FortuneHub</div>
            </div>
            <div class="content">
              <p>Hi,</p>
              <p>Your payment has been confirmed.</p>
              <div class="box">
                <div class="row"><span class="label">Amount:</span> <span class="amount">₦${amountFormatted}</span></div>
                <div class="row"><span class="label">Reference:</span> ${reference}</div>
                <div class="row"><span class="label">Currency:</span> ${currency || 'NGN'}</div>
                <div class="row"><span class="label">Date:</span> ${new Date(paidAt || Date.now()).toLocaleString('en-NG')}</div>
                <div class="row"><span class="label">Status:</span> CONFIRMED</div>
              </div>
              <p style="margin-top:18px;">If you have any issue, contact us at: ${OWNER_EMAIL ? `<a href="mailto:${OWNER_EMAIL}">${OWNER_EMAIL}</a>` : 'support'}.</p>
            </div>
            <div class="footer">
              FortuneHub • ${new Date().getFullYear()}
            </div>
          </div>
        </body>
      </html>
    `
  });
}

// ===================================================
// 8) START SERVER
// ===================================================
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🚀 ================================');
  console.log('📊 Environment:', process.env.NODE_ENV || 'development');
  console.log('📧 Resend API Key:', RESEND_API_KEY ? '✅ Configured' : '❌ Missing');
  console.log('✉️  MAIL_FROM:', MAIL_FROM);
  console.log('📮 Owner Email:', OWNER_EMAIL ? `✅ ${OWNER_EMAIL}` : '❌ Missing');
  console.log('🗄️  MongoDB URI:', MONGODB_URI ? '✅ Configured' : '❌ Missing');
  console.log('💳 Paystack Secret:', PAYSTACK_SECRET_KEY ? '✅ Configured' : '❌ Missing');

  if (MAIL_FROM.includes('@resend.dev') && !process.env.MAIL_FROM) {
    console.log('⚠️  Resend sender is set to onboarding@resend.dev.');
    console.log('⚠️  If customers are not receiving emails, verify a domain in Resend and set MAIL_FROM.');
  }

  console.log('🚀 ================================');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT', () => gracefulExit('SIGINT'));

function gracefulExit(signal) {
  console.log(`👋 ${signal} signal received: closing HTTP server`);
  mongoose.connection.close(() => {
    console.log('💤 MongoDB connection closed');
    process.exit(0);
  });
}
