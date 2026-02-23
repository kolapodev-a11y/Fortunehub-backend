# 🎯 QUICK START GUIDE - FortuneHub Product Management

## What You Received:

✅ **Updated Backend** (`server.js`) - with product upload API  
✅ **Admin Dashboard** (`admin-products.html`) - manage products from phone/PC  
✅ **Frontend Integration** (`frontend-integration.js`) - display products on website  
✅ **Example Shop Page** (`example-shop-page.html`) - see how it works  
✅ **Complete Documentation** - everything explained

---

## 🚀 3-Step Setup (Mobile Friendly)

### STEP 1: Upload to GitHub (5 minutes)
1. Go to **github.com** on your phone browser
2. Create new repository: `fortunehub-backend`
3. Upload these files:
   - `server.js`
   - `package.json`
   - `admin-products.html`
   - `.env.example` (rename to `.env` and add your secrets)

### STEP 2: Deploy to Render.com (5 minutes)
1. Go to **render.com**
2. Sign in with GitHub
3. New → Web Service
4. Select your repository
5. Add environment variables:
   - `MONGODB_URI`: Your MongoDB connection string
   - `PORT`: 5000
6. Click Deploy
7. Wait 3-5 minutes

### STEP 3: Update Admin Dashboard (2 minutes)
1. Copy your Render URL (e.g., `https://fortunehub-xyz.onrender.com`)
2. Open `admin-products.html`
3. Find line 713: `const API_URL = 'http://localhost:5000/api';`
4. Change to: `const API_URL = 'https://fortunehub-xyz.onrender.com/api';`
5. Save and re-upload to GitHub
6. Render auto-deploys

---

## 📱 Using Admin Dashboard

### Access:
```
https://your-render-url.com/admin-products.html
```

### Add Product:
1. Click "➕ Add Product"
2. Fill form (all fields marked with *)
3. **Price Format**: Enter in KOBO
   - ₦1,000 = 100000 (add two zeros)
   - ₦599,990 = 59999000
4. Click upload area
5. Select photos from phone/PC gallery
6. Upload 1-5 images
7. Click "Add Product"

### Edit/Delete:
- Click "✏️ Edit" on any product
- Click "🗑️ Delete" to remove

---

## 🔧 Integrating with Your Website

### Option A: Copy-Paste Integration
Copy this to your existing website's JavaScript:

```javascript
// 1. Update API URL
const API_URL = 'https://your-render-url.com/api';

// 2. Load products
fetch(`${API_URL}/products`)
  .then(res => res.json())
  .then(products => {
    // Display products in your UI
    products.forEach(product => {
      console.log(product.name, product.price, product.image);
    });
  });
```

### Option B: Use Example File
- Open `example-shop-page.html`
- Copy the structure to your website
- Update `API_URL` in `frontend-integration.js`

---

## 📊 API Endpoints You Can Use

### Get All Products:
```javascript
GET https://your-url.com/api/products
```

### Filter by Category:
```javascript
GET https://your-url.com/api/products?category=phones
```

### Search Products:
```javascript
GET https://your-url.com/api/products?search=iphone
```

### Get Single Product:
```javascript
GET https://your-url.com/api/products/{product_id}
```

---

## 💡 Important Notes

### Price Format:
- **Always use KOBO** (1 Naira = 100 kobo)
- Backend stores in kobo
- Frontend divides by 100 to display Naira
- Example: 59999000 kobo = ₦599,990.00

### Images:
- Max 5 images per product
- Max 5MB per image
- Formats: JPG, PNG, GIF, WEBP
- Uploaded from phone gallery or PC

### Categories Available:
- Phones
- Accessories
- Laptops
- Tablets
- Wearables
- Audio
- Other

### Tags Available:
- New (blue badge)
- Sale (red badge)
- Featured (orange badge)
- None

---

## 🆘 Troubleshooting

### "Cannot load products"
- Check API_URL in admin-products.html
- Verify backend is deployed and running
- Check browser console (F12) for errors

### "Images not uploading"
- Max 5MB per image
- Check file format (JPG, PNG, GIF, WEBP)
- Try uploading one image first

### "Products not showing on my website"
- Update API_URL in your frontend code
- Add fetch code to your JavaScript
- Check network tab in browser (F12)

---

## 📁 File Structure

```
fortunehub-backend/
├── server.js                    # Backend API (deploy this)
├── package.json                 # Dependencies
├── .env                         # Your secrets (create this)
├── admin-products.html          # Product management (deploy this)
├── frontend-integration.js      # Use in your website
├── example-shop-page.html       # Example integration
├── README.md                    # Full documentation
├── DEPLOYMENT.md               # Detailed deployment guide
└── uploads/                     # Images folder (auto-created)
```

---

## ✅ Checklist

- [ ] Uploaded files to GitHub
- [ ] Created MongoDB Atlas database
- [ ] Deployed to Render.com
- [ ] Added environment variables
- [ ] Updated API_URL in admin-products.html
- [ ] Tested adding a product
- [ ] Integrated with main website
- [ ] Tested product display on frontend

---

## 🔐 Security (Recommended)

Add password protection to admin dashboard:

1. Add to `.env`:
```
ADMIN_PASSWORD=your_secure_password
```

2. In admin dashboard, add to all fetch requests:
```javascript
headers: {
  'Authorization': 'Bearer your_secure_password'
}
```

---

## 📞 Need Help?

1. Check full `README.md` for detailed docs
2. Read `DEPLOYMENT.md` for deployment help
3. Check browser console for errors (F12)
4. Verify all environment variables are set

---

## 🎉 You're All Set!

Your admin dashboard is ready to:
- ✅ Upload products with images from phone/PC
- ✅ Edit and delete products
- ✅ Manage inventory (stock status)
- ✅ Categorize and tag products
- ✅ Search and filter products
- ✅ Display on your main website

**Start adding products now!** 🚀

---

**Version**: 1.0.0  
**Created by**: kolapodev  
**Last Updated**: 2026
