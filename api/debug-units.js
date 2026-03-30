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
  if (!data.access_token) throw new Error('Token refresh failed');
  return data.access_token;
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

/**
 * DEBUG ENDPOINT: View sample billing addresses from recent invoices
 * 
 * Usage: GET /api/debug-units
 * Returns recent invoice billing addresses to help configure unit extraction
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-app-token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const user = checkAuth(req);
    if (!user || user.role !== 'admin') {
      return res.status(401).json({ error: 'Admin only' });
    }

    const token = await getAccessToken();

    // Fetch recent 50 invoices
    const invRes = await fetch(
      `https://www.zohoapis.in/books/v3/invoices?organization_id=${ZOHO_ORG_ID}&per_page=50&sort_order=desc`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const invData = await invRes.json();
    const invoices = invData.invoices || [];

    // Fetch full details for first 20 to get billing addresses
    const detailPromises = invoices.slice(0, 20).map(inv =>
      fetch(
        `https://www.zohoapis.in/books/v3/invoices/${inv.invoice_id}?organization_id=${ZOHO_ORG_ID}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      ).then(r => r.json()).then(d => d.invoice)
    );

    const detailed = await Promise.all(detailPromises);

    // Extract unique billing address patterns
    const addressPatterns = new Map();

    detailed.forEach((inv) => {
      if (inv.billing_address) {
        const addr = inv.billing_address;
        const key = JSON.stringify({
          address: addr.address || addr.street || '',
          city: addr.city || '',
          state: addr.state || '',
          zip: addr.zip || '',
          country: addr.country || '',
        });

        if (!addressPatterns.has(key)) {
          addressPatterns.set(key, {
            address: addr,
            invoiceNumbers: [],
            customerNames: [],
          });
        }

        const pattern = addressPatterns.get(key);
        pattern.invoiceNumbers.push(inv.invoice_number);
        pattern.customerNames.push(inv.customer_name);
      }
    });

    // Format results
    const patterns = Array.from(addressPatterns.values()).map(p => ({
      address: p.address,
      sampleInvoices: p.invoiceNumbers.slice(0, 3),
      sampleCustomers: [...new Set(p.customerNames)].slice(0, 3),
      occurrences: p.invoiceNumbers.length,
    }));

    // Generate suggested unit extraction code
    const suggestions = patterns.map((p, idx) => {
      const addr = p.address;
      const combined = `${addr.address || addr.street || ''} ${addr.city || ''}`.toUpperCase();
      
      return {
        pattern: combined,
        suggestedCode: `if (combined.includes('${addr.city?.toUpperCase() || 'CITY'}')) return '${addr.city || 'Unit'} Unit';`,
        occurrences: p.occurrences,
      };
    });

    res.status(200).json({
      message: 'Billing address patterns from recent 20 invoices',
      patterns,
      suggestions,
      totalInvoicesChecked: detailed.length,
      howToUse: [
        '1. Review the "patterns" array to see actual billing addresses',
        '2. Identify common patterns (city names, warehouse codes, etc.)',
        '3. Copy suggested code snippets into extractUnit() function in daily-sales.js',
        '4. Customize the return values to match your unit names',
        '5. Redeploy and test',
      ],
      exampleCode: `
function extractUnit(billingAddress) {
  if (!billingAddress) return 'Unit 1';
  
  const addr = billingAddress.address || billingAddress.street || '';
  const city = billingAddress.city || '';
  const combined = \`\${addr} \${city}\`.toUpperCase();
  
  // Add these patterns based on the suggestions above:
  ${suggestions.slice(0, 5).map(s => s.suggestedCode).join('\n  ')}
  
  return 'Unit 1'; // Default fallback
}
      `.trim(),
    });

  } catch (error) {
    console.error('Debug Units Error:', error);
    res.status(500).json({ error: error.message });
  }
}
