# 📱 MOBILE QUICK START GUIDE

## For Users Without Terminal Access

Since you're using a mobile phone and don't have terminal access, follow these steps:

---

## ⚡ SUPER QUICK INTEGRATION (5 Minutes)

### Step 1: Add ONE Line to package.json

In your existing `package.json`, find the `dependencies` section and add this line:

```json
"multer": "^1.4.5-lts.1"
```

So it looks like:
```json
"dependencies": {
  "express": "^4.18.2",
  "mongoose": "^8.0.0",
  "cors": "^2.8.5",
  "dotenv": "^16.3.1",
  "resend": "^3.0.0",
  "multer": "^1.4.5-lts.1"
}
```

Then commit and push to GitHub. Render will auto-install it!

### Step 2: Copy Code to Your server.js

1. Open your existing `server.js`
2. Scroll to the **VERY BOTTOM** (after all your existing code)
3. Add these lines BEFORE the `app.listen()` section:

```javascript
// ============= PRODUCT MANAGEMENT (ADD THIS) =============
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Uploads folder
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
  statusIndicator: { type: String, default: 'available' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);

// Helper function
function saveBase64Image(base64String, filename) {
  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  const filepath = path.join(uploadsDir, filename);
  fs.writeFileSync(filepath, buffer);
  return `/uploads/${filename}`;
}

// Get all products
app.get('/api/products', async (req, res) => {
  try {
    const { category, search } = req.query;
    let query = {};
    if (category && category !== 'all') query.category = category;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }
    const products = await Product.find(query).sort({ createdAt: -1 });
    res.json({ success: true, data: products, count: products.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get single product
app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findOne({ id: parseInt(req.params.id) });
    if (!product) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: product });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create product
app.post('/api/products', async (req, res) => {
  try {
    const { name, price, category, description, tag, outOfStock, images } = req.body;
    
    if (!name || !price || !category || !description) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    if (!images || images.length !== 3) {
      return res.status(400).json({ success: false, message: '3 images required' });
    }
    
    const lastProduct = await Product.findOne().sort({ id: -1 });
    const newId = lastProduct ? lastProduct.id + 1 : 1;
    
    const imagePaths = [];
    for (let i = 0; i < 3; i++) {
      const suffix = i === 0 ? '' : String.fromCharCode(98 + i - 1);
      const filename = `product${newId}${suffix}.jpg`;
      const imagePath = saveBase64Image(images[i], filename);
      imagePaths.push(imagePath);
    }
    
    let statusIndicator = 'available';
    if (tag === 'new') statusIndicator = 'new';
    else if (tag === 'sale') statusIndicator = 'sale';
    else if (outOfStock) statusIndicator = 'outofstock';
    
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
    res.status(201).json({ success: true, message: 'Product created', data: product });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update product
app.put('/api/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const { name, price, category, description, tag, outOfStock, sold, images } = req.body;
    
    const product = await Product.findOne({ id: productId });
    if (!product) return res.status(404).json({ success: false, message: 'Not found' });
    
    if (name) product.name = name;
    if (price) product.price = parseInt(price);
    if (category) product.category = category;
    if (description) product.description = description;
    if (tag !== undefined) product.tag = tag;
    if (outOfStock !== undefined) product.outOfStock = outOfStock;
    if (sold !== undefined) product.sold = sold;
    
    if (images && images.length === 3) {
      product.images.forEach(imagePath => {
        const filename = path.basename(imagePath);
        const filepath = path.join(uploadsDir, filename);
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      });
      
      const imagePaths = [];
      for (let i = 0; i < 3; i++) {
        const suffix = i === 0 ? '' : String.fromCharCode(98 + i - 1);
        const filename = `product${productId}${suffix}.jpg`;
        const imagePath = saveBase64Image(images[i], filename);
        imagePaths.push(imagePath);
      }
      
      product.image = imagePaths[0];
      product.images = imagePaths;
    }
    
    if (product.tag === 'new') product.statusIndicator = 'new';
    else if (product.tag === 'sale') product.statusIndicator = 'sale';
    else if (product.outOfStock) product.statusIndicator = 'outofstock';
    else product.statusIndicator = 'available';
    
    product.updatedAt = Date.now();
    await product.save();
    
    res.json({ success: true, message: 'Product updated', data: product });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete product
app.delete('/api/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const product = await Product.findOne({ id: productId });
    
    if (!product) return res.status(404).json({ success: false, message: 'Not found' });
    
    product.images.forEach(imagePath => {
      const filename = path.basename(imagePath);
      const filepath = path.join(uploadsDir, filename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    });
    
    await Product.deleteOne({ id: productId });
    res.json({ success: true, message: 'Product deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get statistics
app.get('/api/products/stats/summary', async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments();
    const inStock = await Product.countDocuments({ outOfStock: false });
    const outOfStock = await Product.countDocuments({ outOfStock: true });
    const sold = await Product.countDocuments({ sold: true });
    const onSale = await Product.countDocuments({ tag: 'sale' });
    const newProducts = await Product.countDocuments({ tag: 'new' });
    
    res.json({
      success: true,
      data: { totalProducts, inStock, outOfStock, sold, onSale, newProducts }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// ============= END PRODUCT MANAGEMENT =============
```

