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
  // Not the row the remembered session is on: a tap there resumes that session (whatever it
  // was picked from) instead of picking the song from this page.
  const row = page.locator('.trackrow:not(.active)').first();
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

// A song left playing and picked up again elsewhere (a relaunch, another
// device) still counts for where it was picked from: the session a page
// opens on carries the album, and Play reports it. It used to come back with
// no context, so the resumed song never reached the shortcuts.
test('a session resumed in a fresh page still reports the album it was picked from', async ({ page, browser, isMobile }) => {
  test.skip(isMobile, 'one layout is enough');
  await login(page); await waitForLibrary(page);
  const h = await auth(page);
  const album = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items.find((a: any) => a.name === 'Analytical');
  await page.locator('.card, .shortcut', { hasText: 'Analytical' }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  await page.locator('.trackrow').nth(0).dblclick();
  await expect(page.locator('.player button[title="Pause"], .player button[aria-label="Pause"]').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(2500); // a report or two reach the server
  await page.close();

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  try {
    const seen = reportedContexts(page2);
    await login(page2); await waitForLibrary(page2);
    const play = page2.locator('.player button[title="Play"], .player button[aria-label="Play"]').first();
    await expect(play).toBeVisible({ timeout: 20000 });
    await play.click();
    await expect.poll(() => [...seen].join(','), { timeout: 20000 }).toContain(album.id);
  } finally { await ctx2.close(); }
});

// Home's shelves all read /api/home. Each used to ask for it by itself, three
// requests on every load, and every reload after a play tripled again; on an
// account whose answer took 300 ms the server spent its time on nothing else
// (owner, 11-14: slow songs, slow covers, a second device taking the player over).
test('Home asks for /api/home once per load, not once per shelf', async ({ page }) => {
  await login(page); await waitForLibrary(page);
  await page.waitForTimeout(3000); // the first load's own requests are over
  let asked = 0;
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/home') asked += 1; });
  await page.reload();
  await waitForLibrary(page);
  await page.waitForTimeout(4000);
  expect(asked).toBe(1);
});
