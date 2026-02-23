# 🛍️ FortuneHub Product Manager

## Complete Product Management System for FortuneHub

This package adds a professional product management system to your FortuneHub e-commerce platform with image upload capabilities directly from phone/PC gallery.

---

## 📦 What's Included

### 1. **server-enhanced.js** (13.5 KB)
   - Complete REST API for product management
   - Image upload with base64 support (works from phone!)
   - MongoDB integration
   - CRUD operations (Create, Read, Update, Delete)
   - Statistics endpoint
   - Bulk import feature
   - **DOES NOT ALTER YOUR EXISTING LOGIC**

### 2. **product-manager.html** (32 KB)
   - Professional admin interface
   - Mobile-responsive design
   - Upload 3 images per product (from gallery/camera)
   - Search and filter products
   - Real-time statistics
   - Edit and delete products
   - Modern, clean UI

### 3. **package.json**
   - Updated dependencies
   - Includes `multer` for image handling

### 4. **README.md** (This file)
   - Complete setup guide
   - API documentation
   - Troubleshooting

---

## 🚀 Quick Start

### Step 1: Install New Dependency

```bash
npm install multer
```

### Step 2: Integrate with Your Existing Server

#### Option A: Merge Code (Recommended)
1. Open your existing `server.js`
2. Copy the **Product Management Endpoints** section from `server-enhanced.js`
3. Paste it AFTER your existing endpoints
4. Add these at the top of your server.js:

```javascript
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
```

5. Add the Product Schema before your existing schemas:

```javascript
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
```

#### Option B: Use as Separate File
1. Rename your current `server.js` to `server-old.js` (backup)
2. Copy `server-enhanced.js` to `server.js`
3. Copy ALL your existing endpoints from `server-old.js` to the marked section in `server.js`

### Step 3: Upload Admin Page

1. Upload `product-manager.html` to your hosting
2. Access it at: `https://yourdomain.com/product-manager.html`
3. Update the API URL in the HTML file (line 645):

```javascript
const API_BASE_URL = 'https://fortunehub-backend.onrender.com/api';
```

### Step 4: Create Uploads Folder

On your server, create an `uploads` folder:
```bash
mkdir uploads
```

### Step 5: Import Existing Products (Optional)

If you want to import your existing products from `products.json`:

```javascript
// Use the bulk import endpoint
POST https://fortunehub-backend.onrender.com/api/products/bulk-import

Body:
{
  "products": [... your products array from products.json ...]
}
```

---

## 📱 How Image Upload Works

### From Phone Gallery:
1. Click "Add Product" button
2. Scroll to "Product Images" section
3. Click the upload area
4. Your phone gallery/camera will open
5. Select 3 images (you can take photos or choose from gallery)
6. Images are automatically converted to base64
7. Uploaded to server when you save

### From PC:
1. Click "Add Product" button
2. Click upload area
3. Browse and select 3 images
4. Preview appears instantly
5. Save to upload

**No terminal needed!** Everything works through the web interface.

---

## 🔌 API Endpoints

### Products

#### Get All Products
```
GET /api/products
Query Parameters:
  - category: Filter by category
  - tag: Filter by tag (new, sale)
  - search: Search by name/description
  - sort: Sort order (price-asc, price-desc, name)
```

#### Get Single Product
```
GET /api/products/:id
```

#### Create Product
```
POST /api/products
Body: {
  "name": "Product Name",
  "price": 5999900,
  "category": "phones",
  "description": "Product description",
  "tag": "new",
  "outOfStock": false,
  "images": ["base64_image1", "base64_image2", "base64_image3"]
}
```

#### Update Product
```
PUT /api/products/:id
Body: Same as create (all fields optional except images must be 3 if provided)
```

#### Delete Product
```
DELETE /api/products/:id
```

#### Get Statistics
```
GET /api/products/stats/summary
Returns: {
  totalProducts,
  inStock,
  outOfStock,
  sold,
  newProducts,
  onSale,
  categories,
  totalValue
}
```

