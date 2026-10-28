import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Now playing across a song change (the TV flickered): the cover and the
// blurred background keep the old song's art until the new one has loaded,
// so no frame is without a picture, and the background ends on one layer.
test('song change: the art never goes blank, the background crossfades', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'the TV/desktop now-playing view');
  // A cold cache, like the TV's: every picture takes a while.
  await page.route('**/api/image/**', async (route) => { await new Promise((r) => setTimeout(r, 600)); await route.continue(); });
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__player), { timeout: 15000 }).toBe('object');
  const h = { Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '')}` };
  const albums = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items;
  const first = async (name: string) => (await (await page.request.get(`/api/albums/${albums.find((a: any) => a.name === name).id}`, { headers: h })).json()).tracks[0].id;
  const ids = [await first('Analytical'), await first('First Light')];
  await page.evaluate(async (ids) => { const w = window as any; await w.__player.playQueue(await w.__jf.itemsByIds(ids), 0, null); }, ids);
  await expect(page.locator('.player button[title="Pause"]').first()).toBeVisible({ timeout: 20000 });
  await page.locator('.player button[title*="Now playing" i], .player button[aria-label*="Now playing" i], .player .expand').first().click();
  await expect(page.locator('.fs')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => page.evaluate(() => { const i = document.querySelector('.fs-art') as HTMLImageElement | null; return !!i?.complete && i.naturalWidth > 0 && i.src.includes('size=1280'); }), { timeout: 15000 }).toBe(true);
  const before = await page.evaluate(() => (document.querySelector('.fs-art') as HTMLImageElement).src);

  // Every frame from the skip on: is there a painted cover and a background?
  await page.evaluate(() => {
    const w = window as any; w.__frames = [];
    const tick = () => {
      const i = document.querySelector('.fs-art') as HTMLImageElement | null;
      const bgs = [...document.querySelectorAll('.fs-bg')] as HTMLElement[];
      w.__frames.push({ cover: !!i && i.complete && i.naturalWidth > 0, bg: bgs.some((b) => b.style.backgroundImage.includes('url')), layers: bgs.length });
      if (w.__frames.length < 240) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.__player.next();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__frames.length), { timeout: 15000 }).toBe(240);
  const frames = await page.evaluate(() => (window as any).__frames as { cover: boolean; bg: boolean; layers: number }[]);
  expect(frames.filter((f) => !f.cover || !f.bg)).toEqual([]);
  expect(Math.max(...frames.map((f) => f.layers))).toBe(2); // the fade happened
  await expect.poll(() => page.evaluate(() => (document.querySelector('.fs-art') as HTMLImageElement).src), { timeout: 10000 }).not.toBe(before);
  await expect.poll(() => page.locator('.fs-bg').count(), { timeout: 5000 }).toBe(1);
});

// The TV's Album tab: the cover fills the screen, sharp (no blur), a little
// dimmed, with no square cover in the middle.
test('TV: the album tab is the whole cover, sharp and dimmed', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'the TV layout');
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => { (window as any).slopifyShell = { deviceName: 'Test TV', deviceForm: 'tv', platform: 'androidtv', version: '1.0' }; });
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__player), { timeout: 15000 }).toBe('object');
  const h = { Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '')}` };
  const albums = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items;
  const id = (await (await page.request.get(`/api/albums/${albums.find((a: any) => a.name === 'First Light').id}`, { headers: h })).json()).tracks[0].id;
  await page.evaluate(async (ids) => { const w = window as any; await w.__player.playQueue(await w.__jf.itemsByIds(ids), 0, null); }, [id]);
  await page.locator('.player button[title="Now playing view"]').first().click();
  await page.locator('.fs-tabs button[aria-label="Album"]').click();
  await expect.poll(() => page.evaluate(() => { const b = [...document.querySelectorAll('.fs-bg')].pop() as HTMLElement | undefined; return b ? [b.classList.contains('full'), getComputedStyle(b).filter, b.style.backgroundImage.includes('size=1920')] : null; }), { timeout: 15000 }).toEqual([true, 'brightness(0.6)', true]);
  await expect(page.locator('.fs-art')).toHaveCount(0);
  const bg = await page.locator('.fs-bg').last().boundingBox();
  expect(bg).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
  if (process.env.SHOT) { await page.waitForTimeout(1200); await page.screenshot({ path: process.env.SHOT }); }
});
