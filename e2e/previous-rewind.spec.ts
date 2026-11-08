import { test, expect } from '@playwright/test';
import { open, longest, play } from './player-helpers';

// "Previous" a few seconds into a song goes back to its 0:00. On Android (and
// any Chromium without native HLS) a transcode is one progressive stream that
// starts where it was last seeked to, so rewinding the element to its own 0
// only went back to that seek point.
test('previous after a seek on a progressive transcode goes back to 0:00, not to the seek point', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'its own Android context');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  await open(page);
  try {
    await page.evaluate(() => (window as any).__updatePrefs({ quality: 'high', crossfade: 0 }));
    expect(await page.evaluate(() => (window as any).__jf.streamMode())).toBe('chunked');
    await play(page, [await longest(page, 'First Light')], null); // an 8 s song
    await expect.poll(() => page.evaluate(() => (window as any).__player.debugElement()), { timeout: 15000 }).toBeGreaterThan(0.3);
    await page.evaluate(() => (window as any).__player.seek(4));
    // The new stream (from 4 s) is heard.
    await expect.poll(() => page.evaluate(() => (window as any).__player.debugElement()), { timeout: 15000 }).toBeGreaterThan(4.3);
    await page.evaluate(() => (window as any).__player.previous());
    await page.waitForTimeout(1500);
    // What the element is really playing (stream offset + its own clock).
    const at = await page.evaluate(() => (window as any).__player.debugElement());
    expect(at).toBeLessThan(2.5);
    expect(await page.evaluate(() => (window as any).__player.positionNow())).toBeLessThan(2.5);
  } finally {
    await page.evaluate(() => { const w = window as any; w.__player.playing && w.__player.toggle(); return w.__updatePrefs({ quality: 'original' }); }).catch(() => {});
    await ctx.close();
  }
});
