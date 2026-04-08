import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST method' });
  }

  try {
    console.log('🗑️  Starting cache clear...');
    
    // Delete all sales cache keys for last 60 days
    const dates = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    let deleted = 0;
    for (const date of dates) {
      const key = `sales:${date}`;
      const result = await redis.del(key);
      if (result) {
        deleted++;
        console.log(`   Deleted: ${key}`);
      }
    }

    console.log(`✅ Cleared ${deleted} cached sales dates`);
    
    return res.status(200).json({ 
      ok: true, 
      deleted,
      dates: dates.slice(0, 5), // Show first 5 dates as sample
      message: `Sales cache cleared - ${deleted} days deleted`
    });
  } catch (e) {
    console.error('❌ Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
