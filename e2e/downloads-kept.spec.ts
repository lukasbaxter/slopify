import { test, expect } from '@playwright/test';
import { login } from './helpers';

// The Downloads page opens at once from the answer it kept the last time,
// and a slow server (waiting on a busy Lidarr: 20.9 s on the live server,
// 11-08) refreshes it behind; it used to show "Loading…" until the server
// answered. A poll that fails or hangs never empties it.
test.use({ serviceWorkers: 'block' }); // the mocked API has to reach the page itself

test('the Downloads page opens from the kept answer while the server is slow', async ({ page }) => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    id: 200 + i, album_id: `rg-${i}`, artist: 'Some Artist', title: `Kept Album ${i}`, rtype: 'Album', year: '2021', image: null,
    state: 'queued', total: 6, done: 0, reason: null, finished: null, requested: Date.now() - 7200e3, source: 'request', note: null, mine: true,
  }));
  let hang = false;
  await page.route('**/api/downloads*', (r) => { if (hang) return; r.fulfill({ json: { scope: 'mine', items, counts: { queued: 5 }, stuckAfterMs: 1800000, watcher: null, now: Date.now() } }); });
  await login(page);
  const open = async () => { await page.locator('button.avatar').click(); await page.getByRole('button', { name: 'Downloads' }).click(); };
  await open();
  await expect(page.locator('.dl-row')).toHaveCount(5);
  // Opened again later, the server now slow: the rows are there at once.
  hang = true;
  await page.reload();
  await expect(page.locator('button.avatar')).toBeVisible({ timeout: 20000 });
  await open();
  await expect(page.locator('.dl-row')).toHaveCount(5, { timeout: 2000 });
  // Polls that do not answer leave them.
  await page.waitForTimeout(12000);
  await expect(page.locator('.dl-row')).toHaveCount(5);
});
