// The server owns each account's session: what is playing, where, the
// queue, the clock. Every client of the account keeps one WebSocket here
// (/api/ws): it announces itself, reports what it is playing (the ACTIVE
// client is the one making sound; the rest mirror it), publishes its queue
// and the speakers it can reach, and routes commands to whichever client is
// active. Positions are anchored to the server clock, so a client that comes
// back after a gap gets the position as it is now, and the newest event
// wins over anything an offline client sends late (applyEvent).
//
// The remembered session (last track, queue, position) is persisted, so a
// fresh client with nothing local shows what was playing last even when no
// other client is around.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { DB } from './db.js';
import { userByToken } from './auth.js';
import { token as newToken } from './ids.js';
import { Discovery } from './speakers/discovery.js';
import { ServerPlayer } from './speakers/player.js';

export type Device = { id: string; name: string; kind: string } | null;
export type Session = {
  rev: number; active: string | null; trackId: string | null; queue: string[]; index: number; playing: boolean;
  positionMs: number; anchorAt: number; device: Device; lastEventTs: number; updatedAt: number;
  // What the active client last reported (title, art, volume...), for mirrors; and its queue rows.
  nowPlaying: any; queueItems: any[];
};
type Client = { id: string; uid: string; name: string; kind: string; send: (obj: unknown) => void; close: () => void; net: string; lastSeen: number; canPlay: boolean; devices: any[]; nowPlaying: any; queue: any[] | null; _lastPlayId?: string; player?: ServerPlayer };

export const Event = z.object({
  type: z.enum(['play', 'pause', 'toggle', 'seek', 'next', 'previous', 'queue', 'transfer', 'progress', 'stop']),
  ts: z.number(), positionMs: z.number().optional(), trackId: z.string().optional(), queue: z.array(z.string()).max(5000).optional(),
  index: z.number().int().optional(), to: z.string().optional(), device: z.object({ id: z.string(), name: z.string(), kind: z.string() }).nullable().optional(), playing: z.boolean().optional(),
});
export type SessionEvent = z.infer<typeof Event>;

const clients = new Map<string, Client>();          // clientId -> client
const sessions = new Map<string, Session>();        // uid -> session
const saveTimers = new Map<string, NodeJS.Timeout>();

export const emptySession = (): Session => ({ rev: 0, active: null, trackId: null, queue: [], index: -1, playing: false, positionMs: 0, anchorAt: Date.now(), device: null, lastEventTs: 0, updatedAt: Date.now(), nowPlaying: null, queueItems: [] });

export function positionNow(s: Session, now = Date.now()) { return s.playing ? s.positionMs + (now - s.anchorAt) : s.positionMs; }

function loadSession(db: DB, uid: string): Session {
  const have = sessions.get(uid);
  if (have) return have;
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(`session:${uid}`) as any;
  const s: Session = row ? { ...emptySession(), ...JSON.parse(row.v), active: null, playing: false } : emptySession();
  sessions.set(uid, s);
  return s;
}
function saveSession(db: DB, uid: string, s: Session, log: (m: string) => void) {
  if (saveTimers.has(uid)) return;
  saveTimers.set(uid, setTimeout(() => {
    saveTimers.delete(uid);
    const np = s.nowPlaying ? { ...s.nowPlaying, playing: false, position: positionNow(s) / 1000 } : null;
    try { db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(`session:${uid}`, JSON.stringify({ trackId: s.trackId, queue: s.queue.slice(0, 5000), index: s.index, positionMs: positionNow(s), device: s.device, nowPlaying: np, queueItems: s.queueItems.slice(0, 5000), updatedAt: s.updatedAt })); }
    catch (e: any) { log(`session save: ${e.message}`); }
  }, 1500));
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

const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|fc|fd|::1)/.test(ip);
// Which network a client is on: 'lan' for the house, else its public address.
// Speakers found by one client are offered only to clients on the same network.
function networkOf(req: FastifyRequest) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  let ip = xff[xff.length - 1] || req.socket.remoteAddress || 'unknown';
  ip = ip.replace(/^::ffff:/, '');
  return isPrivate(ip) ? 'lan' : ip;
}
const wsSend = (ws: WebSocket) => (obj: unknown) => { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch { /* gone */ } };
const send = (c: Client, obj: unknown) => c.send(obj);
const ofUser = (uid: string) => [...clients.values()].filter((c) => c.uid === uid);

