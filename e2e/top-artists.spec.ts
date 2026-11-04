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
  const play = async (track: string, times: number, back: number) => {
    for (let n = 0; n < times; n++) {
      const r = await page.request.post('/api/plays', { headers, data: { trackId: track, at: Date.now() - (back + n) * 120000, client: 'web' } });
      expect(r.ok()).toBe(true);
    }
  };
  // What Home keeps from this visit has the second artist ahead...
  await play(ranked[1].track, 20, 100);
  await page.reload();
  await waitForLibrary(page);
  await expect(page.locator('.homeshelf h2', { hasText: 'Your top artists' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.endsWith('home.topArtists')))).toBe(true);
  // ...then the first artist passes it, and the next open is on a slow link:
  // Home opens with the kept answer and the new one lands after Show all is up.
  await play(ranked[0].track, 40, 0);
  await page.context().route('**/api/home*', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => {});
  });
  await page.reload();
  await waitForLibrary(page);
  // Phones show the title alone (the button is desktop's): the title opens it too.
  await page.locator('.homeshelf h2', { hasText: 'Your top artists' }).click();
  await expect(page.getByRole('heading', { name: 'Your top artists' })).toBeVisible();
  // Other tests share this server and play other artists: only these two's order counts.
  await expect.poll(async () => {
    const names = await page.locator('.grid .card').evaluateAll((els) => els.map((e) => e.textContent || ''));
    const at = (name: string) => names.findIndex((n) => n.includes(name));
    return at(ranked[0].name) >= 0 && at(ranked[0].name) < at(ranked[1].name);
  }, { timeout: 10000 }).toBe(true);
});
