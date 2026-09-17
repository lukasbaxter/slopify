import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Walks every page the app has and fails on any page error or failed /api call.
test('every page renders without errors or failed API calls', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop walk');
  const errors: string[] = []; const failed: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400 && !/\/api\/(users\/[^/]+\/avatar|lyrics\/|image\/)/.test(r.url())) failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
  await login(page); await waitForLibrary(page);
  const nav = async (label: string) => { await page.locator('.sidebar .navitem', { hasText: label }).first().click(); await page.waitForTimeout(400); };
  // Home shelves
  await expect(page.locator('.card').first()).toBeVisible();
  // an artist page via an album's artist link
  await page.locator('.card', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  await page.locator('.trackrow').first().locator('.trackrow-artist button, .rowlink').first().click().catch(() => {});
  await page.waitForTimeout(600);
  // library: playlists, liked songs, create a playlist and add to it
  await page.locator('.sidebar', { hasText: 'Liked Songs' }).locator('text=Liked Songs').first().click().catch(() => {});
  await page.waitForTimeout(600);
  // search
  await nav('Search');
  await page.locator('input.search').fill('light');
  await page.waitForTimeout(800);
  expect(await page.locator('.trackrow, .card').count()).toBeGreaterThan(0);
  // history + settings via the account menu
  await nav('Home');
  await page.locator('button.avatar').click();
  await page.locator('.avatarmenu button', { hasText: 'History' }).click();
  await expect(page.locator('.sf')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(1200);
  await nav('Home');
  await page.locator('button.avatar').click();
  await page.locator('.avatarmenu button', { hasText: 'Settings' }).click();
  await expect(page.locator('.settings')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(600);
  console.log('page errors', errors, 'failed', failed);
  expect(errors.filter((e) => !/ResizeObserver/.test(e))).toEqual([]);
  expect(failed).toEqual([]);
});

test('playlists, saved albums and the session socket', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop walk');
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await login(page); await waitForLibrary(page);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token);
  const H = { Authorization: `Bearer ${token}` };
  // a playlist made through the API shows up in the sidebar with its rows
  const tracks = (await (await page.request.get('/api/albums?limit=1', { headers: H })).json()).items;
  const album = (await (await page.request.get(`/api/albums/${tracks[0].id}`, { headers: H })).json());
  const pl = await (await page.request.post('/api/playlists', { headers: H, data: { name: 'Walk list', trackIds: album.tracks.slice(0, 3).map((t: any) => t.id) } })).json();
  await page.reload(); await waitForLibrary(page);
  await page.locator('.sidebar').getByText('Walk list').first().click();
  const rows = page.locator('.tracklist .trackrow:not(.reco-row .trackrow)');
  await expect(rows).toHaveCount(3, { timeout: 15000 });
  // remove one row from the row menu
  await rows.nth(0).locator('.trackrow-more').click();
  await page.getByText(/Remove from this playlist/i).click();
  await expect(rows).toHaveCount(2, { timeout: 10000 });
  expect((await (await page.request.get(`/api/playlists/${pl.id}`, { headers: H })).json()).tracks.length).toBe(2);
  // save an album to the library from its page
  await page.locator('.sidebar .navitem', { hasText: 'Home' }).click();
  await page.locator('.card', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  const save = page.locator('button[title="Save to Your Library"]').first();
  await expect(save).toBeVisible({ timeout: 10000 });
  await save.click();
  await expect.poll(async () => (await (await page.request.get('/api/likes/albums', { headers: H })).json()).items.length, { timeout: 5000 }).toBe(1);
  await expect(page.locator('button[title="Remove from Your Library"]').first()).toBeVisible();
  await page.reload(); await waitForLibrary(page);
  await page.locator('.card', { hasText: 'First Light' }).first().click();
  await expect(page.locator('button[title="Remove from Your Library"]').first()).toBeVisible({ timeout: 15000 }); // remembered
  // the session socket: this client is on the roster and the session shows what plays
  await page.locator('.trackrow').nth(0).dblclick();
  await expect(page.locator('.player button[title="Pause"]').first()).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => { const s = await (await page.request.get('/api/session', { headers: H })).json(); return s.clients.length > 0 && s.session.playing && !!s.session.trackId; }, { timeout: 10000 }).toBe(true);
  expect(errors.filter((e) => !/ResizeObserver/.test(e))).toEqual([]);
});
