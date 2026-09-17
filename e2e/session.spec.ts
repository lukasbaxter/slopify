import { test, expect } from '@playwright/test';

import { login, waitForLibrary } from './helpers';

test('two devices, one session: the second mirrors, controls, then takes over', async ({ browser, isMobile }) => {
  test.skip(isMobile, 'desktop project runs it');
  const a = await browser.newPage(); const b = await browser.newPage();
  await login(a); await waitForLibrary(a); await login(b);
  // A plays an album
  await a.locator('.shelf-row .card', { hasText: 'First Light' }).first().click();
  await a.locator('.hero-actions .primary').click();
  const pa = a.getByTestId('player'), pb = b.getByTestId('player');
  await expect(pa).toHaveAttribute('data-state', 'playing', { timeout: 15000 });
  const title = await pa.locator('.row-title').textContent();
  // B shows the same song, as a mirror, with a running clock, and does not play audio itself
  await expect(pb).toContainText(title!, { timeout: 10000 });
  await expect(pb).toHaveClass(/mirror/);
  await expect(pb.getByRole('status')).toContainText(/Playing on/);
  await expect.poll(async () => b.getByTestId('position').textContent(), { timeout: 10000 }).not.toBe('0:00');
  expect(await b.evaluate(() => (window as any).__slopify.audio.paused)).toBe(true);
  // B pauses: A actually pauses
  await b.getByTestId('toggle').click();
  await expect(pa).toHaveAttribute('data-state', 'paused', { timeout: 10000 });
  await expect(pb).toHaveAttribute('data-state', 'paused');
  // B skips: A moves to the next track
  await b.getByTestId('toggle').click();
  await expect(pa).toHaveAttribute('data-state', 'playing', { timeout: 10000 });
  await pb.getByRole('button', { name: 'Next' }).click();
  await expect(pa.locator('.row-title')).not.toHaveText(title!, { timeout: 10000 });
  await expect(pb.locator('.row-title')).toHaveText(await pa.locator('.row-title').textContent() as string, { timeout: 10000 });
  // B takes the session: B plays, A goes quiet and mirrors
  await pb.getByRole('button', { name: 'Connect to a device' }).click();
  await b.getByRole('menuitem', { name: 'This device' }).click();
  await expect(pb).toHaveAttribute('data-state', 'playing', { timeout: 15000 });
  await expect(pb).not.toHaveClass(/mirror/);
  await expect(pa).toHaveClass(/mirror/, { timeout: 10000 });
  expect(await a.evaluate(() => (window as any).__slopify.audio.paused)).toBe(true);
  expect(await b.evaluate(() => (window as any).__slopify.audio.paused)).toBe(false);
  await a.close(); await b.close();
});
