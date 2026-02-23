# FortuneHub Backend API

Complete backend API for FortuneHub e-commerce platform with Paystack payment integration, product management, and order processing.

## 🚀 Features

- **Product Management**: Full CRUD operations for products with image uploads
- **Order Processing**: Complete order lifecycle management
- **Payment Integration**: Paystack payment gateway integration
- **Email Notifications**: Automated email notifications using Resend
- **File Uploads**: Image upload support with Multer
- **MongoDB Database**: Mongoose ODM for data management
- **RESTful API**: Clean and organized API endpoints
- **Error Handling**: Comprehensive error handling and validation

## 📋 Prerequisites

- Node.js >= 18.0.0
- MongoDB (local or cloud instance)
- Paystack Account (for payment processing)
- Resend Account (for email notifications)

## 🛠️ Installation

### 1. Clone and Install Dependencies

```bash
# Navigate to project directory
cd fortunehub-backend

# Install dependencies
npm install
```

### 2. Environment Configuration

Create a `.env` file in the root directory:

```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/fortunehub
PAYSTACK_SECRET_KEY=sk_test_your_secret_key_here
PAYSTACK_PUBLIC_KEY=pk_test_your_public_key_here
RESEND_API_KEY=re_your_resend_api_key_here
FRONTEND_URL=http://localhost:3000
NODE_ENV=development
```

#### Getting API Keys:

