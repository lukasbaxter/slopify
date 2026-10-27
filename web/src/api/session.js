// Client side of the session socket (/api/ws). One instance per running
// app. It announces this client as a controllable player, and surfaces the
// user's other clients + the speakers on this network as targets. The server
// keeps the account's session (what is playing, where, the queue, the clock).
//
// Audio never flows through here. This is presence + command routing only.

// Same-origin in the browser; the desktop app points at the server it logged in to.
// What a published queue may take on the wire (the server's frame limit is
// 4 MiB; titles are mostly ASCII, so characters are about bytes).
const QUEUE_MAX_CHARS = 2.5 * 1024 * 1024;

function defaultUrl(baseUrl) {
  const base = baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base.replace(/^http/, 'ws')}/api/ws`;
}

function clientId() {
  const KEY = 'slopify.clientId';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; localStorage.setItem(KEY, id); }
    return id;
  } catch {
    return `c_${Math.random().toString(36).slice(2)}`;
  }
}

export class SessionLink {
  constructor({ baseUrl, token, name, kind, form = null, canPlay = true, onRoster, onCommand, onQueue, onSession, onPrefs, onLike, onOffsets, onSleep }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.name = name;
    this.kind = kind; // 'desktop' | 'web' | 'phone'
    this.form = form; // 'desktop' | 'laptop' | 'phone' | 'tablet': the icon others show
    this.canPlay = canPlay;
    this.onRoster = onRoster || (() => {});
    this.onCommand = onCommand || (() => {});
    this.onQueue = onQueue || (() => {});
    this.onSession = onSession || (() => {});
    this.onPrefs = onPrefs || (() => {});
    this.onLike = onLike || (() => {});
    this.onOffsets = onOffsets || (() => {});
    this.onSleep = onSleep || (() => {});
    // Whether this connection has heard who is playing yet. Until it has, a
    // play pressed here cannot know the music is already on another device
    // (a phone app just opened): whenRoster() lets the player wait for it.
    this.rosterSeen = false;
    this._rosterWaiters = [];
    this.id = clientId();
    // Per page load. Every tab of a browser shares the stored id, so the server
    // tells a second live tab apart by this and hands it an id of its own
    // (two tabs on one id replaced each other every second or so, forever).
    this.instance = `i_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    this.ws = null;
    this.closed = false;
    this._backoff = 1000;
    this._pending = { devices: [], nowPlaying: null, queue: null };
    this.clockOffset = null; this._rtt = Infinity;
    // True while THIS client holds the active-player claim. Survives socket
    // drops so a reconnect (e.g. after the server restarts and forgets who was
    // active) re-asserts it, restoring the green bar on every other client.
    this._claimed = false;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(defaultUrl(this.baseUrl)); } catch { this._retry(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this._openedAt = Date.now();
      this._send({ type: 'hello', token: this.token, clientId: this.id, instance: this.instance, name: this.name, kind: this.kind, form: this.form, canPlay: this.canPlay });
      this._ping = setInterval(() => this._send({ type: 'ping', t: Date.now() }), 25000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'pong') {
        // Clock offset to the server (server = local + offset), from the round
        // trip: the best (shortest) samples win, so a slow one does not drag it.
        if (typeof m.t === 'number' && typeof m.now === 'number') {
          const rtt = Date.now() - m.t;
          if (rtt >= 0 && rtt <= this._rtt + 15) { this._rtt = Math.min(this._rtt, rtt); this.clockOffset = m.now - (m.t + rtt / 2); }
        }
        return;
      }
      if (m.type === 'hello-ok') {
        this.connected = true;
        // A first, rough offset from the hello itself; the first pong refines it.
        if (typeof m.now === 'number' && this.clockOffset == null) { const rtt = Math.max(0, Date.now() - this._openedAt); this._rtt = rtt; this.clockOffset = m.now - (Date.now() - rtt / 2); }
        setTimeout(() => this._send({ type: 'ping', t: Date.now() }), 400);
        if (typeof m.clientId === 'string' && m.clientId) this.id = m.clientId;
        if (m.offsets) this.onOffsets(m.offsets);
        this.onSleep(m.sleep || null);
        // Only now is the server listening to us. Anything sent while it was
        // still verifying the token was dropped -- which is how the desktop's
        // speaker list went missing from the web player after a restart.
        // Re-assert the claim first so the server re-marks us active before
        // any roster goes out, then flush whatever we last knew. With how
        // long ago play was pressed here: the latest press on the account
        // wins. Pressed here after the device that has the session now, that
        // device is told to stop; pressed before it, this one is yielded.
        if (this._claimed) this._send({ type: 'claim', reassert: true, ago: Math.max(0, Date.now() - (this._claimedAt || 0)) });
        if (this._pending.devices.length) this.reportDevices(this._pending.devices);
        if (this._pending.nowPlaying) this.reportNowPlaying(this._pending.nowPlaying);
        if (this._pending.queue) this.reportQueue(this._pending.queue);
      } else if (m.type === 'queue') this.onQueue(m.from, m.queue || null);
      else if (m.type === 'prefs') this.onPrefs(m.prefs || {});
      else if (m.type === 'like') this.onLike(m);
      else if (m.type === 'offset') this.onOffsets({ [m.id]: m.offset });
      else if (m.type === 'sleep') this.onSleep(m.sleep || null);
      else if (m.type === 'session') this.onSession({ nowPlaying: m.nowPlaying, queue: m.queue || [], at: m.at || 0 });
      else if (m.type === 'roster') {
        // The sender stamps nowPlaying.at with ITS wall clock; a mirror must
        // never do clock math across devices (a skewed machine showed every
        // track 41s in). rxAt is OUR receipt time: same clock as the display.
        const rx = Date.now();
        for (const p of m.players || []) if (p.nowPlaying) p.nowPlaying.rxAt = rx;
        this.onRoster({ players: m.players || [], lanDevices: m.lanDevices || [], activeClientId: m.activeClientId || null });
        this.rosterSeen = true;
        for (const done of this._rosterWaiters.splice(0)) done(true);
      }
      else if (m.type === 'command') {
        // A yield means another client took over: we no longer hold the claim,
        // so a later reconnect must NOT re-assert it.
        if (m.command && m.command.action === 'yield') this._claimed = false;
        this.onCommand(m.command, m.from);
      }
    };
    ws.onclose = (ev) => {
      if (typeof window !== 'undefined') (window.__slopifyMediaLog ||= []).push(`${new Date().toISOString().slice(11, 19)}${document.hidden ? ' bg' : ''} socket closed${ev && ev.code ? ` ${ev.code}` : ''}`);
      this.connected = false; this.rosterSeen = false; clearInterval(this._ping);
      // 4003: the token is refused (signed out elsewhere, removed). Nothing to
      // reconnect with; the app goes back to the sign-in form.
      if (ev && ev.code === 4003 && typeof window !== 'undefined') { this.closed = true; try { window.dispatchEvent(new CustomEvent('slopify:unauthorized')); } catch { /* none */ } return; }
      // A connection that lived starts the backoff over; one the server
      // closed right away (a frame it refused, a token it rejected) keeps
      // doubling, so a refused message is not a reconnect every second.
      if (Date.now() - (this._openedAt || 0) > 5000) this._backoff = 1000;
      this._retry();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  _retry() {
    if (this.closed) return;
    setTimeout(() => this.connect(), this._backoff);
    this._backoff = Math.min(this._backoff * 2, 20000);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  reportDevices(devices) {
    this._pending.devices = devices;
    this._send({ type: 'devices', devices });
  }

  // Publish this client's queue (slim tracks) for the user's other clients.
  // Bounded: the server closes the socket on a frame over its limit, and the
  // queue is re-sent on every reconnect, so one queue that did not fit (a
  // 2,607-song playlist, 2026-10-13) was a reconnect every 2 s for 40
  // minutes on the phone. A queue past the budget is cut at its end.
  reportQueue(queue) {
    let q = queue;
    let frame = JSON.stringify({ type: 'queue', queue: q });
    while (Array.isArray(q) && q.length > 1 && frame.length > QUEUE_MAX_CHARS) {
      q = q.slice(0, Math.ceil(q.length * 0.8));
      frame = JSON.stringify({ type: 'queue', queue: q });
    }
    this._pending.queue = q;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  reportNowPlaying(np) {
    this._pending.nowPlaying = np;
    this._send({ type: 'nowplaying', nowPlaying: np });
  }
  // The server's clock, as this client estimates it (null offset = unknown yet).
  serverNow() { return Date.now() + (this.clockOffset || 0); }
  // Where a report's playhead is now: elapsed since the server stamped it, on
  // the server's clock, so every mirror lands on the same second. Before the
  // first pong (or for an old server) it falls back to our receipt time.
  playheadOf(np) {
    if (!np) return 0;
    const p = Number(np.position) || 0;
    if (!np.playing) return p;
    const since = typeof np.serverAt === 'number' && this.clockOffset != null ? this.serverNow() - np.serverAt : Date.now() - (np.rxAt || np.at || Date.now());
    return p + Math.max(0, since) / 1000;
  }

  // I just started playing here: make the user's other clients yield.
  claim() { this._claimed = true; this._claimedAt = Date.now(); this._send({ type: 'claim' }); }
  // Resolves once this connection has the roster (true), or after `ms` (false).
  whenRoster(ms = 3000) {
    if (this.rosterSeen) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._rosterWaiters = this._rosterWaiters.filter((f) => f !== done); resolve(false); }, ms);
      const done = (v) => { clearTimeout(t); resolve(v); };
      this._rosterWaiters.push(done);
    });
  }
  sendPrefs(prefs) { this._send({ type: 'prefs', prefs }); }
  // A like / unlike; the server stores the timestamp and tells the other clients.
  // The account's sleep timer: { minutes }, { endOfTrack: true } or { off: true }.
  sendSleep(opt) { this._send({ type: 'sleep', ...opt }); }
  // A speaker's measured visualizer offset in seconds (null = forget it).
  sendOffset(id, offset) { this._send({ type: 'offset', id, offset }); }

  // Tell another client to do something.
  command(toClientId, command) {
    this._send({ type: 'command', to: toClientId, command });
  }

  close() {
    this.closed = true;
    clearInterval(this._ping);
    try { this.ws && this.ws.close(); } catch {}
  }
}
