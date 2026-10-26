import { test, expect, type Browser, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// The phone's Now Playing (lock screen, Control Center, AirPods): what the
// page tells navigator.mediaSession and what its <audio> elements hold.
// WebKit decides the lock screen from the elements, not only from what the
// page declares, so the elements are checked as well as the calls.
test.describe.configure({ mode: 'serial' });

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

// Every audio element the page makes, and every setPositionState call.
async function device(browser: Browser, phone: boolean, homeScreenApp = false) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: IPHONE }
    : { viewport: { width: 1400, height: 900 } });
  // The home-screen web app (navigator.standalone): the 2-hour hold applies.
  if (homeScreenApp) await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }); });
  await ctx.addInitScript(() => {
    const w = window as any;
    w.__els = [];
    const Orig = window.Audio;
    const Wrapped: any = function (...a: any[]) { const el = new (Orig as any)(...a); w.__els.push(el); return el; };
    Wrapped.prototype = Orig.prototype;
    w.Audio = Wrapped;
    w.__ps = [];
    const ms = navigator.mediaSession as any;
    if (ms?.setPositionState) { const orig = ms.setPositionState.bind(ms); ms.setPositionState = (s?: any) => { w.__ps.push({ ...(s || {}), at: Date.now() }); return orig(s); }; }
    // The Media Session action handlers, to call them as iOS would.
    w.__msHandlers = {};
    if (ms?.setActionHandler) { const orig = ms.setActionHandler.bind(ms); ms.setActionHandler = (a: string, f: any) => { w.__msHandlers[a] = f; return orig(a, f); }; }
  });
  const page = await ctx.newPage();
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__player), { timeout: 15000 }).toBe('object');
  return page;
}
const token = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '');
async function albumIds(page: Page, name: string) {
  const h = { Authorization: `Bearer ${await token(page)}` };
  const a = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items.find((x: any) => x.name === name);
  return (await (await page.request.get(`/api/albums/${a.id}`, { headers: h })).json()).tracks.map((t: any) => t.id) as string[];
}
// Play these ids here, taking the session if another page has it.
async function play(page: Page, ids: string[]) {
  await expect.poll(() => page.evaluate(() => { const p = (window as any).__player; if (p.mirroring) p.relay?.claim(); return p.mirroring; }), { timeout: 15000 }).toBe(false);
  await page.evaluate(async (ids) => { const w = window as any; await w.__player.playQueue(await w.__jf.itemsByIds(ids), 0, null); }, ids);
}
// Media elements holding a song (the silent stand-in is not one).
const holding = (page: Page) => page.evaluate(() => { const w = window as any; return w.__els.filter((e: any) => e !== w.__conduitKeepAlive && e.getAttribute('src')).length; });

test('another device takes the music: the phone lets go of its song', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  // A paused element that still holds a song is a candidate for WebKit's Now
  // Playing (MediaElementSession::canShowControlsManager asks for a source,
  // not for playback), and its paused state then wins the lock screen while
  // the other device plays (10-26 breadcrumbs: "element paused" holding the
  // phone's old song through 30 minutes of the laptop playing).
  const phone = await device(browser, true);
  const desk = await device(browser, false);
  const ids = await albumIds(phone, 'First Light');
  await play(phone, ids);
  await expect.poll(() => phone.evaluate(() => (window as any).__player.playing), { timeout: 10000 }).toBe(true);
  await expect.poll(() => holding(phone)).toBe(1);
  // The laptop plays something: the phone yields.
  await play(desk, ids.slice(2));
  await expect.poll(() => phone.evaluate(() => (window as any).__player.mirroring), { timeout: 15000 }).toBe(true);
  await expect.poll(() => holding(phone), { timeout: 5000 }).toBe(0);
  // Play on the phone again: it takes the session back and plays here.
  await phone.evaluate(() => (window as any).__player.setDevice({ id: 'local', kind: 'local', name: 'This Web Player' }));
  await expect.poll(() => phone.evaluate(() => { const w = window as any; return w.__els.some((e: any) => e !== w.__conduitKeepAlive && !e.paused && e.getAttribute('src')); }), { timeout: 15000 }).toBe(true);
  // Handed to the laptop from the phone's device list: let go of it too.
  const deskId = await desk.evaluate(() => (window as any).__player.relay.id);
  await phone.evaluate((id) => (window as any).__player.setDevice({ id: `relay:${id}`, kind: 'relay', name: 'Laptop', relayClientId: id }), deskId);
  await expect.poll(() => desk.evaluate(() => (window as any).__player.mirroring === false && (window as any).__player.playing), { timeout: 15000 }).toBe(true);
  await expect.poll(() => holding(phone), { timeout: 5000 }).toBe(0);
  await desk.evaluate(() => (window as any).__player.toggle());
  await phone.context().close(); await desk.context().close();
});

