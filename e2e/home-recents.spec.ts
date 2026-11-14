import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Home's shortcuts are what you picked and played from (owner, 11-14):
//  - the page tells the server where a song was picked from (the album's or
//    playlist's id rides on its now-playing reports);
//  - once the play is logged, Home shows that album or playlist first after
//    Liked Songs without a reload (it kept its answer from before the play).
// The fixture songs are 5-8 s and a play counts after 8 s, so the play itself
// is logged through the API here, exactly as the page's own report would be;
// what the server makes of a report is covered in server/src/home-recents.test.ts.
const auth = async (page: Page) => ({ Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '')}` });
// The contexts this page reports on its session socket while a song plays.
function reportedContexts(page: Page) {
  const seen = new Set<string>();
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    try { const m = JSON.parse(String(f.payload)); if (m.type === 'nowplaying' && m.nowPlaying?.playing) seen.add(String(m.nowPlaying.ctx)); } catch { /* not JSON */ }
  }));
  return seen;
}
const goHome = (page: Page, isMobile: boolean) => page.locator(isMobile ? '.tabbar' : '.sidebar').getByText('Home', { exact: true }).first().click();

test('a song played from an album page reports the album, and Home then leads with it', async ({ page, isMobile }) => {
  const seen = reportedContexts(page);
  await login(page); await waitForLibrary(page);
  const h = await auth(page);
  const album = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items.find((a: any) => a.name === 'First Light');
  const songs = (await (await page.request.get(`/api/albums/${album.id}`, { headers: h })).json()).tracks as { id: string }[];
  await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  const row = page.locator('.trackrow').nth(0);
  if (isMobile) await row.click(); else await row.dblclick();
  await expect.poll(() => seen.has(album.id), { timeout: 20000 }).toBe(true);
  expect((await page.request.post('/api/plays', { headers: h, data: { trackId: songs[0].id, client: 'web', ctx: album.id } })).ok()).toBe(true);
  await goHome(page, isMobile);
  await expect(page.locator('.shortcut').nth(1)).toContainText('First Light', { timeout: 25000 });
});

test('a song played from a playlist page reports the playlist, and Home then leads with it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'opened from the desktop sidebar');
  const seen = reportedContexts(page);
  await login(page); await waitForLibrary(page);
  const h = await auth(page);
  const album = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items.find((a: any) => a.name === 'Second Wind');
  const songs = ((await (await page.request.get(`/api/albums/${album.id}`, { headers: h })).json()).tracks as { id: string }[]).slice(0, 3);
  const name = `Picked ${Date.now()}`;
  const id = (await (await page.request.post('/api/playlists', { headers: h, data: { name, trackIds: songs.map((s) => s.id) } })).json()).id as string;
  try {
    await page.reload(); await waitForLibrary(page);
    await page.locator('.libitem', { hasText: name }).first().click();
    await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
    await page.locator('.trackrow').nth(1).dblclick();
    await expect.poll(() => seen.has(id), { timeout: 20000 }).toBe(true);
    expect((await page.request.post('/api/plays', { headers: h, data: { trackId: songs[1].id, client: 'web', ctx: id } })).ok()).toBe(true);
    await goHome(page, false);
    // The playlist, not the song's album.
    await expect(page.locator('.shortcut').nth(1)).toContainText(name, { timeout: 25000 });
  } finally {
    await page.request.delete(`/api/playlists/${id}`, { headers: h }).catch(() => {});
  }
});
