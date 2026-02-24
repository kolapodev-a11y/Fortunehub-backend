const $ = (id) => document.getElementById(id);

const API = window.location.origin; // same origin as backend

$('backendUrl').textContent = API;

function formatNaira(n) {
  return `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getToken() {
  return localStorage.getItem('fh_admin_token') || '';
}

function setToken(t) {
  localStorage.setItem('fh_admin_token', t);
}

function clearToken() {
  localStorage.removeItem('fh_admin_token');
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Basic ${token}` } : {};
}

function show(sectionId) {
  $('loginSection').classList.add('hidden');
  $('appSection').classList.add('hidden');
  $(sectionId).classList.remove('hidden');
}

async function pingHealth() {
  try {
    const r = await fetch(`${API}/health`, { cache: 'no-store' });
    const d = await r.json();
    // Cloudinary isn't exposed in /health; just show configured if uploads succeed.
    $('cloudinaryStatus').textContent = 'Configured (check by uploading an image)';
  } catch (e) {
    $('cloudinaryStatus').textContent = 'Unknown';
  }
}

async function login() {
  $('loginMsg').textContent = '';
  const username = ($('username').value || '').trim();
  const password = ($('password').value || '').trim();

  if (!username || !password) {
    $('loginMsg').textContent = 'Enter username + password.';
    return;
  }

  const r = await fetch(`${API}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  const d = await r.json();
  if (!r.ok || !d.success) {
    $('loginMsg').textContent = d.message || 'Login failed.';
    return;
  }

  setToken(d.token);
  show('appSection');
  await pingHealth();
  await loadProducts();
}

function logout() {
  clearToken();
  show('loginSection');
}

function badgeFor(p) {
  if (p.outOfStock) return '<span class="badge danger">Out of stock</span>';
  if (p.sold) return '<span class="badge warn">Sold</span>';
  return '<span class="badge ok">Available</span>';
}

function productRow(p) {
  const img = p.image ? `<img class="thumb" src="${p.image}" alt="${p.name}" />` : '<div class="thumb"></div>';
  return `
    <tr>
      <td>${p.id}</td>
      <td>${img}</td>
      <td><b>${p.name || ''}</b><br/><span class="muted">${(p.tag || 'none')}</span></td>
      <td>${p.category || ''}</td>
      <td>${formatNaira(p.price)}</td>
      <td>${badgeFor(p)}</td>
      <td class="actions">
        <div class="row">
          <button class="btn btn-ghost" data-edit="${p.id}">Edit</button>
          <button class="btn danger" data-del="${p.id}">Delete</button>
        </div>
      </td>
    </tr>
  `;
}

let cache = [];
let mode = 'create';
let editingId = null;

async function loadProducts() {
  const tbody = $('productsTbody');
  tbody.innerHTML = '<tr><td colspan="7" class="muted">Loading...</td></tr>';

  const r = await fetch(`${API}/api/admin/products`, { headers: { ...authHeaders() } });
  const d = await r.json();

  if (!r.ok || !d.success) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Failed: ${d.message || 'Unauthorized'}</td></tr>`;
    if (r.status === 401) logout();
    return;
  }

  cache = d.data || [];
  tbody.innerHTML = cache.length ? cache.map(productRow).join('') : '<tr><td colspan="7" class="muted">No products yet.</td></tr>';
}

function openModalCreate() {
  mode = 'create';
  editingId = null;
  $('modalTitle').textContent = 'New Product';
  $('modalMsg').textContent = '';

  $('pName').value = '';
  $('pCategory').value = '';
  $('pPrice').value = '';
  $('pDescription').value = '';
  $('pTag').value = 'none';
  $('pOutOfStock').value = 'false';
  $('pSold').value = 'false';
  $('pStatus').value = 'available';
  $('pImages').value = '';

  $('modal').classList.remove('hidden');
}