test('the stand-in stops muted and comes back unmuted', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  // WebKit gives Now Playing to the most recently interacted-with candidate,
  // not to the element that plays. The stand-in's stop (pause + unload, 2 s
  // after it is let go) can run inside a lock-screen command's user gesture,
  // which made the stopped stand-in that candidate: the lock screen said
  // paused for the rest of the song (tools/ios-sim, locked "next while
  // paused": 4 of 4 before, 0 of 6 after). A muted element is never a
  // candidate, so the stand-in is muted as it stops, and unmuted to play.
  const standIn = (page: Page) => page.evaluate(() => { const a = (window as any).__conduitKeepAlive; return a ? { paused: a.paused, muted: a.muted, src: !!a.getAttribute('src') } : null; });
  const desk = await device(browser, false);
  const phone = await device(browser, true);
  const ids = await albumIds(desk, 'First Light');
  // The laptop plays: the phone shows it, its stand-in playing (unmuted).
  await play(desk, ids);
  await expect.poll(() => standIn(phone), { timeout: 15000 }).toEqual({ paused: false, muted: false, src: true });
  // The phone takes the music: 2 s later the stand-in is stopped, unloaded
  // and muted, while the phone's own element plays, unmuted.
  await phone.evaluate(() => (window as any).__player.setDevice({ id: 'local', kind: 'local', name: 'This Web Player' }));
  await expect.poll(() => standIn(phone), { timeout: 15000 }).toEqual({ paused: true, muted: true, src: false });
  expect(await phone.evaluate(() => { const w = window as any; return w.__els.some((e: any) => e !== w.__conduitKeepAlive && !e.paused && !e.muted && e.getAttribute('src')); })).toBe(true);
  // The laptop takes it back: the stand-in plays again, with its sound.
  await play(desk, ids.slice(1));
  await expect.poll(() => standIn(phone), { timeout: 15000 }).toEqual({ paused: false, muted: false, src: true });
  await desk.evaluate(() => (window as any).__player.toggle());
  await phone.context().close(); await desk.context().close();
});

test('held paused, the face shows and the stand-in plays muted', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  // Locked and untouched, the face (keepalive.js) cannot be made a newer
  // candidate than the playing stand-in, so while a session is held paused
  // the stand-in plays muted (no candidate) and the face, unmuted, is Now
  // Playing with paused (tools/ios-sim, 10-26: the laptop pausing left the
  // phone's lock screen on pause and a running clock).
  const els = (page: Page) => page.evaluate(() => { const w = window as any; const k = w.__conduitKeepAlive, f = w.__conduitFace; return { standIn: k ? { playing: !k.paused, muted: k.muted } : null, face: f ? { loaded: !!f.getAttribute('src'), muted: f.muted, paused: f.paused } : null }; });
  const desk = await device(browser, false);
  const phone = await device(browser, true, true);
  await phone.mouse.click(2, 2); // the first tap: unlocks the stand-in, loads the face
  const ids = await albumIds(desk, 'First Light');
  await play(desk, ids);
  await expect.poll(() => els(phone), { timeout: 15000 }).toEqual({ standIn: { playing: true, muted: false }, face: { loaded: true, muted: true, paused: true } });
  await desk.evaluate(() => (window as any).__player.toggle());
  await expect.poll(() => els(phone), { timeout: 15000 }).toEqual({ standIn: { playing: true, muted: true }, face: { loaded: true, muted: false, paused: true } });
  await desk.evaluate(() => (window as any).__player.toggle());
  await expect.poll(() => els(phone), { timeout: 15000 }).toEqual({ standIn: { playing: true, muted: false }, face: { loaded: true, muted: true, paused: true } });
  await desk.evaluate(() => (window as any).__player.toggle());
  await phone.context().close(); await desk.context().close();
});

