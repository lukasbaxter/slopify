import { expect, type Page } from '@playwright/test';
export const PW = 'e2e password 123';
// The Conduit UI's login form: server, username, password inputs and a
// .primary button. The admin's first password change happens through the
// API (the Conduit UI has no forced-change screen), whichever test is first.
export async function login(page: Page) {
  const r = await page.request.post('/api/auth/login', { data: { username: 'admin', password: 'admin' } });
  if (r.ok()) { const tok = (await r.json()).token; await page.request.post('/api/auth/password', { headers: { authorization: `Bearer ${tok}` }, data: { password: PW } }); }
  await page.goto('/');
  const inputs = page.locator('.login input');
  await expect(inputs).toHaveCount(2); // web build: no server field
  await inputs.nth(0).fill('admin'); await inputs.nth(1).fill(PW);
  await page.locator('.login .primary').click();
  await expect(page.locator('.tabbar, .sidebar, .shell').first()).toBeVisible({ timeout: 20000 });
}
export async function waitForLibrary(page: Page) {
  await expect.poll(async () => page.locator('.card, .shortcut').count(), { timeout: 30000 }).toBeGreaterThan(0);
}
