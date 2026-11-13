import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Go to radio opens the listener's radio playlist as a page ("<artist>
// Radio"); going again within the day is the same radio, not a new one
// (server: radio.ts). It does not start by itself (owner, 11-13): the page's
// play button starts it.
test('Go to radio on an artist opens their radio page without playing it', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop menus');
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__player), { timeout: 15000 }).toBe('object');
  const h = { Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '')}` };
  const artists = (await (await page.request.get('/api/artists?limit=100', { headers: h })).json()).items;
  const band = artists.find((a: any) => a.name === 'The Fixture Band');
  await page.goto(`/?debug=1&artist=${band.id}`); await waitForLibrary(page);
  await expect(page.locator('h1', { hasText: 'The Fixture Band' }).first()).toBeVisible({ timeout: 10000 });
  const made: string[] = [];
  page.on('response', (r) => { if (r.request().method() === 'POST' && r.url().includes(`/api/radio/${band.id}`)) made.push(r.url()); });
  await page.locator('.iconbtn.more').first().click();
  await page.locator('.ctxmenu button', { hasText: 'Go to radio' }).click();
  await expect(page.locator('h1', { hasText: 'The Fixture Band Radio' }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__player.contextId)).not.toBe(`radio:${band.id}`);
  await expect(page.locator('.player button[title="Pause"]')).toHaveCount(0);
  expect(made).toHaveLength(1);
  // The page's play button starts it.
  await page.locator('.actions .playbtn, .actions button[title="Play"]').first().click();
  await expect(page.locator('.player button[title="Pause"]').first()).toBeVisible({ timeout: 20000 });
  expect(await page.evaluate(() => (window as any).__player.contextId)).toBe(`radio:${band.id}`);
  // Its menu refreshes it instead of offering the radio again.
  await page.locator('.iconbtn.more').first().click();
  await expect(page.locator('.ctxmenu button', { hasText: 'Refresh' })).toBeVisible();
  await expect(page.locator('.ctxmenu button', { hasText: 'Go to radio' })).toHaveCount(0);
});
