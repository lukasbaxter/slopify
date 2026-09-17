import { test, expect } from '@playwright/test';
test('the app loads and sees the server', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Slopify' })).toBeVisible();
  await expect(page.getByTestId('health')).toHaveText(/server 0\.1\.0/);
});
