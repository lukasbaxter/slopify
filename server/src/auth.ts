// Accounts: argon2id passwords, opaque device tokens, two roles. The first
// admin comes from the environment (default admin/admin, forced to change on
// first login). Admins invite users by link and promote/demote them.
import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import { token as newToken, userId } from './ids.js';
import { config } from './config.js';

export type User = { id: string; name: string; role: 'admin' | 'user'; must_change_pw: number };
declare module 'fastify' { interface FastifyRequest { user?: User; tokenId?: string } }

const INVITE_TTL = 7 * 86400000;

export async function ensureAdmin(db: DB, name: string, pass: string) {
  const n = (db.prepare('SELECT COUNT(*) n FROM users').get() as any).n;
  if (n > 0) return;
  const hash = await argon2.hash(pass, { type: argon2.argon2id });
  const weak = pass === 'admin';
  db.prepare('INSERT INTO users (id, name, pass_hash, role, must_change_pw, created) VALUES (?, ?, ?, ?, ?, ?)').run(userId(), name, hash, 'admin', weak ? 1 : 0, Date.now());
}

export function userByToken(db: DB, tok: string): User | undefined {
  const row = db.prepare('SELECT u.id, u.name, u.role, u.must_change_pw, t.last_seen AS seen FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?').get(tok) as (User & { seen?: number }) | undefined;
  // Once a minute per token: a phone streaming HLS makes 50+ requests a track.
  if (row && Date.now() - (row.seen || 0) > 60000) db.prepare('UPDATE tokens SET last_seen = ? WHERE token = ?').run(Date.now(), tok);
  if (row) delete row.seen;
  return row;
}

// Bearer, Jellyfin's MediaBrowser Token="..." / X-Emby-Token, or ?token= /
// ?api_key= for media URLs.
export function tokenFromRequest(req: FastifyRequest): string | null {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ')) return h.slice(7);
  // <audio>, <img> and speakers cannot send headers: the token rides in the URL.
  const q = (req.query as any) || {};
  return typeof q.token === 'string' && q.token ? q.token : null;
}

export const publicUser = (u: User) => ({ id: u.id, name: u.name, role: u.role, mustChangePassword: !!u.must_change_pw });

