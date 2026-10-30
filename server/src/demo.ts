// Demo mode (DEMO=1), for a public try-it-out server: no sign-in form. Every
// visitor gets a guest account of their own, cloned from the admin's
// (playlists, likes, follows, history, settings), so the Home page is full and
// one visitor's queue never shows up on another's screen. Guests can play,
// like and edit their own playlists; everything that changes the server
// (settings, scans, accounts, uploads, downloads) is refused. Guests that have
// not been seen for a day are removed.
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { playlistId, token as newToken, userId } from './ids.js';
import { publicUser, type User } from './auth.js';

export const GUEST_PREFIX = 'Guest ';
const GUEST_TTL = 24 * 3600000;

// What a guest may change: their own listening, nothing of the server's.
const GUEST_WRITES: [string, RegExp][] = [
  ['POST', /^\/api\/auth\/logout$/],
  ['POST', /^\/api\/plays$/],
  ['POST', /^\/api\/stream\/warm$/],
  ['POST', /^\/api\/reports$/],
  ['PATCH', /^\/api\/prefs$/],
  ['PUT', /^\/api\/likes\/[^/]+$/],
  ['DELETE', /^\/api\/likes\/[^/]+$/],
  ['POST', /^\/api\/playlists$/],
  ['PATCH', /^\/api\/playlists\/[^/]+$/],
  ['DELETE', /^\/api\/playlists\/[^/]+$/],
  ['POST', /^\/api\/playlists\/[^/]+\/(tracks|move)$/],
  ['DELETE', /^\/api\/playlists\/[^/]+\/tracks\/[^/]+$/],
];

export const isGuest = (u?: User) => !!u && u.name.startsWith(GUEST_PREFIX);

const columns = (db: DB, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name as string);

// A copy of every row of `table` the template owns, under the guest's id.
function cloneRows(db: DB, table: string, from: string, to: string) {
  const cols = columns(db, table).filter((c) => c !== 'user_id');
  db.prepare(`INSERT OR IGNORE INTO ${table} (user_id, ${cols.join(', ')}) SELECT ?, ${cols.join(', ')} FROM ${table} WHERE user_id = ?`).run(to, from);
}

export function createGuest(db: DB, templateName: string) {
  const tpl = db.prepare('SELECT id FROM users WHERE name = ?').get(templateName) as { id: string } | undefined;
  const id = userId();
  const name = `${GUEST_PREFIX}${crypto.randomBytes(3).toString('hex')}`;
  const now = Date.now();
  db.transaction(() => {
    db.prepare('INSERT INTO users (id, name, pass_hash, role, must_change_pw, created, last_seen) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(id, name, `!demo-${crypto.randomBytes(16).toString('hex')}`, 'admin', now, now);
    if (!tpl) return;
    for (const t of ['likes', 'album_likes', 'artist_follows', 'plays', 'prefs']) cloneRows(db, t, tpl.id, id);
    const plCols = columns(db, 'playlists').filter((c) => c !== 'id' && c !== 'user_id');
    const ptCols = columns(db, 'playlist_tracks').filter((c) => c !== 'playlist_id');
    for (const p of db.prepare('SELECT id FROM playlists WHERE user_id = ?').all(tpl.id) as { id: string }[]) {
      const nid = playlistId();
      db.prepare(`INSERT INTO playlists (id, user_id, ${plCols.join(', ')}) SELECT ?, ?, ${plCols.join(', ')} FROM playlists WHERE id = ?`).run(nid, id, p.id);
      db.prepare(`INSERT INTO playlist_tracks (playlist_id, ${ptCols.join(', ')}) SELECT ?, ${ptCols.join(', ')} FROM playlist_tracks WHERE playlist_id = ?`).run(nid, p.id);
    }
  })();
  return { id, name, role: 'admin' as const, must_change_pw: 0 };
}

export function removeStaleGuests(db: DB, now = Date.now()) {
  const stale = (db.prepare(`SELECT u.id FROM users u WHERE u.name LIKE ? AND MAX(u.created, COALESCE(u.last_seen, 0), COALESCE((SELECT MAX(last_seen) FROM tokens t WHERE t.user_id = u.id), 0)) < ?`)
    .all(`${GUEST_PREFIX}%`, now - GUEST_TTL) as { id: string }[]).map((r) => r.id);
  db.transaction(() => {
    for (const id of stale) {
      for (const t of ['likes', 'album_likes', 'artist_follows', 'playlists', 'plays', 'prefs']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
  })();
  return stale.length;
}

export function registerDemo(app: FastifyInstance, db: DB, opts: { enabled: boolean; template: string }) {
  // Every server answers, so the sign-in page can ask without a failed request: 204 = not a demo.
  app.post('/api/auth/demo', opts.enabled ? { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } } : {}, async (req, reply) => {
    if (!opts.enabled) return reply.code(204).send();
    const u = createGuest(db, opts.template);
    const t = newToken();
    const device = String((req.body as any)?.device || 'Web').slice(0, 80);
    db.prepare('INSERT INTO tokens (token, user_id, device, kind, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(t, u.id, device, 'web', Date.now(), Date.now());
    return { token: t, user: publicUser(u), demo: true };
  });
  if (!opts.enabled) return;
  // After registerAuth's hook has resolved who is asking.
  app.addHook('preHandler', async (req, reply) => {
    if (!isGuest(req.user)) return;
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/users') return reply.send({ users: [db.prepare('SELECT id, name, role, must_change_pw, created, last_seen FROM users WHERE id = ?').get(req.user!.id)] });
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (GUEST_WRITES.some(([m, re]) => m === req.method && re.test(url))) return;
    return reply.code(403).send({ error: 'Not available in the demo' });
  });
  const sweep = () => { const n = removeStaleGuests(db); if (n) app.log.info(`demo: removed ${n} idle guests`); };
  const timer = setInterval(sweep, 3600000); timer.unref();
  app.addHook('onReady', async () => sweep());
  app.addHook('onClose', async () => clearInterval(timer));
}
