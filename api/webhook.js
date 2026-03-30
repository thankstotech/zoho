import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const WEBHOOK_SECRET = process.env.ZOHO_WEBHOOK_SECRET || 'your-secret-here';

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify webhook secret (passed as query param or header)
    const secret = req.query.secret || req.headers['x-webhook-secret'];
    if (secret !== WEBHOOK_SECRET) {
      console.log('Webhook auth failed:', secret);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body = req.body || {};
    
    // Log the webhook event
    console.log('Webhook received:', {
      event: body.event_type,
      module: body.module,
      id: body.data?.invoice_id || body.data?.id,
      timestamp: new Date().toISOString()
    });

    // Check if this is an invoice-related event
    const isInvoiceEvent = 
      body.module === 'invoice' || 
      body.event_type?.includes('invoice') ||
      body.data?.invoice_id;

    if (isInvoiceEvent) {
      // Set the refresh flag for stock
      await redis.set('stock:needs_refresh', true, { ex: 3600 }); // expires in 1 hour
      
      // Also invalidate current month sales cache to force refresh
      const now = new Date();
      const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      await redis.del(`sales:${curMonth}`);
      
      console.log('✓ Stock refresh flag set, sales cache cleared');
      
      return res.status(200).json({ 
        ok: true, 
        message: 'Stock refresh triggered',
        event: body.event_type 
      });
    }

    // For non-invoice events, just acknowledge
    return res.status(200).json({ 
      ok: true, 
      message: 'Event received (no action needed)',
      event: body.event_type 
    });

  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}
