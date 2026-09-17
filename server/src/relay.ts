// The Conduit relay protocol, spoken by the Slopify server on /relay so the
// Conduit app (web, desktop, phone) works unchanged: presence, the single
// active player, command routing, queue fan-out, the remembered session,
// likes with timestamps, speaker offsets, prefs nudges. State lives in the
// same SQLite as everything else.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { DB } from './db.js';
import { userByToken } from './auth.js';

type Client = { id: string; ws: WebSocket; uid: string; net: string; name: string; kind: string; token: string; canPlay: boolean; devices: any[]; nowPlaying: any; queue: any[] | null; _lastPlayId?: string };
const users = new Map<string, Map<string, Client>>();
const active = new Map<string, string>();
const lastActive = new Map<string, string>();
const lastSession = new Map<string, { nowPlaying: any; queue: any[] | null; at: number }>();
const saveTimers = new Map<string, NodeJS.Timeout>();

const userMap = (uid: string) => { let m = users.get(uid); if (!m) { m = new Map(); users.set(uid, m); } return m; };
const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|fc|fd|::1)/.test(ip);
function networkOf(req: FastifyRequest) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  let ip = xff[xff.length - 1] || req.socket.remoteAddress || 'unknown';
  ip = ip.replace(/^::ffff:/, '');
  return isPrivate(ip) ? 'lan' : ip;
}
const send = (ws: WebSocket, obj: unknown) => { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch { /* gone */ } };