#### Bulk Import
```
POST /api/products/bulk-import
Body: {
  "products": [array of products]
}
```

---

## 🎨 Features

### Admin Panel Features:
- ✅ **Add Products** - With 3 images from phone/PC
- ✅ **Edit Products** - Update details and images
- ✅ **Delete Products** - Remove with confirmation
- ✅ **Search** - Real-time search
- ✅ **Filter** - By category
- ✅ **Statistics** - Total, in stock, out of stock, on sale
- ✅ **Mobile Responsive** - Works perfectly on phone
- ✅ **Image Preview** - See before uploading
- ✅ **Professional UI** - Modern design

### Technical Features:
- ✅ **Base64 Image Upload** - Works without terminal/SSH
- ✅ **Auto Image Management** - Automatic saving/deleting
- ✅ **MongoDB Integration** - Persistent storage
- ✅ **REST API** - Clean endpoint design
- ✅ **Error Handling** - Comprehensive error messages
- ✅ **Validation** - Input validation
- ✅ **Auto ID Generation** - Sequential product IDs

---

## 🔧 Configuration

### Environment Variables (.env)
```env
MONGODB_URI=your_mongodb_connection_string
PORT=3000
NODE_ENV=production
```

### Update Frontend API URL
In `product-manager.html`, line 645:
```javascript
const API_BASE_URL = 'https://fortunehub-backend.onrender.com/api';
```

---

## 📸 Image Requirements

- **Format**: JPG, PNG, WebP, GIF
- **Size**: Max 10MB per image
- **Count**: Exactly 3 images per product
- **Upload**: From phone gallery, camera, or PC files
- **Storage**: Saved as `/uploads/product{id}.jpg`, `product{id}b.jpg`, `product{id}c.jpg`

---

## 🛡️ Security Notes

### For Production:

1. **Add Authentication** - Protect admin routes:
```javascript
const authenticateAdmin = (req, res, next) => {
  const token = req.headers.authorization;
  // Verify admin token
  if (validToken) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

app.use('/api/products', authenticateAdmin);
```

2. **Rate Limiting**:
```javascript
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);
```

3. **CORS Configuration**:
```javascript
app.use(cors({
  origin: ['https://www.fortunehub.name.ng'],
  credentials: true
}));
```

---

## 📂 File Structure

```
fortunehub-backend/
├── server.js (your enhanced server)
├── uploads/ (create this folder)
│   ├── product1.jpg
│   ├── product1b.jpg
│   ├── product1c.jpg
│   └── ...
├── package.json
├── .env
└── public/ (optional)
    └── product-manager.html
```

---

## 🔄 Migration from products.json

If you have existing products in `products.json`:

### Option 1: Bulk Import API
```bash
curl -X POST https://fortunehub-backend.onrender.com/api/products/bulk-import \
  -H "Content-Type: application/json" \
  -d @products.json
```

### Option 2: Manual Upload
1. Open product-manager.html
2. Click "Add Product" for each product
3. Fill in details and upload images
4. Save

---

## 🐛 Troubleshooting

### Issue: Images not uploading
**Solution**: Check:
- `uploads` folder exists in server root
- Folder has write permissions
- Images are under 10MB
- Exactly 3 images selected

### Issue: Products not appearing
**Solution**: Check:
- MongoDB connection successful
- API_BASE_URL correct in HTML
- CORS configured properly
- Check browser console for errors

### Issue: Cannot access admin page
**Solution**: 
- Upload HTML to your hosting
- Or serve it from your backend:
```javascript
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/product-manager.html');
});
```

### Issue: "Out of Memory" on mobile
**Solution**: 
- Reduce image size before upload
- Take photos at lower resolution
- Compress images using phone app first

---

## 📱 Mobile Usage Tips

### Best Practices:
1. **Take Photos Directly** - Use camera option when uploading
2. **Lower Resolution** - 1080p is enough (not 4K)
3. **Good Lighting** - Clear, well-lit product photos
4. **Multiple Angles** - Front, side, back views
5. **Clean Background** - Simple, uncluttered backgrounds

