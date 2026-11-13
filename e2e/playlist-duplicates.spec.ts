import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// "Add to playlist" with songs the playlist already has (API.md 8.2): each
// one is asked about by name, "Do this for all" answers the rest, songs not
// there are always added, and the toast says what happened. Before, every
// add went straight in, duplicates and all, with no question.
const token = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '');
async function api(page: Page) {
  const h = { Authorization: `Bearer ${await token(page)}` };
  const album = (await (await page.request.get('/api/albums?limit=100', { headers: h })).json()).items.find((a: any) => a.name === 'First Light');
  const songs = (await (await page.request.get(`/api/albums/${album.id}`, { headers: h })).json()).tracks as { id: string, title: string }[];
  const make = async (name: string, trackIds: string[]) => (await (await page.request.post('/api/playlists', { headers: h, data: { name, trackIds } })).json()).id as string;
  const ids = async (id: string) => ((await (await page.request.get(`/api/playlists/${id}`, { headers: h })).json()).tracks as any[]).map((t) => t.id);
  return { album, songs, make, ids };
}
const dialog = (page: Page) => page.locator('.modal-back.dupe-ask .modal');
async function addFromMenu(page: Page, name: string) {
  await page.locator('.ctxmenu .ctxitem', { hasText: 'Add to playlist' }).click();
  await page.locator('.ctxmenu-sub .ctxitem', { hasText: name }).click();
}

test('one song already there: asked, Don\'t add keeps it once, Add anyway adds it again', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop menus');
  await login(page);
  const { album, songs, make, ids } = await api(page);
  const name = `Dupe one ${Date.now()}`;
  const pl = await make(name, [songs[0].id]);
  await page.goto(`/?album=${album.id}`);
  const row = page.locator('.trackrow', { hasText: songs[0].title }).first();
  await expect(row).toBeVisible({ timeout: 15000 });

  await row.locator('.trackrow-more').click();
  await addFromMenu(page, name);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('h3')).toHaveText('Already added');
  await expect(dialog(page)).toContainText(`"${songs[0].title}" is already in ${name}.`);
  // Only one song in question: nothing to do "for all".
  await expect(dialog(page).locator('.dupe-ask-all')).toHaveCount(0);
  await dialog(page).locator('button', { hasText: "Don't add" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveText(`Already in ${name}`);
  expect(await ids(pl)).toEqual([songs[0].id]);

  await row.locator('.trackrow-more').click();
  await addFromMenu(page, name);
  await dialog(page).locator('button', { hasText: 'Add anyway' }).click();
  await expect(page.locator('.toast')).toHaveText(`Added to ${name}`);
  await expect.poll(() => ids(pl)).toEqual([songs[0].id, songs[0].id]);

  // A song that is not there goes straight in, no question.
  await page.locator('.trackrow', { hasText: songs[1].title }).first().locator('.trackrow-more').click();
  await addFromMenu(page, name);
  await expect(page.locator('.toast')).toHaveText(`Added to ${name}`);
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => ids(pl)).toEqual([songs[0].id, songs[0].id, songs[1].id]);
});

