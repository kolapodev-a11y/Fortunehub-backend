// ===================================================
// FortuneHub Frontend Script - WITH PRODUCT DETAIL MODAL & IMAGE ZOOM
// ✅ v2 FIXES:
//   1. AbortController timeout (10s) for backend API → instant fallback to products.json
//   2. Loading skeleton shown while waiting for products (better UX)
//   3. Backend cold-start graceful handling (Render free plan)
// ===================================================

// ------------------------------
// 1) STATE
// ------------------------------
let products = [];
let cart = (() => {
  // ✅ FIX: Migrate old cart items that may have kobo prices to naira
  const saved = JSON.parse(localStorage.getItem("cart")) || [];
  return saved.map(item => {
    let migratedItem = item;
    if (item.price && item.price > 10000) {
      migratedItem = { ...item, price: Math.round(item.price / 100) };
    }
    const img = String(migratedItem.image || '');
    if (img.startsWith('data:') || img.length > 300) {
      migratedItem = { ...migratedItem, image: '' };
    }
    return migratedItem;
  });
})();
let currentProduct = null;
let zoomEnabled = false;

// ✅ FIX: Do NOT hardcode the public key here. The backend returns the correct public key.
let PAYSTACK_PUBLIC_KEY = "pk_test_9f6a5cb45aeab4bd8bccd72129beda47f2609921"; // FALLBACK ONLY
const API_BASE_URL = "https://fortunehub-backend.onrender.com";

// ✅ FIX: Timeout (ms) for the backend /api/products call.
// Render free plan can take 30–60s to wake from sleep.
// We use a SHORT timeout (8s) so we fall back to products.json quickly,
// and users see products immediately instead of staring at a blank page.
const API_TIMEOUT_MS = 8000;

// ------------------------------
// 2) DOM ELEMENTS
// ------------------------------
const productsGrid = document.getElementById("productsGrid");
const cartCount = document.getElementById("cartCount");
const cartModal = document.getElementById("cartModal");
const closeModal = document.getElementById("closeCartModal");
const cartItemsContainer = document.getElementById("cartItems");
const cartTotalElement = document.getElementById("cartTotal");
const cartSubTotalElement = document.getElementById("cartSubTotal");
const shippingFeeAmountElement = document.getElementById("shippingFeeAmount");
const checkoutButton = document.getElementById("checkoutButton");
const continueShoppingButton = document.getElementById("continueShoppingButton");
const filterButtons = document.querySelectorAll(".filter-btn");
const searchInput = document.getElementById("searchInput");
const categoryCards = document.querySelectorAll(".category-card");
const cartIcon = document.getElementById("cartIcon");
const searchIconBtn = document.getElementById("searchIcon");
const footerOpenCart = document.getElementById("footerOpenCart");
const customerNameInput = document.getElementById("customerName");
const customerEmailInput = document.getElementById("customerEmail");
const customerPhoneInput = document.getElementById("customerPhone");
const shippingStateSelect = document.getElementById("shippingState");
const nameError = document.getElementById("nameError");
const emailError = document.getElementById("emailError");
const phoneError = document.getElementById("phoneError");

// Product Detail Modal Elements
const productDetailModal = document.getElementById("productDetailModal");
const closeProductModal = document.getElementById("closeProductModal");
const detailMainImage = document.getElementById("detailMainImage");
const detailThumbnails = document.getElementById("detailThumbnails");
const detailCategory = document.getElementById("detailCategory");
const detailTitle = document.getElementById("detailTitle");
const detailPrice = document.getElementById("detailPrice");
const detailBadge = document.getElementById("detailBadge");
const detailDescription = document.getElementById("detailDescription");
const detailSpecsList = document.getElementById("detailSpecsList");
const detailAddCart = document.getElementById("detailAddCart");
const detailBuyNow = document.getElementById("detailBuyNow");
const zoomToggle = document.getElementById("zoomToggle");
const zoomLens = document.getElementById("zoomLens");
const zoomResult = document.getElementById("zoomResult");

