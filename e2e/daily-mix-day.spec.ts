import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// A Daily Mix tile says who is in today's mix (server: /api/daily-mixes),
// not only "<artist> and more", and the mix page asks for the listener's day
// in its URL: the service worker keeps answers by URL, and a new day's first
// open (the mix takes the server longer than its 350 ms grace to make) used
// to show yesterday's kept mix.
test('Made For You: today\'s artists on the tile, the day in the mix URL', async ({ page }) => {
  await login(page);
  const asked: string[] = [];
  page.on('request', (r) => { if (/\/api\/(tracks\/[0-9a-f]{32}\/mix|daily-mixes)/.test(r.url())) asked.push(r.url()); });
  await page.goto('/'); await waitForLibrary(page);
  const tile = page.locator('.mixcard').first();
  await expect(tile).toBeVisible({ timeout: 20000 });
  // Several artists by name: "A, B, C and more".
  await expect(tile.locator('.card-sub')).toContainText(', ', { timeout: 20000 });
  const today = await page.evaluate(() => { const n = Date.now(); return new Date(n - new Date(n).getTimezoneOffset() * 60000).toISOString().slice(0, 10); });
  const sub = (await tile.locator('.card-sub').textContent())!.trim();
  await tile.locator('.card-art').click();
  await expect.poll(() => asked.some((u) => u.includes('/mix?') && u.includes(`day=${today}`)), { timeout: 15000 }).toBe(true);
  // The page says the same as the tile.
  await expect(page.locator('.hero-meta').first()).toContainText(sub);
});
