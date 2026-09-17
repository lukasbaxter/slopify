import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

test.describe.configure({ mode: 'serial' });

test('the Conduit UI logs in, shows the library, plays a song, likes it', async ({ page, isMobile }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await login(page); await waitForLibrary(page);
  // open the first album card and play the second row
  await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  const row = page.locator('.trackrow').nth(1);
  const title = (await row.locator('.trackrow-name, .trackrow-title').first().textContent())!.trim();
  await row.dblclick();
  await expect(page.locator('.player button[title="Pause"], .player button[aria-label="Pause"]').first()).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await page.locator('.player').textContent()) || '', { timeout: 15000 }).toMatch(/0:0[1-9]|0:[1-5]\d/);
  await expect(page.locator('.player')).toContainText(title.slice(0, 12));
  // like from the row, see it in the store
  if (isMobile) {
    // the phone row has no heart (Conduit hides it); like from the row menu
    // (a different row from the desktop project, which shares the server)
    await page.locator('.trackrow').nth(2).locator('.trackrow-more').click();
    await page.getByText('Add to Liked Songs').click();
  } else {
    await row.locator('.trackrow-like').click();
  }
  await expect.poll(async () => (await (await page.request.get('/api/likes', { headers: { Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '')}` } })).json()).at, { timeout: 5000 }).not.toEqual({});
  expect(errors.filter((e) => !/ResizeObserver/.test(e))).toEqual([]);
});

test('search, lyrics in now playing, phone tab bar', async ({ page, isMobile }) => {
  await login(page); await waitForLibrary(page);
  // Search: the sidebar/tab bar entry, then the search box
  await page.locator(isMobile ? '.tabbar button' : '.sidebar .navitem', { hasText: 'Search' }).first().click();
  const box = page.locator('input.search');
  await expect(box).toBeVisible({ timeout: 10000 });
  await box.fill('harbour');
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.trackrow').first()).toContainText(/harbour/i);
  // play it, open now playing, lyrics tab shows lines
  await page.locator('.trackrow').first().dblclick();
  await expect(page.locator('.player button[title="Pause"], .player button[aria-label="Pause"]').first()).toBeVisible({ timeout: 20000 });
  if (isMobile) { await expect(page.locator('.tabbar')).toBeVisible(); await page.locator('.player-row').click(); }
  else await page.locator('.player button[title*="Now playing" i], .player button[aria-label*="Now playing" i], .player .expand').first().click().catch(() => {});
  await expect(page.locator('.fs')).toBeVisible({ timeout: 10000 });
  // desktop: the tab strip at the top; phone: the lyrics glyph in the bottom row
  await page.locator('.fs button[aria-label="Lyrics"]').locator('visible=true').first().click();
  await expect(page.locator('.fs-lyrics .lyric-line').first()).toBeVisible({ timeout: 15000 });
});
