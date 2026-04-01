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

// Process invoices into daily structure
function processDailyData(invoices) {
  const dailyData = {}; // { 'YYYY-MM-DD': { date, rows[], totals } }

  for (const inv of invoices) {
    const date = inv.date || '';
    if (!date) continue;

    const customer = inv.customer_name || '';
    const invoiceNo = inv.invoice_number || '';

    // Initialize date structure
    if (!dailyData[date]) {
      dailyData[date] = { date, rows: [] };
    }

    // Process each line item as a separate row
    const lineItems = inv.line_items || [];
    for (const li of lineItems) {
      dailyData[date].rows.push({
        invoiceNo,
        customer,
        itemName: li.item_name || li.name || '',
        description: li.description || '',
        qty: parseFloat(li.quantity) || 0,
        unit: li.unit || 'Nos', // Default to Nos if no unit specified
        amount: parseFloat(li.item_total) || parseFloat(li.amount) || 0,
      });
    }
  }

  // Calculate totals for each day
  for (const date in dailyData) {
    const rows = dailyData[date].rows;
    
    // Total amount
    const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0);
    
    // Qty by unit (pivot)
    const qtyByUnit = {};
    rows.forEach(r => {
      const unit = r.unit || 'Nos';
      qtyByUnit[unit] = (qtyByUnit[unit] || 0) + r.qty;
    });
    
    // Total qty (sum across all units)
    const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);

    dailyData[date].totalAmount = totalAmount;
    dailyData[date].totalQty = totalQty;
    dailyData[date].qtyByUnit = qtyByUnit;
    
    // Date label
    dailyData[date].dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
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

    const DAYS_TO_SHOW = 30; // Last 30 days
    const today = new Date().toISOString().split('T')[0];
    
    // Generate list of dates to fetch (last 30 days)
    const dates = [];
    for (let i = 0; i < DAYS_TO_SHOW; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    // Check cache for each date
    const cachedDays = {};
    const missingDates = [];

    for (const date of dates) {
      const cacheKey = `sales:${date}`;
      const cached = await redis.get(cacheKey);

      if (date === today) {
        // Today: only use cache if < 30 min old
        if (cached?.fetchedAt) {
          const age = Date.now() - new Date(cached.fetchedAt).getTime();
          if (age < 1800000) { // 30 minutes
            cachedDays[date] = cached;
          } else {
            missingDates.push(date);
          }
        } else {
          missingDates.push(date);
        }
      } else {
        // Past dates: use cache if exists (cached forever)
        if (cached) {
          cachedDays[date] = cached;
        } else {
          missingDates.push(date);
        }
      }
    }

    // Fetch missing dates from Zoho
    if (missingDates.length > 0) {
      const fromDate = missingDates[missingDates.length - 1]; // Oldest
      const toDate = missingDates[0]; // Newest
      
      const token = await getAccessToken();
      const invoices = await fetchInvoicesForDateRange(token, fromDate, toDate);
      const dailyData = processDailyData(invoices);

      // Cache each day
      for (const date of missingDates) {
        const dayData = dailyData[date] || {
          date,
          dateLabel: new Date(date + 'T00:00:00').toLocaleDateString('en-IN', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
          rows: [],
          totalAmount: 0,
          totalQty: 0,
          qtyByUnit: {},
        };

        dayData.fetchedAt = new Date().toISOString();
        dayData.isToday = date === today;

        // Cache TTL: 30 min for today, no expiry for past dates
        const ttl = date === today ? 1800 : 2592000; // 30 days for past (effectively permanent)
        await redis.set(`sales:${date}`, dayData, { ex: ttl });
        
        cachedDays[date] = dayData;
      }
    }

    // Build response (dates sorted newest first)
    const days = dates
      .map(d => cachedDays[d])
      .filter(Boolean)
      .map(day => ({
        ...day,
        isToday: day.date === today,
      }));

    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=1800');
    res.status(200).json({
      days,
      fetchedAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error('Sales API Error:', e);
    res.status(500).json({ error: e.message });
  }
}
