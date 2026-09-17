// The server as a player: one per account that has put its session on a
// speaker the server can see. It holds the queue, drives the speaker
// (play / pause / seek / volume / next), follows the speaker's own clock,
// moves on at the end of a track, and reports what it is doing into the
// account's session exactly like a client would, so every phone and browser
// mirrors it and can control it, from anywhere.
import type { DB } from '../db.js';
import { tracksByIds } from '../library.js';
import type { Discovery, Speaker } from './discovery.js';
import { transportFor, type Transport } from './transports.js';

type Row = { Id: string; Name: string; Artists: string[]; AlbumArtist: string; Album: string; AlbumId: string; RunTimeTicks: number; ArtistItems: { Id: string; Name: string }[]; AlbumArtists: { Id: string; Name: string }[]; UserData: { IsFavorite: boolean }; _queued: boolean; _codec?: string | null };
const MIME: Record<string, string> = { flac: 'audio/flac', mp3: 'audio/mpeg', aac: 'audio/mp4', m4a: 'audio/mp4', alac: 'audio/mp4', ogg: 'audio/ogg', vorbis: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aiff: 'audio/aiff' };

export type PlayerDeps = {
  db: DB; discovery: Discovery; publicUrl: string; token: string;
  report: (np: any | null) => void; reportQueue: (rows: Row[]) => void; claim: () => void; log: (m: string) => void;
};

export class ServerPlayer {
  queue: Row[] = []; index = -1; original: Row[] = [];
  device: Speaker | null = null; transport: Transport | null = null;
  playing = false; anchor = { pos: 0, at: Date.now() }; duration = 0; volume: number | null = null;
  repeat: 'off' | 'all' | 'one' = 'off'; shuffle: 'off' | 'on' = 'off';
  private timer: NodeJS.Timeout | null = null; private starting = false; private lastTick = 0;
  constructor(public uid: string, private d: PlayerDeps) {}

