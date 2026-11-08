import { test, expect } from '@playwright/test';
import { open, longest, play } from './player-helpers';

// Moving the music from this device to a speaker, then pausing it there,
// pauses. Stopping the old device after the move forgot what the speaker had
// loaded, so the pause took the "nothing loaded here" path and started the
// song again on the speaker instead of pausing it.
test.skip(({ isMobile }) => isMobile, 'one run is enough');

test('pause right after handing the music to a speaker pauses it, never restarts the song', async ({ page }) => {
  test.setTimeout(120000);
  await open(page);
  const id = await longest(page, 'First Light');
  await page.evaluate(() => {
    const w = window as any;
    const st = { playing: false, pos: 0, at: Date.now(), volume: 50, url: '', plays: 0 };
    const now = () => (st.playing ? st.pos + (Date.now() - st.at) / 1000 : st.pos);
    const set = (playing: boolean, pos = now()) => { st.pos = pos; st.at = Date.now(); st.playing = playing; };
    w.__fakeSpeaker = st;
    w.conduit = {
      remote: {
        play: async (_d: any, url: string, _m: any, seek: number) => { st.plays++; st.url = url; set(true, seek || 0); },
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
    // Playing here first, then moved to the speaker.
    await play(page, [id], null);
    await expect.poll(() => page.evaluate(() => (window as any).__player.playing), { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(1500);
    await page.evaluate(() => (window as any).__player.setDevice({ id: 'fake', kind: 'cast', name: 'Fake Speaker' }));
    await expect.poll(() => page.evaluate(() => (window as any).__fakeSpeaker.playing), { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(2000);
    await page.evaluate(() => (window as any).__player.toggle());
    await page.waitForTimeout(2000);
    const st = await page.evaluate(() => ({ ...(window as any).__fakeSpeaker, shown: (window as any).__player.playing }));
    console.log('after pause', JSON.stringify(st));
    expect(st.plays).toBe(1);
    expect(st.playing).toBe(false);
    expect(st.shown).toBe(false);
  } finally {
    await page.evaluate(() => (window as any).__player.setDevice({ id: 'local', kind: 'local', name: 'This Web Player' })).catch(() => {});
    await page.evaluate(() => { delete (window as any).conduit; }).catch(() => {});
  }
});
