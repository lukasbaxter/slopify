// The phone app's two addresses (mobile/App.js): the one it is set up with
// and the server's home-network one, used whenever the phone can reach it so
// music streams straight over Wi-Fi. Nobody types the home address: a
// signed-in app asks here.
//
// A home address is usually plain http on a private IP, and the same IP on
// someone else's Wi-Fi is someone else's machine. Before the app loads that
// address or hands it the sign-in, it asks it to prove it is this server:
// HMAC(key, nonce), with a key only a signed-in app of this account gets.
// The proof is only given to a client on a private network: someone with the
// key's owner's userId could otherwise relay a nonce through the public
// address and have the real server answer for an impostor.
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from './db.js';

const SECRET = 'shell_secret';
const ORIGINS = 'public_origins'; // { origin: last seen ms }
const MAX_ORIGINS = 5;
const ORIGIN_TTL = 30 * 24 * 3600e3;

// RFC 1918, CGNAT (Tailscale), loopback, link-local, IPv6 ULA / link-local.
export function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, '');
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(v);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return v === '::1' || /^f[cd][0-9a-f]{2}:/i.test(v) || /^fe[89ab][0-9a-f]:/i.test(v);
}

// The https origin a request came in through, when it is a name people use
// from anywhere (not an IP, not .local, not a one-word LAN name).
export function publicOriginOf(proto: string, host: string): string | null {
  if (proto !== 'https' || !host) return null;
  const h = host.toLowerCase();
  const name = h.replace(/:\d+$/, '');
  if (!/^[a-z0-9.-]+$/.test(name) || !name.includes('.') || name.endsWith('.local') || name === 'localhost' || /^[\d.]+$/.test(name)) return null;
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(h)) return null;
  return `https://${h.replace(/:443$/, '')}`;
}

export function registerAddresses(app: FastifyInstance, db: DB, opts: { lanUrl: () => string }) {
  const kvGet = (k: string) => (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined)?.v;
  const kvSet = (k: string, v: string) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  let secret = kvGet(SECRET);
  if (!secret) { db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING').run(SECRET, crypto.randomBytes(32).toString('hex')); secret = kvGet(SECRET)!; }
  const keyFor = (userId: string) => crypto.createHmac('sha256', secret!).update(`shell:${userId}`).digest('hex');
  const proofOf = (key: string, nonce: string) => crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(nonce).digest('hex');

  let seen: Record<string, number> = {};
  try { seen = JSON.parse(kvGet(ORIGINS) || '{}') || {}; } catch { seen = {}; }
  const current = () => Object.entries(seen).filter(([, at]) => Date.now() - at < ORIGIN_TTL).sort((a, b) => b[1] - a[1]).map(([o]) => o);

  // The internet addresses signed-in people reach this server at, learnt as
  // they use it (whatever the reverse proxy forwards), so an app set up on
  // the LAN knows where to go when it leaves. Written at most hourly per name.
  app.addHook('onResponse', async (req: FastifyRequest & { user?: { id: string } }, reply) => {
    if (!req.user || reply.statusCode >= 400) return;
    const o = publicOriginOf(req.protocol, req.host);
    if (!o) return;
    const now = Date.now();
    if (seen[o] && now - seen[o] < 3600e3) return;
    seen[o] = now;
    seen = Object.fromEntries(Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, MAX_ORIGINS));
    try { kvSet(ORIGINS, JSON.stringify(seen)); } catch { /* read-only db: keep it in memory */ }
  });

  // What a signed-in phone app needs: its key for checking the home address,
  // the home address, and the internet addresses.
  app.get('/api/server/addresses', { preHandler: (app as any).requireUser }, async (req: FastifyRequest & { user?: { id: string } }) => ({
    key: keyFor(req.user!.id),
    lan: opts.lanUrl() || null,
    public: current(),
  }));

  app.get('/api/server/proof', async (req, reply) => {
    const q = req.query as { u?: string; n?: string };
    if (!isPrivateIp(req.ip)) return reply.code(404).send({ error: 'not found' });
    if (!q.u || !/^[\w-]{1,64}$/.test(q.u) || !q.n || !/^[0-9a-f]{16,128}$/.test(q.n)) return reply.code(400).send({ error: 'bad request' });
    reply.header('Cache-Control', 'no-store');
    return { proof: proofOf(keyFor(q.u), q.n) };
  });
}