**Paystack:**
1. Sign up at [https://paystack.com](https://paystack.com)
2. Go to Settings > API Keys & Webhooks
3. Copy your Test/Live Secret and Public keys

**Resend:**
1. Sign up at [https://resend.com](https://resend.com)
2. Go to API Keys section
3. Create and copy your API key

### 3. Create Uploads Directory

```bash
mkdir uploads
```

### 4. Start MongoDB

Make sure MongoDB is running:

```bash
# If using local MongoDB
mongod

# Or if using MongoDB as a service
sudo service mongod start
```

## 🎯 Running the Application

### Development Mode (with auto-restart)

```bash
npm run dev
```

### Production Mode

```bash
npm start
```

The server will start at `http://localhost:5000`

## 📡 API Endpoints

### Products

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/products` | Get all products (with filtering, pagination) |
| GET | `/api/products/:id` | Get single product |
| POST | `/api/products` | Create new product (with image upload) |
| PUT | `/api/products/:id` | Update product |
| DELETE | `/api/products/:id` | Delete product |
| GET | `/api/products/categories/list` | Get all categories |

**Query Parameters for GET /api/products:**
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 10)
- `category`: Filter by category
- `minPrice`: Minimum price filter
- `maxPrice`: Maximum price filter
- `search`: Text search in name, description, tags
- `sort`: Sort field (default: -createdAt)
- `status`: Filter by status (active/inactive/out_of_stock)

### Orders

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/orders` | Get all orders (with pagination) |
| GET | `/api/orders/:id` | Get single order |
| POST | `/api/orders` | Create new order |
| PATCH | `/api/orders/:id/status` | Update order status |

### Payments

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payments/initialize` | Initialize Paystack payment |
| GET | `/api/payments/verify/:reference` | Verify payment |
| POST | `/api/payments/webhook` | Paystack webhook endpoint |

### Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard/stats` | Get dashboard statistics |

### Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | API health check |
| GET | `/` | API information |

## 📝 API Usage Examples

### Create Product

```bash
curl -X POST http://localhost:5000/api/products \
  -F "name=Wireless Headphones" \
  -F "description=High-quality wireless headphones" \
  -F "price=15000" \
  -F "category=electronics" \
  -F "stock=50" \
  -F "images=@/path/to/image.jpg"
```

### Get All Products

```bash
curl http://localhost:5000/api/products?page=1&limit=10&category=electronics
```

### Create Order

```bash
curl -X POST http://localhost:5000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+2348012345678",
      "address": {
        "street": "123 Main St",
        "city": "Lagos",
        "state": "Lagos",
        "country": "Nigeria"
      }
    },
    "items": [
      {
        "productId": "product_id_here",
        "quantity": 2
      }
    ],
    "shippingCost": 2000
  }'
```

### Initialize Payment

```bash
curl -X POST http://localhost:5000/api/payments/initialize \
  -H "Content-Type: application/json" \
  -d '{
    "email": "customer@example.com",
    "amount": 50000,
    "orderId": "order_id_here",
    "metadata": {
      "custom_fields": []
    }
  }'
```

## 🗂️ Project Structure

```
fortunehub-backend/
├── models/
│   ├── Product.js          # Product schema
│   ├── Order.js            # Order schema
│   └── Transaction.js      # Transaction schema
├── uploads/                # Uploaded images directory
├── server.js               # Main application file
├── package.json            # Dependencies
├── .env                    # Environment variables (create this)
├── .env.example            # Environment template
└── README.md              # Documentation
```

## 🔐 Security Notes

1. **Never commit `.env` file** - Add it to `.gitignore`
2. **Use environment variables** for all sensitive data
3. **Validate webhook signatures** from Paystack
4. **Implement rate limiting** in production
5. **Use HTTPS** in production
6. **Sanitize user inputs** to prevent injection attacks

## 🚢 Deployment

### Deploy to Heroku

```bash
# Login to Heroku
heroku login

# Create new app
heroku create fortunehub-api

# Add MongoDB addon (or use MongoDB Atlas)
heroku addons:create mongolab

# Set environment variables
heroku config:set PAYSTACK_SECRET_KEY=your_key_here
heroku config:set RESEND_API_KEY=your_key_here
heroku config:set FRONTEND_URL=https://your-frontend.com

# Deploy
git push heroku main
```

### Deploy to Render/Railway

1. Connect your GitHub repository
2. Set environment variables in dashboard
3. Deploy with automatic build detection

### Deploy to VPS (Ubuntu)

```bash
# Install Node.js and MongoDB
sudo apt update
sudo apt install nodejs npm mongodb

# Clone repository
git clone your-repo-url
cd fortunehub-backend

# Install dependencies
npm install

# Install PM2 for process management
npm install -g pm2

# Start application
pm2 start server.js --name fortunehub-api

# Setup nginx reverse proxy (optional)
```

## 🧪 Testing

```bash
# Test API health
curl http://localhost:5000/api/health

# Test product creation
curl -X POST http://localhost:5000/api/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Product",
    "description": "Test Description",
    "price": 10000,
    "category": "electronics",
    "stock": 10
  }'
```

## 📊 Database Schema

### Product Schema
- name: String (required)
- description: String (required)
- price: Number (required)
- category: String (enum)
- stock: Number
- images: Array of Strings
- featured: Boolean
- discount: Number (0-100)
- status: String (active/inactive/out_of_stock)
- ratings: Object (average, count)
- specifications: Map
- tags: Array of Strings

### Order Schema
- orderNumber: String (auto-generated)
- customer: Object (name, email, phone, address)
- items: Array of Objects
- totalAmount: Number
- paymentStatus: String
- paymentMethod: String
- paymentReference: String
- orderStatus: String
- shippingCost: Number
- statusHistory: Array

### Transaction Schema
- reference: String (unique)
- order: ObjectId (ref to Order)
- amount: Number
- currency: String
- status: String
- paymentGateway: String
- gatewayResponse: Mixed
- customerEmail: String
- paidAt: Date

## 🤝 Support

For issues and questions:
- Email: support@fortunehub.com
- GitHub Issues: [Create an issue](https://github.com/kolapodev/fortunehub-backend/issues)

## 📄 License

ISC License - see LICENSE file for details

## 👨‍💻 Author

**kolapodev**

---

Built with ❤️ using Node.js, Express, and MongoDB
