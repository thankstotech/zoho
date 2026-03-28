import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const APP_SECRET = process.env.APP_SECRET;

function makeToken(payload) {
  const sig = Buffer.from(
    JSON.stringify({ email: payload.email, role: payload.role, wh: payload.wh, iat: payload.iat }) + APP_SECRET
  ).toString('base64').slice(0, 16);
  return Buffer.from(JSON.stringify({ ...payload, sig })).toString('base64');
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

const DEFAULT_SETTINGS = {
  categoryOrder: [
    { name: 'Coupling', keyword: 'coupling' },
    { name: 'Elbow', keyword: 'elbow' },
    { name: 'Tee', keyword: 'tee' },
    { name: 'Valve Gate', keyword: 'valve gate' },
    { name: 'Valve Ball', keyword: 'valve ball' },
    { name: 'Reducer', keyword: 'reducer' },
    { name: 'End Cap', keyword: 'end cap' },
    { name: 'Flange', keyword: 'flange' },
    { name: 'Union', keyword: 'union' },
  ],
  itemOverrides: {},
};

const DEFAULT_USERS = [
  { email: 'admin', password: 'Matrix', role: 'admin', wh: 'both', active: true }
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = {};
  try { body = await req.json(); } catch {}

  const { action } = req.query;

  // ── LOGIN (no auth needed) ───────────────────────────────────
  if (action === 'login' && req.method === 'POST') {
    const { email, password } = body;
    let users = await redis.get('app:users');
    if (!users) { users = DEFAULT_USERS; await redis.set('app:users', users); }
    const user = users.find(u =>
      u.email.toLowerCase() === email.toLowerCase() &&
      u.password === password &&
      u.active !== false
    );
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const iat = Date.now();
    const token = makeToken({ email: user.email, role: user.role, wh: user.wh, iat });
    return res.status(200).json({ token, role: user.role, wh: user.wh, email: user.email });
  }

  // ── Auth required ────────────────────────────────────────────
  const user = checkAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // ── GET SETTINGS ─────────────────────────────────────────────
  if (action === 'get-settings' && req.method === 'GET') {
    const settings = await redis.get('app:settings') || DEFAULT_SETTINGS;
    return res.status(200).json(settings);
  }

  // ── SAVE SETTINGS ────────────────────────────────────────────
  if (action === 'save-settings' && req.method === 'POST') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const current = await redis.get('app:settings') || DEFAULT_SETTINGS;
    await redis.set('app:settings', { ...current, ...body });
    return res.status(200).json({ ok: true });
  }

  // ── GET USERS ─────────────────────────────────────────────────
  if (action === 'get-users' && req.method === 'GET') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const users = await redis.get('app:users') || DEFAULT_USERS;
    return res.status(200).json(users.map(u => ({ email: u.email, role: u.role, wh: u.wh, active: u.active })));
  }

  // ── SAVE USERS ────────────────────────────────────────────────
  if (action === 'save-users' && req.method === 'POST') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { users: newUsers } = body;
    const existing = await redis.get('app:users') || DEFAULT_USERS;
    const merged = newUsers.map(u => {
      const prev = existing.find(e => e.email.toLowerCase() === u.email.toLowerCase());
      return { ...u, password: u.password || prev?.password || '' };
    });
    if (!merged.some(u => u.email === 'admin')) {
      merged.unshift(existing.find(u => u.email === 'admin') || DEFAULT_USERS[0]);
    }
    await redis.set('app:users', merged);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