// ------------------------------
// 3) HELPERS
// ------------------------------
function formatCurrency(amountInNaira) {
  return `₦${Number(amountInNaira || 0).toLocaleString("en-NG", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function getProductById(id) {
  return products.find((p) => String(p.id) === String(id));
}

function getProductsJsonUrl() {
  return new URL("products.json", window.location.href).toString();
}

function getRepoBaseUrl() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const repoName = parts.length ? parts[0] : "";
  return `${window.location.origin}/${repoName}/`;
}

function resolveAssetUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const base = getRepoBaseUrl();
  if (path.startsWith("/")) return `${window.location.origin}${path}`;
  return new URL(path, base).toString();
}

function svgIcon(name, extraClass = '') {
  return `<svg class=\"icon ${extraClass}\" aria-hidden=\"true\"><use href=\"#icon-${name}\"></use></svg>`;
}

// ------------------------------
// 4) LOADING OVERLAY
// ------------------------------
function showLoadingOverlay(message = "Processing payment...") {
  hideLoadingOverlay();
  const overlay = document.createElement("div");
  overlay.id = "paymentLoadingOverlay";
  overlay.innerHTML = `
    <div class="loading-content">
      <div class="loading-spinner"></div>
      <h3 class="loading-title">${message}</h3>
      <p class="loading-subtitle">Please wait, this may take up to a minute...</p>
      <div class="loading-progress">
        <div class="loading-progress-bar"></div>
      </div>
      <p class="loading-info">
        ${svgIcon('info')} 
        Do not close this window or press the back button
      </p>
    </div>
    <style>
      #paymentLoadingOverlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.85); backdrop-filter: blur(8px);
        z-index: 99999; display: flex; align-items: center; justify-content: center;
        animation: fadeIn 0.3s ease;
      }
      @keyframes fadeIn { from{opacity:0} to{opacity:1} }
      .loading-content {
        background: white; border-radius: 20px; padding: 40px 50px;
        max-width: 450px; width: 90%; text-align: center;
        box-shadow: 0 20px 60px rgba(0,0,0,0.4); animation: slideUp 0.4s ease;
      }
      @keyframes slideUp { from{opacity:0;transform:translateY(30px)} to{opacity:1;transform:translateY(0)} }
      .loading-spinner {
        width:60px; height:60px; border:5px solid #f0f0f0; border-top:5px solid #667eea;
        border-radius:50%; margin:0 auto 25px; animation:spin 1s linear infinite;
      }
      @keyframes spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
      .loading-title { font-size:22px; font-weight:700; color:#1f2937; margin:0 0 10px; }
      .loading-subtitle { font-size:15px; color:#595959; margin:0 0 25px; line-height:1.5; }
      .loading-progress { width:100%; height:6px; background:#f0f0f0; border-radius:10px; overflow:hidden; margin-bottom:20px; }
      .loading-progress-bar { height:100%; background:linear-gradient(90deg,#667eea,#764ba2); border-radius:10px; animation:progressBar 60s ease-in-out; width:0%; }
      @keyframes progressBar { 0%{width:0%} 50%{width:75%} 100%{width:95%} }
      .loading-info { font-size:13px; color:#9ca3af; margin:0; display:flex; align-items:center; justify-content:center; gap:8px; }
      .loading-info i { color:#667eea; }
      @media(max-width:480px){ .loading-content{padding:30px 25px} .loading-title{font-size:18px} }
    </style>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
}

function hideLoadingOverlay() {
  const overlay = document.getElementById("paymentLoadingOverlay");
  if (overlay) {
    overlay.style.animation = "fadeOut 0.3s ease";
    setTimeout(() => { overlay.remove(); document.body.style.overflow = "auto"; }, 300);
  }
}

const _fadeOutStyle = document.createElement("style");
_fadeOutStyle.textContent = `@keyframes fadeOut { from{opacity:1} to{opacity:0} }`;
document.head.appendChild(_fadeOutStyle);

// ------------------------------
// 4b) PRODUCTS LOADING STATE (skeleton)
// ✅ NEW: Shows a spinner while waiting for backend to wake from Render sleep
// ------------------------------
function showProductsLoading(isBackendWaking = false) {
  if (!productsGrid) return;
  productsGrid.innerHTML = `
    <div class="products-loading">
      <div class="loading-spinner-sm" aria-hidden="true"></div>
      <p>${isBackendWaking ? "Waking up product server..." : "Loading products..."}</p>
      <small>${isBackendWaking
        ? "The server may take up to 30 seconds to wake from sleep. Products will appear shortly."
        : "Please wait a moment."
      }</small>
    </div>
  `;
}

// ------------------------------
// 5) CART UI + LOGIC
// ------------------------------
function updateCartUI() {
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  if (cartCount) cartCount.textContent = totalItems;

  if (!cartItemsContainer) return;

  cartItemsContainer.innerHTML = "";
  if (cart.length === 0) {
    cartItemsContainer.innerHTML = '<p style="text-align:center;color:#555;">Your cart is empty.</p>';
    if (checkoutButton) checkoutButton.disabled = true;
    return;
  }

  cart.forEach((item) => {
    const itemHTML = `
      <div class="cart-item">
        <div class="item-details">
          <img src="${resolveAssetUrl(item.image || (getProductById(item.id) && getProductById(item.id).image) || '')}" alt="${item.name}" onerror="this.style.display='none'">
          <div class="item-info">
            <h4>${item.name}</h4>
            <span class="item-price">${formatCurrency(item.price)}</span>
          </div>
        </div>
        <div class="item-quantity">
          <button class="btn-quantity minus" data-id="${item.id}" data-change="-1">-</button>
          <span>${item.quantity}</span>
          <button class="btn-quantity plus" data-id="${item.id}" data-change="1">+</button>
          <button type="button" class="remove-item" data-id="${item.id}" aria-label="Remove item">${svgIcon('trash')}</button>
        </div>
      </div>
    `;
    cartItemsContainer.insertAdjacentHTML("beforeend", itemHTML);
  });

  document.querySelectorAll(".btn-quantity").forEach((button) => {
    button.addEventListener("click", (e) => {
      const id = e.currentTarget.dataset.id;
      const change = parseInt(e.currentTarget.dataset.change, 10);
      updateQuantity(id, change);
    });
  });

  document.querySelectorAll(".remove-item").forEach((button) => {
    button.addEventListener("click", (e) => {
      removeItem(e.currentTarget.dataset.id);
    });
  });

  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const selectedShippingFeeNaira = parseInt(shippingStateSelect?.value || "0", 10);
  const shippingFee = cart.length > 0 ? selectedShippingFeeNaira : 0;
  const grandTotal = subtotal + shippingFee;

  if (cartSubTotalElement) cartSubTotalElement.textContent = formatCurrency(subtotal);
  if (shippingFeeAmountElement) shippingFeeAmountElement.textContent = formatCurrency(shippingFee);
  if (cartTotalElement) cartTotalElement.textContent = formatCurrency(grandTotal);

  if (checkoutButton) {
    const isValid = validateCustomerInfo({ silent: true });
    const name = customerNameInput?.value?.trim() || "";
    const email = customerEmailInput?.value?.trim() || "";
    const phone = customerPhoneInput?.value?.trim() || "";

    if (!isValid || !name || !email || !phone) {
      checkoutButton.disabled = true;
      checkoutButton.innerHTML = `${svgIcon('info')} Complete Info to Continue`;
    } else {
      checkoutButton.disabled = false;
      checkoutButton.innerHTML = `${svgIcon('credit-card')} Proceed to Checkout`;
    }
  }
}

function addToCart(productId, quantity = 1) {
  const product = getProductById(productId);
  if (!product || product.outOfStock) { alert("Product is out of stock."); return; }

  const cartItem = cart.find((item) => String(item.id) === String(productId));
  if (cartItem) cartItem.quantity += quantity;
  else {
    const rawImg = product.image || '';
    const safeImg = (rawImg.startsWith('data:') || rawImg.length > 300) ? '' : rawImg;
    cart.push({ id: product.id, name: product.name, price: product.price, quantity, image: safeImg });
  }

  localStorage.setItem("cart", JSON.stringify(cart));
  updateCartUI();
  alert(`${product.name} added to cart!`);
}

function updateQuantity(productId, change) {
  const cartItem = cart.find((item) => String(item.id) === String(productId));
  if (cartItem) {
    cartItem.quantity += change;
    if (cartItem.quantity <= 0) cart = cart.filter((item) => String(item.id) !== String(productId));
  }
  localStorage.setItem("cart", JSON.stringify(cart));
  updateCartUI();
}

function removeItem(productId) {
  cart = cart.filter((item) => String(item.id) !== String(productId));
  localStorage.setItem("cart", JSON.stringify(cart));
  updateCartUI();
}

// ------------------------------
// 6) VALIDATION
// ------------------------------
function validateCustomerInfo({ silent = false } = {}) {
  let isValid = true;
  if (nameError) nameError.style.display = "none";
  if (emailError) emailError.style.display = "none";
  if (phoneError) phoneError.style.display = "none";

  const name = customerNameInput?.value?.trim() || "";
  const email = customerEmailInput?.value?.trim() || "";
  const phone = customerPhoneInput?.value?.trim() || "";
  const stateValue = shippingStateSelect?.value || "";

  if (!name || name.length < 3 || name.includes("@") || name.includes(".")) {
    if (!silent && nameError) { nameError.textContent = "Please enter your full name (not email)."; nameError.style.display = "block"; }
    isValid = false;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    if (!silent && emailError) { emailError.textContent = "Enter a valid email (e.g., name@example.com)."; emailError.style.display = "block"; }
    isValid = false;
  }

  const phoneRegex = /^(0[789][01])\d{8}$/;
  if (!phone || !phoneRegex.test(phone)) {
    if (!silent && phoneError) { phoneError.textContent = "Enter a valid Nigerian phone number (e.g., 08031234567)."; phoneError.style.display = "block"; }
    isValid = false;
  }

  if (!stateValue) isValid = false;
  return isValid;
}

// ------------------------------
// 7) PRODUCT DETAIL MODAL
// ------------------------------
function openProductDetail(productId) {
  const product = getProductById(productId);
  if (!product) return;

  currentProduct = product;
  zoomEnabled = false;
  const mainContainer = document.querySelector('.main-image-container');
  if (mainContainer) mainContainer.classList.remove('zoom-active');

  if (detailCategory) detailCategory.textContent = product.category || "Product";
  if (detailTitle) detailTitle.textContent = product.name;
  if (detailPrice) detailPrice.textContent = formatCurrency(product.price);

  if (detailBadge) {
    detailBadge.textContent = "";
    detailBadge.className = "detail-badge";
    if (product.sold) { detailBadge.textContent = "SOLD"; detailBadge.classList.add("badge-sold"); detailBadge.style.display = "inline-block"; }
    else if (product.tag === "new") { detailBadge.textContent = "NEW"; detailBadge.classList.add("badge-new"); detailBadge.style.display = "inline-block"; }
    else if (product.tag === "sale") { detailBadge.textContent = "SALE"; detailBadge.classList.add("badge-sale"); detailBadge.style.display = "inline-block"; }
    else detailBadge.style.display = "none";
  }

  if (detailDescription) detailDescription.textContent = product.description || "No description available.";

  if (detailSpecsList) {
    detailSpecsList.innerHTML = "";
    const specs = product.specifications || {
      "Category": product.category,
      "Availability": product.outOfStock ? "Out of Stock" : "In Stock",
      "Price": formatCurrency(product.price)
    };
    Object.entries(specs).forEach(([key, value]) => {
      const li = document.createElement("li");
      li.innerHTML = `${svgIcon('check')} <strong>${key}:</strong> ${value}`;
      detailSpecsList.appendChild(li);
    });
  }

  const imgs = Array.isArray(product.images) && product.images.length
    ? product.images.slice(0, 4)
    : [product.image, product.image, product.image];
  const images = imgs.map(img => resolveAssetUrl(img || product.image));

  if (detailMainImage) { detailMainImage.src = images[0]; detailMainImage.alt = product.name; }

  if (detailThumbnails) {
    detailThumbnails.innerHTML = "";
    images.forEach((imgSrc, index) => {
      const thumb = document.createElement("img");
      thumb.src = imgSrc;
      thumb.alt = `${product.name} ${index + 1}`;
      thumb.classList.add("detail-thumb");
      if (index === 0) thumb.classList.add("active");
      thumb.addEventListener("click", () => {
        detailMainImage.src = imgSrc;
        detailThumbnails.querySelectorAll("img").forEach(t => t.classList.remove("active"));
        thumb.classList.add("active");
      });
      detailThumbnails.appendChild(thumb);
    });
  }

  const isSoldOrOutOfStock = product.sold || product.outOfStock;
  if (detailAddCart) {
    detailAddCart.disabled = isSoldOrOutOfStock;
    detailAddCart.innerHTML = isSoldOrOutOfStock ? `${svgIcon('ban')} Out of Stock` : `${svgIcon('cart-plus')} Add to Cart`;
  }
  if (detailBuyNow) {
    detailBuyNow.disabled = isSoldOrOutOfStock;
    detailBuyNow.innerHTML = isSoldOrOutOfStock ? `${svgIcon('ban')} Out of Stock` : `${svgIcon('bolt')} Buy Now`;
  }

  if (productDetailModal) { productDetailModal.style.display = "block"; document.body.style.overflow = "hidden"; }
  initImageZoom();
}

function closeProductDetail() {
  if (productDetailModal) { productDetailModal.style.display = "none"; document.body.style.overflow = "auto"; }
  currentProduct = null;
  zoomEnabled = false;
  const mainContainer = document.querySelector('.main-image-container');
  if (mainContainer) mainContainer.classList.remove('zoom-active');
}

// ------------------------------
// 8) IMAGE ZOOM FUNCTIONALITY
// ------------------------------
function initImageZoom() {
  const mainImage = detailMainImage;
  const lens = zoomLens;
  const result = zoomResult;
  const container = document.querySelector('.main-image-container');
  if (!mainImage || !lens || !result || !container) return;

  let cx, cy;

  function updateZoomRatio() {
    cx = result.offsetWidth / lens.offsetWidth;
    cy = result.offsetHeight / lens.offsetHeight;
    result.style.backgroundImage = `url('${mainImage.src}')`;
    result.style.backgroundSize = `${mainImage.width * cx}px ${mainImage.height * cy}px`;
  }

  function moveLens(e) {
    if (!zoomEnabled) return;
    e.preventDefault();
    const pos = getCursorPos(e);
    let x = pos.x - lens.offsetWidth / 2;
    let y = pos.y - lens.offsetHeight / 2;
    if (x > mainImage.width - lens.offsetWidth) x = mainImage.width - lens.offsetWidth;
    if (x < 0) x = 0;
    if (y > mainImage.height - lens.offsetHeight) y = mainImage.height - lens.offsetHeight;
    if (y < 0) y = 0;
    lens.style.left = x + 'px';
    lens.style.top = y + 'px';
    result.style.backgroundPosition = `-${x * cx}px -${y * cy}px`;
  }

  function getCursorPos(e) {
    const rect = mainImage.getBoundingClientRect();
    const x = (e.pageX || e.touches[0].pageX) - rect.left - window.pageXOffset;
    const y = (e.pageY || e.touches[0].pageY) - rect.top - window.pageYOffset;
    return { x, y };
  }

  if (zoomToggle) {
    zoomToggle.onclick = function() {
      zoomEnabled = !zoomEnabled;
      if (zoomEnabled) {
        container.classList.add('zoom-active');
        updateZoomRatio();
        const u = this.querySelector('use'); if (u) u.setAttribute('href','#icon-zoom-out');
      } else {
        container.classList.remove('zoom-active');
        const u = this.querySelector('use'); if (u) u.setAttribute('href','#icon-zoom-in');
      }
    };
  }

  container.addEventListener('mousemove', moveLens);
  container.addEventListener('touchmove', moveLens);
  mainImage.addEventListener('load', updateZoomRatio);
  window.addEventListener('resize', updateZoomRatio);
}

// ------------------------------
// 9) PRODUCTS UI
// ------------------------------
function displayProducts(productsToShow) {
  if (!productsGrid) return;
  productsGrid.innerHTML = "";

  if (!productsToShow || productsToShow.length === 0) {
    productsGrid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:40px;color:#555;">
        <span style="display:inline-flex;font-size:48px;color:#ccc;margin-bottom:15px;">${svgIcon('list')}</span>
        <p style="font-size:18px;margin:0;">No products found</p>
      </div>
    `;
    return;
  }

  productsToShow.forEach((product) => {
    const isSold = !!product.sold;
    const isOutOfStock = !!product.outOfStock;

    let badgeClass = "", badgeText = "";
    if (isSold) { badgeClass = "badge-sold"; badgeText = "SOLD"; }
    else if (product.tag === "new") { badgeClass = "badge-new"; badgeText = "NEW"; }
    else if (product.tag === "sale") { badgeClass = "badge-sale"; badgeText = "SALE"; }

    let buttonText = "Add to Cart", buttonClass = "btn-add-to-cart add-to-cart";
    let buyNowText = "Buy Now", buyNowClass = "btn-buy-now buy-now";
    let isDisabled = "";

    if (isSold) {
      buttonText = "SOLD"; buttonClass = "btn-secondary";
      buyNowText = "SOLD"; buyNowClass = "btn-secondary"; isDisabled = "disabled";
    } else if (isOutOfStock) {
      buttonText = "Out of Stock"; buttonClass = "btn-secondary";
      buyNowText = "Out of Stock"; buyNowClass = "btn-secondary"; isDisabled = "disabled";
    }

    const imgs = Array.isArray(product.images) && product.images.length
      ? product.images.slice(0, 3)
      : [product.image, product.image, product.image];
    const images = [
      resolveAssetUrl(imgs[0] || product.image),
      resolveAssetUrl(imgs[1] || product.image),
      resolveAssetUrl(imgs[2] || product.image),
    ];

    productsGrid.insertAdjacentHTML("beforeend", `
      <div class="product-card" data-category="${product.category}" data-product-id="${product.id}">
        <div class="product-image-slider" data-images='${JSON.stringify(images)}'>
          <img src="${images[0]}" alt="${product.name}" class="product-main-img" loading="lazy">
          <div class="product-thumbnails">
            <img src="${images[0]}" alt="1" class="thumb active" data-index="0" loading="lazy">
            <img src="${images[1]}" alt="2" class="thumb" data-index="1" loading="lazy">
            <img src="${images[2]}" alt="3" class="thumb" data-index="2" loading="lazy">
          </div>
          ${badgeText ? `<span class="product-badge ${badgeClass}">${badgeText}</span>` : ""}
        </div>
        <div class="product-info">
          <p class="product-category">${product.category}</p>
          <h3 class="product-title">${product.name}</h3>
          <p class="product-price">${formatCurrency(product.price)}</p>
          <p class="product-description">${product.description}</p>
          <div class="product-actions">
            <button class="btn ${buttonClass}" ${isDisabled} data-id="${product.id}">${buttonText}</button>
            <button class="btn ${buyNowClass}" ${isDisabled} data-id="${product.id}">${buyNowText}</button>
          </div>
        </div>
      </div>
    `);
  });
}

