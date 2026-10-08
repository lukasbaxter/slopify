// The server as a player: one per account that has put its session on a
// speaker the server can see. It holds the queue, drives the speaker
// (play / pause / seek / volume / next), follows the speaker's own clock,
// moves on at the end of a track, and reports what it is doing into the
// account's session exactly like a client would, so every phone and browser
// mirrors it and can control it, from anywhere.
import type { DB } from '../db.js';
import { mixFor, tracksByIds } from '../library.js';
import type { Discovery, Speaker } from './discovery.js';
import { BluOSTransport, transportFor, type Transport } from './transports.js';

type Row = { Id: string; Name: string; Artists: string[]; AlbumArtist: string; Album: string; AlbumId: string; RunTimeTicks: number; ArtistItems: { Id: string; Name: string }[]; AlbumArtists: { Id: string; Name: string }[]; UserData: { IsFavorite: boolean }; _queued: boolean; _codec?: string | null };
const MIME: Record<string, string> = { flac: 'audio/flac', mp3: 'audio/mpeg', aac: 'audio/mp4', m4a: 'audio/mp4', alac: 'audio/mp4', ogg: 'audio/ogg', vorbis: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aiff: 'audio/aiff' };


const STEP_SIZE = 5;
// A member dropped for not answering is not tried again for this long, unless
// discovery finds it again first (then a regroup brings it back in).
const DOWN_RETRY_MS = 90_000;
const UNREACHABLE = /EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|timed out/i;
const STEP_GAP_MS = 300;
const STEP_RUN_REST_MS = 3000;
const STEP_RUN_MAX_RISE = 20;
export type PlayerDeps = {
  db: DB; discovery: Discovery; publicUrl: string; token: string;
  report: (np: any | null) => void; reportQueue: (rows: Row[]) => void; claim: () => void; log: (m: string) => void; scrobble?: (trackId: string, at: number) => void;
  // The speaker's group (itself first); alone, just itself.
  groupOf?: (id: string) => string[];
};

// Groups Slopify has linked with BluOS sync right now: leader id -> member ids.
// Anything else linked on the network is not Slopify's (see the group sweep).
export const linkedGroups = new Map<string, string[]>();

// One physical speaker, one driver: whichever account claimed a device last
// owns it, and the previous owner's player is made to yield first, so two
// accounts never fight over the same box.
const owners = new Map<string, ServerPlayer>();

// Someone wants a speaker for something else (one of its own inputs): whoever
// plays there lets go of it (all of it if it leads their group, else just it).
export async function releaseSpeaker(id: string) {
  const p = owners.get(id);
  if (!p) return;
  if (p.device?.id === id) await p.yield();
  else await p.dropMember(id);
}
// The speaker's own volume was set directly: the player leading on it keeps
// that reading instead of fighting it on its next poll.
export function heldVolume(id: string, level: number) {
  const p = owners.get(id);
  if (p && p.device?.id === id) p.holdVolume(level);
}

