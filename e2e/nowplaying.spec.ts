import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Warming the next songs, so a locked phone's next song starts at once.

const token = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '');
async function albumIds(page: Page, name: string) {
  const h = { Authorization: `Bearer ${await token(page)}` };
  const a = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items.find((x: any) => x.name === name);
  return (await (await page.request.get(`/api/albums/${a.id}`, { headers: h })).json()).tracks.map((t: any) => t.id) as string[];
}

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
