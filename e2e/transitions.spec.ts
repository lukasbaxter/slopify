import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Between songs: gapless, crossfade, volume normalization and the sleep
// timer's "end of track", on the desktop player (Web Audio). The fixture
// songs are 4-8 s sine tones, so a whole transition fits in a test.
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'desktop player');

// Every audio element the player makes, and what each one did when.
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__ev = []; w.__els = [];
    const Orig = window.Audio;
    const Wrapped: any = function (...a: any[]) {
      const el = new (Orig as any)(...a);
      w.__els.push(el);
      // On 'playing': how much of any other element's song was still to play
      // at that moment (an overlap, measured on the media clock itself).
      for (const t of ['playing', 'ended', 'pause']) el.addEventListener(t, () => w.__ev.push({ t, at: performance.now(), track: el.dataset.track || null, othersLeft: w.__els.filter((o: any) => o !== el && !o.paused && !o.ended && o.getAttribute('src')).map((o: any) => o.duration - o.currentTime) }));
      return el;
    };
    Wrapped.prototype = Orig.prototype;
    w.Audio = Wrapped;
  });
}
// The test hooks (window.__player & co) only exist with ?debug.
async function open(page: Page) {
  await instrument(page);
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__updatePrefs), { timeout: 15000 }).toBe('function');
}
const token = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '');
async function api(page: Page, path: string, method = 'GET', data?: unknown) {
  const r = await page.request.fetch(path, { method, data, headers: { Authorization: `Bearer ${await token(page)}` } });
  return r.json();
}
async function albumIds(page: Page, name: string) {
  const a = (await api(page, '/api/albums?limit=100')).items.find((x: any) => x.name === name);
  return { albumId: a.id, ids: (await api(page, `/api/albums/${a.id}`)).tracks.map((t: any) => t.id) as string[] };
}
// Play these ids (rows fetched fresh, so they carry their gains) in a context.
async function play(page: Page, ids: string[], ctx: string | null) {
  // Earlier tests share the account and may leave a page playing: take the
  // session here ("play here"), or the play would be routed to that page.
  await expect.poll(() => page.evaluate(() => { const p = (window as any).__player; if (p.mirroring) p.relay?.claim(); return p.mirroring; }), { timeout: 15000 }).toBe(false);
  await page.evaluate(async ({ ids, ctx }) => {
    const w = window as any;
    w.__ev.length = 0;
    const rows = await w.__jf.itemsByIds(ids);
    await w.__player.playQueue(rows, 0, ctx);
  }, { ids, ctx });
}
const events = (page: Page) => page.evaluate(() => (window as any).__ev as { t: string; at: number; track: string | null; othersLeft: number[] }[]);
const firstAt = (ev: any[], t: string, track: string) => ev.find((e) => e.t === t && e.track === track)?.at;

test('an album plays gapless: the next track starts as the last one ends', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).__updatePrefs({ crossfade: 0, gapless: true }));
  const { albumId, ids } = await albumIds(page, 'Second Wind');
  await play(page, ids.slice(0, 3), albumId);
  // Two transitions (A->B, B->C).
  await expect.poll(async () => firstAt(await events(page), 'playing', ids[2]), { timeout: 30000 }).toBeTruthy();
  const ev = await events(page);
  for (const [a, b] of [[ids[0], ids[1]], [ids[1], ids[2]]]) {
    // The next song starts within a few ms of the end of the last: either the
    // last still had a sliver left to play (an overlap, from its own clock),
    // or it had ended and the gap is the time between the two events.
    const started = ev.find((e) => e.t === 'playing' && e.track === b)!;
    const overlap = started.othersLeft.length ? Math.max(...started.othersLeft) * 1000 : 0;
    const gap = started.othersLeft.length ? 0 : started.at - firstAt(ev, 'ended', a)!;
    console.log(`${a.slice(0, 6)} -> ${b.slice(0, 6)}: overlap ${overlap.toFixed(1)} ms, gap ${gap.toFixed(1)} ms`);
    expect(overlap).toBeLessThan(30);
    expect(gap).toBeLessThan(30);
  }
  const log = await page.evaluate(() => ((window as any).__slopifyMediaLog || []).join('\n'));
  expect(log).toMatch(/gapless \(lead/);
  await page.evaluate(() => (window as any).__player.toggle());
});

