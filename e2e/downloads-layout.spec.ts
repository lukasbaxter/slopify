import { test, expect } from '@playwright/test';
import { login } from './helpers';

// Each Downloads row keeps its status inside the row. The offline-download
// counter once shared the class `.dl-status` (position: absolute), and every
// row's reason and Retry button piled up on top of each other (11-01).
// The mocked API has to reach the page itself: WebKit's service worker fetch
// is not seen by page.route.
test.use({ serviceWorkers: 'block' });

test('downloads rows lay out one under another', async ({ page }) => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    id: 100 + i, album_id: `rg-${i}`, artist: 'Some Artist', title: `Album ${i}`, rtype: 'Album', year: '2021', image: null,
    state: 'failed', total: 6, done: 0, reason: 'nothing matching found on Soulseek in 12 hours', finished: Date.now() - 3600e3, requested: Date.now() - 7200e3, source: 'spotify', note: 'from a Spotify playlist', mine: true,
  }));
  await page.route('**/api/downloads*', (r) => r.fulfill({ json: { scope: 'mine', items, counts: { failed: 5 }, stuckAfterMs: 1800000, watcher: null, now: Date.now() } }));
  await login(page);
  await page.locator('button.avatar').click();
  await page.getByRole('button', { name: 'Downloads' }).click();
  const rows = page.locator('.dl-row');
  await expect(rows).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    const row = await rows.nth(i).boundingBox();
    const st = await rows.nth(i).locator('.dl-status').boundingBox();
    expect(st!.y).toBeGreaterThanOrEqual(row!.y - 1);
    expect(st!.y + st!.height).toBeLessThanOrEqual(row!.y + row!.height + 1);
  }
  const retries = await page.locator('.dl-retry').evaluateAll((b) => b.map((x) => Math.round(x.getBoundingClientRect().top)));
  expect(new Set(retries).size).toBe(5);
});
