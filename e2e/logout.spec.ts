import { test, expect } from '@playwright/test';
import { login, waitForLibrary, PW } from './helpers';

// Logging out ends the music on this device: the sign-in form with a song
// still playing behind it was the next person's or nobody's to stop (11-04).
test('log out stops the music on this device', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'the menu is the desktop one');
  await login(page);
  await waitForLibrary(page);
  await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  await page.locator('.trackrow').nth(0).dblclick();
  const sounding = () => page.evaluate(() => { const a = (window as any).__slopifyAudio(); return [a.active, a.spare].filter((e) => e && !e.paused).length; });
  await expect.poll(sounding, { timeout: 15000 }).toBeGreaterThan(0);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token);
  await page.locator('button.avatar').first().click();
  await page.getByRole('button', { name: 'Log out' }).first().click();
  await expect(page.locator('.login input').first()).toBeVisible();
  await expect.poll(sounding, { timeout: 3000 }).toBe(0);
  // Nothing left to start itself again, or holding the lock screen.
  await page.waitForTimeout(1500);
  expect(await sounding()).toBe(0);
  expect(await page.evaluate(() => navigator.mediaSession.metadata)).toBeNull();
  // The sign-in is over on the server too.
  await expect.poll(async () => (await page.request.get('/api/auth/me', { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
});

// The desktop form asks for the server: it is typed however people type it.
test('desktop sign-in takes the address with nothing in front, and says when nothing answers', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'the desktop app');
  const r = await page.request.post('/api/auth/login', { data: { username: 'admin', password: 'admin' } });
  if (r.ok()) { const tok = (await r.json()).token; await page.request.post('/api/auth/password', { headers: { authorization: `Bearer ${tok}` }, data: { password: PW } }); }
  await page.addInitScript(() => { (window as any).conduit = {}; });
  await page.goto('/');
  const inputs = page.locator('.login input');
  await expect(inputs).toHaveCount(3);
  await expect(page.locator('.login')).toContainText('With or without https://');
  await inputs.nth(1).fill('admin'); await inputs.nth(2).fill(PW);
  await inputs.nth(0).fill('localhost:1');
  await page.locator('.login .primary').click();
  await expect(page.locator('.login')).toContainText('No Slopify server answered at localhost:1');
  await inputs.nth(0).fill('localhost:8080/');
  await page.locator('.login .primary').click();
  await expect(page.locator('.tabbar, .sidebar, .shell').first()).toBeVisible({ timeout: 20000 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').baseUrl)).toBe('http://localhost:8080');
});
