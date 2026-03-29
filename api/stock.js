import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORG_ID = process.env.ZOHO_ORG_ID;
const APP_SECRET = process.env.APP_SECRET;

// Cache settings
const CACHE_TTL = 43200; // 12 hours
const CACHE_KEY = 'stock:cached_data';

async function getAccessToken() {
  const res = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function fetchAllItems(token) {
  let page = 1, all = [];
  while (true) {
    const res = await fetch(
      `https://www.zohoapis.in/books/v3/items?organization_id=${ZOHO_ORG_ID}&page=${page}&per_page=200`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const data = await res.json();
    if (!data.items?.length) break;
    all = all.concat(data.items);
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

async function fetchWarehouses(token) {
  const res = await fetch(
    `https://www.zohoapis.in/books/v3/settings/warehouses?organization_id=${ZOHO_ORG_ID}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const data = await res.json();
  return data.warehouses || [];
}

async function fetchItemDetail(token, itemId) {
  try {
    const res = await fetch(
      `https://www.zohoapis.in/books/v3/items/${itemId}?organization_id=${ZOHO_ORG_ID}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const data = await res.json();
    return data.item || null;
  } catch (e) {
    console.error(`Error fetching item ${itemId}:`, e.message);
    return null;
  }
}

function checkAuth(req) {
  const auth = req.headers['x-app-token'];
  if (!auth) return null;
  try {
    const decoded = Buffer.from(auth, 'base64').toString('utf8');
    const payload = JSON.parse(decoded);
    if (Date.now() - payload.iat > 86400000) return null;
    const expected = Buffer.from(
      JSON.stringify({ email: payload.email, role: payload.role, wh: payload.wh, iat: payload.iat }) + APP_SECRET
    ).toString('base64').slice(0, 16);
    if (payload.sig !== expected) return null;
    return payload;
  } catch { return null; }
}

function detectColour(name) {
  const n = name.toUpperCase();
  if (/-G\b|\(G\)/.test(n)) return 'Green';
  if (/-B\b|\(B\)/.test(n)) return 'Blue';
  if (/-R\b|\(R\)/.test(n)) return 'Red';
  return 'Unknown';
}

const CATEGORY_KEYWORDS = [
  'Coupling','Elbow','Tee','Valve Gate','Valve Ball',
  'Reducer','End Cap','Flange','Union','Nipple','Bushing'
];

function detectCategory(name) {
  const n = name.toLowerCase();
  for (const kw of CATEGORY_KEYWORDS) {
    if (n.includes(kw.toLowerCase())) return kw;
  }
  return '';
}

function extractSize(name) {
  const m = name.match(/(\d+(?:\.\d+)?)\s*\*mm/i);
  return m ? parseFloat(m[1]) : 9999;
}

async function fetchFreshStockData(token, warehouses) {
  const items = await fetchAllItems(token);
  const whMap = {};
  warehouses.forEach(w => { whMap[w.warehouse_id] = w.warehouse_name; });

  const activeItems = items.filter(item => item.status === 'active');
  console.log(`Fetching fresh stock for ${activeItems.length} active items`);

  // Fetch in batches of 30
  const BATCH_SIZE = 30;
  const detailed = [];
  for (let i = 0; i < activeItems.length; i += BATCH_SIZE) {
    const batch = activeItems.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(item => fetchItemDetail(token, item.item_id))
    );
    detailed.push(...results.filter(Boolean));
  }

  return detailed.map(item => {
    const warehouseStock = (item.warehouses || []).map(w => ({
      id: w.warehouse_id,
      name: whMap[w.warehouse_id] || w.warehouse_name || w.warehouse_id,
      stock: w.warehouse_stock_on_hand ?? 0,
    }));
    const totalStock = warehouseStock.reduce((s, w) => s + w.stock, 0);
    return {
      item_id: item.item_id,
      name: item.name,
      sku: item.sku || '',
      unit: item.unit || '',
      reorder_level: item.reorder_level ?? 0,
      stock_on_hand: totalStock,
      warehouses: warehouseStock,
      colour: detectColour(item.name),
      category: detectCategory(item.name),
      size: extractSize(item.name),
      status: item.status || 'active',
    };
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-app-token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const user = checkAuth(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const forceRefresh = req.query.force === 'true';
    const needsRefresh = await redis.get('stock:needs_refresh');

    // Check cache first
    const cached = await redis.get(CACHE_KEY);
    const cacheAge = cached ? Date.now() - cached.timestamp : Infinity;
    const cacheExpired = cacheAge > (CACHE_TTL * 1000);

    const shouldFetchFresh = forceRefresh || needsRefresh || !cached || cacheExpired;

    let stockData;
    let dataSource;

    if (shouldFetchFresh) {
      console.log('Fetching fresh stock data from Zoho Books...');
      dataSource = 'fresh';
      const token = await getAccessToken();
      const warehouses = await fetchWarehouses(token);
      const items = await fetchFreshStockData(token, warehouses);
      stockData = {
        items,
        warehouses: warehouses.map(w => ({ id: w.warehouse_id, name: w.warehouse_name })),
        timestamp: Date.now(),
      };

      await redis.set(CACHE_KEY, stockData, { ex: CACHE_TTL });
      await redis.del('stock:needs_refresh');
      console.log(`Fresh data cached: ${items.length} items`);
    } else {
      console.log(`Serving from cache (age: ${Math.round(cacheAge / 1000 / 60)} minutes)`);
      dataSource = 'cache';
      stockData = cached;
    }

    // Filter by user warehouse access
    const userWh = user.wh;
    const filtered = stockData.items.map(item => {
      if (user.role === 'admin' || userWh === 'both') return item;
      const allowedWh = item.warehouses.filter(w =>
        w.name.toLowerCase().includes(userWh.toLowerCase())
      );
      return {
        ...item,
        warehouses: allowedWh,
        stock_on_hand: allowedWh.reduce((s, w) => s + w.stock, 0),
      };
    });

    const visibleWarehouses = user.role === 'admin' || userWh === 'both'
      ? stockData.warehouses
      : stockData.warehouses.filter(w =>
          w.name.toLowerCase().includes(userWh.toLowerCase())
        );

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({
      items: filtered,
      warehouses: visibleWarehouses,
      fetched_at: new Date(stockData.timestamp).toISOString(),
      cache_age_minutes: Math.round(cacheAge / 1000 / 60),
      data_source: dataSource,
      user_role: user.role,
      user_wh: userWh,
    });

  } catch (e) {
    console.error('Stock API Error:', e);
    res.status(500).json({ error: e.message });
  }
}
