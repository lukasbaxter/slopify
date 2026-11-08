import { test, expect, type Browser, type Page } from '@playwright/test';
import { instrument, longest, play, closeAll, token } from './player-helpers';
import { login, waitForLibrary } from './helpers';

// The language follows the account, but only the device where it was picked
// reloads at once. Every other device got the pick over the session and
// reloaded 800 ms later, in the middle of whatever it was playing.
test.beforeEach(closeAll);
test.afterEach(closeAll);

async function device(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await instrument(page);
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__updatePrefs), { timeout: 15000 }).toBe('function');
  return page;
}

test('a language picked on one device does not reload another one mid-song', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  const picker = await device(browser);
  const player = await device(browser);
  try {
    await play(player, [await longest(player, 'First Light')], null);
    await expect.poll(() => player.evaluate(() => (window as any).__player.playing), { timeout: 10000 }).toBe(true);
    await player.evaluate(() => { (window as any).__slopifyAudio().active.playbackRate = 0.5; (window as any).__marker = 1; });
    await picker.evaluate(() => { (window as any).__marker = 1; });
    // Picked on the other device: that one reloads into it.
    await Promise.all([picker.waitForEvent('load', { timeout: 10000 }), picker.evaluate(() => (window as any).__updatePrefs({ language: 'de' }))]);
    expect(await picker.evaluate(() => (window as any).__marker)).toBeUndefined();
    // The playing device took the pick (for its next launch) and played on.
    await expect.poll(() => player.evaluate(() => localStorage.getItem('slopify.lang.user')), { timeout: 10000 }).toBe('de');
    await player.waitForTimeout(2500);
    expect(await player.evaluate(() => (window as any).__marker)).toBe(1);
    expect(await player.evaluate(() => !(window as any).__slopifyAudio().active.paused)).toBe(true);
    // Paused and out of sight, it interrupts nobody: now it shows the pick.
    await player.evaluate(() => (window as any).__player.toggle());
    await expect.poll(() => player.evaluate(() => (window as any).__player.playing), { timeout: 5000 }).toBe(false);
    await Promise.all([player.waitForEvent('load', { timeout: 10000 }), player.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })]);
    await expect.poll(() => player.evaluate(() => document.documentElement.lang), { timeout: 10000 }).toBe('de');
  } finally {
    // Back to automatic for the account (and the rest of the suite).
    await picker.request.patch('/api/prefs', { headers: { Authorization: `Bearer ${await token(picker).catch(() => '')}` }, data: { language: '' } }).catch(() => {});
  }
});