test('an album onto a playlist that has some of it: asked per song, then "Do this for all"', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop menus');
  await login(page);
  const { album, songs, make, ids } = await api(page);
  const name = `Dupe album ${Date.now()}`;
  const have = [songs[1].id, songs[3].id, songs[5].id];
  const pl = await make(name, have);
  await page.goto(`/?album=${album.id}`);
  await expect(page.locator('.trackrow', { hasText: songs[0].title }).first()).toBeVisible({ timeout: 15000 });

  // First pass: answer the first one alone (Add anyway), then skip the rest for all.
  await page.locator('.iconbtn.more').first().click();
  await addFromMenu(page, name);
  await expect(dialog(page)).toContainText(`"${songs[1].title}" is already in ${name}.`);
  await expect(dialog(page).locator('.dupe-ask-all')).toContainText('Do this for all');
  await dialog(page).locator('button', { hasText: 'Add anyway' }).click();
  await expect(dialog(page)).toContainText(`"${songs[3].title}" is already in ${name}.`);
  await dialog(page).locator('.dupe-ask-all input').check();
  await dialog(page).locator('button', { hasText: "Don't add" }).click();
  // songs[5] was answered by "for all": no third question.
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveText(`Added ${songs.length - 2} to ${name}, skipped 2 already there`);
  const added = songs.map((s) => s.id).filter((id) => id !== songs[3].id && id !== songs[5].id);
  await expect.poll(() => ids(pl)).toEqual([...have, ...added]);

  // Second pass: add all of them again with one answer.
  await page.locator('.iconbtn.more').first().click();
  await addFromMenu(page, name);
  await dialog(page).locator('.dupe-ask-all input').check();
  await dialog(page).locator('button', { hasText: 'Add anyway' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveText(`Added to ${name}`);
  await expect.poll(() => ids(pl)).toEqual([...have, ...added, ...songs.map((s) => s.id)]);
});

test('a song twice in the same batch counts as already there', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop menus');
  await login(page);
  const { songs, make, ids } = await api(page);
  const stamp = Date.now();
  const from = `Dupe from ${stamp}`, into = `Dupe into ${stamp}`;
  await make(from, [songs[0].id, songs[2].id, songs[0].id]);
  const target = await make(into, []);
  await page.goto('/'); await waitForLibrary(page);
  await page.locator('.sidebar').getByText(from, { exact: true }).click();
  await expect(page.locator('h1', { hasText: from }).first()).toBeVisible({ timeout: 15000 });
  await page.locator('.iconbtn.more').first().click();
  await addFromMenu(page, into);
  await expect(dialog(page)).toContainText(`"${songs[0].title}" is already in ${into}.`);
  await dialog(page).locator('button', { hasText: "Don't add" }).click();
  await expect(page.locator('.toast')).toHaveText(`Added 2 to ${into}, skipped 1 already there`);
  await expect.poll(() => ids(target)).toEqual([songs[0].id, songs[2].id]);
});

// The now playing view sits above the page: the question must show above it.
// Its menu is the phone layout's (the desktop view has none).
test('now playing: the question shows above the player view', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone now playing menu');
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__player), { timeout: 15000 }).toBe('object');
  const { songs, make, ids } = await api(page);
  const name = `Dupe np ${Date.now()}`;
  const pl = await make(name, [songs[0].id]);
  await page.reload(); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__player), { timeout: 15000 }).toBe('object');
  await page.evaluate(async (ids) => { const w = window as any; await w.__player.playQueue(await w.__jf.itemsByIds(ids), 0, null); }, [songs[0].id]);
  await expect(page.locator('.player button[title="Pause"]').first()).toBeVisible({ timeout: 20000 });
  await page.locator('.player-row').first().click({ position: { x: 24, y: 24 } });
  await expect(page.locator('.fs')).toBeVisible({ timeout: 10000 });
  await page.locator('.fs-more').click();
  await addFromMenu(page, name);
  await expect(dialog(page)).toContainText(`"${songs[0].title}" is already in ${name}.`);
  await dialog(page).locator('button', { hasText: "Don't add" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await ids(pl)).toEqual([songs[0].id]);
});

// The queue's row menu goes the same way.
test('queue: a song already there is asked about', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop queue panel');
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__player), { timeout: 15000 }).toBe('object');
  const { songs, make, ids } = await api(page);
  const name = `Dupe queue ${Date.now()}`;
  const pl = await make(name, [songs[0].id]);
  await page.reload(); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__player), { timeout: 15000 }).toBe('object');
  await page.evaluate(async (ids) => { const w = window as any; await w.__player.playQueue(await w.__jf.itemsByIds(ids), 0, null); }, [songs[0].id, songs[1].id]);
  await expect(page.locator('.player button[title="Pause"]').first()).toBeVisible({ timeout: 20000 });
  await page.locator('.player button[title="Queue"]').first().click();
  await page.locator('.rightpanel .qrow', { hasText: songs[0].title }).first().click({ button: 'right' });
  await addFromMenu(page, name);
  await expect(dialog(page)).toContainText(`"${songs[0].title}" is already in ${name}.`);
  await dialog(page).locator('button', { hasText: 'Add anyway' }).click();
  await expect(page.locator('.toast')).toHaveText(`Added to ${name}`);
  await expect.poll(() => ids(pl)).toEqual([songs[0].id, songs[0].id]);
});
