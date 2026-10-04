import { test, expect, webkit, type Browser, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// One account on two devices: a phone playing, a desktop choosing what plays
// on it. Whatever the desktop picks has to play on the phone, without the
// desktop taking the music over.

const nowTitle = (p: Page) => p.evaluate(() => (document.querySelector('.player')?.textContent || ''));

async function device(browser: Browser, phone: boolean) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SlopifyMobile/0.1' }
    : { viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await login(page); await waitForLibrary(page);
  return page;
}

async function openAlbum(page: Page, name: string) {
  await page.locator('.card, .shortcut', { hasText: name }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
}

test('the desktop picks songs for the phone that is playing', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  // The phone is WebKit with its real autoplay rules (an iPhone, Safari):
  // sound may only start after a tap, so a song chosen elsewhere has to play
  // on the element the tap unlocked.
  const wk = await webkit.launch({ args: [] }); // none of the Chrome-only flags from the config
  const phone = await device(wk, true);
  const desk = await device(browser, false);

  // The phone plays a song.
  await openAlbum(phone, 'First Light');
  await phone.locator('.trackrow').nth(0).click();
  await expect.poll(() => nowTitle(phone), { timeout: 20000 }).toMatch(/0:0[1-9]|0:[1-5]\d/);

  // The desktop sees it playing on the phone...
  await expect.poll(() => nowTitle(desk), { timeout: 20000 }).toContain('River Harbour');

  // ...and double-clicks another song: it plays on the phone.
  await openAlbum(desk, 'First Light');
  const row = desk.locator('.trackrow').nth(2);
  const title = (await row.locator('.trackrow-name, .trackrow-title').first().textContent())!.trim();
  await row.dblclick();
  await expect.poll(() => nowTitle(phone), { timeout: 15000 }).toContain(title.slice(0, 12));
  await expect.poll(() => nowTitle(desk), { timeout: 15000 }).toContain(title.slice(0, 12));
  // The phone is still the one playing.
  expect(await desk.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused))).toBe(false);

  // Next from the desktop moves the phone on too.
  await desk.locator('.player button[title="Next"], .player button[aria-label="Next"]').first().click();
  await expect.poll(() => nowTitle(phone), { timeout: 15000 }).not.toContain(title.slice(0, 12));

  // Each shows up under a name of its own, not "Web Player (n)".
  const names = await desk.evaluate(async () => {
    const tok = JSON.parse(localStorage.getItem('slopify.session') || '{}').token;
    const r = await (await fetch('/api/session', { headers: { authorization: `Bearer ${tok}` } })).json();
    return r.clients.map((c: any) => c.name);
  });
  expect(names).toContain('Safari on iPhone');
  expect(names.some((n: string) => /^Chrome on (Mac|Linux|Windows)/.test(n))).toBe(true);
  await wk.close();
});
