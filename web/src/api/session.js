// Client side of the session socket (/api/ws). One instance per running
// app. It announces this client as a controllable player, and surfaces the
// user's other clients + the speakers on this network as targets. The server
// keeps the account's session (what is playing, where, the queue, the clock).
//
// Audio never flows through here. This is presence + command routing only.

// Same-origin in the browser; the desktop app points at the server it logged in to.
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
  constructor({ baseUrl, token, name, kind, canPlay = true, onRoster, onCommand, onQueue, onSession, onPrefs, onLike, onOffsets }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.name = name;
    this.kind = kind; // 'desktop' | 'web' | 'mobile'
    this.canPlay = canPlay;
    this.onRoster = onRoster || (() => {});
    this.onCommand = onCommand || (() => {});
    this.onQueue = onQueue || (() => {});
    this.onSession = onSession || (() => {});
    this.onPrefs = onPrefs || (() => {});
    this.onLike = onLike || (() => {});
    this.onOffsets = onOffsets || (() => {});
    this.id = clientId();
    this.ws = null;
    this.closed = false;
    this._backoff = 1000;
    this._pending = { devices: [], nowPlaying: null, queue: null };
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
      this._backoff = 1000;
      this._send({ type: 'hello', token: this.token, clientId: this.id, name: this.name, kind: this.kind, canPlay: this.canPlay });
      this._ping = setInterval(() => this._send({ type: 'ping' }), 25000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'hello-ok') {
        this.connected = true;
        if (m.offsets) this.onOffsets(m.offsets);
        // Only now is the server listening to us. Anything sent while it was
        // still verifying the token was dropped -- which is how the desktop's
        // speaker list went missing from the web player after a restart.
        // Re-assert the claim first so the server re-marks us active before
        // any roster goes out, then flush whatever we last knew.
        if (this._claimed) this._send({ type: 'claim' });
        if (this._pending.devices.length) this.reportDevices(this._pending.devices);
        if (this._pending.nowPlaying) this.reportNowPlaying(this._pending.nowPlaying);
        if (this._pending.queue) this.reportQueue(this._pending.queue);
      } else if (m.type === 'queue') this.onQueue(m.from, m.queue || null);
      else if (m.type === 'prefs') this.onPrefs(m.prefs || {});
      else if (m.type === 'like') this.onLike(m);
      else if (m.type === 'offset') this.onOffsets({ [m.id]: m.offset });
      else if (m.type === 'session') this.onSession({ nowPlaying: m.nowPlaying, queue: m.queue || [], at: m.at || 0 });
      else if (m.type === 'roster') this.onRoster({ players: m.players || [], lanDevices: m.lanDevices || [], activeClientId: m.activeClientId || null });
      else if (m.type === 'command') {
        // A yield means another client took over: we no longer hold the claim,
        // so a later reconnect must NOT re-assert it.
        if (m.command && m.command.action === 'yield') this._claimed = false;
        this.onCommand(m.command, m.from);
      }
    };
    ws.onclose = () => { this.connected = false; clearInterval(this._ping); this._retry(); };
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
  reportQueue(queue) {
    this._pending.queue = queue;
    this._send({ type: 'queue', queue });
  }

  reportNowPlaying(np) {
    this._pending.nowPlaying = np;
    this._send({ type: 'nowplaying', nowPlaying: np });
  }

  // I just started playing here: make the user's other clients yield.
  claim() { this._claimed = true; this._send({ type: 'claim' }); }
  sendPrefs(prefs) { this._send({ type: 'prefs', prefs }); }
  // A like / unlike; the server stores the timestamp and tells the other clients.
  sendLike(itemId, liked) { this._send({ type: 'like', itemId, liked }); }
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
