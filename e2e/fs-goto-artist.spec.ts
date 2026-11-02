import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// The artist name in the now-playing view goes straight to that artist's
// page, and Back from there lands on the page the player was opened from
// (not the player again).
test('now playing: the artist name opens the artist page', async ({ page }, info) => {
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__player), { timeout: 15000 }).toBe('object');
  const h = { Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '')}` };
  const albums = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items;
  const album = albums.find((a: any) => a.name === 'First Light');
  const ids = (await (await page.request.get(`/api/albums/${album.id}`, { headers: h })).json()).tracks.map((t: any) => t.id);
  await page.evaluate(async (ids) => { const w = window as any; await w.__player.playQueue(await w.__jf.itemsByIds(ids), 0, null); }, ids);
  await expect(page.locator('.player button[title="Pause"]').first()).toBeVisible({ timeout: 20000 });
  const phone = info.project.name === 'phone';
  if (phone) await page.locator('.player-row').first().click({ position: { x: 24, y: 24 } });
  else await page.locator('.player button[title="Now playing view"]').first().click();
  await expect(page.locator('.fs')).toBeVisible({ timeout: 10000 });
  const link = page.locator('.fs-artist .linkish').first();
  const name = (await link.textContent())!.trim();
  expect(name.length).toBeGreaterThan(0);
  await link.click();
  await expect(page.locator('.fs')).toHaveCount(0, { timeout: 5000 });
  // Still on the artist page a second later (nothing undoes the step).
  await page.waitForTimeout(1000);
  await expect(page.locator('h1', { hasText: name }).first()).toBeVisible();
  expect(await page.evaluate(() => history.state?.np)).toBeFalsy();
  // Back: the page underneath, no player.
  await page.goBack();
  await page.waitForTimeout(800);
  await expect(page.locator('.fs')).toHaveCount(0);
  await expect(page.locator('h1', { hasText: name })).toHaveCount(0);
});
