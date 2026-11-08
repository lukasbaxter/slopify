import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// The service worker keeps API answers per account (slopify-api-<user id>,
// named by the X-Slopify-User header the app sends). A request without it
// (the app sends it only once it knows the user) went into one cache shared
// by every account on the device, and was answered from it.
test.skip(({ isMobile }) => isMobile, 'one run is enough');

test('an API answer without the account header is never kept in a cache shared by accounts', async ({ page }) => {
  await login(page); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20000 }).toBe(true);
  const r = await page.evaluate(async () => {
    const tok = JSON.parse(localStorage.getItem('slopify.session') || '{}').token;
    const res = await fetch('/api/albums?limit=1', { headers: { Authorization: `Bearer ${tok}` } });
    await res.json();
    return { status: res.status, caches: await caches.keys() };
  });
  expect(r.status).toBe(200);
  // The account's own cache is there (the app's requests), the shared one is not.
  expect(r.caches.some((k: string) => k.startsWith('slopify-api-'))).toBe(true);
  expect(r.caches).not.toContain('slopify-api');
});
