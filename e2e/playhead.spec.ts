import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// The seek bar glides (owner, 11-15: "smooth playhead instead of the choppy
// jumping"). It used to be set from React four times a second, its thumb in
// whole seconds; now it is moved on every frame while a song plays.
test('the seek bar moves on every frame while a song plays, and holds still when paused', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the desktop footer bar; the phone bar is the same hook');
  await login(page); await waitForLibrary(page);
  await page.goto('/?debug'); await waitForLibrary(page); // ?debug: the page hands the test its player
  await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  await page.locator('.trackrow').first().dblclick();
  await expect.poll(() => page.evaluate(() => (window as any).__player?.playing === true && ((window as any).__player.positionNow?.() ?? 0) > 0.3), { timeout: 20000 }).toBe(true);
  // 24 frames in a row: how many different places the bar was at.
  const sample = () => page.evaluate(() => new Promise<{ fills: number; thumbs: number }>((done) => {
    const el = document.querySelector('.player-seek input[type=range]') as HTMLInputElement;
    const fills = new Set<string>(); const thumbs = new Set<string>(); let n = 0;
    const frame = () => {
      fills.add(el.style.getPropertyValue('--pct')); thumbs.add(el.value);
      if (++n < 24) requestAnimationFrame(frame); else done({ fills: fills.size, thumbs: thumbs.size });
    };
    requestAnimationFrame(frame);
  }));
  const moving = await sample();
  expect(moving.fills).toBeGreaterThan(12);
  expect(moving.thumbs).toBeGreaterThan(12);
  await page.evaluate(() => (window as any).__player.toggle());
  await expect.poll(() => page.evaluate(() => (window as any).__player.playing), { timeout: 10000 }).toBe(false);
  await page.waitForTimeout(400);
  const still = await sample();
  expect(still.fills).toBe(1);
  expect(still.thumbs).toBe(1);
});
