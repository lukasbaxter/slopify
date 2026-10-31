// The Slopify TV app (tv/) on an Android TV emulator, pointed at the lab
// server (lab.sh patches the APK: server URL, cleartext, debuggable for the
// WebView's DevTools socket). Sign-in with the remote, the TV in other
// clients' device lists, playback handed to it from a "laptop" (headless
// Chromium on the lab host), the remote's keys, the seeded sign-in
// (--es token / userId), the app in the background, and Google Play services.
//
//   node tools/device-lab/tv-test.mjs SERIAL PORT PASSWORD OUTDIR APK LABEL
// Exit code 1 if a check failed. Results: OUTDIR/tv-<LABEL>.json + PNGs.
import { chromium } from 'playwright';
import { adbFor, cdpPage, mediaSessions, sleep, writeJson } from './android.mjs';
import fs from 'node:fs';
import path from 'node:path';

const [serial, port, password, out, apk, label = 'tv'] = process.argv.slice(2);
if (!apk) { console.error('usage: tv-test.mjs SERIAL PORT PASSWORD OUTDIR APK [LABEL]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const PKG = 'com.lukasbaxter.slopify.tv';
const adb = adbFor(serial);
const base = `http://localhost:${port}`;
const CDP = Number(process.env.TV_CDP_PORT || 9335);
const NAME = `Lab ${label}`;
const results = { started: new Date().toISOString(), label, apk: path.basename(apk), checks: [], notes: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const note = (s) => { results.notes.push(s); console.log(`     ${s}`); };
const shot = (n) => adb.shot(path.join(out, `tv-${label}-${n}.png`));
const finish = (code) => { results.failed = results.checks.filter((c) => !c.ok).map((c) => c.name); writeJson(path.join(out, `tv-${label}.json`), results); console.log(`\n${results.checks.length - results.failed.length}/${results.checks.length} checks passed; ${path.join(out, `tv-${label}.json`)}`); process.exit(code ?? (results.failed.length ? 1 : 0)); };

// The device, and whether Google Play services are there (Fire OS has none).
const gms = adb.sh('pm list packages -e').split('\n').filter((l) => /com\.google\.android\.gms$|com\.android\.vending$|com\.google\.android\.gsf$/.test(l.trim())).map((l) => l.replace('package:', '').trim());
results.device = { android: adb.sh('getprop ro.build.version.release').trim(), model: adb.sh('getprop ro.product.model').trim(), webview: (adb.sh('dumpsys webviewupdate').match(/Current WebView package \(name, version\): \(([^)]*)\)/) || [])[1] || null, gmsEnabled: gms };
note(`Android ${results.device.android} (${results.device.model}), WebView ${results.device.webview}, Google services enabled: ${gms.length ? gms.join(', ') : 'none'}`);

// Login token for the API checks and the seeded sign-in.
const login = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) })).json();
const api = async (p) => (await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${login.token}` } })).json();

// Fresh install; the device's name as the owner would set it.
adb.sh(`settings put global device_name "${NAME}"`);
adb.sh(`pm uninstall ${PKG}`);
const inst = adb.run('install', apk).trim().split('\n').pop();
check('APK installs', /Success|complete/i.test(inst), inst);
adb.run('reverse', `tcp:${port}`, `tcp:${port}`);
adb.sh('logcat -c');
adb.key('KEYCODE_WAKEUP');
const t0 = Date.now();
adb.sh(`am start -W -n ${PKG}/.MainActivity`);

const connect = async () => {
  let pid = '', sock = null;
  for (let i = 0; i < 40 && !sock; i++) {
    pid = adb.sh(`pidof ${PKG}`).trim();
    const m = pid && adb.sh('cat /proc/net/unix').match(new RegExp(`@(webview_devtools_remote_${pid})\\b`));
    if (m) sock = m[1]; else await sleep(500);
  }
  if (!sock) return null;
  adb.run('forward', `tcp:${CDP}`, `localabstract:${sock}`);
  return cdpPage(CDP, base);
};
let page = await connect();
check('the app opened the lab server (DevTools reachable)', page, page?.target?.url || 'no WebView DevTools socket');
if (!page) { shot('00-nopage'); finish(1); }
await page.waitFor(() => document.readyState !== 'loading');
const loginShown = await page.waitFor(() => !!document.querySelector('.login input') || !!document.querySelector('.fs-top'), null, 30000);
results.firstPaintMs = Date.now() - t0;
check('the server\'s page loaded (login form)', loginShown, `${results.firstPaintMs} ms after launch`);
results.page = await page.evaluate(() => ({ shell: window.slopifyShell || null, dpr: window.devicePixelRatio, inner: [innerWidth, innerHeight], ua: navigator.userAgent, mediaSession: 'mediaSession' in navigator, helper: !!window.__tv }));
check('the shell identifies the TV (window.slopifyShell)', results.page.shell?.platform === 'androidtv' && results.page.shell?.deviceName === NAME, results.page.shell);
check('laid out at 1600 css px, devicePixelRatio 1', results.page.inner[0] === 1600 && results.page.dpr === 1, { inner: results.page.inner, dpr: results.page.dpr });
note(`UA: ${results.page.ua}`);
shot('01-login');

// Sign in with the remote: the d-pad moves focus, the keyboard (IME) types.
const focusOf = () => page.evaluate(() => { const a = document.activeElement; const all = [...document.querySelectorAll('.login input, .login button')]; return a ? `${a.tagName.toLowerCase()}${a.type ? `[${a.type}]` : ''} #${all.indexOf(a)}` : 'none'; });
const focusLog = [await focusOf()];
for (let i = 0; i < 4 && !/input\[text\] #0/.test(focusLog[focusLog.length - 1]); i++) { adb.key('KEYCODE_DPAD_DOWN'); await sleep(500); focusLog.push(await focusOf()); }
results.dpadFocus = focusLog;
const dpadReaches = /input\[text\] #0|input #0/.test(focusLog[focusLog.length - 1]);
check('the d-pad reaches the username field', dpadReaches, focusLog);
if (!dpadReaches) await page.evaluate(() => document.querySelector('.login input')?.focus());
adb.sh('input text admin'); await sleep(400);
// With the on-screen keyboard up the d-pad moves around the keyboard (on a
// real TV too): Back closes it, then down moves on. Back only while it is
// up: otherwise Back leaves the app.
if (/mInputShown=true/.test(adb.sh('dumpsys input_method | grep mInputShown'))) { adb.key('KEYCODE_BACK'); await sleep(600); }
adb.key('KEYCODE_DPAD_DOWN'); await sleep(500);
let onPassword = await focusOf();
results.passwordBy = 'dpad';
// The on-screen keyboard's Next is a TAB to the page.
if (!/#1/.test(onPassword)) { adb.key('KEYCODE_TAB'); await sleep(500); onPassword = await focusOf(); results.passwordBy = 'tab (keyboard Next)'; }
if (!/#1/.test(onPassword)) { await page.evaluate(() => document.querySelectorAll('.login input')[1]?.focus()); results.passwordBy = 'focus() from the harness'; }
check('the d-pad moves from username to password', results.passwordBy === 'dpad', results.passwordBy);
adb.sh(`input text "${password.replace(/ /g, '%s')}"`); await sleep(400);
adb.key('KEYCODE_ENTER'); await sleep(500);
let signedIn = await page.waitFor(() => !!document.querySelector('.fs-top, .sidebar, .shell'), null, 8000);
if (!signedIn) { // Enter did not submit: the d-pad to the button and centre.
  adb.key('KEYCODE_DPAD_DOWN'); await sleep(400); results.buttonFocus = await focusOf(); adb.key('KEYCODE_DPAD_CENTER');
  signedIn = await page.waitFor(() => !!document.querySelector('.fs-top, .sidebar, .shell'), null, 15000);
}
check('signed in with the remote (Enter in the password field, or the button)', signedIn, { passwordBy: results.passwordBy, submit: results.buttonFocus ? `button (${results.buttonFocus})` : 'Enter' });
if (!signedIn) await page.evaluate(({ pw }) => { const i = document.querySelectorAll('.login input'); const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }; set(i[0], 'admin'); set(i[1], pw); document.querySelector('.login .primary').click(); }, { pw: password });
check('the now-playing view opens by itself', await page.waitFor(() => !!document.querySelector('.fs-top'), null, 20000));
shot('02-signed-in');

// Other clients see it.
await sleep(2000);
const clients = (await api('/api/session')).clients || [];
results.clients = clients;
const me = clients.find((c) => c.name === NAME || (c.name || '').includes(NAME));
check(`listed in /api/session clients as "${NAME}"`, me, clients.map((c) => `${c.name} (${c.kind}${c.canPlay ? ', can play' : ''})`));

// A laptop hands it the music through its device menu.
const desk = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const dp = await (await desk.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await dp.goto(`${base}/?debug=1`);
await dp.locator('.login input').nth(0).fill('admin'); await dp.locator('.login input').nth(1).fill(password);
await dp.locator('.login .primary').click();
await dp.waitForFunction(() => typeof window.__player === 'object' && typeof window.__jf === 'object', null, { timeout: 30000 });
await dp.waitForFunction(() => document.querySelectorAll('.card, .shortcut').length > 0, null, { timeout: 30000 });
await dp.evaluate(async () => {
  const tok = JSON.parse(localStorage.getItem('slopify.session') || '{}').token; const h = { Authorization: `Bearer ${tok}` };
  const a = (await (await fetch('/api/albums?limit=100', { headers: h })).json()).items.find((x) => x.name === 'Second Wind');
  const ids = (await (await fetch(`/api/albums/${a.id}`, { headers: h })).json()).tracks.map((t) => t.id);
  const p = window.__player; if (p.mirroring) p.relay?.claim();
  await p.playQueue(await window.__jf.itemsByIds(ids), 0, a.id);
});
await sleep(1500);
await dp.locator('.devicebtn').first().click(); await sleep(800);
const items = await dp.locator('.deviceitem').allInnerTexts();
results.laptopDeviceMenu = items;
let tvItem = dp.locator('.deviceitem', { hasText: NAME });
check('the TV is in the laptop\'s device menu under its name', await tvItem.count(), items.map((s) => s.replace(/\n/g, ' / ')));
if (!(await tvItem.count())) {
  // Listed under another name (no shell identity): the one other client.
  const other = items.filter((t) => !/This Web Player/.test(t));
  if (other.length === 1) { tvItem = dp.locator('.deviceitem', { hasText: other[0].split('\n')[0] }); note(`picking the TV as "${other[0].split('\n')[0]}"`); }
}
const tvState = () => page.evaluate(() => { const el = window.__slopifyAudio?.().active; return { paused: el?.paused, t: el ? Math.round(el.currentTime * 10) / 10 : null, track: el?.dataset.track?.slice(0, 6) || null, title: document.querySelector('.fs-title, .fs .title, .player .title')?.textContent?.trim()?.slice(0, 40) || null, log: (window.__slopifyMediaLog || []).slice(-5) }; }, null, 5000).catch((e) => ({ error: e.message }));
if (await tvItem.count()) {
  await tvItem.first().click();
  let s1 = null;
  for (let i = 0; i < 20; i++) { await sleep(1000); s1 = await tvState(); if (s1.paused === false && s1.t > 0.5) break; }
  await sleep(1500); const s2 = await tvState();
  check('plays on the TV after the laptop picks it (clock moves)', s2.paused === false && s2.t > s1.t, { s1, s2 });
  const deskPlaying = await dp.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused));
  check('the laptop itself went quiet', !deskPlaying, deskPlaying);
  shot('03-playing');
  // The remote: right = next, play/pause.
  const before = (await tvState()).track;
  adb.key('KEYCODE_DPAD_RIGHT'); await sleep(2500);
  const afterNext = await tvState();
  check('remote right skips to the next song', afterNext.track && afterNext.track !== before, { before, after: afterNext.track });
  adb.key('KEYCODE_MEDIA_PLAY_PAUSE'); await sleep(1500);
  const paused = await tvState();
  adb.key('KEYCODE_MEDIA_PLAY_PAUSE'); await sleep(2000);
  const resumed = await tvState();
  check('remote play/pause pauses and resumes', paused.paused === true && resumed.paused === false, { paused: paused.paused, resumed: resumed.paused });
  const ms = mediaSessions(adb.sh).sessions.filter((s) => s.package === PKG);
  results.mediaSessions = ms;
  note(`system media session for the TV app: ${ms.length ? JSON.stringify(ms) : 'none (the WebView publishes none: no system Now Playing, no Bluetooth/HDMI-CEC remote media keys when the app is not in front)'}`);
  // Home: the app in the background.
  const bgFrom = await tvState();
  adb.key('KEYCODE_HOME'); await sleep(6000);
  const bg = await tvState();
  results.background = { from: bgFrom, after6s: bg };
  check('keeps playing with the TV app in the background (Home)', bg.paused === false && (bg.track !== bgFrom.track || bg.t > bgFrom.t), { from: `${bgFrom.track}@${bgFrom.t}`, after: bg.error || `${bg.track}@${bg.t}${bg.paused ? ' paused' : ''}` });
  adb.sh(`am start -n ${PKG}/.MainActivity`); await sleep(2000);
  await dp.evaluate(() => window.__player.playing && window.__player.toggle()).catch(() => {});
}
await desk.close();

// fps the page logs every 10 s (visualizer cost on this device).
const logcat = adb.sh('logcat -d -s SlopifyTV:I chromium:E');
results.fps = [...logcat.matchAll(/slopify-tv fps ([\d.]+) tab=(\S+)/g)].map((m) => `${m[1]} (${m[2]})`);
results.consoleErrors = logcat.split('\n').filter((l) => /SlopifyTV.*\bERROR\b|Uncaught/.test(l)).slice(0, 15);
if (results.fps.length) note(`fps: ${results.fps.join(', ')}`);
check('no uncaught errors in the page console', results.consoleErrors.length === 0, results.consoleErrors);
page.close();

// The seeded sign-in: a fresh TV started with a device token.
adb.sh(`pm clear ${PKG}`);
adb.sh(`am start -W -n ${PKG}/.MainActivity --es token ${login.token} --es userId ${login.user.id}`);
page = await connect();
const seeded = page && await page.waitFor(() => !!document.querySelector('.fs-top, .sidebar, .shell'), null, 30000);
check('seeded sign-in (--es token --es userId) skips the form', seeded);
shot('04-seeded');
page?.close();
finish();