### Photo Tips:
- 📸 Use natural lighting
- 📐 Square framing works best
- 🎨 White/neutral backgrounds
- 📏 Show product size reference
- ✨ Clean, professional appearance

---

## 🎯 Usage Examples

### Example 1: Add New Product
1. Open admin page
2. Click "➕ Add Product"
3. Fill in details:
   - Name: "iPhone 15 Pro Max"
   - Price: 85000000 (₦850,000.00)
   - Category: phones
   - Description: "Latest flagship..."
   - Tag: new
4. Upload 3 images from gallery
5. Click "💾 Save Product"
6. Product appears immediately!

### Example 2: Edit Product
1. Find product in grid
2. Click "✏️ Edit"
3. Update details or replace images
4. Click "💾 Save Product"
5. Changes applied instantly!

### Example 3: Delete Product
1. Find product
2. Click "🗑️ Delete"
3. Confirm deletion
4. Product and images removed!

---

## 🚀 Deployment

### Render.com (Your Current Host)
1. Upload all files via GitHub or direct
2. Make sure `uploads` folder is in `.gitignore` if empty
3. Set environment variables in Render dashboard
4. Deploy!

### File Upload to Render:
- Uploads folder is **ephemeral** on Render
- Images may be lost on restart
- **Solution**: Use cloud storage (Cloudinary, AWS S3)

### Alternative: Use Cloudinary (Recommended for Production)
```javascript
// Install: npm install cloudinary
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: 'your_cloud_name',
  api_key: 'your_api_key',
  api_secret: 'your_api_secret'
});

// Upload function
async function uploadToCloudinary(base64Image) {
  const result = await cloudinary.uploader.upload(base64Image);
  return result.secure_url;
}
```

---

## 🎓 Product Structure

```javascript
{
  "id": 1,
  "name": "Product Name",
  "price": 5999900, // in kobo
  "category": "phones",
  "description": "Product description",
  "image": "/uploads/product1.jpg", // main image
  "images": [ // all 3 images
    "/uploads/product1.jpg",
    "/uploads/product1b.jpg",
    "/uploads/product1c.jpg"
  ],
  "tag": "new", // new, sale, or none
  "outOfStock": false,
  "sold": false,
  "statusIndicator": "new", // new, sale, available, outofstock
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

---

## ✅ Testing Checklist

Before going live:

- [ ] Install multer: `npm install multer`
- [ ] Create uploads folder
- [ ] Update API_BASE_URL in HTML
- [ ] Test add product with 3 images
- [ ] Test edit product
- [ ] Test delete product
- [ ] Test search functionality
- [ ] Test category filter
- [ ] Test on mobile phone
- [ ] Test image upload from phone gallery
- [ ] Check images display on frontend
- [ ] Verify MongoDB storage
- [ ] Test error handling

---

## 📞 Support

### Your Setup:
- Frontend: https://www.fortunehub.name.ng/
- Backend: https://fortunehub-backend.onrender.com
- GitHub: https://github.com/kolapodev-a11y/Fortunehub-frontend

### Common Questions:

**Q: Will this break my existing code?**
A: No! The code is designed to be added alongside your existing endpoints.

**Q: Can I upload images from my phone?**
A: Yes! Click upload area → phone gallery/camera opens → select 3 images → done!

**Q: Do I need terminal access?**
A: No! Everything works through the web interface. Just install multer once.

**Q: What about existing products?**
A: Use the bulk import endpoint to migrate from products.json

**Q: Images lost after server restart?**
A: Render's filesystem is ephemeral. Use Cloudinary for permanent storage (see deployment section).

---

## 🎉 You're Ready!

Your FortuneHub now has:
- ✅ Professional product management
- ✅ Image upload from phone/PC
- ✅ Complete CRUD operations
- ✅ Beautiful admin interface
- ✅ Mobile-responsive design
- ✅ No terminal needed

**Start managing your products now!** 🚀

---

Made with ❤️ for FortuneHub
Version: 1.0.0
Date: February 20, 2026