export function registerAuth(app: FastifyInstance, db: DB) {
  // Every request: resolve the token if there is one.
  app.addHook('onRequest', async (req) => {
    const t = tokenFromRequest(req);
    if (t) { const u = userByToken(db, t); if (u) { req.user = u; req.tokenId = t; } }
  });
  app.decorate('requireUser', async (req: FastifyRequest, reply: FastifyReply) => { if (!req.user) return reply.code(401).send({ error: 'unauthorized' }); });
  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => { if (!req.user) return reply.code(401).send({ error: 'unauthorized' }); if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin only' }); });

  const Login = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256), device: z.string().max(80).default('web'), kind: z.enum(['web', 'desktop', 'phone', 'service']).default('web') });
  app.post('/api/auth/login', { config: { rateLimit: { max: config.loginRateMax, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = Login.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad request', issues: body.error.issues });
    const u = db.prepare('SELECT id, name, role, must_change_pw, pass_hash FROM users WHERE name = ?').get(body.data.username) as (User & { pass_hash: string }) | undefined;
    if (!u || !(await argon2.verify(u.pass_hash, body.data.password))) return reply.code(401).send({ error: 'wrong username or password' });
    const t = newToken();
    db.prepare('INSERT INTO tokens (token, user_id, device, kind, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(t, u.id, body.data.device, body.data.kind, Date.now(), Date.now());
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), u.id);
    return { token: t, user: publicUser(u) };
  });
  app.post('/api/auth/logout', { preHandler: (app as any).requireUser }, async (req) => { db.prepare('DELETE FROM tokens WHERE token = ?').run(req.tokenId); return { ok: true }; });
  app.get('/api/auth/me', { preHandler: (app as any).requireUser }, async (req) => publicUser(req.user!));

  const Password = z.object({ current: z.string().optional(), password: z.string().min(8).max(256) });
  app.post('/api/auth/password', { preHandler: (app as any).requireUser }, async (req, reply) => {
    const body = Password.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    const row = db.prepare('SELECT pass_hash, must_change_pw FROM users WHERE id = ?').get(req.user!.id) as any;
    if (!row.must_change_pw && !(body.data.current && (await argon2.verify(row.pass_hash, body.data.current)))) return reply.code(401).send({ error: 'current password is wrong' });
    db.prepare('UPDATE users SET pass_hash = ?, must_change_pw = 0 WHERE id = ?').run(await argon2.hash(body.data.password, { type: argon2.argon2id }), req.user!.id);
    // Other sessions of this account are logged out; this one stays.
    db.prepare('DELETE FROM tokens WHERE user_id = ? AND token != ?').run(req.user!.id, req.tokenId);
    return { ok: true };
  });
  app.get('/api/auth/devices', { preHandler: (app as any).requireUser }, async (req) => ({
    devices: (db.prepare('SELECT token, device, kind, created, last_seen FROM tokens WHERE user_id = ? ORDER BY last_seen DESC').all(req.user!.id) as any[]).map((t) => ({ id: t.token.slice(0, 8), device: t.device, kind: t.kind, created: t.created, lastSeen: t.last_seen, current: t.token === req.tokenId })),
  }));
  app.delete('/api/auth/devices/:id', { preHandler: (app as any).requireUser }, async (req) => {
    const id = (req.params as any).id as string;
    db.prepare('DELETE FROM tokens WHERE user_id = ? AND substr(token, 1, 8) = ?').run(req.user!.id, id);
    return { ok: true };
  });

  // --- admin: users, roles, invites ---
  app.get('/api/users', { preHandler: (app as any).requireAdmin }, async () => ({ users: db.prepare('SELECT id, name, role, must_change_pw, created, last_seen FROM users ORDER BY name').all() }));
  const Role = z.object({ role: z.enum(['admin', 'user']) });
  app.post('/api/users/:id/role', { preHandler: (app as any).requireAdmin }, async (req, reply) => {
    const body = Role.safeParse(req.body); if (!body.success) return reply.code(400).send({ error: 'role must be admin or user' });
    const id = (req.params as any).id as string;
    if (id === req.user!.id && body.data.role !== 'admin') return reply.code(400).send({ error: 'you cannot demote yourself' });
    const r = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.data.role, id);
    if (!r.changes) return reply.code(404).send({ error: 'no such user' });
    return { ok: true };
  });
  app.delete('/api/users/:id', { preHandler: (app as any).requireAdmin }, async (req, reply) => {
    const id = (req.params as any).id as string;
    if (id === req.user!.id) return reply.code(400).send({ error: 'you cannot delete yourself' });
    const r = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (!r.changes) return reply.code(404).send({ error: 'no such user' });
    return { ok: true };
  });
  app.post('/api/invites', { preHandler: (app as any).requireAdmin }, async () => {
    const code = newToken();
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run(`invite:${code}`, String(Date.now() + INVITE_TTL));
    return { code, expires: Date.now() + INVITE_TTL };
  });
  const Register = z.object({ invite: z.string().min(1), username: z.string().regex(/^[a-z0-9_.-]{2,32}$/i, 'letters, digits, . _ - only'), password: z.string().min(8).max(256) });
  app.post('/api/auth/register', { config: { rateLimit: { max: config.loginRateMax, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = Register.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message || 'bad request' });
    const inv = db.prepare('SELECT v FROM kv WHERE k = ?').get(`invite:${body.data.invite}`) as any;
    if (!inv || Number(inv.v) < Date.now()) return reply.code(400).send({ error: 'invite is invalid or expired' });
    if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(body.data.username)) return reply.code(409).send({ error: 'that name is taken' });
    const id = userId();
    db.prepare('INSERT INTO users (id, name, pass_hash, role, must_change_pw, created) VALUES (?, ?, ?, ?, 0, ?)').run(id, body.data.username, await argon2.hash(body.data.password, { type: argon2.argon2id }), 'user', Date.now());
    db.prepare('DELETE FROM kv WHERE k = ?').run(`invite:${body.data.invite}`);
    const t = newToken();
    db.prepare('INSERT INTO tokens (token, user_id, device, kind, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(t, id, 'web', 'web', Date.now(), Date.now());
    return { token: t, user: { id, name: body.data.username, role: 'user', mustChangePassword: false } };
  });
}