  get current() { return this.queue[this.index] ?? null; }
  get position() { return this.playing ? this.anchor.pos + (Date.now() - this.anchor.at) / 1000 : this.anchor.pos; }
  private rowsFor(ids: string[]): Row[] {
    return tracksByIds(this.d.db, ids).map((t: any) => ({
      Id: t.id, Name: t.title, Artists: t.artists, AlbumArtist: t.albumArtist, Album: t.album, AlbumId: t.albumId, RunTimeTicks: t.durationMs * 10000,
      ArtistItems: t.artists.map((n: string, i: number) => ({ Id: t.artistIds[i], Name: n })).filter((a: any) => a.Id), AlbumArtists: t.artistIds[0] ? [{ Id: t.artistIds[0], Name: t.albumArtist }] : [],
      UserData: { IsFavorite: !!this.d.db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND track_id = ?').get(this.uid, t.id) }, _queued: false, _codec: t.codec,
    }));
  }
  private url(path: string) { return `${this.d.publicUrl.replace(/\/+$/, '')}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.d.token)}`; }
  private meta(t: Row) {
    const artistId = t.ArtistItems?.[0]?.Id || null;
    return { title: t.Name, artist: t.Artists?.join(', ') || t.AlbumArtist || '', album: t.Album || '', artwork: this.url(`/api/image/${t.AlbumId || t.Id}?size=640`), artworkFallback: artistId ? this.url(`/api/image/${artistId}?size=640`) : undefined, contentType: MIME[(t._codec || 'mp3').toLowerCase()] || 'audio/mpeg' };
  }
  nowPlaying() {
    const t = this.current; if (!t || !this.device) return null;
    return {
      itemId: t.Id, title: t.Name, artist: t.Artists?.join(', ') || t.AlbumArtist || '', album: t.Album || null, artUrl: this.url(`/api/image/${t.AlbumId || t.Id}?size=128`),
      albumId: t.AlbumId || null, artistId: t.ArtistItems?.[0]?.Id || null, artists: t.ArtistItems || [], liked: !!t.UserData?.IsFavorite,
      device: { id: this.device.id, kind: this.device.kind, name: this.device.name }, queueIndex: this.index,
      playing: this.playing, position: Math.max(0, this.position), duration: this.duration || t.RunTimeTicks / 10000000, volume: this.volume ?? 100, repeat: this.repeat, shuffle: this.shuffle, at: Date.now(),
    };
  }
  private report() { this.d.report(this.nowPlaying()); }
  private setPos(pos: number, playing = this.playing) { this.anchor = { pos: Math.max(0, pos), at: Date.now() }; this.playing = playing; }

  async execute(cmd: any) {
    const a = cmd?.action;
    this.d.log(`speaker ${this.device?.name || cmd?.deviceId || '?'}: ${a}${cmd?.trackIds ? ` ${cmd.trackIds.length} tracks @${cmd.index ?? 0}` : ''}${cmd?.pos != null ? ` pos=${cmd.pos}` : ''}${cmd?.level != null ? ` level=${cmd.level}` : ''}`);
    try {
      if (a === 'transfer') await this.transfer(cmd);
      else if (a === 'play') await this.play(cmd);
      else if (a === 'enqueue') { const rows = this.rowsFor(cmd.trackIds || []).map((r) => ({ ...r, _queued: true })); this.queue.splice(this.index + 1, 0, ...rows); this.d.reportQueue(this.queue); }
      else if (a === 'queueRemove') { const i = cmd.index | 0; if (i !== this.index && this.queue[i]) { this.queue.splice(i, 1); if (i < this.index) this.index--; this.d.reportQueue(this.queue); this.report(); } }
      else if (a === 'queueMove') { const from = cmd.from | 0, to = cmd.to | 0; if (this.queue[from] && this.queue[to]) { const [m] = this.queue.splice(from, 1); this.queue.splice(to, 0, m); const cur = this.current; this.index = Math.max(0, this.queue.indexOf(cur as Row)); this.d.reportQueue(this.queue); this.report(); } }
      else if (a === 'queueClear') { const cur = this.current; this.queue = this.queue.filter((t, i) => i <= this.index || !t._queued); this.index = cur ? this.queue.indexOf(cur) : -1; this.d.reportQueue(this.queue); }
      else if (a === 'skipTo') await this.skipTo(cmd.index | 0);
      else if (a === 'toggle') await this.toggle();
      else if (a === 'seek') await this.seek(Number(cmd.pos) || 0);
      else if (a === 'setVolume') await this.setVolume(Number(cmd.level ?? 100));
      else if (a === 'next') await this.next(false);
      else if (a === 'previous') await this.previous();
      else if (a === 'setRepeat') { this.repeat = ['off', 'all', 'one'].includes(cmd.mode) ? cmd.mode : 'off'; this.report(); }
      else if (a === 'setShuffle') { this.setShuffle(cmd.mode === 'on' ? 'on' : 'off'); }
      else if (a === 'yield') await this.yield();
      else if (a === 'patchLiked' && cmd.itemId) { for (const t of this.queue) if (t.Id === cmd.itemId) t.UserData = { IsFavorite: !!cmd.liked }; this.report(); }
    } catch (e: any) { this.d.log(`speaker ${this.device?.name || '?'}: ${a} FAILED: ${e.message}`); }
  }

  // Another client hands its session over: its queue, playhead, and the speaker to use.
  private async transfer(cmd: any) {
    const dev = this.d.discovery.get(String(cmd.deviceId || ''));
    if (!dev) throw new Error(`no such speaker ${cmd.deviceId}`);
    const ids: string[] = Array.isArray(cmd.trackIds) ? cmd.trackIds : [];
    if (!ids.length) throw new Error('transfer carried no tracks');
    const rows = this.rowsFor(ids);
    const idx = Math.min(Math.max(0, cmd.index | 0), rows.length - 1);
    // The chosen track first (the speaker starts within a second), the rest around it.
    const chosenId = ids[idx];
    const at = Math.max(0, rows.findIndex((r) => r.Id === chosenId));
    await this.switchDevice(dev);
    this.queue = rows; this.original = rows; this.index = at;
    this.d.claim();
    await this.start(this.queue[at], Number(cmd.position) || 0, cmd.playing !== false);
    this.d.reportQueue(this.queue);
  }
  // A mirror tapped a track: play that list here, from that index.
  private async play(cmd: any) {
    if (!this.device) throw new Error('no speaker selected');
    const ids: string[] = Array.isArray(cmd.trackIds) ? cmd.trackIds : [];
    const rows = this.rowsFor(ids); if (!rows.length) return;
    const idx = Math.min(Math.max(0, cmd.index | 0), rows.length - 1);
    let order = rows, start = idx;
    if (this.shuffle === 'on' && rows.length > 1) { order = [rows[idx], ...shuffled(rows.filter((_, i) => i !== idx))]; start = 0; }
    this.original = rows; this.queue = order; this.index = start;
    this.d.claim();
    await this.start(this.queue[start], Number(cmd.startAt) || 0, true);
    this.d.reportQueue(this.queue);
  }
  private async switchDevice(dev: Speaker) {
    if (this.device && this.device.id !== dev.id && this.transport) { await this.transport.stop().catch(() => {}); this.transport.close(); this.transport = null; }
    this.device = dev;
    if (!this.transport) this.transport = transportFor(dev);
  }
  private async start(t: Row, startAt: number, play: boolean) {
    if (!this.transport || !t) return;
    this.starting = true;
    try {
      this.duration = t.RunTimeTicks / 10000000;
      this.setPos(startAt, play);
      this.report();
      const t0 = Date.now();
      await this.transport.play(this.url(`/api/stream/${t.Id}`), this.meta(t), startAt);
      this.d.log(`speaker ${this.device?.name}: playing ${t.Name} from ${Math.round(startAt)}s after ${Date.now() - t0} ms`);
      if (!play) await this.transport.pause().catch(() => {});
      this.setPos(startAt, play);
      this.logPlay(t.Id);
    } finally { this.starting = false; }
    this.report();
    this.startPolling();
  }
  private logPlay(trackId: string) {
    const db = this.d.db;
    const last = db.prepare('SELECT track_id, at FROM plays WHERE user_id = ? ORDER BY at DESC LIMIT 1').get(this.uid) as any;
    if (!(last && last.track_id === trackId && Date.now() - last.at < 60000)) db.prepare('INSERT OR IGNORE INTO plays (user_id, track_id, at, client) VALUES (?, ?, ?, ?)').run(this.uid, trackId, Date.now(), this.device?.name || 'speaker');
  }
  private async skipTo(i: number) {
    if (!this.queue[i]) return;
    this.index = i;
    await this.start(this.queue[i], 0, true);
  }
  async toggle() {
    if (!this.transport || !this.current) return;
    if (this.playing) { await this.transport.pause(); this.setPos(this.position, false); }
    else { await this.transport.resume(); this.setPos(this.position, true); }
    this.report();
  }
  async seek(pos: number) {
    if (!this.transport || !this.current) return;
    this.setPos(pos); this.report();
    await this.transport.seek(pos);
    this.setPos(pos); this.report();
  }
  async setVolume(level: number) {
    this.volume = Math.max(0, Math.min(100, Math.round(level))); this.report();
    if (this.transport) await this.transport.setVolume(this.volume);
  }
  async next(auto: boolean) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') return this.skipTo(this.index);
    const n = this.index + 1;
    if (n < this.queue.length) return this.skipTo(n);
    if (this.repeat === 'all') return this.skipTo(0);
    // End of the queue: park at the start of the last track, paused.
    if (auto && this.transport) { this.setPos(0, false); this.report(); }
  }
  async previous() {
    if (this.position > 3 || this.index <= 0) return this.seek(0);
    return this.skipTo(this.index - 1);
  }
  private setShuffle(mode: 'off' | 'on') {
    this.shuffle = mode;
    const cur = this.current;
    if (mode === 'on') { const rest = this.queue.filter((t) => t !== cur); this.queue = cur ? [cur, ...shuffled(rest)] : shuffled(rest); this.index = cur ? 0 : -1; }
    else if (this.original.length) { this.queue = [...this.original]; this.index = cur ? Math.max(0, this.queue.findIndex((t) => t.Id === cur.Id)) : -1; }
    this.d.reportQueue(this.queue); this.report();
  }
  // Another client took the session over: silence the speaker, keep the queue.
  async yield() {
    this.stopPolling();
    if (this.transport) { await this.transport.stop().catch(() => {}); this.transport.close(); this.transport = null; }
    this.setPos(this.position, false);
    this.d.report(null);
  }
  async stopAll() { this.stopPolling(); if (this.transport) { await this.transport.stop().catch(() => {}); this.transport.close(); this.transport = null; } }

