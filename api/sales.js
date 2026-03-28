import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORG_ID        = process.env.ZOHO_ORG_ID;
const APP_SECRET         = process.env.APP_SECRET;

function getAccessToken() {
  return fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN,
    }),
  }).then(r => r.json()).then(d => {
    if (!d.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(d));
    return d.access_token;
  });
}

function checkAuth(req) {
  const auth = req.headers['x-app-token'];
  if (!auth) return null;
  try {
    const payload = JSON.parse(Buffer.from(auth, 'base64').toString('utf8'));
    if (Date.now() - payload.iat > 86400000) return null;
    const expected = Buffer.from(
      JSON.stringify({ email: payload.email, role: payload.role, wh: payload.wh, iat: payload.iat }) + APP_SECRET
    ).toString('base64').slice(0, 16);
    if (payload.sig !== expected) return null;
    return payload;
  } catch { return null; }
}

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  return new Date(parseInt(y), parseInt(m) - 1, 1)
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function invoiceDateKey(dateStr) {
  // dateStr = "2026-03-28" → "2026-03"
  return dateStr ? dateStr.slice(0, 7) : null;
}

// Fetch invoices for a specific month (YYYY-MM)
async function fetchInvoicesForMonth(token, yearMonth) {
  const [y, m] = yearMonth.split('-');
  const from = `${y}-${m}-01`;
  // Last day of month
  const last = new Date(parseInt(y), parseInt(m), 0).getDate();
  const to   = `${y}-${m}-${String(last).padStart(2, '0')}`;

  const all = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `https://www.zohoapis.in/books/v3/invoices?organization_id=${ZOHO_ORG_ID}` +
      `&date_from=${from}&date_to=${to}&page=${page}&per_page=200&sort_order=desc`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const data = await res.json();
    const invoices = data.invoices || [];
    all.push(...invoices);
    if (!data.page_context?.has_more_page) break;
    page++;
  }

  // Fetch line items in batches of 20
  const BATCH = 20;
  const enriched = [];
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const items = await Promise.all(
      batch.map(inv =>
        fetch(`https://www.zohoapis.in/books/v3/invoices/${inv.invoice_id}?organization_id=${ZOHO_ORG_ID}&fields=invoice_number,date,customer_name,line_items,billing_address`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` }
        }).then(r => r.json()).then(d => d.invoice)
      )
    );
    enriched.push(...items.filter(Boolean));
  }

  // Flatten line items
  const rows = [];
  for (const inv of enriched) {
    const invDate = inv.date || '';
    for (const li of inv.line_items || []) {
      rows.push({
        date:        invDate,
        monthKey:    invoiceDateKey(invDate),
        invoiceNo:   inv.invoice_number || '',
        customer:    inv.customer_name || '',
        itemName:    li.item_name || li.name || '',
        description: li.description || '',
        qty:         parseFloat(li.quantity) || 0,
        unit:        li.unit || '',
        rate:        parseFloat(li.rate) || 0,
        amount:      parseFloat(li.amount) || 0,
      });
    }
  }

  return rows;
}

async function fetchAndCacheCurrentMonth(token) {
  const key = thisMonth();
  const rows = await fetchInvoicesForMonth(token, key);
  // Cache for 12 hours — past months are never re-fetched
  await redis.set(`sales:${key}`, rows, { ex: 43200 });
  return { key, rows, source: 'fresh' };
}

async function getAllCachedMonths() {
  const pattern = 'sales:????-??';
  const keys = await redis.keys(pattern);
  return keys.sort().reverse(); // newest month first
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-app-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = checkAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const curMonth = thisMonth();

  try {
    const token = await getAccessToken();
    const cachedMonths = await getAllCachedMonths();
    const hasCurrent = cachedMonths.includes(`sales:${curMonth}`);

    // Always refresh current month
    const { key: curKey, rows: curRows, source } = await fetchAndCacheCurrentMonth(token);

    // Load ALL cached months (current + any past months)
    const allMonths = await getAllCachedMonths();
    const months = await Promise.all(
      allMonths.map(async (mk) => {
        const data = await redis.get(`sales:${mk}`);
        const rows = Array.isArray(data) ? data : [];
        return {
          key:       mk,
          label:     monthLabel(mk),
          isCurrent: mk === curMonth,
          rows,
          totalQty:  rows.reduce((s, r) => s + r.qty, 0),
          totalAmt:  rows.reduce((s, r) => s + r.amount, 0),
        };
      })
    );

    // If current month was already cached (fresh fetch returned same data), source = 'cache'
    const source2 = hasCurrent ? 'cache' : source;

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ months, currentMonth: curMonth, fetchedAt: new Date().toISOString(), source: source2 });
  } catch (e) {
    console.error('Sales API Error:', e);
    res.status(500).json({ error: e.message });
  }
}