export function registerRelay(app: FastifyInstance, db: DB) {
  const sessionGet = (uid: string) => { const hot = lastSession.get(uid); if (hot) return hot; const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(`relay:session:${uid}`) as any; const s = row ? JSON.parse(row.v) : { nowPlaying: null, queue: null, at: 0 }; lastSession.set(uid, s); return s; };
  const rememberSession = (uid: string, patch: any) => {
    const next = { ...sessionGet(uid), ...patch, at: Date.now() }; lastSession.set(uid, next);
    if (!saveTimers.has(uid)) saveTimers.set(uid, setTimeout(() => { saveTimers.delete(uid); try { db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(`relay:session:${uid}`, JSON.stringify(lastSession.get(uid))); } catch (e: any) { app.log.error(`session save: ${e.message}`); } }, 1500));
  };
  const sessionMsg = (uid: string) => { const s = sessionGet(uid); return s && s.nowPlaying ? { type: 'session', nowPlaying: s.nowPlaying, queue: s.queue || [], at: s.at } : null; };
  const offsetsAll = () => Object.fromEntries((db.prepare("SELECT k, v FROM kv WHERE k LIKE 'offset:%'").all() as any[]).map((r) => [r.k.slice(7), Number(r.v)]));
  const rosterFor = (self: Client) => {
    const players: any[] = [], lanDevices: any[] = [];
    for (const c of userMap(self.uid).values()) {
      if (c.id !== self.id) players.push({ id: c.id, name: c.name, kind: c.kind, canPlay: c.canPlay, nowPlaying: c.nowPlaying || null, sameNetwork: c.net === self.net });
      if (c.net === self.net) for (const d of c.devices || []) lanDevices.push({ ...d, viaClient: c.id });
    }
    return { type: 'roster', players, lanDevices, activeClientId: active.get(self.uid) || null };
  };
  const broadcastRoster = (uid: string) => { for (const c of userMap(uid).values()) send(c.ws, rosterFor(c)); };
  app.decorate('relayLike', (uid: string, itemId: string, liked: boolean, at: number) => { for (const c of userMap(uid).values()) send(c.ws, { type: 'like', itemId, liked, at }); });

  app.get('/relay', { websocket: true }, (ws, req) => {
    const net = networkOf(req);
    let self: Client | null = null;
    const timeout = setTimeout(() => { if (!self) ws.close(4001, 'auth timeout'); }, 10000);
    const onMessage = (raw: Buffer | string) => {
      let msg: any; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!self) {
        if (msg.type !== 'hello' || !msg.token) return;
        const who = userByToken(db, msg.token);
        if (!who) { ws.close(4003, 'bad token'); return; }
        clearTimeout(timeout);
        const kind = msg.kind || 'web';
        let name = msg.name || who.name || 'Slopify';
        if (kind === 'web' || kind === 'mobile') {
          const used = new Set([...userMap(who.id).values()].filter((c) => (c.kind === 'web' || c.kind === 'mobile') && c.id !== msg.clientId).map((c) => c.name));
          let n = 1; while (used.has(`Web Player (${n})`)) n += 1; name = `Web Player (${n})`;
        }
        self = { id: msg.clientId || `c_${Math.random().toString(36).slice(2)}`, ws, uid: who.id, net, name, kind, token: msg.token, canPlay: msg.canPlay !== false, devices: [], nowPlaying: null, queue: null };
        userMap(who.id).set(self.id, self);
        send(ws, { type: 'hello-ok', clientId: self.id, userId: who.id, offsets: offsetsAll() });
        broadcastRoster(self.uid);
        for (const c of userMap(self.uid).values()) if (c.id !== self.id && c.queue) send(ws, { type: 'queue', from: c.id, queue: c.queue });
        if (!active.has(self.uid)) { const sm = sessionMsg(self.uid); if (sm) send(ws, sm); }
        return;
      }
      const me = self;
      switch (msg.type) {
        case 'devices': me.devices = Array.isArray(msg.devices) ? msg.devices : []; broadcastRoster(me.uid); break;
        case 'queue':
          me.queue = Array.isArray(msg.queue) ? msg.queue : null;
          if (me.queue && (!active.has(me.uid) || active.get(me.uid) === me.id)) rememberSession(me.uid, { queue: me.queue });
          for (const c of userMap(me.uid).values()) if (c.id !== me.id) send(c.ws, { type: 'queue', from: me.id, queue: me.queue });
          break;
        case 'nowplaying': {
          me.nowPlaying = msg.nowPlaying || null;
          if (me.nowPlaying?.playing && me.nowPlaying.itemId && me.nowPlaying.itemId !== me._lastPlayId) {
            me._lastPlayId = me.nowPlaying.itemId;
            const last = db.prepare('SELECT track_id, at FROM plays WHERE user_id = ? ORDER BY at DESC LIMIT 1').get(me.uid) as any;
            if (!(last && last.track_id === me.nowPlaying.itemId && Date.now() - last.at < 60000)) db.prepare('INSERT OR IGNORE INTO plays (user_id, track_id, at, client) VALUES (?, ?, ?, ?)').run(me.uid, me.nowPlaying.itemId, Date.now(), me.name);
          }
          if (me.nowPlaying && me.nowPlaying.playing && !active.has(me.uid)) { active.set(me.uid, me.id); lastActive.set(me.uid, me.id); }
          const noActive = !active.has(me.uid);
          const trusted = active.get(me.uid) === me.id || (noActive && (me.nowPlaying?.playing || lastActive.get(me.uid) === me.id));
          if (me.nowPlaying && trusted) rememberSession(me.uid, { nowPlaying: me.nowPlaying, queue: me.queue || sessionGet(me.uid).queue || null });
          broadcastRoster(me.uid);
          break;
        }
        case 'like': {
          if (!msg.itemId) break;
          const itemId = String(msg.itemId), liked = !!msg.liked, at = Date.now();
          if (liked) db.prepare('INSERT INTO likes (user_id, track_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(me.uid, itemId, at); else db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(me.uid, itemId);
          for (const c of userMap(me.uid).values()) send(c.ws, { type: 'like', itemId, liked, at });
          break;
        }
        case 'offset': {
          if (!msg.id) break;
          const offset = Number.isFinite(msg.offset) ? Math.max(-5, Math.min(5, msg.offset)) : null;
          if (offset == null) db.prepare('DELETE FROM kv WHERE k = ?').run(`offset:${msg.id}`); else db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(`offset:${msg.id}`, String(offset));
          for (const m of users.values()) for (const c of m.values()) send(c.ws, { type: 'offset', id: String(msg.id), offset });
          break;
        }
        case 'diag': app.log.info({ client: me.name, diag: msg.data || {} }, 'diag'); break;
        case 'prefs': for (const c of userMap(me.uid).values()) if (c.id !== me.id) send(c.ws, { type: 'prefs', prefs: msg.prefs || {} }); break;
        case 'command': { const target = userMap(me.uid).get(msg.to); if (target) send(target.ws, { type: 'command', from: me.id, command: msg.command }); break; }
        case 'claim': {
          active.set(me.uid, me.id); lastActive.set(me.uid, me.id);
          for (const c of userMap(me.uid).values()) if (c.id !== me.id) send(c.ws, { type: 'command', from: me.id, command: { action: 'yield' } });
          broadcastRoster(me.uid);
          break;
        }
        case 'ping': send(ws, { type: 'pong' }); break;
      }
    };
    ws.on('message', onMessage);
    ws.on('close', () => {
      clearTimeout(timeout);
      if (!self) return;
      userMap(self.uid).delete(self.id);
      const wasActive = active.get(self.uid) === self.id;
      if (wasActive) active.delete(self.uid);
      broadcastRoster(self.uid);
      if (wasActive) { const sm = sessionMsg(self.uid); if (sm) for (const c of userMap(self.uid).values()) send(c.ws, sm); }
    });
    ws.on('error', () => {});
  });
}
