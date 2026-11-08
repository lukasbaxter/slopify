import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// The app never reloads itself while it is in the background. On an iPhone
// a backgrounded web app's Cache Storage does not answer (tools/ios-sim:
// caches.keys() still pending after 3 s once the app is sent home) and the
// app is suspended within seconds, so a reload started then is a black page
// that has to finish when the app is opened again: the black screen on
// coming back. A new build or a language picked elsewhere waits for the app
// to be in front and left alone there. (Elsewhere a hidden page still
// reloads: e2e/autoupdate.spec.ts.)
async function hide(page: Page, hidden: boolean) {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
const reloaded = (page: Page) => page.evaluate(() => !(window as any).__sameDocument).catch(() => true);

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
test('iPhone: a new build does not reload the app while it is in the background', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'its own iPhone context');
  const ctx = await browser.newContext({ userAgent: IPHONE, viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page); await waitForLibrary(page);
  await page.evaluate(() => { (window as any).__sameDocument = true; });
  // A deploy: the server says a newer build is out.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slopify:webbuild', { detail: 'assets/index-NewBuild1.js' })));
  await hide(page, true);
  await page.waitForTimeout(4000);
  expect(await reloaded(page)).toBe(false);
  await ctx.close();
});