export type SessionOptions = { speakers?: boolean; publicUrl?: string };

export function registerSession(app: FastifyInstance, db: DB, opts: SessionOptions = {}) {
  const log = (m: string) => app.log.error(m);
  const offsetsAll = () => Object.fromEntries((db.prepare("SELECT k, v FROM kv WHERE k LIKE 'offset:%'").all() as any[]).map((r) => [r.k.slice(7), Number(r.v)]));
  const rosterFor = (self: Client, s: Session) => {
    const players: any[] = [], lanDevices: any[] = [];
    for (const c of ofUser(self.uid)) {
      if (c.id !== self.id) players.push({ id: c.id, name: c.name, kind: c.kind, canPlay: c.canPlay, nowPlaying: c.nowPlaying || null, sameNetwork: c.kind === 'server' || c.net === self.net });
      // The server's speakers are for everyone; a client's own only for clients on its network.
      if (c.kind === 'server' || c.net === self.net) for (const d of c.devices || []) lanDevices.push({ ...d, viaClient: c.id });
    }
    return { type: 'roster', players, lanDevices, activeClientId: s.active };
  };
  const broadcastRoster = (uid: string) => { const s = loadSession(db, uid); for (const c of ofUser(uid)) send(c, rosterFor(c, s)); };
  // The remembered session, with the position as it is now.
  const sessionMsg = (s: Session) => (s.nowPlaying ? { type: 'session', nowPlaying: { ...s.nowPlaying, playing: s.playing, position: positionNow(s) / 1000 }, queue: s.queueItems || [], at: s.updatedAt } : null);
  const logPlay = (uid: string, trackId: string, client: string) => {
    const last = db.prepare('SELECT track_id, at FROM plays WHERE user_id = ? ORDER BY at DESC LIMIT 1').get(uid) as any;
    if (!(last && last.track_id === trackId && Date.now() - last.at < 60000)) { db.prepare('INSERT OR IGNORE INTO plays (user_id, track_id, at, client) VALUES (?, ?, ?, ?)').run(uid, trackId, Date.now(), client); (app as any).scrobbleStart?.(uid, trackId, Date.now()); }
  };
  app.decorate('sessionOf', (uid: string) => loadSession(db, uid));
  // Likes changed over HTTP reach the open clients too.
  app.decorate('sessionLike', (uid: string, itemId: string, liked: boolean, at: number) => { for (const c of ofUser(uid)) send(c, { type: 'like', itemId, liked, at }); });

  // --- the server's own speakers -----------------------------------------------
  // One virtual client per account ("Home speakers") carries the speakers the
  // server found and, once a session is put on one, plays it (ServerPlayer).
  const discovery = opts.speakers ? new Discovery((list) => { for (const c of clients.values()) if (c.kind === 'server') c.devices = list; for (const uid of new Set([...clients.values()].map((c) => c.uid))) broadcastRoster(uid); }, (m) => app.log.warn(m)) : null;
  if (discovery) { discovery.start(); app.addHook('onClose', async () => { discovery.stop(); for (const c of clients.values()) await c.player?.stopAll(); }); }
  const speakerToken = (uid: string) => {
    const row = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND kind = 'speaker' LIMIT 1").get(uid) as any;
    if (row) return row.token as string;
    const t = newToken();
    db.prepare('INSERT INTO tokens (token, user_id, device, kind, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(t, uid, 'Home speakers', 'speaker', Date.now(), Date.now());
    return t;
  };
  const serverClientFor = (uid: string): Client | null => {
    if (!discovery) return null;
    const id = `server:${uid}`;
    const have = clients.get(id); if (have) return have;
    const c: Client = { id, uid, name: 'Home speakers', kind: 'server', canPlay: false, net: 'lan', lastSeen: Date.now(), devices: discovery.list(), nowPlaying: null, queue: null, close: () => {}, send: () => {} };
    c.send = (obj: any) => { if (obj?.type === 'command') void c.player?.execute(obj.command); };
    c.player = new ServerPlayer(uid, {
      db, discovery, publicUrl: opts.publicUrl || '', token: speakerToken(uid), log: (m) => app.log.info(m),
      report: (np) => handle(c, { type: 'nowplaying', nowPlaying: np }),
      scrobble: (trackId, at) => (app as any).scrobbleStart?.(uid, trackId, at),
      reportQueue: (rows) => handle(c, { type: 'queue', queue: rows }),
      claim: () => handle(c, { type: 'claim' }),
    });
    clients.set(id, c);
    return c;
  };
  app.decorate('speakers', { list: () => (discovery ? discovery.list().map((d) => ({ ...d, playing: [...clients.values()].some((c) => c.kind === 'server' && c.player?.device?.id === d.id && c.player.playing) })) : []) });

  // --- one message from a client (or from the server player) ---------------------
  const handle = (me: Client, msg: any) => {
    me.lastSeen = Date.now();
    const s = loadSession(db, me.uid);
    const now = Date.now();
    switch (msg.type) {
      case 'ping': send(me, { type: 'pong', now }); break;
      case 'devices': me.devices = Array.isArray(msg.devices) ? msg.devices.slice(0, 50) : []; broadcastRoster(me.uid); break;
      case 'queue': {
        me.queue = Array.isArray(msg.queue) ? msg.queue.slice(0, 5000) : null;
        if (me.queue && (!s.active || s.active === me.id)) {
          const ids = me.queue.map((t: any) => t?.Id).filter((x: any) => typeof x === 'string');
          const idx = s.trackId ? ids.indexOf(s.trackId) : -1;
          s.queue = ids; s.queueItems = me.queue; s.index = idx; s.rev++; s.updatedAt = now; saveSession(db, me.uid, s, log);
        }
        for (const c of ofUser(me.uid)) if (c.id !== me.id) send(c, { type: 'queue', from: me.id, queue: me.queue });
        break;
      }
      case 'nowplaying': {
        const np = msg.nowPlaying && typeof msg.nowPlaying === 'object' ? msg.nowPlaying : null;
        me.nowPlaying = np;
        if (me.kind !== 'server' && np?.playing && typeof np.itemId === 'string' && np.itemId !== me._lastPlayId) { me._lastPlayId = np.itemId; logPlay(me.uid, np.itemId, me.name); }
        // Sound coming out of a client nobody else has claimed makes it the active one.
        if (np?.playing && !s.active) { s.active = me.id; s.rev++; }
        // The active client has nothing playing any more: release the session,
        // frozen where it was, so the others keep it (the server's speaker
        // client never disconnects, so this is how it lets go).
        if (!np && s.active === me.id) {
          s.positionMs = positionNow(s); s.anchorAt = now; s.playing = false; s.active = null; s.rev++; s.updatedAt = now; saveSession(db, me.uid, s, log);
          const sm = sessionMsg(s); if (sm) for (const c of ofUser(me.uid)) if (c.id !== me.id) send(c, sm);
        }
        if (np && s.active === me.id) {
          applyEvent(s, { type: 'progress', ts: now, positionMs: Math.max(0, Math.round((Number(np.position) || 0) * 1000)), playing: !!np.playing, trackId: typeof np.itemId === 'string' ? np.itemId : undefined }, me.id, now);
          s.nowPlaying = np; s.device = np.device && typeof np.device === 'object' ? { id: String(np.device.id ?? ''), name: String(np.device.name ?? ''), kind: String(np.device.kind ?? '') } : s.device;
          if (me.queue) { s.queueItems = me.queue; s.queue = me.queue.map((t: any) => t?.Id).filter((x: any) => typeof x === 'string'); s.index = s.trackId ? s.queue.indexOf(s.trackId) : -1; }
          s.updatedAt = now; saveSession(db, me.uid, s, log);
        }
        broadcastRoster(me.uid);
        break;
      }
      case 'claim': {
        // "Play here": this client becomes the one making sound; the others yield.
        if (s.active !== me.id) { s.lastEventTs = now; s.active = me.id; s.rev++; s.updatedAt = now; }
        for (const c of ofUser(me.uid)) if (c.id !== me.id) send(c, { type: 'command', from: me.id, command: { action: 'yield' } });
        broadcastRoster(me.uid);
        break;
      }
      case 'command': { const target = clients.get(String(msg.to)); if (target && target.uid === me.uid) send(target, { type: 'command', from: me.id, command: msg.command }); break; }
      case 'like': {
        if (typeof msg.itemId !== 'string' || !msg.itemId) break;
        const liked = !!msg.liked;
        if (liked) db.prepare('INSERT INTO likes (user_id, track_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(me.uid, msg.itemId, now); else db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(me.uid, msg.itemId);
        for (const c of ofUser(me.uid)) send(c, { type: 'like', itemId: msg.itemId, liked, at: now });
        break;
      }
      case 'offset': {
        // A speaker's measured visualizer offset (seconds), shared by everyone on the server.
        if (typeof msg.id !== 'string' || !msg.id) break;
        const offset = Number.isFinite(msg.offset) ? Math.max(-5, Math.min(5, msg.offset)) : null;
        if (offset == null) db.prepare('DELETE FROM kv WHERE k = ?').run(`offset:${msg.id}`); else db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(`offset:${msg.id}`, String(offset));
        for (const c of clients.values()) send(c, { type: 'offset', id: msg.id, offset });
        break;
      }
      case 'prefs': for (const c of ofUser(me.uid)) if (c.id !== me.id) send(c, { type: 'prefs', prefs: msg.prefs || {} }); break;
      case 'diag': app.log.info({ client: me.name, diag: msg.data || {} }, 'diag'); break;
    }
  };

  app.get('/api/ws', { websocket: true }, (ws, req) => {
    const net = networkOf(req);
    let self: Client | null = null;
    const timeout = setTimeout(() => { if (!self) ws.close(4001, 'auth timeout'); }, 10000);
    ws.on('message', (raw: Buffer | string) => {
      let msg: any; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!self) {
        if (msg.type !== 'hello' || !msg.token) return;
        const who = userByToken(db, msg.token);
        if (!who) { ws.close(4003, 'bad token'); return; }
        clearTimeout(timeout);
        const kind = String(msg.kind || 'web').slice(0, 20);
        let name = String(msg.name || who.name || 'Slopify').slice(0, 60);
        // Browsers are numbered per account ("Web Player (2)"); desktops carry their machine name.
        if (kind === 'web' || kind === 'mobile') {
          const used = new Set(ofUser(who.id).filter((c) => (c.kind === 'web' || c.kind === 'mobile') && c.id !== msg.clientId).map((c) => c.name));
          let n = 1; while (used.has(`Web Player (${n})`)) n += 1; name = `Web Player (${n})`;
        }
        const id = typeof msg.clientId === 'string' && /^[\w-]{4,64}$/.test(msg.clientId) && !msg.clientId.startsWith('server:') ? msg.clientId : `c_${Math.random().toString(36).slice(2)}`;
        const prev = clients.get(id); if (prev && prev !== self) { try { prev.close(); } catch { /* gone */ } clients.delete(id); }
        self = { id, uid: who.id, net, name, kind, canPlay: msg.canPlay !== false, devices: [], nowPlaying: null, queue: null, lastSeen: Date.now(), send: wsSend(ws), close: () => ws.close(4000, 'replaced') };
        clients.set(id, self);
        serverClientFor(who.id);
        const s = loadSession(db, who.id);
        send(self, { type: 'hello-ok', clientId: id, userId: who.id, offsets: offsetsAll(), now: Date.now() });
        broadcastRoster(who.id);
        for (const c of ofUser(who.id)) if (c.id !== id && c.queue) send(self, { type: 'queue', from: c.id, queue: c.queue });
        if (!s.active) { const sm = sessionMsg(s); if (sm) send(self, sm); }
        return;
      }
      handle(self, msg);
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (!self) return;
      if (clients.get(self.id) !== self) return; // replaced by a reconnect of the same client id
      clients.delete(self.id);
      const s = loadSession(db, self.uid);
      if (s.active === self.id) {
        // The sound stopped with it: freeze the clock and remember where it was.
        s.positionMs = positionNow(s); s.anchorAt = Date.now(); s.playing = false; s.active = null; s.rev++; s.updatedAt = Date.now(); saveSession(db, self.uid, s, log);
        const sm = sessionMsg(s); if (sm) for (const c of ofUser(self.uid)) send(c, sm);
      }
      broadcastRoster(self.uid);
    });
    ws.on('error', () => {});
  });

  // Same state over plain HTTP (a client with no socket yet, tests).
  app.get('/api/session', { preHandler: (app as any).requireUser }, async (req) => {
    const s = loadSession(db, req.user!.id);
    const { queueItems, ...rest } = s; void queueItems;
    return { session: { ...rest, positionMs: positionNow(s), anchorAt: Date.now() }, clients: ofUser(req.user!.id).filter((c) => c.kind !== 'server').map((c) => ({ id: c.id, name: c.name, kind: c.kind, canPlay: c.canPlay, lastSeen: c.lastSeen })), now: Date.now() };
  });
}