function filterProducts(category) {
  const filtered = category === "all" ? products : products.filter((p) => (p.category || "").toLowerCase() === category.toLowerCase());
  displayProducts(filtered);
}

function searchProducts(query) {
  const text = (query || "").toLowerCase();
  const filtered = products.filter((p) =>
    (p.name || "").toLowerCase().includes(text) ||
    (p.category || "").toLowerCase().includes(text) ||
    (p.description || "").toLowerCase().includes(text)
  );
  displayProducts(filtered);
}

// ------------------------------
// 10) EVENTS
// ------------------------------
function setActiveFilterButton(category) {
  filterButtons.forEach((btn) => {
    const isActive = btn.dataset.category === category;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function setupEventListeners() {
  if (searchIconBtn) {
    searchIconBtn.addEventListener("click", () => {
      document.getElementById("products")?.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => searchInput?.focus(), 400);
    });
  }

  if (searchInput) searchInput.addEventListener("input", (e) => searchProducts(e.target.value));

  filterButtons.forEach((button) => {
    button.setAttribute("aria-pressed", button.classList.contains("active") ? "true" : "false");
    button.addEventListener("click", () => {
      const category = button.dataset.category;
      setActiveFilterButton(category);
      filterProducts(category);
    });
  });

  categoryCards.forEach((card) => {
    card.addEventListener("click", () => {
      const category = card.dataset.category;
      setActiveFilterButton(category);
      filterProducts(category);
      document.getElementById("products")?.scrollIntoView({ behavior: "smooth" });
    });
  });

  cartIcon?.addEventListener("click", openCartModal);
  footerOpenCart?.addEventListener("click", (e) => { e.preventDefault(); openCartModal(); });
  closeModal?.addEventListener("click", closeCartModal);
  continueShoppingButton?.addEventListener("click", closeCartModal);
  closeProductModal?.addEventListener("click", closeProductDetail);

  if (detailAddCart) {
    detailAddCart.addEventListener("click", () => {
      if (currentProduct && !currentProduct.sold && !currentProduct.outOfStock) {
        addToCart(String(currentProduct.id));
      }
    });
  }

  if (detailBuyNow) {
    detailBuyNow.addEventListener("click", () => {
      if (currentProduct && !currentProduct.sold && !currentProduct.outOfStock) {
        addToCart(String(currentProduct.id), 1);
        closeProductDetail();
        openCartModal();
      }
    });
  }

  window.addEventListener("click", (e) => {
    if (cartModal && e.target === cartModal) closeCartModal();
    if (productDetailModal && e.target === productDetailModal) closeProductDetail();
  });

  shippingStateSelect?.addEventListener("change", updateCartUI);
  customerNameInput?.addEventListener("input", updateCartUI);
  customerEmailInput?.addEventListener("input", updateCartUI);
  customerPhoneInput?.addEventListener("input", updateCartUI);
  checkoutButton?.addEventListener("click", initiatePaystackPayment);

  productsGrid?.addEventListener("click", (e) => {
    const target = e.target;
    const card = target.closest(".product-card");
    if (card && !target.closest("button") && !target.closest(".thumb")) {
      openProductDetail(card.dataset.productId);
      return;
    }
    if (target?.classList?.contains("add-to-cart")) { e.stopPropagation(); addToCart(target.dataset.id); return; }
    if (target?.classList?.contains("buy-now")) { e.stopPropagation(); addToCart(target.dataset.id, 1); openCartModal(); return; }
    if (target?.classList?.contains("thumb")) {
      e.stopPropagation();
      const slider = target.closest(".product-image-slider");
      const mainImg = slider?.querySelector(".product-main-img");
      if (!slider || !mainImg) return;
      const images = JSON.parse(slider.dataset.images || "[]");
      const index = parseInt(target.dataset.index, 10);
      if (images[index]) mainImg.src = images[index];
      slider.querySelectorAll(".thumb").forEach((t) => t.classList.remove("active"));
      target.classList.add("active");
    }
  });
}

// ------------------------------
// 11) MODAL
// ------------------------------
function openCartModal() {
  if (!cartModal) return;
  cartModal.style.display = "block";
  document.body.style.overflow = "hidden";
  updateCartUI();
}

function closeCartModal() {
  if (!cartModal) return;
  cartModal.style.display = "none";
  document.body.style.overflow = "auto";
}

// ------------------------------
// 12) PAYSTACK - WITH LOADING INDICATOR
//     Paystack JS is loaded ONLY when user clicks checkout.
// ------------------------------
async function loadPaystackScript() {
  if (typeof window.PaystackPop !== 'undefined') return true;
  if (window.__paystackLoadingPromise) return window.__paystackLoadingPromise;
  window.__paystackLoadingPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.paystack.co/v1/inline.js';
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('Failed to load Paystack script'));
    document.head.appendChild(s);
  });
  return window.__paystackLoadingPromise;
}

