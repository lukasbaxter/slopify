// The Android app on a weak mobile link: the phone on mobile data (Wi-Fi off)
// and every byte from the lab server through a proxy that holds the whole
// connection to KBPS (a weak 4G cell). Plays an album of long songs and
// reads the player's own log: how long each song took to sound, how often
// it ran dry mid-song, what the whole-song downloads did, and which quality
// the songs climbed to.
//
//   node tools/device-lab/slow-link.mjs SERIAL PORT PASSWORD OUTDIR APK [ALBUM] [SECONDS]
// Env: KBPS (480), PROXY_PORT (PORT+1). The lab server must be serving a
// library with songs of a minute or so (lab.sh serve with LAB_MUSIC=...).
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { adbFor, cdpPage, sleep, writeJson } from './android.mjs';

const [serial, port, password, out, apk, album = 'Long Tones', secs = '150'] = process.argv.slice(2);
if (!apk) { console.error('usage: slow-link.mjs SERIAL PORT PASSWORD OUTDIR APK [ALBUM] [SECONDS]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const PKG = 'com.lukasbaxter.slopify';
const KBPS = Number(process.env.KBPS || 480);
const PROXY = Number(process.env.PROXY_PORT || Number(port) + 1);
const CDP = Number(process.env.APP_CDP_PORT || 9335);
const adb = adbFor(serial);
const base = `http://localhost:${port}`;

// One shared link for everything sent to the phone, shared fairly: each
// tick the budget goes round the connections with data in small slices, as
// a cell does, so one big download slows the others down without making
// them wait behind it. At most HIGH bytes wait per connection; past that the
// proxy stops reading from the server for it.
const perTick = Math.max(1, Math.round((KBPS * 1000) / 8 / 20)); // bytes per 50 ms
const SLICE = 1400, HIGH = 64 * 1024, LOW = 16 * 1024;
const conns = new Set(); // { client, up, chunks: Buffer[], bytes, upDone }
setInterval(() => {
  let budget = perTick;
  let any = true;
  while (budget > 0 && any) {
    any = false;
    for (const c of conns) {
      if (budget <= 0) break;
      if (!c.chunks.length || c.client.destroyed) continue;
      any = true;
      const buf = c.chunks[0];
      const n = Math.min(SLICE, budget, buf.length);
      c.client.write(buf.subarray(0, n));
      budget -= n; c.bytes -= n; c.sent += n;
      if (n === buf.length) c.chunks.shift(); else c.chunks[0] = buf.subarray(n);
    }
  }
  for (const c of conns) {
    if (c.up.isPaused() && c.bytes < LOW) c.up.resume();
    // The server finishing is not the phone having it: what is queued goes first.
    if (c.upDone && !c.chunks.length) { conns.delete(c); c.client.end(); }
  }
}, 50);
const proxy = net.createServer((client) => {
  const up = net.connect(Number(port), '127.0.0.1');
  const c = { client, up, chunks: [], bytes: 0, upDone: false, sent: 0, since: Date.now(), path: '' };
  conns.add(c);
  client.on('data', (d) => { if (/^(GET|POST|PUT|HEAD) /.test(d.toString('latin1', 0, 8))) c.path = (/^[A-Z]+ (\S+)/.exec(d.toString('latin1')) || [])[1]?.replace(/token=[^&]+/, 'T').slice(0, 60) || '?'; up.write(d); });
  up.on('data', (d) => { c.chunks.push(d); c.bytes += d.length; if (c.bytes > HIGH) up.pause(); });
  up.on('end', () => { c.upDone = true; }); up.on('error', () => { c.upDone = true; });
  const end = () => { conns.delete(c); client.destroy(); up.destroy(); };
  client.on('close', end); client.on('error', end);
});
await new Promise((r) => proxy.listen(PROXY, '127.0.0.1', r));

adb.sh('am force-stop com.android.chrome');
adb.sh(`pm uninstall ${PKG}`);
adb.run('install', '-g', apk);
adb.run('reverse', `tcp:${port}`, `tcp:${PROXY}`); // the app's server, through the throttle
adb.sh('svc wifi disable'); await sleep(3000); // mobile data only
adb.key('KEYCODE_WAKEUP'); adb.sh('wm dismiss-keyguard');
adb.sh(`am start -W -n ${PKG}/.MainActivity`);
let sock = null;
for (let i = 0; i < 60 && !sock; i++) {
  const pid = adb.sh(`pidof ${PKG}`).trim();
  const m = pid && adb.sh('cat /proc/net/unix').match(new RegExp(`@(webview_devtools_remote_${pid})\\b`));
  if (m) sock = m[1]; else await sleep(500);
}
if (!sock) { console.error('no WebView DevTools socket'); process.exit(1); }
adb.run('forward', `tcp:${CDP}`, `localabstract:${sock}`);
const page = await cdpPage(CDP, base);
await page.waitFor(() => document.readyState !== 'loading', undefined, 60000);
const link = await page.evaluate(() => ({ type: navigator.connection?.type || null, effective: navigator.connection?.effectiveType || null }));
console.log(`link as the page sees it: ${JSON.stringify(link)}, throttle ${KBPS} kbit/s`);
// Over the throttle the page takes a while: the sign-in form or the app, whichever comes.
await page.waitFor(() => document.querySelectorAll('.login input').length === 2 || !!document.querySelector('.tabbar'), undefined, 90000);
if (await page.evaluate(() => document.querySelectorAll('.login input').length)) {
  await page.fill('.login input', 0, 'admin'); await page.fill('.login input', 1, password);
  await page.touch('.login .primary');
}
await page.waitFor(() => !!document.querySelector('.tabbar'), undefined, 60000);
const found = await page.waitFor((name) => [...document.querySelectorAll('.card, .shortcut')].some((e) => e.textContent.includes(name)), album, 90000);
console.log(found ? `album ${album} on Home` : `album ${album} not on Home: the first card instead`);
await page.touch('.card, .shortcut', found ? album : undefined);
await page.waitFor(() => !!document.querySelector('.trackrow'), undefined, 60000); await sleep(500); await page.touch('.trackrow');
const t0 = Date.now();
// The element as the page sees it, every 5 s: clock, readyState, what it says is buffered.
const samples = []; const connLog = [];
while (Date.now() - t0 < Number(secs) * 1000) {
  samples.push(await page.evaluate(() => { const el = window.__slopifyAudio?.().active; if (!el) return null; const b = []; for (let k = 0; k < el.buffered.length; k++) b.push([Math.round(el.buffered.start(k) * 10) / 10, Math.round(el.buffered.end(k) * 10) / 10]); return { s: Math.round(performance.now() / 1000), t: Math.round(el.currentTime * 10) / 10, rs: el.readyState, ns: el.networkState, paused: el.paused, b }; }).catch(() => null));
  connLog.push(`${Math.round((Date.now() - t0) / 1000)}s ` + [...conns].filter((c) => c.sent > 20000 || c.chunks.length).map((c) => `${c.path}:${Math.round(c.sent / 1024)}K${c.up.isPaused() ? '(held)' : ''}`).join(' | '));
  await sleep(5000);
}
for (const x of samples) console.log('sample', JSON.stringify(x));
for (const x of connLog) console.log('conns', x);
const log = await page.evaluate(() => window.__slopifyMediaLog || []);
console.log('keepalive', JSON.stringify(await page.evaluate(() => window.__conduitKeepAliveState?.() || null).catch(() => null)));
const res = await page.evaluate(() => { const el = window.__slopifyAudio?.().active; return { t: el?.currentTime, track: el?.dataset.track?.slice(0, 6), paused: el?.paused }; });
adb.sh('svc wifi enable');
const lines = log.filter((l) => /load |el playing|el waiting|starving|whole-song|gapless|error/.test(l));
// From the element's own events (old builds too): per song, seconds from
// its load to the first 'playing', and how often it waited after that.
const sec = (l) => { const m = /^(\d\d):(\d\d):(\d\d)/.exec(l); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null; };
const songs = [];
for (const l of log) {
  const ld = /load (\w{6}) at/.exec(l); if (ld) { songs.push({ id: ld[1], loadAt: sec(l), startS: null, waits: 0 }); continue; }
  const s = songs.at(-1); if (!s) continue;
  if (new RegExp(`el playing ${s.id}`).test(l) && s.startS == null) s.startS = sec(l) - s.loadAt;
  else if (new RegExp(`el waiting ${s.id} t=([0-9.]+)`).test(l) && s.startS != null && Number(/t=([0-9.]+)/.exec(l)[1]) > 0.5) s.waits += 1;
}
const sum = {
  songs: songs.map(({ id, startS, waits }) => ({ id, startS, waits })),
  link, kbps: KBPS, seconds: Math.round((Date.now() - t0) / 1000), end: res,
  starts: lines.filter((l) => /starving: .* s to sound/.test(l)).length,
  rebuffers: lines.filter((l) => /starving: rebuffer/.test(l)).length,
  wholePaused: lines.filter((l) => /whole-song download paused/.test(l)).length,
  wholeResumed: lines.filter((l) => /whole-song download resumed/.test(l)).length,
  capped: lines.some((l) => /a rung lower/.test(l)),
};
console.log(lines.join('\n'));
console.log(JSON.stringify(sum));
writeJson(path.join(out, 'slow-link.json'), { ...sum, log });
proxy.close();
process.exit(0);
