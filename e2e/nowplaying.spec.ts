import { test, expect, type Browser, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// The phone's Now Playing (lock screen, Control Center, AirPods): what the
// page tells navigator.mediaSession and what its <audio> elements hold.
// WebKit decides the lock screen from the elements, not only from what the
// page declares, so the elements are checked as well as the calls.
test.describe.configure({ mode: 'serial' });

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

// Every audio element the page makes, and every setPositionState call.
async function device(browser: Browser, phone: boolean) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: IPHONE }
    : { viewport: { width: 1400, height: 900 } });
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
