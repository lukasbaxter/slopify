import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Home (owner, 11-17): no Recently played shelf (the 8 shortcuts are that);
// Recommended Stations and Your top mixes come right after Made For You,
// their covers drawn by the server (art_ images, no band on top); Your Top
// Songs is the last shelf.
const auth = async (page: Page) => ({ Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '')}` });

test('Home: stations and top mixes after Made For You, drawn covers, no Recently played, Top Songs last', async ({ page, isMobile }) => {
  await login(page); await waitForLibrary(page);
  const h = await auth(page);
  // Plays across the fixture artists, so there is a listening history to make mixes from.
  const albums = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items as { id: string }[];
  const tracks: { id: string }[] = [];
  for (const a of albums) tracks.push(...((await (await page.request.get(`/api/albums/${a.id}`, { headers: h })).json()).tracks || []));
  let at = Date.now() - 3 * 86400000;
  for (const [i, tr] of tracks.entries()) for (let k = 0; k <= i % 3; k++) {
    at += 120000; // a minute or more apart, or it counts as the same play
    expect((await page.request.post('/api/plays', { headers: h, data: { trackId: tr.id, client: 'web', at } })).ok()).toBe(true);
  }
  await page.reload(); await waitForLibrary(page);
  if (isMobile) await page.locator('.tabbar').getByText('Home', { exact: true }).first().click();
  const heads = page.locator('.homeshelf h2');
  await expect(heads.filter({ hasText: 'Recommended Stations' })).toBeVisible({ timeout: 30000 });
  await expect(heads.filter({ hasText: 'Your top mixes' })).toBeVisible({ timeout: 30000 });
  const order = await heads.allTextContents();
  expect(order).not.toContain('Recently played');
  expect(order.indexOf('Recommended Stations')).toBe(order.indexOf('Made For You') + 1);
  expect(order.indexOf('Your top mixes')).toBe(order.indexOf('Recommended Stations') + 1);
  if (order.includes('Your Top Songs')) expect(order[order.length - 1]).toBe('Your Top Songs');
  // The station and mix tiles are the server's drawn pictures, with nothing laid on top.
  const station = page.locator('.homeshelf', { has: page.locator('h2', { hasText: 'Recommended Stations' }) }).locator('.mixcard').first();
  await expect(station.locator('img')).toHaveAttribute('src', /\/api\/image\/art_[0-9a-f]{40}/);
  await expect(station.locator('.mixband')).toHaveCount(0);
  const mix = page.locator('.homeshelf', { has: page.locator('h2', { hasText: 'Your top mixes' }) }).locator('.mixcard').first();
  await expect(mix.locator('img')).toHaveAttribute('src', /\/api\/image\/art_[0-9a-f]{40}/);
  // A top mix opens as a page with its songs.
  await mix.click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
});
