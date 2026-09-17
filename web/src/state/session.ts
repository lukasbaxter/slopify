// This client's view of the account's session (server-owned). One
// WebSocket; the clock is synced to the server's so events carry server
// time. If this client is the ACTIVE one it makes the sound and reports
// progress; otherwise it mirrors the session (title, clock, state) and its
// controls send events. Offline, the local player keeps going and every
// action is queued with its timestamp; on reconnect they are replayed and
// the newest wins server-side.
import { createStore } from './store';
import { auth, get, type Track } from '../api/client';
import { player, playQueue as localPlayQueue, toggle as localToggle, next as localNext, previous as localPrevious, seek as localSeek, current, skipTo } from './player';

export type Session = { rev: number; active: string | null; trackId: string | null; queue: string[]; index: number; playing: boolean; positionMs: number; anchorAt: number; device: { id: string; name: string; kind: string } | null };
export type Peer = { id: string; name: string; kind: string; canPlay: boolean; lastSeen: number };
type S = { connected: boolean; clientId: string | null; session: Session | null; clients: Peer[]; offset: number; track: Track | null };
export const session = createStore<S>({ connected: false, clientId: null, session: null, clients: [], offset: 0, track: null });

let ws: WebSocket | null = null;
let retry = 1000;
let pending: any[] = [];
const serverNow = () => Date.now() + session.get().offset;
export const isActive = () => { const s = session.get(); return !!s.session && !!s.clientId && s.session.active === s.clientId; };
export const mirroring = () => { const s = session.get(); return !!s.session?.trackId && !!s.session.active && s.session.active !== s.clientId; };

function sendEvent(event: Record<string, unknown>) {
  const msg = { type: 'event', event: { ts: serverNow(), ...event } };
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); else pending.push(msg);
}

export function connect(name: string, kind = 'web') {
  if (ws) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws?token=${encodeURIComponent(auth.token)}&name=${encodeURIComponent(name)}&kind=${kind}`;
  ws = new WebSocket(url);
  ws.onopen = () => { retry = 1000; ws!.send(JSON.stringify({ type: 'ping', t0: Date.now() })); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'pong') { const rtt = Date.now() - msg.t0; session.set({ offset: msg.now + rtt / 2 - Date.now() }); return; }
    if (msg.type === 'hello') { session.set({ connected: true, clientId: msg.clientId, session: msg.session, clients: msg.clients }); for (const p of pending) ws!.send(JSON.stringify(p)); pending = []; void applySession(msg.session); return; }
    if (msg.type === 'clients') { session.set({ clients: msg.clients }); return; }
    if (msg.type === 'session') { session.set({ session: msg.session, clients: msg.clients }); void applySession(msg.session); }
  };
  ws.onclose = () => { ws = null; session.set({ connected: false }); setTimeout(() => connect(name, kind), retry); retry = Math.min(retry * 2, 30000); };
  ws.onerror = () => ws?.close();
}

// Keep the local player in step with the session.
let lastTrackId: string | null = null;
async function applySession(s: Session) {
  const me = session.get().clientId;
  if (s.trackId && s.trackId !== lastTrackId) { lastTrackId = s.trackId; try { session.set({ track: await get<Track>(`/tracks/${s.trackId}`) }); } catch { /* unknown track */ } }
  if (!s.trackId) return;
  if (s.active === me) {
    // I make the sound. Load what the session says if it is not what I have.
    const cur = current();
    if (!cur || cur.id !== s.trackId) {
      const q = s.queue.length ? (await get<{ items: Track[] }>(`/tracks?ids=${s.queue.slice(0, 2000).join(',')}`)).items : session.get().track ? [session.get().track!] : [];
      const i = Math.max(0, q.findIndex((t) => t.id === s.trackId));
      if (q.length) { localPlayQueue(q, i, null); if (!s.playing) localToggle(); if (s.positionMs > 1500) localSeek(s.positionMs); }
      return;
    }
    const st = player.get();
    if (s.playing && st.state === 'paused') localToggle();
    if (!s.playing && st.state === 'playing') localToggle();
    const drift = Math.abs(st.positionMs - s.positionMs);
    if (drift > 4000) localSeek(s.positionMs);
  } else {
    // Someone else plays: make sure I am silent.
    if (player.get().state === 'playing') localToggle();
  }
}

// Progress from the active client, once a second, so mirrors have a clock.
setInterval(() => { if (!isActive()) return; const t = current(); if (!t) return; const st = player.get(); sendEvent({ type: 'progress', positionMs: st.positionMs, playing: st.state === 'playing', trackId: t.id }); }, 1000);

// --- the controls the UI calls: local when active or alone, events otherwise ---
export const actions = {
  playQueue(tracks: Track[], index: number, contextId: string | null) {
    const s = session.get();
    if (s.connected && s.session?.active && s.session.active !== s.clientId) { sendEvent({ type: 'queue', queue: tracks.map((t) => t.id), index, positionMs: 0, playing: true }); return; }
    localPlayQueue(tracks, index, contextId);
    sendEvent({ type: 'queue', queue: tracks.map((t) => t.id), index, positionMs: 0, playing: true });
  },
  toggle() { if (mirroring()) { sendEvent({ type: 'toggle' }); return; } localToggle(); const st = player.get(); sendEvent({ type: st.state === 'playing' ? 'pause' : 'play', positionMs: st.positionMs }); },
  next() { if (mirroring()) { sendEvent({ type: 'next' }); return; } localNext(); sendEvent({ type: 'next' }); },
  previous() { if (mirroring()) { sendEvent({ type: 'previous', positionMs: displayPosition() }); return; } const p = player.get().positionMs; localPrevious(); sendEvent({ type: 'previous', positionMs: p }); },
  seek(ms: number) { if (mirroring()) { sendEvent({ type: 'seek', positionMs: ms }); return; } localSeek(ms); sendEvent({ type: 'seek', positionMs: ms }); },
  skipTo(i: number) { if (mirroring()) { const s = session.get().session!; sendEvent({ type: 'play', trackId: s.queue[i] }); return; } skipTo(i); const t = current(); if (t) sendEvent({ type: 'play', trackId: t.id, positionMs: 0 }); },
  transferTo(clientId: string) { const s = session.get(); sendEvent({ type: 'transfer', to: clientId, positionMs: displayPosition(), playing: s.session?.playing ?? player.get().state === 'playing' }); },
};
export function displayPosition() {
  const s = session.get();
  if (mirroring() && s.session) return s.session.playing ? s.session.positionMs + (serverNow() - s.session.anchorAt) : s.session.positionMs;
  return player.get().positionMs;
}
export const useSessionTick = () => { /* components re-render on the player store; mirrors tick via the interval below */ };
setInterval(() => { if (mirroring()) session.set((s) => ({ ...s })); }, 500);
