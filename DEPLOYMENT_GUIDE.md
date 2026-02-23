# 🚀 Quick Deployment Guide

## For Complete Beginners

### Step 1: Install Required Software

**Install Node.js:**
1. Go to [https://nodejs.org](https://nodejs.org)
2. Download LTS version (18.x or higher)
3. Run installer and follow prompts
4. Verify installation:
   ```bash
   node --version
   npm --version
   ```

**Install MongoDB:**

**Option A - Local Installation:**
- Windows: Download from [https://www.mongodb.com/try/download/community](https://www.mongodb.com/try/download/community)
- Mac: `brew install mongodb-community`
- Linux: Follow MongoDB docs for your distro

**Option B - Cloud (Recommended for beginners):**
1. Go to [https://www.mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas)
2. Create free account
3. Create new cluster (Free tier)
4. Get connection string (looks like: `mongodb+srv://username:password@cluster.mongodb.net/fortunehub`)

### Step 2: Setup Project

```bash
# Navigate to the project folder
cd fortunehub-backend

# Install all dependencies
npm install
```

### Step 3: Configure Environment

1. Copy `.env.example` to `.env`
2. Edit `.env` with your details:

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string_here
PAYSTACK_SECRET_KEY=your_paystack_secret_key
PAYSTACK_PUBLIC_KEY=your_paystack_public_key
RESEND_API_KEY=your_resend_api_key
FRONTEND_URL=http://localhost:3000
NODE_ENV=development
```

### Step 4: Get API Keys

**Paystack (Payment Processing):**
1. Visit [https://dashboard.paystack.com/signup](https://dashboard.paystack.com/signup)
2. Create account
3. Go to Settings → API Keys
4. Copy Test Secret Key (starts with `sk_test_`)
5. Copy Test Public Key (starts with `pk_test_`)

**Resend (Email):**
1. Visit [https://resend.com/signup](https://resend.com/signup)
2. Create account
3. Go to API Keys
4. Create new key and copy it (starts with `re_`)

### Step 5: Run the Server

**Development Mode (recommended for testing):**
```bash
npm run dev
```

**Production Mode:**
```bash
npm start
```

You should see:
```
✅ MongoDB Connected Successfully
🚀 FortuneHub Server running on port 5000
```

### Step 6: Test the API

Open browser and go to: `http://localhost:5000`

You should see welcome message!

## 🌐 Deploy to Cloud (Free Options)

### Option 1: Deploy to Render.com (Easiest)

1. **Create Render Account:**
   - Go to [https://render.com](https://render.com)
   - Sign up with GitHub

2. **Create New Web Service:**
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Or use "Deploy from Git URL"

3. **Configure Service:**
   - **Name:** fortunehub-api
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

4. **Add Environment Variables:**
   Go to "Environment" tab and add:
   - `MONGODB_URI`
   - `PAYSTACK_SECRET_KEY`
   - `PAYSTACK_PUBLIC_KEY`
   - `RESEND_API_KEY`
   - `FRONTEND_URL`
   - `NODE_ENV=production`

5. **Deploy:**
   - Click "Create Web Service"
   - Wait for build to complete
   - Your API URL: `https://your-app-name.onrender.com`

### Option 2: Deploy to Railway.app

1. **Create Railway Account:**
   - Go to [https://railway.app](https://railway.app)
   - Sign up with GitHub

2. **Deploy:**
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your repository

3. **Add Environment Variables:**
   - Click on your service
   - Go to "Variables" tab
   - Add all environment variables

4. **Get URL:**
   - Railway automatically generates URL
   - Find it in "Settings" tab

### Option 3: Deploy to Heroku

```bash
# Install Heroku CLI
# Windows: Download from https://devcenter.heroku.com/articles/heroku-cli
# Mac: brew tap heroku/brew && brew install heroku
# Linux: curl https://cli-assets.heroku.com/install.sh | sh

# Login
heroku login

# Create app
heroku create fortunehub-api

# Add MongoDB addon (or use MongoDB Atlas)
heroku addons:create mongolab:sandbox

# Set environment variables
heroku config:set PAYSTACK_SECRET_KEY=your_key
heroku config:set RESEND_API_KEY=your_key
heroku config:set FRONTEND_URL=https://your-frontend.com

# Deploy
git push heroku main

# Open app
heroku open
```

## 🧪 Testing Your API

### Using Browser:

1. **Health Check:**
   - Open: `http://localhost:5000/api/health`
   - Should see: `{"success": true, "message": "FortuneHub API is running"}`

2. **Get Products:**
   - Open: `http://localhost:5000/api/products`

### Using Postman:

1. Download [Postman](https://www.postman.com/downloads/)
2. Create new request
3. Import these examples:

**Create Product:**
```
POST http://localhost:5000/api/products
Body (form-data):
- name: iPhone 15 Pro
- description: Latest Apple flagship
- price: 500000
- category: electronics
- stock: 10
- images: [select image file]
```

**Get Products:**
```
GET http://localhost:5000/api/products?page=1&limit=10
```

## 🆘 Common Issues & Solutions

### Issue: "Cannot connect to MongoDB"
**Solution:**
- Check if MongoDB is running: `mongod --version`
- Verify MONGODB_URI in .env
- For Atlas: Check IP whitelist (allow all: 0.0.0.0/0)

### Issue: "Port already in use"
**Solution:**
- Change PORT in .env to different number (5001, 8000, etc.)
- Or kill process using port:
  - Windows: `netstat -ano | findstr :5000` then `taskkill /PID [PID] /F`
  - Mac/Linux: `lsof -ti:5000 | xargs kill`

### Issue: "Module not found"
**Solution:**
```bash
rm -rf node_modules package-lock.json
npm install
```

### Issue: Payment not working
**Solution:**
- Verify Paystack keys are correct
- Use test keys for testing (start with sk_test_ and pk_test_)
- Check Paystack dashboard for logs

## 📱 Connect to Frontend

In your React/Vue/Angular frontend:

```javascript
// Set base URL
const API_URL = 'http://localhost:5000/api';

// Example: Fetch products
fetch(`${API_URL}/products`)
  .then(res => res.json())
  .then(data => console.log(data));

// Example: Create order
fetch(`${API_URL}/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    customer: {
      name: 'John Doe',
      email: 'john@example.com',
      phone: '+2348012345678'
    },
    items: [{ productId: 'xxx', quantity: 2 }]
  })
});
```

## 🔒 Security Checklist

Before going live:

- [ ] Change all API keys to production keys
- [ ] Set NODE_ENV=production
- [ ] Enable CORS only for your frontend domain
- [ ] Use HTTPS (not HTTP)
- [ ] Add rate limiting
- [ ] Set up monitoring
- [ ] Regular backups of database
- [ ] Never commit .env file

## 📞 Need Help?

- Check the main README.md for detailed API documentation
- Review error messages in console
- Check MongoDB connection
- Verify all environment variables are set
- Test with Postman first before frontend integration

## ✅ Deployment Checklist

- [ ] All dependencies installed (`npm install`)
- [ ] MongoDB connected (local or Atlas)
- [ ] .env file configured with all keys
- [ ] Server starts without errors (`npm start`)
- [ ] Can access health endpoint
- [ ] Paystack keys configured
- [ ] Resend email configured
- [ ] Frontend URL set correctly
- [ ] Tested basic CRUD operations

---

**You're all set! 🎉** Your FortuneHub backend is ready to handle products, orders, and payments!