### Step 3: Upload Admin Page

1. Open your GitHub repo
2. Go to your frontend folder
3. Create new file: `product-manager.html`
4. Copy and paste the entire content from the `product-manager.html` file
5. Commit and push

### Step 4: Update API URL

In the `product-manager.html` you just uploaded, find line 645 and change:

```javascript
const API_BASE_URL = 'https://fortunehub-backend.onrender.com/api';
```

Make sure it matches your backend URL!

### Step 5: Access Admin Panel

Open in browser:
```
https://www.fortunehub.name.ng/product-manager.html
```

---

## ✅ That's It!

You now have:
- ✅ Product management system
- ✅ Image upload from phone gallery
- ✅ Professional admin interface
- ✅ All without terminal access!

---

## 📸 How to Add Products (From Your Phone)

1. Open: https://www.fortunehub.name.ng/product-manager.html
2. Click "➕ Add Product"
3. Fill in:
   - Product name
   - Price (in kobo, e.g., 5999900 = ₦59,999.00)
   - Category
   - Description
   - Tag (new/sale/none)
4. Click "📸 Click to upload"
5. **Your phone camera/gallery opens!**
6. Take/select 3 photos
7. Preview appears
8. Click "💾 Save Product"
9. Done! Product is live on your site!

---

## 🎯 Price Examples

Since price is in kobo (100 kobo = 1 Naira):

- ₦599.99 = `59999` (in kobo)
- ₦5,999.00 = `599900`
- ₦59,999.00 = `5999900`
- ₦599,999.00 = `59999900`

**Formula**: Price in Naira × 100 = Price in kobo

---

## 🔍 Troubleshooting

### Can't see admin page?
- Make sure you uploaded `product-manager.html` to your frontend repo
- Access it directly: `https://www.fortunehub.name.ng/product-manager.html`
- Check file is in the right folder

### Images not uploading?
- Make sure multer is in package.json
- Check you selected exactly 3 images
- Each image should be under 10MB
- Try lower resolution photos

### Products not appearing?
- Check API_BASE_URL is correct in HTML
- Open browser console (F12) to see errors
- Make sure backend is running

---

## 💡 Pro Tips

### Taking Good Product Photos:
1. **Natural Light** - Photo near window
2. **Clean Background** - White or plain surface
3. **Multiple Angles** - Front, side, detail
4. **Clear Focus** - Tap to focus on product
5. **Fill Frame** - Product should be main subject

### Best Practices:
- Take photos at **1080p** (not 4K) for faster upload
- Use **portrait mode** for blur effect
- **Clean products** before photographing
- **Consistent style** across all products
- **Test on mobile** before going live

---

## 🚀 Quick Commands (Via GitHub)

All changes via GitHub web interface:

### 1. Edit package.json:
- Open file in GitHub
- Click pencil icon (edit)
- Add multer line
- Commit changes

### 2. Edit server.js:
- Open file in GitHub
- Click pencil icon
- Scroll to bottom
- Paste product code
- Commit changes

### 3. Add admin page:
- Click "Add file" → "Create new file"
- Name: `product-manager.html`
- Paste HTML content
- Commit changes

### 4. Deploy:
- Render auto-deploys from GitHub
- Wait 2-3 minutes
- Test admin page!

---

## ✨ What You Get

### Admin Interface:
- **Dashboard** with statistics
- **Search** products
- **Filter** by category
- **Add** new products with images
- **Edit** existing products
- **Delete** products
- **Mobile responsive**

### API Features:
- Full CRUD operations
- Image upload and storage
- Auto ID generation
- Statistics endpoint
- Search and filter
- Error handling

---

## 🎉 Success!

You can now:
- ✅ Add products from your phone
- ✅ Upload photos from gallery/camera
- ✅ Manage all products
- ✅ No terminal needed
- ✅ Professional interface
- ✅ Works on mobile

**Start adding your products now!** 📱🎨

---

Need help? Check the main README.md for detailed docs!

Made with ❤️ for mobile entrepreneurs
