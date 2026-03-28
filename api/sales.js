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

const CACHE_KEY = 'sales:cached_data';
const CACHE_TTL = 43200;

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

async function fetchInvoices(token, fromDate, toDate) {
  let page = 1;
  let allInvoices = [];

  const params = new URLSearchParams({
    organization_id: ZOHO_ORG_ID,
    page: String(page),
    per_page: '200',
    sort_by: 'date',
    sort_order: 'A',
  });
  if (fromDate) params.set('date_start', fromDate);
  if (toDate) params.set('date_end', toDate);

  while (true) {
    params.set('page', String(page));
    const res = await fetch(`https://www.zohoapis.in/books/v3/invoices?${params}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const data = await res.json();
    if (!data.invoices?.length) break;
    allInvoices = allInvoices.concat(data.invoices);
    if (!data.page_context?.has_more_page) break;
    page++;
  }

  return allInvoices;
}

async function fetchInvoiceLineItems(token, invoiceId) {
  const res = await fetch(
    `https://www.zohoapis.in/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORG_ID}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const data = await res.json();
  return data.invoice?.line_items || [];
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
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-app-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = checkAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { from, to, unit } = req.query;
    const forceRefresh = req.query.force === 'true';
    const needsRefresh = await redis.get('sales:needs_refresh');

    const cached = await redis.get(CACHE_KEY);
    const cacheAge = cached ? Date.now() - cached.timestamp : Infinity;
    const cacheExpired = cacheAge > (CACHE_TTL * 1000);

    let rawInvoices;

    if (forceRefresh || needsRefresh || !cached || cacheExpired) {
      const token = await getAccessToken();
      rawInvoices = await fetchInvoices(token, from, to);

      // Fetch line items in batches of 20
      const lineItems = [];
      const BATCH_SIZE = 20;
      for (let i = 0; i < rawInvoices.length; i += BATCH_SIZE) {
        const batch = rawInvoices.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(inv => fetchInvoiceLineItems(token, inv.invoice_id))
        );
        batch.forEach((inv, idx) => {
          (results[idx] || []).forEach((li, sNo) => {
            lineItems.push({
              date: inv.date,
              invoiceId: inv.invoice_id,
              invoiceNumber: inv.invoice_number || inv.invoice_id,
              customerName: inv.customer_name || 'Unknown',
              sNo: sNo + 1,
              itemName: li.item_name || li.name || 'Unknown',
              quantity: parseFloat(li.quantity) || 0,
              unit: li.unit || 'NOS',
              rate: parseFloat(li.rate) || 0,
              amount: parseFloat(li.amount) || 0,
              itemId: li.item_id || null,
            });
          });
        });
      }

      const salesData = {
        lineItems,
        cachedAt: new Date().toISOString(),
      };

      await redis.set(CACHE_KEY, salesData, { ex: CACHE_TTL });
      await redis.del('sales:needs_refresh');

      rawInvoices = salesData;
    } else {
      rawInvoices = cached;
    }

    let lineItems = rawInvoices.lineItems || [];

    // Client-side filter by unit if specified
    if (unit && unit !== 'all') {
      lineItems = lineItems.filter(li => li.unit.toLowerCase() === unit.toLowerCase());
    }

    // Group by unit, then date, then invoice
    const byUnit = {};
    lineItems.forEach(li => {
      const u = li.unit || 'Unknown';
      if (!byUnit[u]) byUnit[u] = [];
      byUnit[u].push(li);
    });

    // Sort units alphabetically
    const sortedUnits = Object.keys(byUnit).sort();

    // Build grouped structure
    const grouped = sortedUnits.map(u => {
      const items = byUnit[u];
      // Group by date
      const byDate = {};
      items.forEach(li => {
        const d = li.date || 'Unknown';
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(li);
      });
      // Sort dates descending
      const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
      const totalQty = items.reduce((s, li) => s + li.quantity, 0);
      const totalAmount = items.reduce((s, li) => s + li.amount, 0);
      return {
        unit: u,
        totalQty,
        totalAmount,
        dates: sortedDates.map(d => ({
          date: d,
          items: byDate[d].sort((a, b) => (a.invoiceNumber > b.invoiceNumber ? 1 : -1)),
        })),
      };
    });

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({
      groups: grouped,
      units: sortedUnits,
      totalQty: grouped.reduce((s, g) => s + g.totalQty, 0),
      totalAmount: grouped.reduce((s, g) => s + g.totalAmount, 0),
      from: from || null,
      to: to || null,
      filterUnit: unit || 'all',
      cachedAt: rawInvoices.cachedAt,
      cacheAgeMinutes: Math.round(cacheAge / 1000 / 60),
    });
  } catch (e) {
    console.error('Sales API Error:', e);
    res.status(500).json({ error: e.message });
  }
}
