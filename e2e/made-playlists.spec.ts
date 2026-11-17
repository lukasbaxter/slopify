import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Themed playlists made for the listener (owner, 11-17): searching a
// playlist's words ("rock", "christmas", "this is ...") puts the listener's
// own copy at the top of the results, and the search page has a Made For You
// row; each opens with songs. The fixture library is two genres half and half
// with no brain, so This Is (their most played artist) is the one it makes.
const auth = async (page: Page) => ({ Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '')}` });

test('searching "this is" finds the listener\'s This Is playlist, which opens with songs; the search page lists it', async ({ page, isMobile }) => {
  await login(page); await waitForLibrary(page);
  const h = await auth(page);
  const albums = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items as { id: string }[];
  let at = Date.now() - 2 * 86400000;
  for (const a of albums) for (const tr of ((await (await page.request.get(`/api/albums/${a.id}`, { headers: h })).json()).tracks || []) as { id: string }[]) {
    at += 120000;
    await page.request.post('/api/plays', { headers: h, data: { trackId: tr.id, client: 'web', at } });
  }
  // Built on first ask (no brain in tests: by tags and plays).
  let title = '';
  await expect.poll(async () => { const m = ((await (await page.request.get('/api/made', { headers: h })).json()).items as any[]).find((x) => x.kind === 'thisis'); title = m?.title || ''; return !!m; }, { timeout: 30000 }).toBe(true);
  if (isMobile) await page.locator('.tabbar').getByText('Search', { exact: true }).first().click();
  else await page.keyboard.press('/');
  await expect(page.locator('.made-row .card', { hasText: title }).first()).toBeVisible({ timeout: 15000 }); // the search page's row
  const box = page.locator('input.search').first();
  await box.click();
  await box.fill('this is');
  const card = page.locator('.made-row .card', { hasText: title }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
});
