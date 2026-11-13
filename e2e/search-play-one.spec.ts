import { test, expect, type Page } from '@playwright/test';
import { open } from './player-helpers';

// A song played from search is the whole context, like Spotify: it plays
// alone (not the other hits) and the queue fills with its continuation mix
// (brain, or the library's own mix) straight away, so "Next up" shows it.
async function searchFor(page: Page, q: string) {
  await expect.poll(() => page.evaluate(() => { const p = (window as any).__player; if (p.mirroring) p.relay?.claim(); return p.mirroring; }), { timeout: 15000 }).toBe(false);
  await page.keyboard.press('/');
  await page.locator('input.search').fill(q);
  await expect(page.locator('.searchgrid .trackrow').first()).toBeVisible({ timeout: 15000 });
}
const state = (page: Page) => page.evaluate(() => {
  const p = (window as any).__player;
  return { ids: p.queue.map((t: any) => t.Id) as string[], index: p.index as number, ctx: p.contextId };
});

test('a song row from search plays alone, then its continuation fills the queue', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop rows (double-click)');
  await open(page);
  await searchFor(page, 'Static River');
  const rows = page.locator('.searchgrid .trackrow');
  expect(await rows.count()).toBeGreaterThan(1); // several hits, so "alone" means something
  const mixes: string[] = [];
  page.on('request', (r) => { if (/\/api\/tracks\/[^/]+\/mix/.test(r.url())) mixes.push(r.url()); });
  await rows.nth(1).dblclick();
  await expect.poll(async () => (await state(page)).ids.length, { timeout: 10000 }).toBeGreaterThan(0);
  const first = await state(page);
  const chosen = first.ids[first.index];
  // The continuation was asked for the chosen song as soon as it started.
  await expect.poll(() => mixes.some((u) => u.includes(chosen) && u.includes('mode=continue')), { timeout: 10000 }).toBe(true);
  await expect.poll(async () => (await state(page)).ids.length, { timeout: 15000 }).toBeGreaterThan(1);
  const s = await state(page);
  expect(s.index).toBe(0);
  expect(s.ids[0]).toBe(chosen);
  expect(s.ctx).toBeNull();
  expect(new Set(s.ids).size).toBe(s.ids.length);
  // The picks show in the queue panel under "Next up".
  await page.locator('.player button[title="Queue"]').first().click();
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible({ timeout: 10000 });
});

test('the top result card plays the song alone too', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop top result card');
  await open(page);
  await searchFor(page, 'Static River');
  await expect(page.locator('.topresult .card-play')).toBeVisible();
  const kind = await page.locator('.topresult .kind b').textContent().catch(() => null);
  test.skip(kind !== 'Song', 'top result is not a song on this library');
  const mixes: string[] = [];
  page.on('request', (r) => { if (/\/api\/tracks\/[^/]+\/mix/.test(r.url())) mixes.push(r.url()); });
  await page.locator('.topresult .card-play').click();
  await expect.poll(async () => (await state(page)).ids.length, { timeout: 10000 }).toBeGreaterThan(0);
  const chosen = (await state(page)).ids[0];
  await expect.poll(() => mixes.some((u) => u.includes(chosen) && u.includes('mode=continue')), { timeout: 10000 }).toBe(true);
  const s = await state(page);
  expect(s.index).toBe(0);
  expect(s.ctx).toBeNull();
});
