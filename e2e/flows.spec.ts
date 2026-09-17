import { test, expect, type Page } from '@playwright/test';

// One admin account, one server, run in order: first login forces the
// password change, everything after uses the new password.
const PW = 'e2e password 123';
async function login(page: Page, pw = PW) {
  await page.goto('/');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill(pw);
  await page.getByRole('button', { name: 'Log in' }).click();
}
// The admin starts as admin/admin and is forced to change it once; every
// project in the run shares the server, so whichever test gets there first
// does the change and the rest log in with the new password.
async function ensureLoggedIn(page: Page) {
  await login(page);
  if (await page.getByRole('heading', { name: 'Home' }).waitFor({ timeout: 4000 }).then(() => true, () => false)) return 'existing';
  await login(page, 'admin');
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill(PW);
  await page.getByLabel('Repeat it', { exact: true }).fill(PW);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  return 'changed';
}
async function waitForLibrary(page: Page) {
  // the boot scan takes a second on the fixture library
  await expect.poll(async () => (await page.request.get('/api/healthz')).ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'New in your library' })).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => page.locator('.shelf-row .card').count(), { timeout: 30000 }).toBeGreaterThan(0);
}

test.describe.configure({ mode: 'serial' });

test('first login: admin/admin is forced to pick a new password', async ({ page }) => {
  await ensureLoggedIn(page);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: 'admin' } })).status()).toBe(401);
  await waitForLibrary(page);
});

test('wrong password is refused, right one lands on Home', async ({ page }) => {
  await login(page, 'nope');
  await expect(page.getByRole('alert')).toHaveText(/wrong username or password/);
  await login(page);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
});