test('another app interrupting a phone that only controls the session pauses nothing', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  // Another app taking the sound interrupts the phone's silent stand-in, and
  // WebKit then calls the page's Media Session 'pause' handler
  // (MediaSession::suspendPlayback), as if from the lock screen: it paused
  // the speaker or TV the phone only controls. A pause that comes with the
  // stand-in paused by the system is dropped; a real lock-screen pause still
  // goes through.
  const desk = await device(browser, false);
  const phone = await device(browser, true, true);
  await phone.mouse.click(2, 2); // the first tap unlocks the stand-in
  const ids = await albumIds(desk, 'First Light');
  await play(desk, ids);
  await expect.poll(() => phone.evaluate(() => { const k = (window as any).__conduitKeepAlive; return !!k && !k.paused; }), { timeout: 15000 }).toBe(true);
  // The interruption: iOS pauses the stand-in, then WebKit hands the page 'pause'.
  await phone.evaluate(() => { const w = window as any; w.__conduitKeepAlive.pause(); w.__msHandlers.pause?.({ action: 'pause' }); });
  await phone.waitForTimeout(2500);
  expect(await desk.evaluate(() => (window as any).__player.playing)).toBe(true);
  // The stand-in asked to play again (iOS resumes it when the interruption ends).
  await expect.poll(() => phone.evaluate(() => !(window as any).__conduitKeepAlive.paused), { timeout: 5000 }).toBe(true);
  // A lock-screen pause (the stand-in still playing) is sent.
  await phone.waitForTimeout(3500); // past the 3 s an interruption's pause is recognised for
  await phone.evaluate(() => (window as any).__msHandlers.pause?.({ action: 'pause' }));
  await expect.poll(() => desk.evaluate(() => (window as any).__player.playing), { timeout: 5000 }).toBe(false);
  await phone.context().close(); await desk.context().close();
});

test('iOS: the lock-screen clock is told again once a waited-for song is heard', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'its own phone');
  // iOS starts the lock screen's clock when the element is asked to play and
  // MediaRemote keeps that anchor unless told a position over about a second
  // off: a song that waited for its first data showed the wait as a lead for
  // its whole length. Once heard, the position is told again with an
  // invisible metadata change (a zero-width mark on the album) that
  // MediaRemote always takes.
  const phone = await device(browser, true);
  await phone.context().route('**/api/stream/**', async (route) => { await new Promise((r) => setTimeout(r, 600)); await route.continue(); });
  const ids = await albumIds(phone, 'First Light');
  await play(phone, ids);
  await expect.poll(() => phone.evaluate(() => ((window as any).__slopifyMediaLog || []).some((l: string) => /lock screen clock re-anchored/.test(l))), { timeout: 15000 }).toBe(true);
  const told = await phone.evaluate(() => { const w = window as any; const el = w.__els.find((e: any) => e !== w.__conduitKeepAlive && e !== w.__conduitFace && !e.paused); const last = w.__ps[w.__ps.length - 1]; return { album: navigator.mediaSession.metadata?.album || '', pos: last.position + (Date.now() - last.at) / 1000, el: el?.currentTime }; });
  expect(told.album.endsWith('​')).toBe(true);
  expect(Math.abs(told.pos - told.el)).toBeLessThan(0.5);
  await phone.evaluate(() => (window as any).__player.toggle());
  await phone.context().close();
});

