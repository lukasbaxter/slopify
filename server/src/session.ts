// The server owns each account's session: what is playing, where, the
// queue, the clock. Clients connect over WebSocket, sync their clock to the
// server's, and send EVENTS (play, pause, seek, next, previous, queue,
// transfer, progress) stamped with their synced time. The newest event wins
// (so a client that was offline and reconnects with older actions loses to
// what happened since), the session is rebroadcast, and every client
// renders it: the ACTIVE client is the one making sound; the rest mirror.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { DB } from './db.js';
import { userByToken, type User } from './auth.js';

export type Device = { id: string; name: string; kind: string } | null;
export type Session = {
  rev: number; active: string | null; trackId: string | null; queue: string[]; index: number; playing: boolean;
  positionMs: number; anchorAt: number; device: Device; lastEventTs: number; updatedAt: number;
};
type Client = { id: string; uid: string; name: string; kind: string; ws: WebSocket; lastSeen: number; canPlay: boolean };

const Event = z.object({
  type: z.enum(['play', 'pause', 'toggle', 'seek', 'next', 'previous', 'queue', 'transfer', 'progress', 'stop']),
  ts: z.number(), positionMs: z.number().optional(), trackId: z.string().optional(), queue: z.array(z.string()).max(5000).optional(),
  index: z.number().int().optional(), to: z.string().optional(), device: z.object({ id: z.string(), name: z.string(), kind: z.string() }).nullable().optional(), playing: z.boolean().optional(),
});
export type SessionEvent = z.infer<typeof Event>;

let nextClient = 1;
const clients = new Map<string, Client>();          // clientId -> client
const sessions = new Map<string, Session>();        // uid -> session

export const emptySession = (): Session => ({ rev: 0, active: null, trackId: null, queue: [], index: -1, playing: false, positionMs: 0, anchorAt: Date.now(), device: null, lastEventTs: 0, updatedAt: Date.now() });

export function positionNow(s: Session, now = Date.now()) { return s.playing ? s.positionMs + (now - s.anchorAt) : s.positionMs; }

function loadSession(db: DB, uid: string): Session {
  const have = sessions.get(uid);
  if (have) return have;
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(`session:${uid}`) as any;
  const s: Session = row ? { ...emptySession(), ...JSON.parse(row.v), active: null, playing: false } : emptySession();
  sessions.set(uid, s);
  return s;
}
function saveSession(db: DB, uid: string, s: Session) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(`session:${uid}`, JSON.stringify({ trackId: s.trackId, queue: s.queue.slice(0, 5000), index: s.index, positionMs: positionNow(s), device: s.device }));
}

export function applyEvent(s: Session, e: SessionEvent, from: string, now: number): { changed: boolean; reason?: string } {
  const pos = () => positionNow(s, now);
  if (e.type === 'progress') {
    // Only the active client's clock counts, and it never rewinds a newer action.
    if (s.active !== from || e.ts < s.lastEventTs) return { changed: false };
    if (typeof e.positionMs === 'number') { s.positionMs = e.positionMs; s.anchorAt = e.ts; }
    if (typeof e.playing === 'boolean') s.playing = e.playing;
    if (e.trackId && e.trackId !== s.trackId) { s.trackId = e.trackId; s.index = s.queue.indexOf(e.trackId); }
    return { changed: true };
  }
  if (e.ts < s.lastEventTs) return { changed: false, reason: 'stale' }; // newest wins
  s.lastEventTs = e.ts;
  switch (e.type) {
    case 'queue': {
      s.queue = e.queue ?? s.queue; s.index = Math.min(Math.max(0, e.index ?? 0), Math.max(0, s.queue.length - 1)); s.trackId = s.queue[s.index] ?? null;
      s.positionMs = e.positionMs ?? 0; s.anchorAt = now; s.playing = e.playing ?? true;
      if (!s.active) s.active = from;
      break;
    }
    case 'play': { if (e.trackId) { s.trackId = e.trackId; s.index = s.queue.indexOf(e.trackId); } s.positionMs = e.positionMs ?? (s.trackId ? pos() : 0); s.anchorAt = now; s.playing = true; if (!s.active) s.active = from; break; }
    case 'pause': { s.positionMs = e.positionMs ?? pos(); s.anchorAt = now; s.playing = false; break; }
    case 'toggle': { s.positionMs = pos(); s.anchorAt = now; s.playing = !s.playing; break; }
    case 'stop': { s.positionMs = 0; s.anchorAt = now; s.playing = false; break; }
    case 'seek': { s.positionMs = Math.max(0, e.positionMs ?? 0); s.anchorAt = now; break; }
    case 'next': case 'previous': {
      if (!s.queue.length) break;
      const i = e.type === 'next' ? (s.index + 1) % s.queue.length : (e.positionMs ?? pos()) > 3000 ? s.index : Math.max(0, s.index - 1);
      s.index = i; s.trackId = s.queue[i]; s.positionMs = 0; s.anchorAt = now; s.playing = true; break;
    }
    case 'transfer': {
      if (e.to && clients.has(e.to)) s.active = e.to;
      if (e.device !== undefined) s.device = e.device;
      s.positionMs = e.positionMs ?? pos(); s.anchorAt = now; if (e.playing !== undefined) s.playing = e.playing;
      break;
    }
  }
  return { changed: true };
}

