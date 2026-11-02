// The Slopify Android app (mobile/, an Expo WebView shell) on the phone
// emulator, pointed at the lab server (built from this tree: lab.sh apk-src), driven through the
// WebView's DevTools socket (webview_devtools_remote_<pid>, open in release
// builds). Launch, sign in, play, the hardware volume buttons (the phone's own
// sound, then a session playing on another device: a headless Chromium
// "laptop" on the lab host), the app in the background and with the screen
// off, and what Android shows (media session, notification).
//
//   node tools/device-lab/app-test.mjs SERIAL PORT PASSWORD OUTDIR APK
// Exit code 1 if a check failed. Results: OUTDIR/app.json + PNGs.
import { chromium } from 'playwright';
import { adbFor, cdpPage, mediaSessions, mediaNotifications, sleep, writeJson } from './android.mjs';
import fs from 'node:fs';
import path from 'node:path';

const [serial, port, password, out, apk] = process.argv.slice(2);
if (!apk) { console.error('usage: app-test.mjs SERIAL PORT PASSWORD OUTDIR APK'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const PKG = 'com.lukasbaxter.slopify';
const adb = adbFor(serial);
const base = `http://localhost:${port}`;
const CDP = Number(process.env.APP_CDP_PORT || 9334);
const results = { started: new Date().toISOString(), apk: path.basename(apk), checks: [], notes: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const note = (s) => { results.notes.push(s); console.log(`     ${s}`); };
const shot = (n) => adb.shot(path.join(out, `${n}.png`));
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error(`no answer in ${ms} ms`); })]);
const musicIndex = () => { const m = adb.sh('cmd media_session volume --stream 3 --get 2>/dev/null').match(/volume is (\d+)/); return m ? Number(m[1]) : null; };

// Fresh install, the lab server reachable as localhost. Chrome stopped: a
// Slopify tab left playing there (phone-test) is another device of the same
// account and would take the session.
adb.sh('am force-stop com.android.chrome');
adb.sh(`pm uninstall ${PKG}`);
const inst = adb.run('install', '-g', apk).trim().split('\n').pop();
check('APK installs', /Success|complete/i.test(inst), inst);
const info = adb.sh(`dumpsys package ${PKG} | grep -E "versionName|versionCode|targetSdk" | head -3`).trim().replace(/\s+/g, ' ');
results.package = info; note(`package: ${info}`);
adb.run('reverse', `tcp:${port}`, `tcp:${port}`);
adb.key('KEYCODE_WAKEUP'); adb.sh('wm dismiss-keyguard');
adb.sh('logcat -c');
adb.sh(`am start -W -n ${PKG}/.MainActivity`);

// The WebView's DevTools socket for the app's process.
let pid = '', sock = null;
for (let i = 0; i < 40 && !sock; i++) {
  pid = adb.sh(`pidof ${PKG}`).trim();
  const m = pid && adb.sh('cat /proc/net/unix').match(new RegExp(`@(webview_devtools_remote_${pid})\\b`));
  if (m) sock = m[1]; else await sleep(500);
}
check('WebView DevTools socket open (release build)', sock, sock || `pid ${pid}`);
if (!sock) { writeJson(path.join(out, 'app.json'), results); process.exit(1); }
adb.run('forward', `tcp:${CDP}`, `localabstract:${sock}`);
const page = await cdpPage(CDP, base);
check('the app opened the lab server', page, page?.target?.url);
if (!page) { writeJson(path.join(out, 'app.json'), results); process.exit(1); }
await page.waitFor(() => document.readyState !== 'loading');
results.shell = await page.evaluate(() => ({ shell: window.slopifyShell || null, bridge: !!window.ReactNativeWebView, ua: navigator.userAgent, secure: isSecureContext, sw: 'serviceWorker' in navigator, mediaSession: 'mediaSession' in navigator, mediaMetadata: typeof MediaMetadata }));
note(`WebView: mediaSession in navigator=${results.shell.mediaSession}, MediaMetadata=${results.shell.mediaMetadata}, secure=${results.shell.secure}`);
// Record what the page tells the shell (session: remote or not, volume).
await page.evaluate(() => { const rn = window.ReactNativeWebView; if (!rn || rn.__labWrapped) return; const orig = rn.postMessage.bind(rn); window.__bridgeLog = []; rn.postMessage = (m) => { window.__bridgeLog.push(`${new Date().toISOString().slice(11, 23)} ${m}`); return orig(m); }; rn.__labWrapped = true; });
check('the shell told the page who it is (window.slopifyShell)', results.shell.shell?.platform === 'android', results.shell.shell);
shot('app-01-launch');

// Sign in.
if (await page.evaluate(() => document.querySelectorAll('.login input').length)) {
  const n = await page.evaluate(() => document.querySelectorAll('.login input').length);
  check('login form without a server field (web build)', n === 2, n);
  await page.fill('.login input', 0, 'admin'); await page.fill('.login input', 1, password);
  await page.touch('.login .primary');
}
check('signed in (tab bar)', await page.waitFor(() => !!document.querySelector('.tabbar')));
await page.waitFor(() => document.querySelectorAll('.card, .shortcut').length > 0);

