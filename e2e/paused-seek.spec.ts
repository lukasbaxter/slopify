import { test, expect } from '@playwright/test';
import { open, longest, play } from './player-helpers';

// A seek while paused keeps the session paused. The seek re-anchored the
// clock as playing (held until the speaker was heard there), so on a speaker
// the clock let go after the 15 s hold, the app showed playing and the
// playhead ran until the next readings said paused.
test.skip(({ isMobile }) => isMobile, 'one run is enough');

test('a seek on a paused speaker stays paused, clock and all', async ({ page }) => {
  test.setTimeout(120000);
  await open(page);
  const id = await longest(page, 'First Light');
  // A speaker this app drives itself (the desktop app's remote API), faked:
  // it plays, pauses and seeks as told and reports that back.
  await page.evaluate(() => {
    const w = window as any;
    const st = { playing: false, pos: 0, at: Date.now(), volume: 50, url: '' };
    const now = () => (st.playing ? st.pos + (Date.now() - st.at) / 1000 : st.pos);
    const set = (playing: boolean, pos = now()) => { st.pos = pos; st.at = Date.now(); st.playing = playing; };
    w.__fakeSpeaker = st;
    w.conduit = {
      remote: {
        play: async (_d: any, url: string, _m: any, seek: number) => { st.url = url; set(true, seek || 0); },
        pause: async () => set(false),
        resume: async () => set(true),
        stop: async () => set(false, 0),
        seek: async (_d: any, s: number) => set(st.playing, s),
        setVolume: async (_d: any, v: number) => { st.volume = v; },
        status: async () => ({ playing: st.playing, position: now(), duration: 8, volume: st.volume, state: st.playing ? 'PLAYING' : 'PAUSED', streamUrl: st.url }),
      },
    };
    w.__player.setVolume(79); // a render, so the player picks the API up
  });
  await page.waitForTimeout(300);
  try {
    // Picked first, then the song played on it.
    await page.evaluate(() => (window as any).__player.setDevice({ id: 'fake', kind: 'cast', name: 'Fake Speaker' }));
    await play(page, [id], null);
    await expect.poll(() => page.evaluate(() => (window as any).__fakeSpeaker.playing), { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(2500);
    await page.evaluate(() => (window as any).__player.toggle());
    await expect.poll(() => page.evaluate(() => (window as any).__player.playing), { timeout: 5000 }).toBe(false);
    await page.waitForTimeout(2500);
    await page.evaluate(() => (window as any).__player.seek(1));
    // 20 s of readings: still paused, the clock still at the seek.
    const seen = await page.evaluate(async () => {
      const p = () => (window as any).__player;
      const out = { playing: false, min: Infinity, max: -Infinity };
      for (let k = 0; k < 80; k++) {
        await new Promise((r) => setTimeout(r, 250));
        if (p().playing) out.playing = true;
        const pos = p().positionNow();
        out.min = Math.min(out.min, pos); out.max = Math.max(out.max, pos);
      }
      return out;
    });
    console.log('after a paused seek', JSON.stringify(seen));
    expect(seen.playing).toBe(false);
    expect(seen.min).toBeGreaterThan(0.8);
    expect(seen.max).toBeLessThan(1.3);
  } finally {
    await page.evaluate(() => (window as any).__player.setDevice({ id: 'local', kind: 'local', name: 'This Web Player' })).catch(() => {});
    await page.evaluate(() => { delete (window as any).conduit; }).catch(() => {});
  }
});
