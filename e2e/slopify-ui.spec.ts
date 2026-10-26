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
  // A phone row plays on one tap (and a second tap on the playing row pauses
  // it, now that "playing" shows from the tap); the desktop row needs two.
  if (isMobile) await row.click(); else await row.dblclick();
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
  // play it, open now playing, lyrics tab shows lines. Mouse: double-click
  // plays. Phone: a tap on a search result opens its album; a tap there plays.
  if (isMobile) {
    await page.locator('.trackrow').first().click();
    await page.locator('.trackrow', { hasText: /harbour/i }).first().click();
  } else await page.locator('.trackrow').first().dblclick();
  await expect(page.locator('.player button[title="Pause"], .player button[aria-label="Pause"]').first()).toBeVisible({ timeout: 20000 });
  if (isMobile) { await expect(page.locator('.tabbar')).toBeVisible(); await page.locator('.player-row').click(); }
  else await page.locator('.player button[title*="Now playing" i], .player button[aria-label*="Now playing" i], .player .expand').first().click().catch(() => {});
  await expect(page.locator('.fs')).toBeVisible({ timeout: 10000 });
  // desktop: the tab strip at the top; phone: the lyrics glyph in the bottom row
  await page.locator('.fs button[aria-label="Lyrics"]').locator('visible=true').first().click();
  await expect(page.locator('.fs-lyrics .lyric-line').first()).toBeVisible({ timeout: 15000 });
});

// An ask for lyrics that fails (on the TV, 2026-10-26: the answer held up
// past the 8 s timeout) is asked again; it used to stay "we don't have the
// lyrics" until the song changed (a skip away and back).
test.describe('lyrics', () => {
  test.use({ serviceWorkers: 'block' }); // so the route below sees the ask
  test('a lyrics ask that times out is asked again', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the same component on both');
    const asks: string[] = [];
    await page.route((u) => /\/api\/lyrics\/[0-9a-f]{32}$/.test(u.pathname), async (route) => {
      asks.push(route.request().url().split('/').pop()!);
      if (asks.length === 1) { await new Promise((r) => setTimeout(r, 9000)); return route.abort('timedout').catch(() => {}); }
      return route.continue();
    });
    await login(page); await waitForLibrary(page);
    // River Harbour on First Light: a song with lyrics (an .lrc beside it).
    await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
    await expect(page.locator('.trackrow').first()).toContainText('River Harbour', { timeout: 15000 });
    await page.locator('.trackrow').first().dblclick();
    // Paused at once: the fixture songs are 8 s, the next song would bring its own lyrics.
    const pause = page.locator('.player button[title="Pause"], .player button[aria-label="Pause"]').first();
    await expect(pause).toBeVisible({ timeout: 20000 });
    await pause.click();
    await page.locator('.player button[title*="Now playing" i], .player button[aria-label*="Now playing" i], .player .expand').first().click().catch(() => {});
    await expect(page.locator('.fs')).toBeVisible({ timeout: 10000 });
    await page.locator('.fs button[aria-label="Lyrics"]').locator('visible=true').first().click();
    await expect(page.locator('.fs-lyrics .lyric-line').first()).toBeVisible({ timeout: 25000 });
    expect(asks.length).toBeGreaterThan(1);
    expect(new Set(asks).size).toBe(1); // the same song, asked again
  });
});