// Play.
await page.touch('.card, .shortcut', 'Second Wind');
await page.waitFor(() => !!document.querySelector('.trackrow'), null, 15000);
await sleep(800); await page.touch('.trackrow');
const state = () => within(page.evaluate(() => {
  const el = window.__slopifyAudio?.().active; const md = navigator.mediaSession?.metadata;
  return { paused: el?.paused, t: el ? Math.round(el.currentTime * 10) / 10 : null, track: el?.dataset.track?.slice(0, 6) || null, title: md?.title || null, hidden: document.hidden, volume: el?.volume, log: (window.__slopifyMediaLog || []).slice(-6) };
}), 5000).catch((e) => ({ error: e.message }));
await sleep(3000);
const a = await state(); await sleep(1500); const b = await state();
check('plays in the app (<audio> clock moves)', b.paused === false && b.t > a.t, { a: a.t, b: b.t, track: b.track });
check('navigator.mediaSession metadata in the WebView', b.title, b.title);
shot('app-02-playing');
const ms = mediaSessions(adb.sh);
const own = ms.sessions.filter((s) => s.package === PKG);
results.mediaSessions = ms;
note(`system media sessions: ${JSON.stringify(ms.sessions.map((s) => `${s.package} ${s.state} ${s.metadata || ''}`))}`);
check('Android has a media session for the app (lock screen / notification controls)', own.length > 0, own.length ? own : 'none: the WebView publishes no MediaSession, so no notification, lock-screen or headset controls');
const notes = mediaNotifications(adb.sh, PKG);
check('media notification for the app', notes.some((n) => n.media), notes);

// Volume buttons, the phone's own sound: Android's music volume moves, the page does nothing.
const v0 = musicIndex();
adb.key('KEYCODE_VOLUME_UP'); await sleep(600); adb.key('KEYCODE_VOLUME_UP'); await sleep(1000);
const v1 = musicIndex();
const afterLocal = await state();
check('volume up while the phone plays: music volume +2, page untouched', v0 != null && v1 === v0 + 2 && !afterLocal.log?.some((l) => /volume button/.test(l)), { before: v0, after: v1, log: afterLocal.log });
adb.key('KEYCODE_VOLUME_DOWN'); await sleep(300); adb.key('KEYCODE_VOLUME_DOWN'); await sleep(3000); // (no BACK for the volume panel: BACK closes the app)

// Background (home), across a song change, then the screen off.
const titleBefore = (await state()).track;
adb.key('KEYCODE_HOME');
const bg = [];
for (let i = 0; i < 6; i++) { await sleep(2500); bg.push({ at: (i + 1) * 2.5, ...(await state()) }); }
results.background = bg;
for (const r of bg) note(`home +${r.at}s: ${r.error || `${r.track} paused=${r.paused} t=${r.t} hidden=${r.hidden}`}`);
const moving = (rs) => { const [a, b] = rs.slice(-2); return a && b && b.paused === false && (b.track !== a.track ? b.t > 0.3 : b.t > a.t + 0.5); };
check('keeps playing in the background (home pressed), clock still moving at the end', bg.every((r) => r.paused === false) && moving(bg), bg.map((r) => r.error || `${r.track}@${r.t}${r.paused ? ' paused' : ''}`));
check('the next song is heard in the background (its clock moves)', bg.some((r) => r.track && r.track !== titleBefore && r.t > 0.5), { before: titleBefore, during: bg.map((r) => `${r.track}@${r.t}`) });
// Back to the app, playing again, then the screen off with the app in front.
adb.sh(`am start -n ${PKG}/.MainActivity`); await sleep(2500);
const back = await state();
check('back in the app: page alive', !back.error, back);
if (back.paused !== false) {
  await page.touch('.player button[aria-label="Play"], .player button[title="Play"]').catch((e) => note(`resume: ${e.message}`));
  await sleep(2000);
}
const titleOn = (await state()).track;
adb.key(26); await sleep(500);
const off = [];
for (let i = 0; i < 6; i++) { await sleep(2500); off.push({ at: (i + 1) * 2.5, ...(await state()) }); }
results.screenOff = off;
for (const r of off) note(`screen off +${r.at}s: ${r.error || `${r.track} paused=${r.paused} t=${r.t}`}`);
const proc = adb.sh(`dumpsys activity processes ${PKG}`).match(/curProcState=\d+|isFrozen=\w+/g);
results.processState = proc; note(`process with the screen off: ${(proc || []).slice(0, 2).join(' ')}`);
check('keeps playing with the screen off, across a song change, clock still moving at the end', off.every((r) => r.paused === false) && off.some((r) => r.track !== titleOn && r.t > 0.5) && moving(off), off.map((r) => r.error || `${r.track}@${r.t}${r.paused ? ' paused' : ''}`));
adb.key('KEYCODE_WAKEUP'); adb.sh('wm dismiss-keyguard'); await sleep(1500);
shot('app-03-back');
// Android's audio-focus decisions for the app (Android 15+ "audio hardening"
// ignores focus requests from background apps without a foreground service).
const focus = adb.sh('logcat -d').split('\n').filter((l) => l.includes(PKG) && /HardeningEnforcer|requestAudioFocus|abandonAudioFocus/.test(l)).map((l) => l.replace(/AudioAttributes.*|android\.media\.AudioManager@\S+/g, '').trim());
results.audioFocusLog = focus.slice(-20);
const denied = focus.filter((l) => /HardeningEnforcer/.test(l));
if (denied.length) note(`audio focus refused ${denied.length}x, first: ${denied[0]}`);
results.mediaLogBackground = await page.evaluate(() => (window.__slopifyMediaLog || []).filter((l) => / bg |bg el|reconcile|app (background|active)/.test(` ${l}`)).slice(-25)).catch(() => []);