test('a transcoded stream (Very high, 320 kbps) is gapless too', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).__updatePrefs({ crossfade: 0, gapless: true, quality: 'high' }));
  console.log('stream mode', await page.evaluate(() => (window as any).__jf.streamMode()));
  const { albumId, ids } = await albumIds(page, 'First Light');
  await play(page, ids.slice(0, 2), albumId);
  await expect.poll(async () => firstAt(await events(page), 'playing', ids[1]), { timeout: 30000 }).toBeTruthy();
  const ev = await events(page);
  const started = ev.find((e) => e.t === 'playing' && e.track === ids[1])!;
  const overlap = started.othersLeft.length ? Math.max(...started.othersLeft) * 1000 : 0;
  const ended = firstAt(ev, 'ended', ids[0]);
  const gap = started.othersLeft.length || !ended ? 0 : started.at - ended;
  console.log(`transcoded: overlap ${overlap.toFixed(1)} ms, gap ${gap.toFixed(1)} ms`);
  expect(overlap).toBeLessThan(30);
  expect(gap).toBeLessThan(30);
  await page.evaluate(() => (window as any).__player.toggle());
  await page.evaluate(() => (window as any).__updatePrefs({ quality: 'original' }));
});

test('crossfade: songs from different albums overlap, one fading out as the next fades in', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).__updatePrefs({ crossfade: 2, gapless: true }));
  const a = await albumIds(page, 'First Light');
  const b = await albumIds(page, 'Analytical');
  const ids = [a.ids[4], b.ids[4]]; // 8 s songs: a 2 s fade fits
  await play(page, ids, null);
  // Mid-fade: both elements sounding, the outgoing one turned partly down.
  const seen = { both: false, gains: [] as number[] };
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !seen.both) {
    const s = await page.evaluate(() => {
      const w = window as any;
      const wa = w.__player.webAudio();
      const live = w.__els.filter((e: any) => !e.paused && e.getAttribute('src'));
      return { n: live.length, gains: live.map((e: any) => wa.gains.get(e)?.fade.gain.value) };
    });
    if (s.n === 2) { seen.both = true; seen.gains = s.gains; }
    await page.waitForTimeout(100);
  }
  expect(seen.both).toBe(true);
  expect(seen.gains.some((g) => g > 0.02 && g < 0.98)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__player.current?.Id), { timeout: 10000 }).toBe(ids[1]);
  // After the fade only the new song is left playing.
  await page.waitForTimeout(2600);
  expect(await page.evaluate(() => (window as any).__els.filter((e: any) => !e.paused && e.getAttribute('src')).length)).toBe(1);
  const log = await page.evaluate(() => ((window as any).__slopifyMediaLog || []).join('\n'));
  expect(log).toMatch(/crossfade \d\.\d s into/);
  await page.evaluate(() => (window as any).__player.toggle());
  await page.evaluate(() => (window as any).__updatePrefs({ crossfade: 0 }));
});

