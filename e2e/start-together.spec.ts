import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// One device makes the sound; every other screen (the time, the lyrics, the
// visualizer) follows it. A song picked on the laptop for a phone on a slow
// link used to run on the laptop from the click, ahead of the phone that was
// still loading (11-03). The clock waits for the sound now.

const elapsed = (p: Page) => p.locator('.player .t').first().textContent();

// Devices other tests left open (and their sessions) would be the account's
// active player here: gone before and after each test.
const closeAll = async ({ browser }: { browser: import('@playwright/test').Browser }) => { for (const c of browser.contexts()) await c.close().catch(() => {}); };
test.beforeEach(closeAll);
test.afterEach(closeAll);

test('a song picked on the laptop waits for the slow phone before its clock runs', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  const pctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  await pctx.addInitScript(() => { (window as any).slopifyShell = { deviceName: 'Slow Phone', deviceForm: 'phone', platform: 'android', version: 'test' }; });
  const phone = await pctx.newPage(); await login(phone); await waitForLibrary(phone);
  const desk = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await login(desk); await waitForLibrary(desk);
  // The phone plays.
  await phone.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await expect(phone.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  await phone.locator('.trackrow').nth(0).dblclick();
  await expect.poll(() => desk.locator('.player').textContent(), { timeout: 20000 }).toContain('Slow Phone');
  await expect.poll(() => phone.locator('.player button[title="Pause"]').count(), { timeout: 10000 }).toBeGreaterThan(0);
  // The phone's link slows down: its next song takes 4 s to arrive.
  let slow = false;
  await pctx.route('**/api/stream/**', async (route) => { if (slow) await new Promise((r) => setTimeout(r, 4000)); await route.continue(); });
  slow = true;
  // The laptop picks another song on that album for the phone.
  await desk.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
  await expect(desk.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  const pick = desk.locator('.trackrow').nth(3);
  const title = (await pick.locator('.title, .name').first().textContent({ timeout: 2000 }).catch(() => null)) || '';
  await pick.dblclick();
  if (title) await expect.poll(() => desk.locator('.player').textContent(), { timeout: 10000 }).toContain(title.trim());
  // Still loading on the phone: the laptop's clock has not moved.
  await desk.waitForTimeout(2500);
  expect(await desk.locator('.player').textContent()).toContain('Slow Phone');
  expect(await elapsed(desk)).toBe('0:00');
  // Heard on the phone: now it runs, on both.
  slow = false;
  await expect.poll(() => elapsed(desk), { timeout: 15000 }).not.toBe('0:00');
  await expect.poll(() => elapsed(phone), { timeout: 5000 }).not.toBe('0:00');
  await phone.locator('.player button[title="Pause"]').first().click();
  await pctx.close(); await desk.context().close();
});
