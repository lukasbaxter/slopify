import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Owner, 11-13: a right-click (two-finger click) on the player bar's cover did
// nothing; it opens the playing song's menu, the same as on its row.
test('right-click on the player bar cover opens the song menu', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop player bar');
  await login(page); await waitForLibrary(page);
  await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await page.locator('.trackrow').first().dblclick();
  await expect(page.locator('.player button[title="Pause"]').first()).toBeVisible({ timeout: 20000 });
  await page.locator('.player .player-art').first().click({ button: 'right' });
  const menu = page.locator('.ctxmenu').first();
  await expect(menu).toBeVisible();
  for (const item of ['Add to queue', 'Add to playlist', 'Go to song radio', 'Go to album']) await expect(menu).toContainText(item);
  // The title opens it too.
  await page.keyboard.press('Escape');
  await page.locator('.player .player-title').first().click({ button: 'right' });
  await expect(page.locator('.ctxmenu').first()).toContainText('Go to song radio');
});