export function registerSession(app: FastifyInstance, db: DB) {
  const send = (ws: WebSocket, msg: unknown) => { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); } catch { /* gone */ } };
  const roster = (uid: string) => [...clients.values()].filter((c) => c.uid === uid).map((c) => ({ id: c.id, name: c.name, kind: c.kind, canPlay: c.canPlay, lastSeen: c.lastSeen }));
  const broadcast = (uid: string) => {
    const s = loadSession(db, uid); const now = Date.now();
    const msg = { type: 'session', session: { ...s, positionMs: positionNow(s, now), anchorAt: now }, clients: roster(uid), now };
    for (const c of clients.values()) if (c.uid === uid) send(c.ws, msg);
  };
  app.decorate('sessionOf', (uid: string) => loadSession(db, uid));

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const token = (req.query as any)?.token as string | undefined;
    const user: User | undefined = token ? userByToken(db, token) : undefined;
    if (!user) { send(socket, { type: 'error', error: 'unauthorized' }); socket.close(4001, 'unauthorized'); return; }
    const q = req.query as any;
    const me: Client = { id: `c${nextClient++}`, uid: user.id, name: String(q.name || 'Player').slice(0, 60), kind: String(q.kind || 'web').slice(0, 20), ws: socket, lastSeen: Date.now(), canPlay: q.canPlay !== '0' };
    clients.set(me.id, me);
    const s = loadSession(db, user.id);
    send(socket, { type: 'hello', clientId: me.id, now: Date.now(), session: { ...s, positionMs: positionNow(s), anchorAt: Date.now() }, clients: roster(user.id) });
    for (const c of clients.values()) if (c.uid === user.id && c.id !== me.id) send(c.ws, { type: 'clients', clients: roster(user.id) });

    socket.on('message', (raw: Buffer | string) => {
      let msg: any; try { msg = JSON.parse(String(raw)); } catch { return; }
      me.lastSeen = Date.now();
      if (msg.type === 'ping') { send(socket, { type: 'pong', t0: msg.t0, now: Date.now() }); return; }
      if (msg.type === 'event') {
        const e = Event.safeParse(msg.event); if (!e.success) { send(socket, { type: 'error', error: 'bad event' }); return; }
        const s2 = loadSession(db, user.id);
        const r = applyEvent(s2, e.data, me.id, Date.now());
        if (!r.changed) { if (r.reason) send(socket, { type: 'rejected', reason: r.reason, rev: s2.rev }); return; }
        s2.rev++; s2.updatedAt = Date.now();
        if (e.data.type !== 'progress') { saveSession(db, user.id, s2); app.log.debug({ uid: user.id, client: me.id, event: e.data.type }, 'session event'); }
        // A play started on this session: record it (the play log feeds Home).
        if ((e.data.type === 'play' || e.data.type === 'queue' || e.data.type === 'next' || e.data.type === 'previous') && s2.trackId) {
          const last = db.prepare('SELECT track_id, at FROM plays WHERE user_id = ? ORDER BY at DESC LIMIT 1').get(user.id) as any;
          if (!(last && last.track_id === s2.trackId && Date.now() - last.at < 60000)) db.prepare('INSERT OR IGNORE INTO plays (user_id, track_id, at, client) VALUES (?, ?, ?, ?)').run(user.id, s2.trackId, Date.now(), me.name);
        }
        broadcast(user.id);
      }
    });
    socket.on('close', () => {
      clients.delete(me.id);
      const s3 = sessions.get(user.id);
      if (s3 && s3.active === me.id) { s3.positionMs = positionNow(s3); s3.anchorAt = Date.now(); s3.playing = false; s3.active = null; s3.rev++; saveSession(db, user.id, s3); }
      broadcast(user.id);
    });
  });

  // Same state over plain HTTP (a client with no socket yet, tests).
  app.get('/api/session', { preHandler: (app as any).requireUser }, async (req) => { const s = loadSession(db, req.user!.id); return { session: { ...s, positionMs: positionNow(s), anchorAt: Date.now() }, clients: roster(req.user!.id), now: Date.now() }; });
}
