import { test, expect } from '@playwright/test';
import { PW, waitForLibrary } from './helpers';
import { instrument, longest, play } from './player-helpers';

// The stall watchdog reloads a stuck song from the whole copy in memory, after
// 3 s, when that copy is there. Its listener effect is set up once per audio
// element, before sign-in, so it kept the signed-out client: it never saw the
// copy in memory, waited the network's 6-30 s and reloaded from the network.
test.skip(({ isMobile }) => isMobile, 'one run is enough');

test('signed in on the open page, a stuck song is reloaded from memory', async ({ page }) => {
  await instrument(page);
  // Signed in on this very page (no reload after the sign-in).
  const r = await page.request.post('/api/auth/login', { data: { username: 'admin', password: 'admin' } });
  if (r.ok()) { const tok = (await r.json()).token; await page.request.post('/api/auth/password', { headers: { authorization: `Bearer ${tok}` }, data: { password: PW } }); }
  await page.goto('/?debug=1');
  const inputs = page.locator('.login input');
  await expect(inputs).toHaveCount(2);
  await inputs.nth(0).fill('admin'); await inputs.nth(1).fill(PW);
  await page.locator('.login .primary').click();
  await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__updatePrefs), { timeout: 15000 }).toBe('function');
  try {
    await page.evaluate(() => (window as any).__updatePrefs({ quality: 'high', crossfade: 0 }));
    expect(await page.evaluate(() => (window as any).__jf.hasWhole())).toBe(true);
    const id = await longest(page, 'First Light');
    const whole: string[] = [];
    page.on('requestfinished', (q) => { if (q.url().includes(`/api/stream/${id}/whole/`)) whole.push(q.url()); });
    await play(page, [id], null);
    // Slowed down so the song outlasts the test.
    await page.evaluate(() => { (window as any).__slopifyAudio().active.playbackRate = 0.25; });
    await expect.poll(() => whole.length, { timeout: 20000 }).toBeGreaterThan(0);
    await page.waitForTimeout(500); // the copy is turned into an object URL
    // The element's clock stops moving (a decoder or connection that hung).
    await page.evaluate(() => {
      const el = (window as any).__slopifyAudio().active as HTMLAudioElement;
      const proto = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
      const frozen = proto.get!.call(el);
      Object.defineProperty(el, 'currentTime', { configurable: true, get: () => frozen, set: (v) => proto.set!.call(el, v) });
      (window as any).__stuckAt = Date.now();
    });
    await expect.poll(() => page.evaluate(() => ((window as any).__slopifyMediaLog || []).join('\n')), { timeout: 8000 }).toMatch(/watchdog: \w+ stuck at/);
    const { src, after } = await page.evaluate(() => ({ src: (window as any).__slopifyAudio().active.getAttribute('src') || '', after: Date.now() - (window as any).__stuckAt }));
    expect(src.startsWith('blob:')).toBe(true);
    // The watchdog ticks once a second: up to 1 s to see the clock stop, 1 s
    // to mark it, the 3 s memory limit, up to 1 s to the tick past it, so
    // about 6 s at worst. The network path (the bug) is 6 s + those ticks,
    // 7 s and up, and reloads from the network (the blob check above).
    expect(after).toBeLessThan(6500);
  } finally {
    await page.evaluate(() => { const w = window as any; const el = w.__slopifyAudio().active; delete el.currentTime; if (w.__player.playing) w.__player.toggle(); return w.__updatePrefs({ quality: 'original' }); }).catch(() => {});
  }
});
