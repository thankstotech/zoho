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

function getAccessToken() {
  return fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ZOHO_CLIENT_ID,
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

// Extract Unit/Location from billing address
function extractUnit(billingAddress) {
  if (!billingAddress) return 'Unit 1'; // Default
  
  const addr = billingAddress.address || billingAddress.street || '';
  const city = billingAddress.city || '';
  const combined = `${addr} ${city}`.toUpperCase();
  
  // Try to detect unit from address patterns
  // Customize these patterns based on your actual address format
  if (combined.includes('UNIT 1') || combined.includes('U1') || combined.includes('LOCATION 1')) return 'Unit 1';
  if (combined.includes('UNIT 2') || combined.includes('U2') || combined.includes('LOCATION 2')) return 'Unit 2';
  if (combined.includes('UNIT 3') || combined.includes('U3') || combined.includes('LOCATION 3')) return 'Unit 3';
  
  // Try to match warehouse names
  if (combined.includes('BANGALORE') || combined.includes('BENGALURU')) return 'Bangalore Unit';
  if (combined.includes('DELHI') || combined.includes('NEW DELHI')) return 'Delhi Unit';
  if (combined.includes('MUMBAI')) return 'Mumbai Unit';
  if (combined.includes('CHENNAI')) return 'Chennai Unit';
  
  return 'Unit 1'; // Default fallback
}

// Fetch invoices for a date range
async function fetchInvoicesForDateRange(token, fromDate, toDate) {
  const all = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `https://www.zohoapis.in/books/v3/invoices?organization_id=${ZOHO_ORG_ID}` +
      `&date_from=${fromDate}&date_to=${toDate}&page=${page}&per_page=200&sort_order=desc`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const data = await res.json();
    const invoices = data.invoices || [];
    all.push(...invoices);
    if (!data.page_context?.has_more_page) break;
    page++;
  }

  // Fetch full invoice details in batches
  const BATCH = 20;
  const enriched = [];
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const items = await Promise.all(
      batch.map(inv =>
        fetch(
          `https://www.zohoapis.in/books/v3/invoices/${inv.invoice_id}?organization_id=${ZOHO_ORG_ID}`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
        ).then(r => r.json()).then(d => d.invoice)
      )
    );
    enriched.push(...items.filter(Boolean));
  }

  return enriched;
}

// Process invoices into daily sales structure
function processDailySales(invoices) {
  const dailyData = {}; // { 'YYYY-MM-DD': { unit: { invoices: [...] } } }

  for (const inv of invoices) {
    const date = inv.date || '';
    if (!date) continue;

    const unit = extractUnit(inv.billing_address);
    
    // Initialize date structure
    if (!dailyData[date]) {
      dailyData[date] = {};
    }
    
    // Initialize unit structure
    if (!dailyData[date][unit]) {
      dailyData[date][unit] = {
        invoices: [],
        totalQty: 0,
        totalAmount: 0,
      };
    }

    // Process line items
    const lineItems = (inv.line_items || []).map((li, idx) => ({
      sno: idx + 1,
      itemName: li.item_name || li.name || '',
      description: li.description || '',
      qty: parseFloat(li.quantity) || 0,
      unit: li.unit || '',
      rate: parseFloat(li.rate) || 0,
      amount: parseFloat(li.amount) || 0,
    }));

    const invoiceTotalQty = lineItems.reduce((sum, li) => sum + li.qty, 0);
    const invoiceTotalAmount = lineItems.reduce((sum, li) => sum + li.amount, 0);

    dailyData[date][unit].invoices.push({
      invoiceNo: inv.invoice_number || '',
      invoiceId: inv.invoice_id,
      customer: inv.customer_name || '',
      lineItems,
      totalQty: invoiceTotalQty,
      totalAmount: invoiceTotalAmount,
    });

    dailyData[date][unit].totalQty += invoiceTotalQty;
    dailyData[date][unit].totalAmount += invoiceTotalAmount;
  }

  return dailyData;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-app-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const user = checkAuth(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Get date range from query params (default to current month)
    const { from, to, days } = req.query;
    
    let fromDate, toDate;
    
    if (from && to) {
      fromDate = from;
      toDate = to;
    } else if (days) {
      // Last N days
      const daysNum = parseInt(days) || 7;
      const now = new Date();
      toDate = now.toISOString().split('T')[0];
      const past = new Date(now.getTime() - (daysNum * 24 * 60 * 60 * 1000));
      fromDate = past.toISOString().split('T')[0];
    } else {
      // Current month by default
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      fromDate = `${year}-${month}-01`;
      toDate = now.toISOString().split('T')[0];
    }

    // Cache key based on date range
    const cacheKey = `daily-sales:${fromDate}:${toDate}`;
    
    // Check if we need to refresh (if toDate is today, always refresh)
    const isToday = toDate === new Date().toISOString().split('T')[0];
    const cached = await redis.get(cacheKey);
    
    let dailySales;
    let source;

    if (!isToday && cached) {
      // Use cache for past dates
      dailySales = cached;
      source = 'cache';
    } else {
      // Fetch fresh data
      const token = await getAccessToken();
      const invoices = await fetchInvoicesForDateRange(token, fromDate, toDate);
      dailySales = processDailySales(invoices);
      
      // Cache for 6 hours (today) or 24 hours (past dates)
      const ttl = isToday ? 21600 : 86400;
      await redis.set(cacheKey, dailySales, { ex: ttl });
      
      source = 'fresh';
    }

    // Format response
    const dates = Object.keys(dailySales).sort().reverse(); // Newest first
    const formatted = dates.map(date => ({
      date,
      dateLabel: new Date(date).toLocaleDateString('en-IN', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
      units: Object.keys(dailySales[date])
        .sort()
        .map(unitName => ({
          unit: unitName,
          ...dailySales[date][unitName],
        })),
      dayTotalQty: Object.values(dailySales[date]).reduce((sum, u) => sum + u.totalQty, 0),
      dayTotalAmount: Object.values(dailySales[date]).reduce((sum, u) => sum + u.totalAmount, 0),
    }));

    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({
      dateRange: { from: fromDate, to: toDate },
      dailySales: formatted,
      totalDays: dates.length,
      source,
      fetchedAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error('Daily Sales API Error:', e);
    res.status(500).json({ error: e.message });
  }
}
