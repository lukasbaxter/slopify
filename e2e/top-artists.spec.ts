import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Show all on "Your top artists" is the ranking, most played first, not the
// library's artists A to Z.
test('Show all on top artists lists them by plays', async ({ page }) => {
  await login(page);
  await waitForLibrary(page);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token);
  const headers = { authorization: `Bearer ${token}` };
  const { items: artists } = await (await page.request.get('/api/artists?limit=100', { headers })).json();
  expect(artists.length).toBeGreaterThan(1);
  // The names last in A to Z get the most plays, so the two orders differ.
  const ranked: { name: string; track: string }[] = [];
  for (const a of [...artists].sort((x, y) => y.name.localeCompare(x.name))) {
    const { tracks } = await (await page.request.get(`/api/artists/${a.id}`, { headers })).json();
    if (tracks?.length) ranked.push({ name: a.name, track: tracks[0].id });
    if (ranked.length === 2) break;
  }
  expect(ranked.length).toBe(2);
  for (const [i, a] of ranked.entries()) {
    for (let n = 0; n < (2 - i) * 20; n++) {
      const r = await page.request.post('/api/plays', { headers, data: { trackId: a.track, at: Date.now() - (i * 100 + n) * 120000, client: 'web' } });
      expect(r.ok()).toBe(true);
    }
  }
  await page.reload();
  await waitForLibrary(page);
  // Phones show the title alone (the button is desktop's): the title opens it too.
  await page.locator('.homeshelf h2', { hasText: 'Your top artists' }).click();
  await expect(page.getByRole('heading', { name: 'Your top artists' })).toBeVisible();
  const names = await page.locator('.grid .card').evaluateAll((els) => els.map((e) => e.textContent || ''));
  expect(names[0]).toContain(ranked[0].name);
  expect(names[1]).toContain(ranked[1].name);
});