test('search, open an album, play a song, the clock runs, like it', async ({ page, isMobile }) => {
  await login(page);
  await waitForLibrary(page);
  await page.getByRole('button', { name: 'Search', exact: true }).first().click();
  await page.getByLabel('Search', { exact: true }).fill('harb');
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await expect(page.getByTestId('track-row').first()).toContainText(/harbour/i);
  await page.getByLabel('Search', { exact: true }).fill('first light');
  await expect(page.getByRole('heading', { name: 'Albums' })).toBeVisible();
  await page.locator('.shelf-row .card', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.hero .kind')).toHaveText('Album');
  const rows = page.getByTestId('track-row');
  await expect(rows.first()).toBeVisible();
  const title = (await rows.nth(1).locator('.row-title').textContent())!;
  await rows.nth(1).locator('.row-title').click();
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('data-state', 'playing', { timeout: 15000 });
  await expect(player).toContainText(title);
  await expect.poll(async () => page.getByTestId('position').textContent(), { timeout: 10000 }).not.toBe('0:00');
  // pause / resume through the transport
  await page.getByTestId('toggle').click();
  await expect(player).toHaveAttribute('data-state', 'paused');
  await page.getByTestId('toggle').click();
  await expect(player).toHaveAttribute('data-state', 'playing');
  // like from the player bar, see it in Liked Songs
  // (another project may have liked this very row already: start from unliked)
  const likeBtn = rows.nth(1).locator('button.like');
  if ((await likeBtn.getAttribute('aria-pressed')) === 'true') { await likeBtn.click(); await expect(likeBtn).toHaveAttribute('aria-pressed', 'false'); }
  await likeBtn.click();
  await expect(likeBtn).toHaveAttribute('aria-pressed', 'true');
  if (!isMobile) await expect(player.getByRole('button', { name: 'Remove from Liked Songs' })).toBeVisible(); // the bar mirrors the row
  await page.getByRole('button', { name: 'Library', exact: true }).first().click();
  await page.locator('.libitem', { hasText: 'Liked Songs' }).click();
  await expect(page.getByRole('heading', { name: 'Liked Songs' })).toBeVisible();
  await expect(page.getByTestId('track-row')).toHaveCount(1);
  await expect(page.getByTestId('track-row').first()).toContainText(title);
});

test('next/previous walk the album queue; lyrics follow the song', async ({ page }) => {
  await login(page);
  await waitForLibrary(page);
  await page.locator('.shelf-row .card').first().click();
  await page.locator('.hero-actions .primary').click();
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('data-state', 'playing', { timeout: 15000 });
  const first = await player.locator('.row-title').textContent();
  // the phone bar keeps only play/pause; next/previous live in now playing on both
  await player.getByRole('button', { name: 'Open now playing' }).click();
  const np = page.getByRole('dialog', { name: 'Now playing' });
  await expect(np).toBeVisible();
  await np.getByRole('button', { name: 'Next' }).click();
  await expect(player).toHaveAttribute('data-state', 'playing', { timeout: 15000 });
  await expect(np.locator('h2')).not.toHaveText(first!);
  await expect(np.locator('.np-lyrics p').first()).toBeVisible({ timeout: 10000 });
  await expect.poll(async () => np.locator('.np-lyrics p.now').count(), { timeout: 10000 }).toBeGreaterThan(0);
  await np.getByRole('button', { name: 'Previous' }).click();
  await expect(np.locator('h2')).toHaveText(first!, { timeout: 15000 });
  await page.keyboard.press('Escape');
  await expect(np).toBeHidden();
});

test('playlists: create, add via the API, open, rename, delete', async ({ page }) => {
  await login(page);
  await waitForLibrary(page);
  page.once('dialog', (d) => d.accept('Road trip'));
  await page.getByRole('button', { name: 'Library', exact: true }).first().click();
  await page.getByRole('button', { name: '+ Playlist' }).click();
  await expect(page.getByRole('heading', { name: 'Road trip' })).toBeVisible();
  const id = page.url().split('/playlist/')[1];
  const token = await page.evaluate(() => localStorage.getItem('slopify.token'));
  const album = await (await page.request.get('/api/albums?limit=1', { headers: { authorization: `Bearer ${token}` } })).json();
  const tracks = (await (await page.request.get(`/api/albums/${album.items[0].id}`, { headers: { authorization: `Bearer ${token}` } })).json()).tracks;
  await page.request.post(`/api/playlists/${id}/tracks`, { headers: { authorization: `Bearer ${token}` }, data: { trackIds: tracks.slice(0, 3).map((t: any) => t.id) } });
  await page.reload();
  await expect(page.getByTestId('track-row')).toHaveCount(3);
  page.once('dialog', (d) => d.accept('Road trip 2'));
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByRole('heading', { name: 'Road trip 2' })).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { name: 'Your Library' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Road trip/ })).toHaveCount(0);
});

test('settings: quality, devices, admin scan and invite', async ({ page, isMobile }) => {
  await login(page);
  await page.getByRole('button', { name: isMobile ? 'You' : 'Settings', exact: true }).first().click();
  await page.getByLabel('Normal (160 kbps)').check();
  expect(await page.evaluate(() => localStorage.getItem('slopify.quality'))).toBe('aac-160');
  await expect(page.locator('.plain li').first()).toContainText('this one');
  await page.getByRole('button', { name: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
  await expect(page.getByText(/songs without lyrics/)).toContainText(/\d+ songs without lyrics/);
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await expect(page.locator('code')).toContainText('/#/join?code=');
  await page.getByRole('button', { name: 'Scan now' }).click();
  await expect(page.getByText(/Last scan: 30 files/)).toBeVisible({ timeout: 20000 });
});

test('phone layout has the tab bar and a working mini player', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone project only');
  await login(page);
  await waitForLibrary(page);
  await expect(page.locator('.tabbar')).toBeVisible();
  await page.locator('.tabbar button', { hasText: 'Library' }).click();
  await page.getByRole('tab', { name: 'Albums' }).click();
  await page.locator('.grid .card').first().click();
  await page.getByTestId('track-row').first().locator('.row-title').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 15000 });
  const box = await page.locator('.tabbar').boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(852 + 1);
});
