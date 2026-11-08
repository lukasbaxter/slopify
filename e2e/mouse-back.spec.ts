import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// A mouse's back / forward button moves exactly one page per press, however
// long it is held and whichever events the platform delivers: the DOM's
// mousedown / mouseup / auxclick and, in the desktop app on Linux and
// Windows, Electron's app-command (relayed as window.conduit.onNavigate),
// which on Linux arrives on the PRESS and may repeat while the button is
// held. Held past the old 350 ms lock, the press (app-command) and the
// release (mouseup) went two pages back.
const BACK = 3, FWD = 4;

// conduit: a stand-in for the desktop app's bridge, so the page takes the
// app-command path; its callback is window.__nav(dir).
async function setup(page: Page, conduit: boolean) {
  await login(page); // signed in as the web app (the desktop's sign-in form asks for a server too)
  if (conduit) {
    await page.addInitScript(() => {
      const w = window as any;
      w.conduit = { onNavigate: (cb: (d: string) => void) => { w.__nav = cb; return () => { w.__nav = null; }; } };
    });
  }
  await page.goto('/'); await waitForLibrary(page);
  // Five places: Home, then Search, Profile, History, Settings from the app menu.
  for (const name of ['Search', 'Profile', 'History', 'Settings']) {
    await page.locator('.appmenu-btn').click();
    await page.locator('.appmenu button', { hasText: name }).click();
  }
  await expect.poll(() => idx(page)).toBe(4);
}
// Where the app's history is (it mirrors its stack into the browser's).
const idx = (page: Page) => page.evaluate(() => (history.state as any)?.conduit ?? -1);
const mouse = (page: Page, type: string, button: number) => page.evaluate(([type, button]) => {
  window.dispatchEvent(new MouseEvent(type as string, { button: button as number, bubbles: true, cancelable: true }));
}, [type, button] as const);
const command = (page: Page, dir: 'back' | 'forward') => page.evaluate((dir) => (window as any).__nav(dir), dir);
// One physical press: what the platform delivers, in order, with the hold in between.
async function press(page: Page, button: number, { holdMs = 80, appCommand = false, repeat = 0 } = {}) {
  const dir = button === BACK ? 'back' : 'forward';
  await mouse(page, 'mousedown', button);
  if (appCommand) await command(page, dir); // Linux: the app-command comes with the press
  for (let i = 0; i < repeat; i++) { await page.waitForTimeout(holdMs / (repeat + 1)); await command(page, dir); } // key-repeat while held
  await page.waitForTimeout(repeat ? holdMs / (repeat + 1) : holdMs);
  await mouse(page, 'mouseup', button);
  await mouse(page, 'auxclick', button);
}
// Settled: no late second step.
const settled = async (page: Page) => { await page.waitForTimeout(900); return idx(page); };

test.describe('mouse back / forward buttons', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'chromium', 'a mouse: the desktop layout'); });

  test('desktop app: held back button (app-command at the press, release 800 ms later) goes back one page', async ({ page }) => {
    await setup(page, true);
    await press(page, BACK, { holdMs: 800, appCommand: true });
    expect(await settled(page)).toBe(3);
  });

  test('desktop app: held back button with the app-command repeating while held goes back one page', async ({ page }) => {
    await setup(page, true);
    await press(page, BACK, { holdMs: 1200, appCommand: true, repeat: 4 });
    expect(await settled(page)).toBe(3);
  });

  test('desktop app: a quick click with both events goes back one page', async ({ page }) => {
    await setup(page, true);
    await press(page, BACK, { holdMs: 60, appCommand: true });
    expect(await settled(page)).toBe(3);
  });

  test('desktop app: app-command after the release (Windows order) goes back one page', async ({ page }) => {
    await setup(page, true);
    await mouse(page, 'mousedown', BACK);
    await page.waitForTimeout(500);
    await mouse(page, 'mouseup', BACK);
    await mouse(page, 'auxclick', BACK);
    await command(page, 'back');
    expect(await settled(page)).toBe(3);
  });

  test('desktop app: app-command only (no DOM events), held with repeats, goes back one page', async ({ page }) => {
    await setup(page, true);
    for (let i = 0; i < 5; i++) { await command(page, 'back'); await page.waitForTimeout(100); }
    expect(await settled(page)).toBe(3);
  });

  test('browser: quick and held presses go back one page each', async ({ page }) => {
    await setup(page, false);
    await press(page, BACK, { holdMs: 60 });
    expect(await settled(page)).toBe(3);
    await press(page, BACK, { holdMs: 800 });
    expect(await settled(page)).toBe(2);
  });

  test('two separate presses go back two pages', async ({ page }) => {
    await setup(page, true);
    await press(page, BACK, { holdMs: 300, appCommand: true });
    expect(await settled(page)).toBe(3);
    await press(page, BACK, { holdMs: 300, appCommand: true });
    expect(await settled(page)).toBe(2);
  });

  test('forward button: held, quick and DOM-only presses go forward one page each', async ({ page }) => {
    await setup(page, true);
    for (let i = 0; i < 3; i++) { await press(page, BACK, { holdMs: 60, appCommand: true }); await settled(page); }
    expect(await idx(page)).toBe(1);
    await press(page, FWD, { holdMs: 800, appCommand: true });
    expect(await settled(page)).toBe(2);
    await press(page, FWD, { holdMs: 60, appCommand: true });
    expect(await settled(page)).toBe(3);
    await press(page, FWD, { holdMs: 800 });
    expect(await settled(page)).toBe(4);
  });
});