// Volume buttons drive another device: a headless "laptop" takes the music.
const desk = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const dp = await (await desk.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await dp.goto(`${base}/?debug=1`);
await dp.locator('.login input').nth(0).fill('admin'); await dp.locator('.login input').nth(1).fill(password);
await dp.locator('.login .primary').click();
await dp.waitForFunction(() => typeof window.__player === 'object' && typeof window.__jf === 'object', null, { timeout: 30000 });
await dp.waitForFunction(() => document.querySelectorAll('.card, .shortcut').length > 0, null, { timeout: 30000 });
await dp.evaluate(async () => {
  const tok = JSON.parse(localStorage.getItem('slopify.session') || '{}').token; const h = { Authorization: `Bearer ${tok}` };
  const a = (await (await fetch('/api/albums?limit=100', { headers: h })).json()).items.find((x) => x.name === 'First Light');
  const ids = (await (await fetch(`/api/albums/${a.id}`, { headers: h })).json()).tracks.map((t) => t.id);
  const p = window.__player; if (p.mirroring) p.relay?.claim();
  await p.playQueue(await window.__jf.itemsByIds(ids), 0, null);
});
const deskVol = () => dp.evaluate(() => Math.round(window.__player.volume ?? -1));
// The latest session message (media-session updates go over the same bridge in between).
const isRemote = () => page.evaluate(() => /"remote":true/.test((window.__bridgeLog || []).filter((m) => m.includes('"type":"session"')).slice(-1)[0] || '')).catch(() => false);
let remoteSeen = false;
for (let i = 0; i < 30 && !remoteSeen; i++) { await sleep(500); remoteSeen = await isRemote(); }
check('the page told the shell the sound is elsewhere (bridge: session remote)', remoteSeen, await page.evaluate(() => (window.__bridgeLog || []).slice(-3)).catch(() => null));
const phoneNow = await state();
check('the phone stopped its own sound when the laptop took the music', phoneNow.paused !== false, { paused: phoneNow.paused, t: phoneNow.t });
await sleep(1500);
const seq = [];
const sample = async (what) => seq.push({ what, laptop: await deskVol(), phoneIndex: musicIndex() });
await sample('start');
for (const k of ['KEYCODE_VOLUME_UP', 'KEYCODE_VOLUME_UP', 'KEYCODE_VOLUME_DOWN']) { adb.key(k); await sleep(2000); await sample(k.replace('KEYCODE_VOLUME_', '')); }
const log = await page.evaluate(() => (window.__slopifyMediaLog || []).filter((l) => /volume|shell/.test(l)).slice(-8)).catch(() => []);
results.remoteVolume = { seq, log, bridge: await page.evaluate(() => (window.__bridgeLog || []).slice(-4)).catch(() => null) };
for (const r of seq) note(`remote volume ${r.what}: laptop ${r.laptop}, phone music index ${r.phoneIndex}`);
check('each volume press on the phone steps the laptop (up, up, down)', seq[1].laptop > seq[0].laptop && seq[2].laptop > seq[1].laptop && seq[3].laptop < seq[2].laptop, { laptop: seq.map((r) => r.laptop), log });
check('the phone\'s own level is put back after each press', seq.every((r) => r.phoneIndex === seq[0].phoneIndex), seq.map((r) => r.phoneIndex));
shot('app-04-remote');
await dp.evaluate(() => window.__player.playing && window.__player.toggle()).catch(() => {});
await desk.close();

const errors = page.errors;
results.errors = errors;
check('no page errors', errors.filter((e) => !/ResizeObserver/.test(e)).length === 0, errors.slice(0, 10));
results.failed = results.checks.filter((c) => !c.ok).map((c) => c.name);
writeJson(path.join(out, 'app.json'), results);
console.log(`\n${results.checks.length - results.failed.length}/${results.checks.length} checks passed; ${path.join(out, 'app.json')}`);
page.close();
process.exit(results.failed.length ? 1 : 0);
