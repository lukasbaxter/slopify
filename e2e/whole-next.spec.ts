import { test, expect } from '@playwright/test';
import { open, albumIds, longest, play } from './player-helpers';

// The whole-song downloads (trackCache.js): the song playing, then the next,
// held until the song playing has buffer in hand. Every re-run of the preload
// (the queue growing, its 2 s retry, the end of a fade) held them again, and
// the buffer gate, already open, never let them go: the next song's download
// did not start until the track changed.
test.skip(({ isMobile }) => isMobile, 'one run is enough');

test('the next song is downloaded whole even when the queue changes during the first download', async ({ page }) => {
  await open(page);
  try {
    await page.evaluate(() => (window as any).__updatePrefs({ quality: 'high', crossfade: 0 }));
    expect(await page.evaluate(() => (window as any).__jf.hasWhole())).toBe(true);
    const a = await longest(page, 'First Light');
    const { ids } = await albumIds(page, 'Second Wind');
    const [b, c, d] = ids;
    // The playing song's whole download is slow to answer.
    let started = 0; let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    await page.route(`**/api/stream/${a}/whole/**`, async (route) => { started += 1; await held; await route.continue(); });
    const wanted: string[] = [];
    page.on('request', (q) => { const m = /\/api\/stream\/([^/]+)\/whole\//.exec(q.url()); if (m) wanted.push(m[1]); });
    await play(page, [a, b, c], null);
    await page.evaluate(() => { (window as any).__slopifyAudio().active.playbackRate = 0.25; }); // outlasts the test
    // The gate opened: this song's download is under way.
    await expect.poll(() => started, { timeout: 20000 }).toBeGreaterThan(0);
    // The queue grows meanwhile (the preload runs again).
    await page.evaluate(async (x) => { const w = window as any; w.__player.addToQueue(await w.__jf.itemsByIds([x])); }, d);
    await page.waitForTimeout(2500);
    release();
    // Then the next song's download follows (the added one: "Add to queue"
    // goes right after the song playing), while the first is still playing.
    expect(await page.evaluate(() => (window as any).__player.queue[1]?.Id)).toBe(d);
    await expect.poll(() => wanted.includes(d), { timeout: 10000 }).toBe(true);
    expect(await page.evaluate(() => (window as any).__player.current?.Id)).toBe(a);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await page.evaluate(() => { const w = window as any; if (w.__player.playing) w.__player.toggle(); return w.__updatePrefs({ quality: 'original' }); }).catch(() => {});
  }
});