async function initiatePaystackPayment() {
  if (cart.length === 0) { alert("Your cart is empty."); return; }

  try {
    await loadPaystackScript();
  } catch (e) {
    alert("Paystack could not load. Please disable adblockers or try another network and retry.");
    return;
  }

  if (typeof PaystackPop === "undefined") {
    alert("Paystack could not load on this browser/network. Please disable adblockers, try incognito mode, or try another network and retry.");
    return;
  }

  const name = (customerNameInput?.value || "").trim();
  const email = (customerEmailInput?.value || "").trim();
  const phone = (customerPhoneInput?.value || "").trim();

  if (!validateCustomerInfo()) { alert("Please complete all required information correctly."); return; }

  const shippingFeeNaira = parseInt(shippingStateSelect?.value || "0", 10) || 0;
  const subtotalNaira = cart.reduce((sum, item) => sum + Number(item.price || 0) * (item.quantity || 1), 0);
  const totalNaira = subtotalNaira + shippingFeeNaira;

  if (!Number.isFinite(totalNaira) || totalNaira <= 0) { alert("Invalid total amount. Please refresh the page and try again."); return; }

  const totalKobo = Math.round(totalNaira * 100);
  const metadata = {
    customer_name: name,
    customer_email: email,
    customer_phone: phone,
    cart_items: cart,
    shipping_fee: shippingFeeNaira,
    shipping_state: shippingStateSelect?.options?.[shippingStateSelect.selectedIndex]?.text || "",
  };

  showLoadingOverlay("Starting payment...");

  fetch(`${API_BASE_URL}/api/payment/initialize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ email, amount: totalNaira, metadata }),
  })
    .then((r) => { if (!r.ok) throw new Error(`Initialize failed (HTTP ${r.status})`); return r.json(); })
    .then((init) => {
      if (!init?.success || !init?.access_code) throw new Error(init?.message || "Failed to initialize transaction");
      if (init.public_key && init.public_key.startsWith('pk_')) {
        PAYSTACK_PUBLIC_KEY = init.public_key;
      }
      hideLoadingOverlay();

      const handler = PaystackPop.setup({
        key: PAYSTACK_PUBLIC_KEY,
        email,
        amount: totalKobo,
        currency: 'NGN',
        access_code: init.access_code,
        ref: init.reference,
        metadata,
        callback: function (response) {
          showLoadingOverlay("Verifying your payment...");
          const timeoutId = setTimeout(() => {
            hideLoadingOverlay();
            alert("⏱️ Payment verification is taking longer than expected. Your payment was received. Please check your email for confirmation or contact support with reference: " + response.reference);
          }, 90000);

          fetch(`${API_BASE_URL}/api/payment/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ reference: response.reference }),
          })
            .then((r) => { clearTimeout(timeoutId); if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`); return r.json(); })
            .then((data) => {
              hideLoadingOverlay();
              if (data.success) {
                alert("✅ Payment successful! Order confirmed. Check your email for details.");
                cart = [];
                localStorage.setItem("cart", JSON.stringify(cart));
                if (customerNameInput) customerNameInput.value = "";
                if (customerEmailInput) customerEmailInput.value = "";
                if (customerPhoneInput) customerPhoneInput.value = "";
                if (shippingStateSelect) shippingStateSelect.value = "";
                updateCartUI();
                closeCartModal();
              } else {
                alert("⚠️ Payment verification failed: " + (data.message || "Unknown error"));
              }
            })
            .catch((err) => { clearTimeout(timeoutId); hideLoadingOverlay(); alert("❌ Failed to verify payment. Please contact support with reference: " + response.reference); });
        },
        onClose: function () { hideLoadingOverlay(); },
      });
      handler.openIframe();
    })
    .catch((err) => {
      hideLoadingOverlay();
      alert("❌ Could not start payment: " + (err?.message || "Unknown error") + "\n\nPossible causes:\n• Backend server is still waking up (wait 30s and retry)\n• PAYSTACK_SECRET_KEY missing in server environment\n• Public/Secret key mode mismatch (test vs live)");
    });
}

// ------------------------------
// 13) INIT — with timeout + graceful Render cold-start handling
// ✅ FIX: AbortController timeout ensures we don't wait forever for a sleeping Render backend.
//         Products load from products.json immediately if backend doesn't respond in 8 seconds.
// ------------------------------
async function initializeApp() {
  // Show loading state while we wait for products
  showProductsLoading(false);

  // ✅ Create an AbortController to cancel the backend request if it takes too long
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.warn("⏱️ Backend API timeout — falling back to products.json (Render free plan may be waking up)");
    // Update the loading message to inform the user
    const loadingEl = productsGrid?.querySelector('.products-loading p');
    if (loadingEl) loadingEl.textContent = "Loading products from cache...";
  }, API_TIMEOUT_MS);

  try {
    let backendFailed = false;

    try {
      // ✅ Pass the AbortController signal — this will throw AbortError after API_TIMEOUT_MS
      const response = await fetch(`${API_BASE_URL}/api/products`, {
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data.success && Array.isArray(data.data) && data.data.length) {
          products = data.data;
        } else if (Array.isArray(data) && data.length) {
          products = data;
        } else {
          backendFailed = true; // Backend returned empty — fall back to products.json
        }
      } else {
        backendFailed = true;
      }
    } catch (apiErr) {
      clearTimeout(timeoutId);
      // AbortError means we hit our timeout — backend is sleeping on Render free plan
      if (apiErr.name === "AbortError") {
        console.warn("⚠️ Backend API timed out. Using products.json fallback. The backend will wake up in the background.");
        // ✅ Re-trigger the backend wake-up in the background (fire-and-forget with long timeout)
        // This primes the server so it's ready for checkout later
        fetch(`${API_BASE_URL}/health`, { cache: "no-store" }).catch(() => {});
      } else {
        console.error("❌ Backend API error:", apiErr.message);
      }
      backendFailed = true;
    }

    if (backendFailed) {
      // Load from products.json (fallback)
      try {
        const fallbackResp = await fetch(getProductsJsonUrl(), { cache: "no-store" });
        if (!fallbackResp.ok) throw new Error(`HTTP ${fallbackResp.status}`);
        const rawProducts = await fallbackResp.json();
        // products.json stores prices in KOBO → convert to NAIRA for display
        products = rawProducts.map(p => ({ ...p, price: (Number(p.price) || 0) / 100 }));
      } catch (fallbackErr) {
        console.error("❌ Failed to load products.json:", fallbackErr);
        products = [];
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  displayProducts(products);
  setupEventListeners();
  updateCartUI();
  setActiveFilterButton("all");
}

document.addEventListener("DOMContentLoaded", initializeApp);


if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
