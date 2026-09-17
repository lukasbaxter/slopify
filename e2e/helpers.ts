import { expect, type Page } from '@playwright/test';
export const PW = 'e2e password 123';
async function fill(page: Page, pw: string) {
  await page.goto('/');
  await page.getByLabel('Username').fill('admin'); await page.getByLabel('Password').fill(pw);
  await page.getByRole('button', { name: 'Log in' }).click();
}
// admin starts as admin/admin and must change it once; whichever test gets
// there first does it, the rest log in with the new password.
export async function login(page: Page) {
  await fill(page, PW);
  if (await page.getByRole('heading', { name: 'Home' }).waitFor({ timeout: 4000 }).then(() => true, () => false)) return;
  await fill(page, 'admin');
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill(PW); await page.getByLabel('Repeat it', { exact: true }).fill(PW);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
}
export async function waitForLibrary(page: Page) {
  await expect(page.getByRole('heading', { name: 'New in your library' })).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => page.locator('.shelf-row .card').count(), { timeout: 30000 }).toBeGreaterThan(0);
}
