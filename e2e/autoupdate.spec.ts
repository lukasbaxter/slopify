import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// A deploy reaches open apps without anyone reloading: the server names the
// web build it hands out as each app connects, and a page on an older build
// reloads onto it once that interrupts nobody (nothing playing here, out of
// sight or untouched for 2 minutes), and never twice for the same build.
test('a page on an old build reloads onto the new one, but not while it plays', async ({ page }) => {
  await page.addInitScript(() => { const w = window as any; w.__builds = []; window.addEventListener('slopify:webbuild', (e: any) => w.__builds.push(e.detail)); });
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__player), { timeout: 15000 }).toBe('object');

  // The server told this page the build it is running: nothing to do.
  const running = await page.evaluate(() => { const s = document.querySelector('script[type="module"][src*="assets/index-"]')!.getAttribute('src')!; return s.slice(s.lastIndexOf('assets/')); });
  await expect.poll(() => page.evaluate(() => (window as any).__builds[0] || null), { timeout: 10000 }).toBe(running);

  // Playing here: a newer build waits, even out of sight.
  const h = { Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '')}` };
  const albums = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items;
  const ids = (await (await page.request.get(`/api/albums/${albums[0].id}`, { headers: h })).json()).tracks.map((t: any) => t.id);
  await page.evaluate(async (ids) => { const w = window as any; await w.__player.playQueue(await w.__jf.itemsByIds(ids), 0, null); }, ids);
  await expect(page.locator('.player button[title="Pause"]').first()).toBeVisible({ timeout: 20000 });
  const hide = () => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }); (window as any).__marker = 1; document.dispatchEvent(new Event('visibilitychange')); });
  await hide();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slopify:webbuild', { detail: 'assets/index-NEWBUILD.js' })));
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__marker)).toBe(1);

  // Paused and out of sight: it goes.
  await page.locator('.player button[title="Pause"]').first().click();
  await expect(page.locator('.player button[title="Play"]').first()).toBeVisible();
  await Promise.all([page.waitForEvent('load'), hide()]);
  expect(await page.evaluate(() => (window as any).__marker)).toBeUndefined();

  // The reload still landed on the same build (here the "new" one never
  // existed): it is not tried again.
  await waitForLibrary(page);
  await hide();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slopify:webbuild', { detail: 'assets/index-NEWBUILD.js' })));
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__marker)).toBe(1);
});