test('an emptied song element is muted, and unmuted with its next song', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  // An emptied element still counts for WebKit's Now Playing while it is
  // unmuted: after a hand-off the phone's emptied element (last touched by a
  // lock-screen tap) stayed Now Playing with isPlaying = false while the
  // laptop played (tools/ios-sim, 10-26). Muted, it is never a candidate.
  const songEls = (page: Page) => page.evaluate(() => { const w = window as any; return w.__els.filter((e: any) => e !== w.__conduitKeepAlive && e !== w.__conduitFace).map((e: any) => ({ src: !!e.getAttribute('src'), muted: e.muted, paused: e.paused })); });
  const phone = await device(browser, true);
  const desk = await device(browser, false);
  const ids = await albumIds(phone, 'First Light');
  await play(phone, ids);
  await expect.poll(() => phone.evaluate(() => (window as any).__player.playing), { timeout: 10000 }).toBe(true);
  // Playing here: the playing element is unmuted.
  expect((await songEls(phone)).some((e) => e.src && !e.paused && !e.muted)).toBe(true);
  // The laptop takes it: every emptied element on the phone is muted.
  await play(desk, ids.slice(2));
  await expect.poll(() => phone.evaluate(() => (window as any).__player.mirroring), { timeout: 15000 }).toBe(true);
  await expect.poll(async () => (await songEls(phone)).every((e) => !e.src && e.muted), { timeout: 5000 }).toBe(true);
  // Back to the phone: its new song plays unmuted.
  await phone.evaluate(() => (window as any).__player.setDevice({ id: 'local', kind: 'local', name: 'This Web Player' }));
  await expect.poll(async () => (await songEls(phone)).some((e) => e.src && !e.paused && !e.muted), { timeout: 15000 }).toBe(true);
  await phone.evaluate(() => (window as any).__player.toggle());
  await phone.context().close(); await desk.context().close();
});

test('a seek on the device playing moves the lock screen of a phone showing it', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  // A roster update that only moves the playhead does not re-render the
  // phone (applyRoster), and the lock screen kept counting from where it
  // was told last: after a seek elsewhere it showed the old time.
  const desk = await device(browser, false);
  const phone = await device(browser, true);
  const ids = await albumIds(desk, 'First Light');
  await play(desk, [ids[3]]); // 8 s
  await expect.poll(() => phone.evaluate(() => navigator.mediaSession.playbackState), { timeout: 15000 }).toBe('playing');
  await desk.evaluate(() => (window as any).__player.toggle());
  await expect.poll(() => phone.evaluate(() => navigator.mediaSession.playbackState), { timeout: 10000 }).toBe('paused');
  await phone.waitForTimeout(500);
  const t0 = Date.now();
  await desk.evaluate(() => (window as any).__player.seek(5));
  await expect.poll(() => phone.evaluate((t0) => (window as any).__ps.filter((s: any) => s.at > t0).map((s: any) => Math.round(s.position)), t0), { timeout: 5000 }).toContain(5);
  await phone.context().close(); await desk.context().close();
});

test('the next songs are warmed: playlist, init segment and first segments, all fetched', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'one run is enough');
  // jf.prewarm() puts the next songs' first segments in the browser cache.
  // The server writes each segment line with the token (s0000.ts?token=...),
  // which the old line match never matched, and the lossless init segment
  // went out as init.mp4&token=... (401 on every warm in the 10-26 log).
  const got: { url: string; status: number }[] = [];
  page.on('response', (r) => { if (/\/hls\/(aac-96|alac)\//.test(r.url())) got.push({ url: r.url().replace(/^https?:\/\/[^/]+/, ''), status: r.status() }); });
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__jf), { timeout: 15000 }).toBe('object');
  const ids = await albumIds(page, 'Second Wind');
  // Chromium plays no HLS itself: warm as a phone would.
  await page.evaluate((ids) => {
    const jf = (window as any).__jf;
    jf.streamMode = () => 'hls';
    jf.quality = 'high'; jf.prewarm(ids[5]);
    jf.quality = 'original'; jf.prewarm(ids[0]);
    jf.quality = 'high';
  }, ids);
  const seg = (id: string, rung: string, name: RegExp) => got.filter((g) => g.url.includes(`/${id}/hls/${rung}/`) && name.test(g.url.split('/').pop()!));
  // Both 8 s songs: two segments each.
  await expect.poll(() => seg(ids[5], 'aac-96', /^s\d{4}\.ts/).length, { timeout: 30000 }).toBe(2);
  await expect.poll(() => seg(ids[0], 'alac', /^init\.mp4/).length + seg(ids[0], 'alac', /^s\d{4}\.m4s/).length, { timeout: 30000 }).toBe(3);
  expect(got.filter((g) => g.status !== 200)).toEqual([]);
});