  // Follow the speaker's own clock; move on when a track ends; notice when
  // someone paused or stopped it from the speaker's own app.
  private startPolling() {
    this.stopPolling();
    this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
  }
  private stopPolling() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private async tick() {
    if (!this.transport || this.starting || !this.current) return;
    const s = await this.transport.status();
    if (typeof s.volume === 'number') this.volume = s.volume;
    // The track ran out: the speaker says so (Cast), or it stopped by itself
    // within a few seconds of the end of what we know the track to be (BluOS
    // does not always know a stream's length).
    const nearEnd = this.duration > 0 && this.position >= this.duration - 3;
    if (s.ended || (s.state === 'stop' && this.playing && nearEnd)) { await this.next(true); return; }
    if (s.state === 'IDLE' || s.state === 'stop') {
      // Stopped from the speaker itself (or the stream failed): show it paused where it was.
      if (this.playing) { this.setPos(this.position, false); this.report(); }
      return;
    }
    const drift = Math.abs(s.position - this.position);
    if (s.playing !== this.playing || drift > 2.5) this.setPos(s.position, s.playing);
    if (s.duration > 0) this.duration = s.duration;
    // Reports every second while playing, like a client (mirrors follow the clock).
    const now = Date.now();
    if (now - this.lastTick >= 1000) { this.lastTick = now; this.report(); }
  }
}

function shuffled<T>(arr: T[]): T[] { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
