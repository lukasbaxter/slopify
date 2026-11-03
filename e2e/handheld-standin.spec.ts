import { test, expect, type Browser, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// AirPods follow the Apple device that starts playing. An iPad standing in
// (its silent lock-screen audio) for music the iPhone plays itself took the
// AirPods off the iPhone, which paused it (11-03). Music on another phone or
// tablet: no stand-in. Music on a laptop: the stand-in as before.

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SlopifyMobile/0.1';
const nowTitle = (p: Page) => p.evaluate(() => (document.querySelector('.player')?.textContent || ''));
const standInPlaying = (p: Page) => p.evaluate(() => { const a = (window as any).__conduitKeepAlive; return !!a && !a.paused; });

async function ios(browser: Browser, name: string, form: 'phone' | 'tablet') {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: IOS });
  await ctx.addInitScript(([n, f]) => { (window as any).slopifyShell = { deviceName: n, deviceForm: f, platform: 'ios', version: 'test' }; }, [name, form]);
  const page = await ctx.newPage(); await login(page); await waitForLibrary(page);
  await page.reload(); await waitForLibrary(page);
  await page.locator('body').click({ position: { x: 5, y: 5 } }); // the first tap unlocks the stand-in
  return page;
}

async function playAlbum(page: Page) {
  await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  await page.locator('.trackrow').nth(0).dblclick();
}

// Devices other tests left open (and their sessions) would be the account's
// active player here: gone before and after each test.
const closeAll = async ({ browser }: { browser: import('@playwright/test').Browser }) => { for (const c of browser.contexts()) await c.close().catch(() => {}); };
test.beforeEach(closeAll);
test.afterEach(closeAll);

test('an iPad never stands in for music the iPhone plays itself; it does for a laptop', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'devices of its own');
  const ipad = await ios(browser, 'Test iPad', 'tablet');
  const desk = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await login(desk); await waitForLibrary(desk);
  // A laptop plays: the iPad's lock screen shows it (stand-in playing).
  await playAlbum(desk);
  await expect.poll(() => nowTitle(ipad), { timeout: 20000 }).toContain('River Harbour');
  await expect.poll(() => standInPlaying(ipad), { timeout: 10000 }).toBe(true);
  await desk.locator('.player button[title="Pause"]').first().click();
  await desk.context().close();
  // The iPhone plays its own sound: the iPad shows the song, silently, and
  // starts nothing that would take the AirPods.
  const phone = await ios(browser, 'Test iPhone', 'phone');
  await playAlbum(phone);
  await expect.poll(() => phone.locator('.player button[title="Pause"]').count(), { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(() => nowTitle(ipad), { timeout: 20000 }).toContain('Playing on Test iPhone');
  await ipad.waitForTimeout(3000);
  expect(await standInPlaying(ipad)).toBe(false);
  await phone.locator('.player button[title="Pause"]').first().click();
  await phone.context().close(); await ipad.context().close();
});
