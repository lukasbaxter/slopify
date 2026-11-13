import { test, expect, type Page, type Locator } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Dragging songs within a playlist on desktop (owner, 11-13):
//  - the green line shows where the song will land while it is dragged
//    (the rule was on .trackrow.dropbefore, but the class sits on the row's
//    wrapper, so it never showed);
//  - a second drag moves the song on screen, not a stale index (rows kept
//    the positions they were loaded with);
//  - the queue playing that playlist follows the new order at once.
const token = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '');
async function setup(page: Page) {
  const h = { Authorization: `Bearer ${await token(page)}` };
  const album = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items.find((a: any) => a.name === 'First Light');
  const songs = (await (await page.request.get(`/api/albums/${album.id}`, { headers: h })).json()).tracks.slice(0, 5) as { id: string, title: string }[];
  const name = `Reorder ${Date.now()}`;
  const id = (await (await page.request.post('/api/playlists', { headers: h, data: { name, trackIds: songs.map((s) => s.id) } })).json()).id as string;
  const serverIds = async () => ((await (await page.request.get(`/api/playlists/${id}`, { headers: h })).json()).tracks as any[]).map((t) => t.id);
  return { songs, name, serverIds };
}

async function drag(page: Page, from: Locator, to: Locator, check?: () => Promise<void>) {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await from.dispatchEvent('dragstart', { dataTransfer: dt });
  await to.dispatchEvent('dragenter', { dataTransfer: dt });
  await to.dispatchEvent('dragover', { dataTransfer: dt });
  if (check) await check();
  await to.dispatchEvent('drop', { dataTransfer: dt });
  await from.dispatchEvent('dragend', { dataTransfer: dt });
}
// The accent line on a row: a visible box-shadow (inset top or bottom).
const lineOn = (row: Locator) => row.evaluate((el) => {
  const s = (e: Element) => getComputedStyle(e).boxShadow;
  return [s(el), el.parentElement ? s(el.parentElement) : 'none'].some((v) => v && v !== 'none');
});

async function openPlaylist(page: Page, name: string) {
  await page.reload(); await waitForLibrary(page);
  await page.locator('.libitem', { hasText: name }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
}

test('dragging a song in a playlist shows the green line where it lands', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop drag and drop');
  await login(page); await waitForLibrary(page);
  const { songs, name } = await setup(page);
  await openPlaylist(page, name);
  const r = page.locator('.trackrow');
  await drag(page, r.nth(4), r.nth(1), async () => {
    expect(await lineOn(r.nth(1)), 'line on the row being dragged over').toBe(true);
    expect(await lineOn(r.nth(3)), 'no line elsewhere').toBe(false);
  });
  await expect(r.nth(1)).toContainText(songs[4].title);
});

test('two drags in a row move the right songs on the server', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop drag and drop');
  await login(page); await waitForLibrary(page);
  const { songs, name, serverIds } = await setup(page);
  await openPlaylist(page, name);
  const r = page.locator('.trackrow');
  await drag(page, r.nth(4), r.nth(0)); // 4 0 1 2 3
  await expect(r.nth(0)).toContainText(songs[4].title);
  await drag(page, r.nth(4), r.nth(1)); // 4 3 0 1 2
  await expect(r.nth(1)).toContainText(songs[3].title);
  const want = [4, 3, 0, 1, 2].map((i) => songs[i].id);
  await expect.poll(serverIds).toEqual(want);
});

test('the queue playing the playlist follows a reorder at once', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop drag and drop');
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  const { songs, name } = await setup(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await page.locator('.libitem', { hasText: name }).first().click();
  const r = page.locator('.trackrow');
  await expect(r.first()).toBeVisible({ timeout: 15000 });
  await r.nth(0).dblclick();
  await expect(page.locator('.player button[title="Pause"]').first()).toBeVisible({ timeout: 20000 });
  await page.locator('.player button[title="Pause"]').first().click();
  const upcoming = () => page.evaluate(() => { const p = (window as any).__player; return p.queue.slice(p.index + 1).map((t: any) => t.Id); });
  await expect.poll(upcoming).toEqual([1, 2, 3, 4].map((i) => songs[i].id));
  await drag(page, r.nth(4), r.nth(1)); // 0 4 1 2 3
  await expect.poll(upcoming, { timeout: 3000 }).toEqual([4, 1, 2, 3].map((i) => songs[i].id));
});
