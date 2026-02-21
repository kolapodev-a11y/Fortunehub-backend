const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage for transactions (replace with database in production)
let transactions = [];

// PayPal Configuration
const PAYPAL_API = process.env.PAYPAL_MODE === 'live' 
    ? 'https://api-m.paypal.com' 
    : 'https://api-m.sandbox.paypal.com';

// Get PayPal access token
async function getPayPalAccessToken() {
    try {
        const auth = Buffer.from(
            `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
        ).toString('base64');

        const response = await axios.post(
            `${PAYPAL_API}/v1/oauth2/token`,
            'grant_type=client_credentials',
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        return response.data.access_token;
    } catch (error) {
        console.error('Error getting PayPal access token:', error.response?.data || error.message);
        throw error;
    }
}

// Create PayPal order
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount, currency = 'USD', description = 'Payment' } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        const accessToken = await getPayPalAccessToken();

        const orderData = {
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: currency,
                    value: amount.toFixed(2)
                },
                description: description
            }],
            application_context: {
                return_url: `${process.env.BASE_URL}/success`,
                cancel_url: `${process.env.BASE_URL}/cancel`,
                brand_name: process.env.BRAND_NAME || 'Your Business',
                user_action: 'PAY_NOW'
            }
        };

        const response = await axios.post(
            `${PAYPAL_API}/v2/checkout/orders`,
            orderData,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Store transaction
        transactions.push({
            id: response.data.id,
            amount: amount,
            currency: currency,
            status: 'CREATED',
            description: description,
            createdAt: new Date().toISOString()
        });

        res.json({ 
            orderId: response.data.id,
            links: response.data.links 
        });
    } catch (error) {
        console.error('Error creating order:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to create order',
            details: error.response?.data || error.message 
        });
    }
});

// Capture PayPal order
app.post('/api/capture-order', async (req, res) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: 'Order ID is required' });
        }

        const accessToken = await getPayPalAccessToken();

        const response = await axios.post(
            `${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`,
            {},
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Update transaction status
        const transaction = transactions.find(t => t.id === orderId);
        if (transaction) {
            transaction.status = 'COMPLETED';
            transaction.capturedAt = new Date().toISOString();
            transaction.payerEmail = response.data.payer?.email_address;
            transaction.payerName = response.data.payer?.name?.given_name + ' ' + response.data.payer?.name?.surname;
        }

        res.json({ 
            success: true,
            orderId: orderId,
            status: response.data.status,
            details: response.data
        });
    } catch (error) {
        console.error('Error capturing order:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to capture order',
            details: error.response?.data || error.message 
        });
    }
});

// Get all transactions (Admin)
app.get('/api/admin/transactions', async (req, res) => {
    try {
        const { password } = req.query;

        // Simple password check (use proper authentication in production)
        if (password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        res.json({ 
            transactions: transactions.sort((a, b) => 
                new Date(b.createdAt) - new Date(a.createdAt)
            ),
            total: transactions.length,
            totalAmount: transactions
                .filter(t => t.status === 'COMPLETED')
                .reduce((sum, t) => sum + parseFloat(t.amount), 0)
        });
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

// **NEW: Delete a single transaction by ID**
app.delete('/api/admin/transactions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;

        // Verify admin password
        if (password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'Unauthorized - Invalid password' });
        }

        // Find and delete the transaction
        const transactionIndex = transactions.findIndex(t => t.id === id);
        if (transactionIndex === -1) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        const deletedTransaction = transactions[transactionIndex];
        transactions.splice(transactionIndex, 1);

        console.log(`Transaction deleted: ${id} by admin`);
        
        res.json({ 
            success: true, 
            message: 'Transaction deleted successfully',
            deletedTransaction: {
                id: deletedTransaction.id,
                amount: deletedTransaction.amount,
                status: deletedTransaction.status
            }
        });
    } catch (error) {
        console.error('Error deleting transaction:', error);
        res.status(500).json({ error: 'Failed to delete transaction' });
    }
});

// **NEW: Clear all transactions (for test mode)**
app.post('/api/admin/transactions/clear', async (req, res) => {
    try {
        const { password, confirmText } = req.body;

        // Verify admin password
        if (password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'Unauthorized - Invalid password' });
        }

        // Extra confirmation check
        if (confirmText !== 'DELETE ALL') {
            return res.status(400).json({ error: 'Invalid confirmation text. Please type "DELETE ALL"' });
        }

        const deletedCount = transactions.length;
        const totalAmount = transactions
            .filter(t => t.status === 'COMPLETED')
            .reduce((sum, t) => sum + parseFloat(t.amount), 0);

        transactions.length = 0; // Clear all transactions
        
        console.log(`All transactions cleared: ${deletedCount} transactions deleted by admin`);
        
        res.json({ 
            success: true, 
            message: `Successfully cleared ${deletedCount} transactions (Total: $${totalAmount.toFixed(2)})`,
            deletedCount,
            totalAmount
        });
    } catch (error) {
        console.error('Error clearing transactions:', error);
        res.status(500).json({ error: 'Failed to clear transactions' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        mode: process.env.PAYPAL_MODE || 'sandbox',
        timestamp: new Date().toISOString() 
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`PayPal Mode: ${process.env.PAYPAL_MODE || 'sandbox'}`);
    console.log(`Admin Panel: http://localhost:${PORT}/admin.html`);
});

module.exports = app;