function openModalEdit(id) {
  const p = cache.find((x) => x.id === Number(id));
  if (!p) return;

  mode = 'edit';
  editingId = p.id;
  $('modalTitle').textContent = `Edit Product #${p.id}`;
  $('modalMsg').textContent = 'If you select new images, they will replace the old images.';

  $('pName').value = p.name || '';
  $('pCategory').value = p.category || '';
  $('pPrice').value = p.price || 0;
  $('pDescription').value = p.description || '';
  $('pTag').value = p.tag || 'none';
  $('pOutOfStock').value = String(!!p.outOfStock);
  $('pSold').value = String(!!p.sold);
  $('pStatus').value = p.statusIndicator || 'available';
  $('pImages').value = '';

  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
}

async function saveProduct() {
  $('modalMsg').textContent = '';

  const name = ($('pName').value || '').trim();
  const category = ($('pCategory').value || '').trim();
  const price = Number(($('pPrice').value || '').trim());

  if (!name || !category || !price) {
    $('modalMsg').textContent = 'Name, Category and Price are required.';
    return;
  }

  const fd = new FormData();
  fd.append('name', name);
  fd.append('category', category);
  fd.append('price', String(price));
  fd.append('description', $('pDescription').value || '');
  fd.append('tag', $('pTag').value);
  fd.append('outOfStock', $('pOutOfStock').value);
  fd.append('sold', $('pSold').value);
  fd.append('statusIndicator', $('pStatus').value);

  const files = $('pImages').files;
  if (files && files.length) {
    for (const f of files) fd.append('images', f);
  } else if (mode === 'create') {
    $('modalMsg').textContent = 'Please select at least 1 image.';
    return;
  }

  const url = mode === 'create'
    ? `${API}/api/admin/products`
    : `${API}/api/admin/products/${editingId}`;

  const r = await fetch(url, {
    method: mode === 'create' ? 'POST' : 'PUT',
    headers: { ...authHeaders() },
    body: fd
  });

  const d = await r.json().catch(() => ({}));

  if (!r.ok || !d.success) {
    $('modalMsg').textContent = d.message || 'Save failed. (Check Cloudinary config + backend logs)';
    return;
  }

  closeModal();
  await loadProducts();
}

async function deleteProduct(id) {
  if (!confirm('Delete this product?')) return;

  const r = await fetch(`${API}/api/admin/products/${id}`, {
    method: 'DELETE',
    headers: { ...authHeaders() }
  });

  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.success) {
    alert(d.message || 'Delete failed');
    return;
  }

  await loadProducts();
}

async function importProducts() {
  $('importMsg').textContent = '';
  const file = $('importFile').files?.[0];
  if (!file) {
    $('importMsg').textContent = 'Choose products.json file.';
    return;
  }

  const text = await file.text();
  let products;
  try {
    products = JSON.parse(text);
  } catch (e) {
    $('importMsg').textContent = 'Invalid JSON file.';
    return;
  }

  const r = await fetch(`${API}/api/admin/products/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ products })
  });

  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.success) {
    $('importMsg').textContent = d.message || 'Import failed';
    return;
  }

  $('importMsg').textContent = d.message;
  await loadProducts();
}

// Events
$('loginBtn').addEventListener('click', login);
$('logoutBtn').addEventListener('click', logout);
$('refreshBtn').addEventListener('click', loadProducts);
$('openCreateBtn').addEventListener('click', openModalCreate);
$('closeModal').addEventListener('click', closeModal);
$('saveBtn').addEventListener('click', saveProduct);
$('importBtn').addEventListener('click', importProducts);

$('productsTbody').addEventListener('click', (e) => {
  const edit = e.target?.dataset?.edit;
  const del = e.target?.dataset?.del;
  if (edit) openModalEdit(edit);
  if (del) deleteProduct(del);
});

// Auto-login
if (getToken()) {
  show('appSection');
  pingHealth().then(loadProducts);
} else {
  show('loginSection');
}