test('volume normalization: a measured song plays at its gain; turned off, at unity', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).__updatePrefs({ normalize: true }));
  const { ids } = await albumIds(page, 'Sampler');
  // Measure the library (the task the server runs hourly).
  await api(page, '/api/admin/tasks/loudness/run', 'POST');
  await expect.poll(async () => (await api(page, `/api/albums/${(await albumIds(page, 'Sampler')).albumId}`)).tracks.every((t: any) => t.gain?.track != null), { timeout: 60000 }).toBe(true);
  const gain = (await api(page, `/api/albums/${(await albumIds(page, 'Sampler')).albumId}`)).tracks[0].gain.track;
  expect(gain).toBeGreaterThan(3); // quiet tones: turned up
  await play(page, [ids[0]], null);
  await expect.poll(() => page.evaluate(() => (window as any).__player.playing), { timeout: 10000 }).toBe(true);
  const applied = await page.evaluate(() => { const w = window as any; const el = w.__els.find((e: any) => !e.paused); return w.__player.webAudio().gains.get(el).norm.gain.value; });
  expect(applied).toBeCloseTo(10 ** (gain / 20), 2);
  await page.evaluate(() => (window as any).__updatePrefs({ normalize: false }));
  await play(page, [ids[1]], null);
  await expect.poll(() => page.evaluate(() => { const w = window as any; const el = w.__els.find((e: any) => !e.paused && e.dataset.track); return el ? w.__player.webAudio().gains.get(el).norm.gain.value : -1; }), { timeout: 10000 }).toBe(1);
  await page.evaluate(() => (window as any).__player.toggle());
  await page.evaluate(() => (window as any).__updatePrefs({ normalize: true }));
});

test('iPhone: no Web Audio there, so the server bakes the gain into the stream', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SlopifyMobile/0.1' });
  const page = await ctx.newPage();
  const urls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/stream/')) urls.push(r.url().replace(/^https?:\/\/[^/]+/, '')); });
  await open(page);
  await page.evaluate(() => (window as any).__updatePrefs({ normalize: true }));
  const { albumId, ids } = await albumIds(page, 'Sampler');
  await api(page, '/api/admin/tasks/loudness/run', 'POST');
  await expect.poll(async () => (await api(page, `/api/albums/${albumId}`)).tracks[3].gain?.track, { timeout: 60000 }).not.toBeNull();
  const g = (await api(page, `/api/albums/${albumId}`)).tracks[3].gain.track;
  expect(await page.evaluate(() => (window as any).__player.webAudio())).toBeNull();
  await play(page, [ids[3]], null);
  const variant = `aac-320g${g.toFixed(1).replace(/\.0$/, '')}`;
  await expect.poll(() => urls.some((u) => u.includes(`/api/stream/${ids[3]}/hls/master.m3u8`) && u.includes('norm=track')), { timeout: 15000 }).toBe(true);
  await expect.poll(() => urls.some((u) => u.includes(`/api/stream/${ids[3]}/hls/${variant}/`) || (u.includes(`/api/stream/${ids[3]}/whole/aac-320`) && u.includes('norm=track'))), { timeout: 15000 }).toBe(true);
  // Turned off: the plain stream.
  await page.evaluate(() => (window as any).__updatePrefs({ normalize: false }));
  urls.length = 0;
  await play(page, [ids[4]], null);
  await expect.poll(() => urls.some((u) => u.includes(`/api/stream/${ids[4]}/hls/master.m3u8`)), { timeout: 15000 }).toBe(true);
  expect(urls.filter((u) => u.includes('norm='))).toEqual([]);
  await page.evaluate(() => (window as any).__updatePrefs({ normalize: true }));
  await ctx.close();
});

test('sleep timer, end of track: the song finishes, the next one waits paused at 0', async ({ page }) => {
  await open(page);
  const { ids } = await albumIds(page, 'Analytical');
  await play(page, [ids[0], ids[1]], null);
  await page.evaluate(() => (window as any).__player.setSleepTimer({ endOfTrack: true }));
  await expect.poll(async () => firstAt(await events(page), 'ended', ids[0]), { timeout: 20000 }).toBeTruthy();
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => { const p = (window as any).__player; return { playing: p.playing, id: p.current?.Id, pos: p.position, sleep: p.sleep }; });
  expect(st.playing).toBe(false);
  expect(st.id).toBe(ids[1]);
  expect(st.pos).toBe(0);
  expect(st.sleep).toBeNull();
  expect(firstAt(await events(page), 'playing', ids[1])).toBeUndefined();
});
