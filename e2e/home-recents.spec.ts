import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Home's shortcuts are what you picked and played from (owner, 11-14): a
// song played from an album's page puts that album first, with the page
// telling the server where the play came from.
test('a song played from an album page makes that album the latest pick', async ({ page, isMobile }) => {
  await login(page); await waitForLibrary(page);
  const h = { Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '')}` };
  await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  const row = page.locator('.trackrow').nth(0);
  if (isMobile) await row.click(); else await row.dblclick();
  await expect(page.locator('.player button[title="Pause"], .player button[aria-label="Pause"]').first()).toBeVisible({ timeout: 20000 });
  // A play counts after 8 s.
  await expect.poll(async () => {
    const r = (await (await page.request.get('/api/home', { headers: h })).json()).recents as any[];
    return r[0] ? `${r[0].kind}:${r[0].name}` : '';
  }, { timeout: 30000 }).toBe('album:First Light');
});
