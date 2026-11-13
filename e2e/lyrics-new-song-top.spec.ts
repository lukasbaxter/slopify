import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

test.use({ serviceWorkers: 'block' }); // so the route below sees the lyrics asks

// Owner, 2026-11-11 (desktop app on the Mac): a new song's lyrics did not start at the top of
// the lyrics panel; it stayed scrolled where the last song's lyrics were.
test('desktop lyrics panel: a new song starts at the top', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the desktop side panel');
  // Long lyrics for every song, the first line a few seconds in, so the panel can scroll.
  await page.route((u) => /\/api\/lyrics\/[0-9a-f]{32}$/.test(u.pathname), (route) => {
    const id = route.request().url().split('/').pop()!.slice(0, 6);
    const lines = Array.from({ length: 60 }, (_, i) => ({ start: 3000 + i * 4000, text: `${id} line ${i + 1}` }));
    return route.fulfill({ json: { kind: 'synced', lines } });
  });
  await login(page); await waitForLibrary(page);
  await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toContainText('River Harbour', { timeout: 15000 });
  await page.locator('.trackrow').first().dblclick();
  const pause = page.locator('.player button[title="Pause"], .player button[aria-label="Pause"]').first();
  await expect(pause).toBeVisible({ timeout: 20000 });
  await pause.click();
  await page.locator('.player-right button[title="Lyrics"]').click();
  const body = page.locator('.rightpanel .panel-body');
  await expect(body.locator('.lyric-line').first()).toBeVisible({ timeout: 15000 });
  const first = await body.locator('.lyric-line').first().textContent();
  // Read ahead: scroll the old song's lyrics well down.
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  await page.locator('.player button[title="Next"], .player button[aria-label="Next"]').first().click();
  await expect(body.locator('.lyric-line').first()).not.toHaveText(first!, { timeout: 15000 });
  await expect.poll(() => body.evaluate((el) => el.scrollTop), { timeout: 3000 }).toBeLessThan(5);
});

// Owner, 2026-11-13: "lyrics scroll to top on song change no matter what". A song whose lines
// were already lit when its lyrics came in went straight to the lit line (well down the list).
test('desktop lyrics panel: a new song starts at the top even with lines already lit', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the desktop side panel');
  // 40 lines all sung in the first 0.4 s, the next one a minute in; the answer comes late, so
  // the song is past them when the lyrics arrive.
  await page.route((u) => /\/api\/lyrics\/[0-9a-f]{32}$/.test(u.pathname), async (route) => {
    const id = route.request().url().split('/').pop()!.slice(0, 6);
    const lines = [...Array.from({ length: 40 }, (_, i) => ({ start: i * 10, text: `${id} early ${i + 1}` })),
      ...Array.from({ length: 20 }, (_, i) => ({ start: 60000 + i * 4000, text: `${id} late ${i + 1}` }))];
    await new Promise((r) => setTimeout(r, 1500));
    return route.fulfill({ json: { kind: 'synced', lines } });
  });
  await login(page); await waitForLibrary(page);
  await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toContainText('River Harbour', { timeout: 15000 });
  await page.locator('.trackrow').first().dblclick();
  await expect(page.locator('.player button[title="Pause"], .player button[aria-label="Pause"]').first()).toBeVisible({ timeout: 20000 });
  await page.locator('.player-right button[title="Lyrics"]').click();
  const body = page.locator('.rightpanel .panel-body');
  await expect(body.locator('.lyric-line').first()).toBeVisible({ timeout: 15000 });
  const first = await body.locator('.lyric-line').first().textContent();
  await page.locator('.player button[title="Next"], .player button[aria-label="Next"]').first().click();
  await expect(body.locator('.lyric-line').first()).not.toHaveText(first!, { timeout: 15000 });
  await page.waitForTimeout(1500);
  expect(await body.evaluate((el) => el.scrollTop)).toBeLessThan(5);
});
