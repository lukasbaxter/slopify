// Slopify in real Chrome on the Android phone emulator, driven over the
// DevTools protocol (adb forward to chrome_devtools_remote, Playwright
// connectOverCDP). Signs in, plays an album, then checks what Android sees:
// the <audio> element, navigator.mediaSession, the system media session and
// notification (dumpsys), a track change with the screen off, and the PWA's
// installability (manifest, service worker, the install menu item).
//
//   node tools/device-lab/phone-chrome.mjs SERIAL PORT PASSWORD OUTDIR
//
// PORT is the lab server on the lab host; it is reached from the phone as
// http://localhost:PORT through `adb reverse` (a secure context, like https),
// and once as http://10.0.2.2:PORT (the emulator's alias for the host's
// loopback, plain http: not a secure context) for comparison.
// Exit code 1 if a check failed. Results: OUTDIR/phone-chrome.json + PNGs.
import { chromium } from 'playwright';
import { adbFor, mediaSessions, mediaNotifications, PB, sleep, writeJson } from './android.mjs';
import fs from 'node:fs';
import path from 'node:path';

const [serial, port, password, out] = process.argv.slice(2);
if (!out) { console.error('usage: phone-chrome.mjs SERIAL PORT PASSWORD OUTDIR'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const adb = adbFor(serial);
const base = `http://localhost:${port}`;
const CDP = Number(process.env.CDP_PORT || 9333);
const results = { started: new Date().toISOString(), checks: [], notes: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const note = (s) => { results.notes.push(s); console.log(`     ${s}`); };
const pngs = [];
const shot = (n) => { const f = path.join(out, `${n}.png`); adb.shot(f); pngs.push(f); return f; };

// Chrome: no first-run screens, DevTools socket forwarded, the server reachable as localhost.
adb.sh('am set-debug-app --persistent com.android.chrome');
adb.sh(`echo "_ --disable-fre --no-default-browser-check --no-first-run --disable-features=SigninPromo" > /data/local/tmp/chrome-command-line`);
adb.sh('pm grant com.android.chrome android.permission.POST_NOTIFICATIONS');
adb.sh('settings put system screen_off_timeout 1800000');
adb.key('KEYCODE_WAKEUP'); adb.sh('wm dismiss-keyguard');
adb.run('reverse', `tcp:${port}`, `tcp:${port}`);
adb.sh('am force-stop com.android.chrome');
adb.key('KEYCODE_HOME');
adb.sh(`am start -n com.android.chrome/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d ${base}/`);
adb.run('forward', `tcp:${CDP}`, 'localabstract:chrome_devtools_remote');
let ver = null;
for (let i = 0; i < 40 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); } catch { await sleep(500); } }
if (!ver) { check('Chrome DevTools reachable', false); writeJson(path.join(out, 'phone-chrome.json'), results); process.exit(1); }
results.chrome = ver.Browser; results.ua = ver['User-Agent'];
note(`${ver.Browser}; Android ${adb.sh('getprop ro.build.version.release').trim()}`);
// A permission prompt from an earlier run may still be up.
await adb.tapText(/^No thanks$|^Not now$/i, { tries: 2, wait: 500 });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
const ctx = browser.contexts()[0];
let page = null;
for (let i = 0; i < 20 && !page; i++) { page = ctx.pages().find((p) => p.url().startsWith(base)) || null; if (!page) await sleep(500); }
if (!page) { page = await ctx.newPage(); await page.goto(`${base}/`); }
// A real touch (CDP Input.dispatchTouchEvent) at the element's centre: a
// trusted gesture, as a finger would give.
const touch = async (loc) => {
  await loc.first().scrollIntoViewIfNeeded();
  const b = await loc.first().boundingBox();
  if (!b) throw new Error('no box for touch');
  const pt = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const s = await ctx.newCDPSession(page);
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
  await sleep(60);
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await s.detach().catch(() => {});
};
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const failed = []; page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(base, '')}`); });

// Sign in (the web build's form: username, password).
await page.goto(`${base}/`);
await page.waitForLoadState('domcontentloaded');
if (await page.locator('.login input').count()) {
  const inputs = page.locator('.login input');
  await inputs.nth(0).fill('admin'); await inputs.nth(1).fill(password);
  // Close the soft keyboard first: while it is up, Chrome scrolls the visual
  // viewport and Playwright's hit test lands on the wrong element.
  await page.evaluate(() => document.activeElement?.blur()); await sleep(1000);
  await touch(page.locator('.login .primary'));
}
await page.locator('.tabbar, .sidebar, .shell').first().waitFor({ timeout: 30000 });
const signedIn = await page.locator('.tabbar').count();
check('signed in, phone layout (tab bar)', signedIn > 0);
await page.waitForFunction(() => document.querySelectorAll('.card, .shortcut').length > 0, null, { timeout: 30000 });

// Play an album: open it, tap a row (one tap plays on a phone).
await touch(page.locator('.card, .shortcut', { hasText: 'Second Wind' }));
await page.locator('.trackrow').first().waitFor({ timeout: 15000 });
await sleep(800); await touch(page.locator('.trackrow'));
const pause = page.locator('.player button[title="Pause"], .player button[aria-label="Pause"]').first();
check('player shows Pause after a tap', await pause.waitFor({ timeout: 20000 }).then(() => true, () => false));

const audioState = () => page.evaluate(() => {
  const a = window.__slopifyAudio?.() || {}; const el = a.active;
  const ms = navigator.mediaSession; const md = ms?.metadata;
  return {
    el: el ? { paused: el.paused, t: Math.round(el.currentTime * 10) / 10, dur: Math.round((el.duration || 0) * 10) / 10, readyState: el.readyState, muted: el.muted, volume: el.volume, track: el.dataset.track || null, src: (el.currentSrc || '').replace(location.origin, '').slice(0, 80) } : null,
    standIn: a.standIn ? { paused: a.standIn.paused, muted: a.standIn.muted } : null,
    session: md ? { title: md.title, artist: md.artist, album: md.album, artwork: (md.artwork || []).map((x) => x.sizes || x.src.slice(-20)) } : null,
    playbackState: ms?.playbackState,
    hidden: document.hidden, visibility: document.visibilityState,
    bar: (document.querySelector('.player')?.textContent || '').slice(0, 80),
  };
});
await sleep(2500);
const s1 = await audioState();
await sleep(1500);
const s2 = await audioState();
results.playing = s2;
check('<audio> is playing and its clock moves', s2.el && !s2.el.paused && s2.el.t > s1.el.t, { t1: s1.el?.t, t2: s2.el?.t, readyState: s2.el?.readyState, src: s2.el?.src });
check('navigator.mediaSession metadata set', s2.session?.title && s2.session?.artist, s2.session);
check('navigator.mediaSession.playbackState is "playing"', s2.playbackState === 'playing', s2.playbackState);

const sys = () => { const m = mediaSessions(adb.sh); return { ...m, chrome: m.sessions.filter((s) => s.package === 'com.android.chrome') }; };
const m1 = sys();
results.mediaSessionPlaying = m1;
const chromeActive = m1.chrome.find((s) => s.active) || m1.chrome[0];
check('system media session (dumpsys media_session) for Chrome', chromeActive, chromeActive);
check('system session state PLAYING', /^(3|PLAYING)$/.test(chromeActive?.state || ''), chromeActive?.state || 'none');
check('system session metadata has the song title', chromeActive?.metadata?.includes(s2.session?.title || '\u0000'), chromeActive?.metadata);
const notes1 = mediaNotifications(adb.sh, 'com.android.chrome');
results.notificationsPlaying = notes1;
const mediaNote = notes1.find((n) => n.media) || notes1.find((n) => n.title && n.title === s2.session?.title);
check('media notification posted by Chrome', mediaNote, notes1);
shot('phone-01-playing');
adb.sh('cmd statusbar expand-notifications'); await sleep(1500);
shot('phone-02-notification-shade');
adb.sh('cmd statusbar collapse'); await sleep(500);

// Pause from the notification's media session (a headset / notification
// pause goes through the same session): `cmd media_session dispatch pause`.
adb.sh('cmd media_session dispatch pause'); await sleep(1500);
const paused = await audioState();
check('system pause (media button) pauses the page', paused.el?.paused === true, { paused: paused.el?.paused, playbackState: paused.playbackState });
adb.sh('cmd media_session dispatch play'); await sleep(2000);
const resumed = await audioState();
check('system play (media button) resumes', resumed.el?.paused === false, { paused: resumed.el?.paused, playbackState: resumed.playbackState });
const t0 = resumed.session?.title;
adb.sh('cmd media_session dispatch next'); await sleep(2500);
const nexted = await audioState();
check('system next skips to another song', nexted.session?.title && nexted.session.title !== t0, { from: t0, to: nexted.session?.title });

// Screen off through a track change (the fixture songs are 4-8 s long).
const before = await audioState();
adb.key(26); await sleep(800);
check('screen is off after the power key', !adb.screenOn());
const offLog = [];
for (let i = 0; i < 10; i++) {
  await sleep(2000);
  let st = null; try { st = await audioState(); } catch (e) { st = { error: String(e).slice(0, 120) }; }
  const sess = sys().chrome.find((s) => s.active) || null;
  offLog.push({ at: i * 2 + 2, title: st.session?.title, paused: st.el?.paused, t: st.el?.t, visibility: st.visibility, sys: sess ? `${PB[sess.state] || sess.state} ${sess.metadata || ''}` : 'no active session' });
}
results.screenOff = offLog;
for (const r of offLog) note(`screen off +${r.at}s: ${r.title} paused=${r.paused} t=${r.t} ${r.visibility}; system: ${r.sys}`);
const titles = [...new Set(offLog.map((r) => r.title).filter(Boolean))];
check('a track change happened with the screen off', titles.some((t) => t !== before.session?.title), { before: before.session?.title, during: titles });
check('kept playing with the screen off (never paused)', offLog.every((r) => r.paused === false), offLog.map((r) => r.paused));
const lastSys = offLog[offLog.length - 1].sys;
check('system session follows the new song with the screen off', titles.length && lastSys.includes(offLog[offLog.length - 1].title || '\u0000'), lastSys);
adb.key('KEYCODE_WAKEUP'); adb.sh('wm dismiss-keyguard'); await sleep(1500);
const after = await audioState();
check('after waking: still playing, same song as the system session', after.el && !after.el.paused, { title: after.session?.title, t: after.el?.t, sys: (sys().chrome.find((s) => s.active) || {}).metadata });
shot('phone-03-after-wake');


// PWA: manifest, service worker, installability as Chrome sees it.
const cdp = await ctx.newCDPSession(page);
let manifest = null, installErrors = null;
try { manifest = await cdp.send('Page.getAppManifest'); } catch (e) { manifest = { error: String(e) }; }
try { installErrors = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors; } catch (e) { installErrors = String(e); }
const sw = await page.evaluate(async () => ({ secure: isSecureContext, controller: !!navigator.serviceWorker?.controller, regs: (await navigator.serviceWorker?.getRegistrations?.() || []).map((r) => r.scope), standalone: matchMedia('(display-mode: standalone)').matches }));
results.pwa = { manifestUrl: manifest?.url, manifestErrors: manifest?.errors, parsed: manifest?.data ? JSON.parse(manifest.data) : null, installErrors, sw };
check('manifest found and parsed without errors', manifest?.url && !(manifest.errors || []).length, { url: manifest?.url, errors: manifest?.errors });
check('Chrome reports no installability errors', Array.isArray(installErrors) && installErrors.length === 0, installErrors);
check('service worker registered (secure origin)', sw.regs.length > 0, sw);

// Install through the menu, as a person would.
const webapksBefore = adb.sh('pm list packages').split('\n').filter((l) => l.includes('webapk'));
// Chrome's "Save password?" sheet (a fresh server, a fresh login) covers the menu.
if (adb.find(/Save password|Password Manager/)) { if (!(await adb.tapText(/^(Never|No thanks|Not now)$/i, { tries: 2, wait: 600 }))) adb.key('KEYCODE_BACK'); await sleep(800); }
await adb.tapText(/menu_button|More options|Customize and control/i);
await sleep(1200);
const nodes = adb.ui();
const item = nodes.find((n) => /^(Install app|Add to home screen|Add to Home screen)$/i.test(n.text));
results.pwa.menuItem = item?.text || null;
check('Chrome menu offers Install app / Add to home screen', item, nodes.filter((n) => n.text && n.pkg === 'com.android.chrome').map((n) => n.text).slice(0, 20));
if (item) {
  adb.sh(`input tap ${item.x} ${item.y}`); await sleep(2000);
  shot('phone-04-install-dialog');
  const btn = await adb.tapText(/^(Install|Add)$/i, { tries: 4, wait: 1000 });
  await sleep(6000);
  const webapks = adb.sh('pm list packages').split('\n').filter((l) => l.includes('webapk'));
  const shortcuts = adb.sh('dumpsys shortcut | grep -iE "slopify|webapk" | head -5').trim();
  results.pwa.install = { clicked: btn?.text || null, webapksBefore, webapks, shortcuts };
  note(`install: tapped "${btn?.text || 'nothing'}"; WebAPK packages ${JSON.stringify(webapks)}; launcher shortcuts: ${shortcuts || 'none'}`);
  check('installed as a WebAPK or home-screen shortcut', webapks.length > webapksBefore.length || shortcuts, { webapks, shortcuts });
  shot('phone-05-after-install');
  adb.key('KEYCODE_BACK');
} else adb.key('KEYCODE_BACK');

// The same server over 10.0.2.2: plain http on a non-local address.
const p2 = await ctx.newPage();
await p2.goto(`http://10.0.2.2:${port}/`).catch(() => {});
const insecure = await p2.evaluate(() => ({ secure: isSecureContext, sw: 'serviceWorker' in navigator, mediaSession: 'mediaSession' in navigator, caches: typeof caches })).catch((e) => ({ error: String(e) }));
results.via10022 = insecure;
note(`over http://10.0.2.2: ${JSON.stringify(insecure)}`);
await p2.close();

results.errors = errors; results.failedRequests = failed;
if (failed.length) note(`failed requests: ${failed.join(', ')}`);
// A user with no picture: /avatar answers 404, which Chrome logs as a console
// error (walk.spec allows it too). Counted apart, not as a failure.
const avatar404 = failed.filter((f) => /\/avatar/.test(f));
if (avatar404.length) note(`avatar 404s (no picture set): ${avatar404.length}`);
const realErrors = errors.filter((e) => !/ResizeObserver/.test(e) && !(avatar404.length && /status of 404/.test(e)) && !/Failed to install WebAPK/.test(e));
check('no page errors', realErrors.length === 0, realErrors.slice(0, 10));
results.mediaLog = await page.evaluate(() => (window.__slopifyMediaLog || []).slice(-60)).catch(() => []);
results.screenshots = pngs;
results.failed = results.checks.filter((c) => !c.ok).map((c) => c.name);
writeJson(path.join(out, 'phone-chrome.json'), results);
console.log(`\n${results.checks.length - results.failed.length}/${results.checks.length} checks passed; ${path.join(out, 'phone-chrome.json')}`);
await browser.close().catch(() => {});
process.exit(results.failed.length ? 1 : 0);
