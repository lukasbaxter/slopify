#!/usr/bin/env node
// Plays through a Slopify server on each named speaker and checks what comes
// back: start, the clock moving, pause, resume, seek, next, volume, stop.
// Works with any speaker the server can see (Cast, BluOS, DLNA / Sonos,
// AirPlay, Roku, bridges), real or virtual.
//
//   SLOPIFY_URL=http://<server>:8090 SLOPIFY_USER=admin SLOPIFY_PASSWORD=... \
//     node tools/device-lab/cast-check.mjs "Lab DLNA" "Lab AirPlay"
//   node tools/device-lab/cast-check.mjs --list      speakers the server sees
//
// Options: --query <search> picks the tracks (default: the first album found),
// --seek <s> (default 20), --volume <0-100> (default 30), --keep (leave it playing).
// Never point this at speakers people are listening to: it takes them over.
import WebSocket from '../../node_modules/ws/index.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const LIST = flag('--list');
const KEEP = flag('--keep');
const QUERY = opt('--query', null);
const SEEK = Number(opt('--seek', 20));
const VOLUME = Number(opt('--volume', 30));
const base = (process.env.SLOPIFY_URL || '').replace(/\/+$/, '');
if (!base || !process.env.SLOPIFY_USER || !process.env.SLOPIFY_PASSWORD) { console.error('set SLOPIFY_URL, SLOPIFY_USER, SLOPIFY_PASSWORD'); process.exit(2); }
if (!LIST && !args.length) { console.error('name one or more speakers (substring match), or --list'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, init = {}) => {
  const r = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
let token = null;
token = (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: process.env.SLOPIFY_USER, password: process.env.SLOPIFY_PASSWORD }) })).token;
const me = await api('/api/auth/me').catch(() => null);

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/ws`);
let roster = null; let np = null; let npAt = 0;
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  // What the server's speaker player reports reaches the other clients in
  // the roster (players[].nowPlaying), stamped with the server's clock.
  if (m.type === 'roster') {
    roster = m;
    const sp = (m.players || []).find((p) => p.kind === 'server');
    if (sp) { np = sp.nowPlaying || null; npAt = Date.now(); }
  }
});
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
ws.send(JSON.stringify({ type: 'hello', token, kind: 'web', clientId: `castcheck-${process.pid}`, name: 'Cast check', canPlay: false }));
for (let i = 0; i < 40 && !roster?.lanDevices; i++) await sleep(250);
if (!roster) { console.error('no roster from the server'); process.exit(1); }
// The server's discovery needs a little while after a start.
for (let i = 0; i < 20 && !LIST && !args.every((a) => roster.lanDevices.some((d) => d.name.toLowerCase().includes(a.toLowerCase()))); i++) await sleep(1000);

const devices = roster.lanDevices.filter((d) => String(d.viaClient || '').startsWith('server:'));
if (LIST) { for (const d of devices) console.log(`${d.kind.padEnd(8)} ${d.name}  [${d.model || ''}]  ${d.id}`); ws.close(); process.exit(0); }
const serverClient = devices[0]?.viaClient || (me ? `server:${me.id}` : null);

const search = await api(`/api/search?q=${encodeURIComponent(QUERY || 'a')}&limit=50`);
let trackIds = search.tracks.map((t) => t.Id || t.id).filter(Boolean);
if (!QUERY && search.albums?.[0]) { const a = await api(`/api/albums/${search.albums[0].Id || search.albums[0].id}`).catch(() => null); const ids = (a?.tracks || a?.Items || []).map((t) => t.Id || t.id); if (ids.length > 1) trackIds = ids; }
if (trackIds.length < 2) { console.error('need at least two tracks to test next'); process.exit(1); }

const cmd = (command) => ws.send(JSON.stringify({ type: 'command', to: serverClient, command }));
const pos = () => (np ? np.position + (np.playing ? (Date.now() - npAt) / 1000 : 0) : null);
const results = [];
const check = (speaker, name, ok, detail) => { results.push({ speaker, name, ok }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const waitFor = async (pred, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (pred()) return true; await sleep(200); } return pred(); };

for (const want of args) {
  const d = devices.find((x) => x.name.toLowerCase().includes(want.toLowerCase()));
  if (!d) { console.log(`${want}: not found (the server sees: ${devices.map((x) => x.name).join(', ') || 'nothing'})`); results.push({ speaker: want, name: 'found', ok: false }); continue; }
  console.log(`${d.name} (${d.kind}, ${d.model || ''})`);
  np = null;
  const t0 = Date.now();
  cmd({ action: 'transfer', deviceId: d.id, trackIds, index: 0, position: 0, playing: true });
  const started = await waitFor(() => np?.device?.id === d.id && np.playing && np.position > 0.5, 25000);
  check(d.name, 'starts', started, started ? `${((Date.now() - t0) / 1000).toFixed(1)} s to a moving clock` : `last: ${JSON.stringify(np)?.slice(0, 200)}`);
  if (!started) { cmd({ action: 'yield' }); continue; }
  const p1 = pos(); await sleep(4000); const p2 = pos();
  check(d.name, 'clock runs in real time', p2 - p1 > 3 && p2 - p1 < 5, `${(p2 - p1).toFixed(2)} s in 4 s`);

  cmd({ action: 'setPlaying', playing: false });
  const paused = await waitFor(() => np && !np.playing, 8000);
  const pp = pos(); await sleep(3000);
  check(d.name, 'pauses and holds', paused && Math.abs(pos() - pp) < 0.6, `at ${pp?.toFixed(1)} s`);

  cmd({ action: 'setPlaying', playing: true });
  const resumed = await waitFor(() => np?.playing, 8000);
  await sleep(2000);
  check(d.name, 'resumes from there', resumed && pos() >= pp && pos() < pp + 4, `now ${pos()?.toFixed(1)} s`);

  // The server moves its clock to the target at once; only a clock that
  // keeps running from there (the speaker's own reads) proves the seek.
  cmd({ action: 'seek', pos: SEEK });
  await sleep(3000);
  const ps = pos(); await sleep(2000); const ps2 = pos();
  check(d.name, `seeks to ${SEEK} s`, ps >= SEEK && ps < SEEK + 5 && np?.playing && ps2 - ps > 1.5, `now ${ps?.toFixed(1)} s, ${(ps2 - ps).toFixed(1)} s later ${ps2?.toFixed(1)}`);

  cmd({ action: 'setVolume', level: VOLUME });
  const vol = await waitFor(() => np?.volume === VOLUME, 6000);
  await sleep(2500); // the next poll reads the speaker's own level back
  check(d.name, `volume ${VOLUME}`, vol && np?.volume === VOLUME, `reads ${np?.volume}`);

  const first = np?.itemId;
  cmd({ action: 'next' });
  const nexted = await waitFor(() => np?.itemId && np.itemId !== first && np.playing && np.position > 0.3, 20000);
  check(d.name, 'next track', nexted, nexted ? `${np.title} at ${pos()?.toFixed(1)} s` : `last: ${JSON.stringify(np)?.slice(0, 160)}`);

  // Track end: seek near the end and wait for the queue to move on by itself.
  const dur = np?.duration || 0;
  if (dur > 15) {
    const cur = np.itemId;
    cmd({ action: 'seek', pos: dur - 6 });
    const moved = await waitFor(() => np?.itemId && np.itemId !== cur && np.playing, 25000);
    check(d.name, 'moves on at the end of a track', moved, moved ? np.title : `stuck at ${pos()?.toFixed(1)} of ${dur}`);
  }
  if (!KEEP) {
    cmd({ action: 'yield' });
    const stopped = await waitFor(() => !np || !np.playing || np.device?.id !== d.id, 10000);
    check(d.name, 'stops', stopped);
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((f) => `${f.speaker}: ${f.name}`).join(', ')}` : ''}`);
ws.close();
process.exit(failed.length ? 1 : 0);