export class ServerPlayer {
  queue: Row[] = []; index = -1; original: Row[] = [];
  device: Speaker | null = null; transport: Transport | null = null;
  // The rest of the device's group, playing along through BluOS sync.
  members: Speaker[] = [];
  playing = false; anchor = { pos: 0, at: Date.now() }; duration = 0; volume: number | null = null; private volumeHeldUntil = 0;
  repeat: 'off' | 'all' | 'one' = 'off'; shuffle: 'off' | 'on' = 'off';
  private timer: NodeJS.Timeout | null = null; private starting = false; private ticking = false; private lastTick = 0;
  private lastRead: { pos: number; at: number } | null = null;
  private groupReadAt = 0;
  // How far into the current track playback got (seconds). A BluOS speaker
  // that finishes a track resets its counter to 0 a moment before it reports
  // 'stop'; the clock followed it, and the end then read as a stop from the
  // speaker's own app (Summer Madness, 2026-10-05: frozen at 0:00.75 and the
  // queue went quiet). The end is judged by this instead.
  private reached = 0;
  private busyUntil = 0; // a seek/toggle in flight: the poll leaves the clock alone until then
  private ops: Promise<void> = Promise.resolve();
  private playLogTimer: NodeJS.Timeout | null = null;
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
      device: { id: this.device.id, kind: this.device.kind, name: [this.device, ...this.members].map((d) => d.name).join(' + '), members: this.members.map((d) => d.id) }, queueIndex: this.index,
      playing: this.playing, position: Math.max(0, this.position), duration: this.duration || t.RunTimeTicks / 10000000, volume: this.volume ?? 100, repeat: this.repeat, shuffle: this.shuffle, at: Date.now(),
    };
  }
  private report() { this.d.report(this.nowPlaying()); }
  private setPos(pos: number, playing = this.playing) { this.anchor = { pos: Math.max(0, pos), at: Date.now() }; this.playing = playing; this.lastRead = null; }
  // A deliberate move (a track start, a seek): the furthest point starts over.
  private moveTo(pos: number, playing = this.playing) { this.reached = Math.max(0, pos); this.setPos(pos, playing); }

  // Commands arrive fire-and-forget: run them one at a time so a second
  // command never interleaves with a transfer or seek still mid-flight.
  execute(cmd: any) {
    this.ops = this.ops.then(() => this.run(cmd));
    return this.ops;
  }
  private async run(cmd: any) {
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
      // Asks for a state rather than flipping it: a pause sent while the
      // speaker is already paused stays a pause (a toggle restarted it).
      else if (a === 'setPlaying') { if (!!cmd.playing !== this.playing) await this.toggle(); }
      else if (a === 'volumeStep') await this.volumeStep(Number(cmd.step) || 0);
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
    // A mirror that never got this session's queue sends only the current
    // song; switching speakers must not throw the rest of the queue away.
    const keep = ids.length === 1 && this.queue.some((r) => r.Id === ids[0]);
    const rows = keep ? this.queue : this.rowsFor(ids);
    const idx = keep ? this.queue.findIndex((r) => r.Id === ids[0]) : Math.min(Math.max(0, cmd.index | 0), rows.length - 1);
    // The chosen track first (the speaker starts within a second), the rest around it.
    const chosenId = keep ? ids[0] : ids[idx];
    let at = rows.findIndex((r) => r.Id === chosenId);
    if (at < 0) {
      // The chosen track is gone from the library: land on the first id
      // after it that survived, not back at the top of the queue.
      for (let i = ids.indexOf(chosenId) + 1; i < ids.length && at < 0; i++) at = rows.findIndex((r) => r.Id === ids[i]);
      if (at < 0) at = 0;
    }
    await this.switchDevice(dev);
    if (!keep) { this.queue = rows; this.original = rows; }
    this.index = at;
    this.d.claim();
    await this.start(this.queue[at], Number(cmd.position) || 0, cmd.playing !== false);
    this.d.reportQueue(this.queue);
  }
  // A mirror tapped a track: play that list here, from that index.
  private async play(cmd: any) {
    if (!this.device) throw new Error('no speaker selected');
    // After a yield the device is remembered but the transport is gone:
    // get the speaker back the way a transfer does, or give up loudly
    // instead of claiming the session with nothing to make sound.
    if (!this.transport) {
      const dev = this.d.discovery.get(this.device.id);
      if (!dev) { this.device = null; this.d.report(null); throw new Error('speaker is gone'); }
      await this.claimDevice(dev);
      this.device = dev;
      this.transport = transportFor(dev);
      await this.formGroup();
    }
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
    if (this.device && this.device.id !== dev.id && this.transport) { await this.dissolveGroup(); await this.transport.stop().catch(() => {}); this.transport.close(); this.transport = null; this.releaseDevice(); }
    await this.claimDevice(dev);
    this.device = dev;
    if (!this.transport) this.transport = transportFor(dev);
    await this.formGroup();
  }
  // The device's group plays along: each member is claimed, taken out of any
  // other BluOS group, and linked to the leader. Only the picked speaker is
  // ever taken from something else: a member busy with other music (its own
  // input, Spotify, someone else's Slopify) is left alone, unless someone
  // put it into this group on purpose while the music plays (takeBusy).
  // Speakers being taken from us right now: never pulled back into the group.
  private excluded = new Set<string>();
  private async busy(m: Speaker) {
    const o = owners.get(m.id);
    if (o && o !== this) return o.playing;
    if (o === this) return false;
    try { const st = await new BluOSTransport(m).status(); return st.state === 'play' || st.state === 'stream'; }
    catch { return false; }
  }
  private async formGroup({ take = new Set<string>() }: { take?: Set<string> } = {}) {
    const leader = this.device;
    if (!leader) return;
    const ids = leader.kind === 'bluos' ? (this.d.groupOf?.(leader.id) ?? [leader.id]).slice(1).filter((id) => !this.excluded.has(id)) : [];
    // Who stays is the household's group: a member a discovery sweep missed
    // is still linked and playing (one that stops answering is the poll's to
    // drop). Who joins has to be found on the network, and not have just
    // stopped answering (trying it again costs every command ~3 s).
    const keep = new Set(ids);
    const want = ids.filter((id) => !this.isDown(id)).map((id) => this.d.discovery.get(id)).filter((d): d is Speaker => !!d && d.kind === 'bluos');
    for (const m of this.members.filter((m) => !keep.has(m.id))) await this.unlink(m);
    const lt = this.transport as unknown as Partial<BluOSTransport> | null;
    // The leader leaves any other group and drops slaves it should not have,
    // but keeps the members it already has: a regroup (any group edit in the
    // house) or a re-pick of the same speaker used to unlink them all, and only
    // newcomers were added back, so the existing members went silent.
    const stay = new Set(this.members.map((m) => `${m.host}:${m.port}`));
    if (leader.kind === 'bluos' && lt?.standAlone) await lt.standAlone(stay).catch((e: any) => this.d.log(`group: ${leader.name} stand alone: ${e.message}`));
    const have = new Set(this.members.map((m) => m.id));
    for (const m of want.filter((m) => !have.has(m.id))) {
      this.down.delete(m.id);
      if (!take.has(m.id) && (await this.busy(m))) { this.d.log(`group: ${m.name} is playing something else; ${leader.name} plays without it`); continue; }
      await this.claimDevice(m);
      try {
        const t = new BluOSTransport(m);
        await t.standAlone().catch(() => {});
        await (this.transport as unknown as BluOSTransport).addSlave(m.host, m.port);
        this.members.push(m);
        this.d.log(`group: ${m.name} joins ${leader.name}${take.has(m.id) ? ' (added on purpose)' : ''}`);
      } catch (e: any) { this.d.log(`group: could not add ${m.name} to ${leader.name}: ${e.message}`); if (owners.get(m.id) === this) owners.delete(m.id); }
    }
    if (this.members.length) linkedGroups.set(leader.id, this.members.map((m) => m.id)); else linkedGroups.delete(leader.id);
  }
  private async unlink(m: Speaker) {
    const lt = this.transport as unknown as Partial<BluOSTransport> | null;
    if (this.device?.kind === 'bluos' && lt?.removeSlave) await lt.removeSlave(m.host, m.port).catch(() => {});
    this.members = this.members.filter((x) => x.id !== m.id);
    if (owners.get(m.id) === this) owners.delete(m.id);
  }
  private async dissolveGroup() {
    for (const m of [...this.members]) await this.unlink(m);
    if (this.device) linkedGroups.delete(this.device.id);
  }
  async dropMember(id: string) {
    const m = this.members.find((x) => x.id === id);
    if (!m) return;
    this.ops = this.ops.then(async () => { await this.unlink(m); if (this.device) { if (this.members.length) linkedGroups.set(this.device.id, this.members.map((x) => x.id)); else linkedGroups.delete(this.device.id); } this.report(); }).catch(() => {});
    return this.ops;
  }
  holdVolume(level: number) {
    // One speaker of a group set on its own: the group's level is re-read
    // (its loudest speaker) rather than taken from that one.
    this.balance = null;
    if (this.grouped()) { this.volumeHeldUntil = 0; this.groupReadAt = 0; return; }
    this.volume = Math.max(0, Math.min(100, Math.round(level)));
    this.volumeHeldUntil = Date.now() + 2000;
    this.report();
  }
  // The household changed the groups while music plays here: follow. `take`
  // names the speakers someone added on purpose: those join even when busy.
  async regroup(take: Set<string> = new Set()) {
    if (!this.transport || !this.device) return;
    this.ops = this.ops.then(async () => { await this.formGroup({ take }); this.report(); }).catch(() => {});
    return this.ops;
  }
  // Latest claim wins: whoever held this speaker is stopped first (it yields
  // and reports its session not-playing), then the device is ours.
  // Latest claim wins, for that speaker only: whoever played on it gives up
  // just this speaker and keeps playing on the rest of their group.
  private async claimDevice(dev: Speaker) {
    const prev = owners.get(dev.id);
    if (prev && prev !== this) await prev.giveUp(dev.id).catch(() => {});
    owners.set(dev.id, this);
  }
  // Another account took one of our speakers. A member just leaves the group;
  // the speaker the music started on hands the music to the next one in the
  // group, which carries on from the same place. Nothing left: let go.
  async giveUp(id: string) {
    if (this.device?.id !== id) return this.dropMember(id);
    const rest = this.members.filter((m) => m.id !== id);
    if (!rest.length || !this.transport) return this.yield();
    this.ops = this.ops.then(async () => {
      const pos = this.position, playing = this.playing, track = this.current;
      this.excluded.add(id);
      try {
        this.stopPolling();
        await this.dissolveGroup();
        await this.transport?.stop().catch(() => {}); this.transport?.close(); this.transport = null;
        if (owners.get(id) === this) owners.delete(id);
        this.device = null;
        await this.switchDevice(rest[0]);
        if (track) await this.start(track, pos, playing);
      } finally { this.excluded.delete(id); }
    }).catch((e: any) => this.d.log(`group: hand-off failed: ${e.message}`));
    return this.ops;
  }
  private releaseDevice() {
    if (this.device && owners.get(this.device.id) === this) owners.delete(this.device.id);
    for (const m of this.members) if (owners.get(m.id) === this) owners.delete(m.id);
  }
  private async start(t: Row, startAt: number, play: boolean) {
    if (!this.transport || !t) return;
    this.starting = true;
    try {
      this.duration = t.RunTimeTicks / 10000000;
      this.moveTo(startAt, play);
      this.report();
      const t0 = Date.now();
      await this.transport.play(this.url(`/api/stream/${t.Id}`), this.meta(t), startAt);
      this.d.log(`speaker ${this.device?.name}: playing ${t.Name} from ${Math.round(startAt)}s after ${Date.now() - t0} ms`);
      if (!play) await this.transport.pause().catch(() => {});
      this.moveTo(startAt, play);
      if (play) this.armLogPlay(t.Id);
    } finally { this.starting = false; }
    this.report();
    this.startPolling();
  }
  // A play is logged once the same track has kept playing for 8 s, the same
  // confirmation clients get: skip-hunting on a speaker never enters history.
  private armLogPlay(trackId: string) {
    if (this.playLogTimer) clearTimeout(this.playLogTimer);
    this.playLogTimer = setTimeout(() => { this.playLogTimer = null; if (this.playing && this.current?.Id === trackId) this.logPlay(trackId); }, 8000);
  }
  private cancelLogPlay() { if (this.playLogTimer) clearTimeout(this.playLogTimer); this.playLogTimer = null; }
  private logPlay(trackId: string) {
    const db = this.d.db;
    const last = db.prepare('SELECT track_id, at FROM plays WHERE user_id = ? ORDER BY at DESC LIMIT 1').get(this.uid) as any;
    if (!(last && last.track_id === trackId && Date.now() - last.at < 60000)) { db.prepare('INSERT OR IGNORE INTO plays (user_id, track_id, at, client) VALUES (?, ?, ?, ?)').run(this.uid, trackId, Date.now(), this.device?.name || 'speaker'); this.d.scrobble?.(trackId, Date.now()); }
  }
  private async skipTo(i: number) {
    if (!this.queue[i]) return;
    this.index = i;
    await this.start(this.queue[i], 0, true);
  }
  async toggle() {
    if (!this.transport || !this.current) return;
    // The poll must not re-anchor off a reading taken while the device is
    // still flipping state.
    this.busyUntil = Date.now() + 2000;
    if (this.playing) { await this.transport.pause(); this.setPos(this.position, false); }
    else { await this.transport.resume(); this.setPos(this.position, true); }
    this.report();
  }
  async seek(pos: number) {
    if (!this.transport || !this.current) return;
    // Readings taken mid-seek are the old position: hold the poll off until
    // the transport settles (BluOS verifies the landing itself) or 8 s.
    this.busyUntil = Date.now() + 8000;
    this.moveTo(pos); this.report();
    try {
      await this.transport.seek(pos);
      this.moveTo(pos); this.report();
    } finally { this.busyUntil = 0; }
  }
  async setVolume(level: number) {
    this.volume = Math.max(0, Math.min(100, Math.round(level)));
    // The 250 ms poll must not fight the value just set: ignore what the
    // speaker reports back for a moment (the device also takes a beat to
    // settle, and BluOS briefly reads 0 mid-change).
    this.volumeHeldUntil = Date.now() + 2000;
    this.report();
    if (!this.grouped()) { this.d.log(`speaker ${this.device?.name || '?'}: volume ${this.volume}`); if (this.transport) await this.transport.setVolume(this.volume); return; }
    // A group: its level is its loudest speaker, and a change scales every
    // speaker by the same ratio, so the household's balance (one speaker
    // quieter, one muted at 0) survives. Every speaker used to be set to the
    // same number, which woke a speaker muted on purpose. The levels a drag
    // started from are kept for the whole drag, so rounding at a low level
    // cannot flatten the balance on the way back up.
    const now = Date.now();
    if (!this.balance || now - this.balance.at > 3000) {
      const levels = await this.groupLevels();
      this.balance = { at: now, top: Math.max(0, ...levels.map((x) => x.level ?? 0)), levels };
    }
    this.balance.at = now;
    const { top, levels } = this.balance;
    const L = this.volume;
    const to = levels.map(({ sp, level }) => ({ sp, level, next: level == null || top <= 0 ? L : Math.round((level * L) / top) }));
    this.d.log(`speaker ${this.device?.name || '?'}: group volume ${L} (${to.map((x) => `${x.sp.name} ${x.level ?? '?'}->${x.next}`).join(', ')})`);
    await Promise.all(to.filter(({ sp }) => sp.id === this.device?.id || this.members.some((m) => m.id === sp.id))
      .map(({ sp, next }) => this.member(sp, new BluOSTransport(sp).setOwnVolume(next)).catch(() => {})));
  }
  // A hardware volume button press from a phone: one step from the speaker's
  // own level, worked out here rather than by the phone (whose idea of the
  // level lags). A phone once reported presses nobody made, 4 at a time, and
  // took a group from 18 to 83, so: one step per 300 ms, and a run of steps
  // goes at most 20 above where it began until the buttons rest for 3 s.
  async volumeStep(step: number) {
    if (!step) return;
    const now = Date.now();
    if (now - this.lastStepAt < STEP_GAP_MS) { this.d.log(`speaker ${this.device?.name || '?'}: volume step dropped (too soon)`); return; }
    const from = this.volume ?? 0;
    if (!this.stepRun || now - this.lastStepAt > STEP_RUN_REST_MS) this.stepRun = { from };
    this.lastStepAt = now;
    const want = Math.max(0, Math.min(100, from + Math.sign(step) * STEP_SIZE));
    const next = Math.min(want, Math.max(from, this.stepRun.from + STEP_RUN_MAX_RISE));
    if (next === from) { this.d.log(`speaker ${this.device?.name || '?'}: volume step held at ${from} (run limit)`); return; }
    await this.setVolume(next);
  }
  private lastStepAt = 0;
  private stepRun: { from: number } | null = null;
  private balance: { at: number; top: number; levels: { sp: Speaker; level: number | null }[] } | null = null;
  private grouped() { return this.device?.kind === 'bluos' && this.members.length > 0; }
  // Each speaker's own level (leader first).
  private groupLevels() {
    return Promise.all([this.device as Speaker, ...this.members].map(async (sp) => ({ sp, level: await this.member(sp, new BluOSTransport(sp).ownVolume()).catch(() => null) })));
  }
  // A member that stopped answering (switched off, off the WiFi) leaves the
  // music. Kept, every call to it took ~3 s to fail (EHOSTUNREACH), so each
  // command and poll waited on it, and the leader, resumed with a member
  // missing, played 5 s and stopped (Pulse, 2026-10-08). Two misses in a row,
  // and only for "not there" errors: a busy BluOS hanging up is not one.
  private misses = new Map<string, number>();
  private down = new Map<string, { at: number; lost: boolean }>(); // dropped for not answering; lost = discovery lost it since
  private isDown(id: string) { const d = this.down.get(id); return !!d && Date.now() - d.at < DOWN_RETRY_MS; }
  // The speaker list changed. A dropped member that discovery lost and has
  // now found again is back: the group takes it in again.
  speakersChanged(ids: Set<string>) {
    let back = false;
    for (const [id, d] of this.down) {
      if (!ids.has(id)) d.lost = true;
      else if (d.lost) { this.down.delete(id); back = true; }
    }
    if (back) void this.regroup();
  }
  private async member<T>(sp: Speaker, call: Promise<T>): Promise<T> {
    if (sp.id === this.device?.id) return call;
    try { const v = await call; this.misses.delete(sp.id); return v; }
    catch (e: any) {
      if (UNREACHABLE.test(`${e?.code || ''} ${e?.message || ''}`)) {
        const n = (this.misses.get(sp.id) || 0) + 1;
        this.misses.set(sp.id, n);
        if (n >= 2) this.dropUnreachable(sp, e?.code || e?.message);
      }
      throw e;
    }
  }
  private dropUnreachable(m: Speaker, why: string) {
    if (!this.members.some((x) => x.id === m.id)) return;
    this.misses.delete(m.id);
    this.down.set(m.id, { at: Date.now(), lost: false });
    // Out of the list now, so nothing queued after this waits on it; the
    // leader is told in the background.
    this.members = this.members.filter((x) => x.id !== m.id);
    if (owners.get(m.id) === this) owners.delete(m.id);
    if (this.device) { if (this.members.length) linkedGroups.set(this.device.id, this.members.map((x) => x.id)); else linkedGroups.delete(this.device.id); }
    this.d.log(`group: ${m.name} stopped answering (${why}); ${this.device?.name || '?'} plays on without it`);
    const lt = this.transport as unknown as Partial<BluOSTransport> | null;
    if (this.device?.kind === 'bluos' && lt?.removeSlave) void lt.removeSlave(m.host, m.port).catch(() => {});
    this.balance = null;
    this.report();
  }
  async next(auto: boolean) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') return this.skipTo(this.index);
    const n = this.index + 1;
    if (n < this.queue.length) return this.skipTo(n);
    if (this.repeat === 'all') return this.skipTo(0);
    // End of the queue: the music never stops (the web player's Autoplay).
    // Songs that go with the last one are appended and play on; only when
    // there is nothing to add does it park at the start of the last track.
    if (this.extend()) return this.skipTo(n);
    if (auto && this.transport) { this.moveTo(0, false); this.report(); }
  }
  private extend() {
    const cur = this.current; if (!cur) return false;
    const have = new Set(this.queue.map((t) => t.Id));
    const prefs = this.d.db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(this.uid) as any;
    let dislikes: Record<string, unknown> = {};
    try { dislikes = JSON.parse(prefs?.json || '{}').dislikes || {}; } catch { /* unreadable prefs: no dislikes */ }
    const ids = (mixFor(this.d.db, cur.Id, 25) || []).map((t) => t.id).filter((id) => !have.has(id) && !dislikes[id]);
    const rows = this.rowsFor(ids); if (!rows.length) return false;
    this.queue.push(...rows); this.original.push(...rows);
    this.d.reportQueue(this.queue);
    return true;
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
    this.cancelLogPlay();
    await this.dissolveGroup();
    if (this.transport) { await this.transport.stop().catch(() => {}); this.transport.close(); this.transport = null; }
    this.releaseDevice();
    this.setPos(this.position, false);
    this.d.report(null);
  }
  // The speaker was taken by another app: let go of it WITHOUT touching it
  // (no stop, no unlinking the group: the other app plays on all of it now)
  // and leave the session paused where it was.
  private foreignReads = 0;
  private async lose(by: string) {
    this.d.log(`speaker ${this.device?.name || '?'}: taken by ${by}; Slopify lets go without stopping it`);
    this.foreignReads = 0;
    this.stopPolling();
    this.cancelLogPlay();
    this.releaseDevice();
    this.members = []; // still linked for the other app: not ours to unlink
    if (this.transport) { this.transport.close(); this.transport = null; }
    this.setPos(this.position, false);
    this.d.report(null);
  }
  // The server is shutting down. Only a speaker still playing OUR stream is
  // stopped; one another app took over (Spotify on the group) is left
  // exactly as it is, group links included. A restart used to stop Spotify
  // on a whole group Slopify had played on earlier and still thought it had.
  async shutdown() {
    this.stopPolling(); this.cancelLogPlay();
    const t = this.transport;
    const s = t ? await t.status().catch(() => null) : null;
    const theirs = !!s && !!s.service && !/^(url)?$/i.test(s.service) && !!s.streamUrl && !s.streamUrl.includes('/api/stream');
    if (theirs) {
      this.d.log(`speaker ${this.device?.name || '?'}: plays ${s?.serviceName || s?.service} now; left alone at shutdown`);
      this.members = []; t?.close(); this.transport = null; this.releaseDevice();
      return;
    }
    await this.stopAll();
  }
  async stopAll() { this.stopPolling(); this.cancelLogPlay(); await this.dissolveGroup(); if (this.transport) { await this.transport.stop().catch(() => {}); this.transport.close(); this.transport = null; } this.releaseDevice(); }

  // Follow the speaker's own clock; move on when a track ends; notice when
  // someone paused or stopped it from the speaker's own app.
  private startPolling() {
    this.stopPolling();
    // BluOS only reports whole seconds, so it is polled four times a second
    // to catch the moment each second ticks over (see tick()).
    const every = this.device?.kind === 'bluos' ? 250 : 1000;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick().catch(() => {}).finally(() => { this.ticking = false; });
    }, every);
  }
  private stopPolling() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private async tick() {
    if (!this.transport || this.starting || !this.current) return;
    if (Date.now() < this.busyUntil) return;
    const t0 = Date.now();
    if (this.playing) this.reached = Math.max(this.reached, this.position);
    const s = await this.transport.status();
    if (Date.now() < this.busyUntil) return; // a seek/toggle started while we read: stale
    const readAt = (t0 + Date.now()) / 2;
    // Mirror the speaker's own volume (someone used the dial or the BluOS
    // app), but never a muted reading and never right after we set it.
    if (this.grouped()) {
      // A group reads as its loudest speaker (each speaker's own level, once
      // a second): the leader's own level is only one of them.
      if (Date.now() > this.volumeHeldUntil && Date.now() - this.groupReadAt > 1000) {
        this.groupReadAt = Date.now();
        const levels = (await this.groupLevels()).map((x) => x.level).filter((v): v is number => v != null);
        if (levels.length && Date.now() > this.volumeHeldUntil) this.volume = Math.max(...levels);
      }
    } else if (typeof s.volume === 'number' && !s.muted && Date.now() > this.volumeHeldUntil) this.volume = s.volume;
    // The transport lost the device under us (socket error, receiver hung
    // up): release the session cleanly, never relaunch on a dead connection.
    if (s.gone) { await this.yield(); return; }
    // Another app took the speaker (Spotify, AirPlay, the BluOS app): what it
    // plays is no longer our stream. Twice in a row, so a reading from the
    // moment our own stream starts never counts.
    // Strict on purpose: it takes a service name AND a stream address that is
    // not ours (Spotify reports 'Spotify:spotify_pcm01:...'); a speaker that
    // reports nothing about our own stream can never look taken.
    const foreign = (s.state === 'play' || s.state === 'stream') && !!s.service && !/^(url)?$/i.test(s.service)
      && !!s.streamUrl && !s.streamUrl.includes('/api/stream');
    this.foreignReads = foreign ? this.foreignReads + 1 : 0;
    if (this.foreignReads >= 2) { await this.lose(s.serviceName || s.service || 'another app'); return; }
    // The track ran out: the speaker says so (Cast), or it stopped by itself
    // within a few seconds of the end of what we know the track to be (BluOS
    // does not always know a stream's length).
    // A jump back from somewhere short of the end is a scrub (the BluOS app):
    // the furthest point starts over there. Only the end's reset to 0 is kept.
    if (this.duration > 0 && this.reached < this.duration - 5 && s.position + 10 < this.reached) this.reached = s.position;
    const got = Math.max(this.position, this.reached);
    const nearEnd = this.duration > 0 && got >= this.duration - 3;
    // 'ended' is only believed near the end: Cast reports FINISHED for an
    // external stop too, and skipping ahead on that would relaunch a
    // speaker someone just silenced. Anything else is an external stop.
    const atEnd = this.duration > 0 && (got >= this.duration - 5 || got >= this.duration * 0.95);
    if (s.ended && !atEnd) { await this.yield(); return; }
    if (s.ended || (s.state === 'stop' && this.playing && nearEnd)) { await this.next(true); return; }
    if (s.state === 'IDLE' || s.state === 'stop') {
      // Stopped from the speaker itself (or the stream failed): show it paused where it was.
      if (this.playing) { this.d.log(`speaker ${this.device?.name || '?'}: stopped at ${Math.round(this.position)}s of ${Math.round(this.duration)}s (reached ${Math.round(this.reached)}s), not the end: paused`); this.setPos(this.position, false); this.report(); }
      return;
    }
    // Lyrics follow this clock, so it has to match what is coming out of
    // the speaker to a fraction of a second. The old rule (re-sync only past
    // 2.5 s of drift) left every start, seek and rebuffer that far off.
    if (s.playing !== this.playing) this.setPos(s.position + (s.coarse && s.playing ? 0.5 : 0), s.playing);
    else if (s.coarse && s.playing) {
      // A whole-second clock reports the floor of the true position. When
      // it steps up by one between two readings, that second began between
      // them: anchor there (accurate to half the poll interval). Otherwise
      // only a reading the clock cannot explain (a stall, a seek landing
      // elsewhere) moves it, to the middle of the reported second.
      const prev = this.lastRead;
      const pos = this.position;
      if (prev && s.position === prev.pos + 1) this.anchor = { pos: s.position, at: (prev.at + readAt) / 2 };
      else if (pos < s.position - 0.25 || pos >= s.position + 1.25) this.setPos(s.position + 0.5, true);
      this.lastRead = { pos: s.position, at: readAt };
    } else if (Math.abs(s.position - this.position) > 0.75) this.setPos(s.position, s.playing);
    if (s.duration > 0) this.duration = s.duration;
    // Reports every second while playing, like a client (mirrors follow the clock).
    const now = Date.now();
    if (now - this.lastTick >= 1000) { this.lastTick = now; this.report(); }
  }
}

function shuffled<T>(arr: T[]): T[] { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
