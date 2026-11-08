import { test, expect } from '@playwright/test';
import { open, longest, play } from './player-helpers';

// "Play" (the lock screen, another device's setPlaying) asks for a state, not
// a flip. When the system had just paused the element (followSystem moved the
// player's own idea of the state) and React had not re-rendered yet, the play
// went through a toggle working from the old render's "playing" and paused
// the music instead.
test.skip(({ isMobile }) => isMobile, 'one run is enough');

test('a play asked for right after a system pause plays, it does not pause', async ({ page }) => {
  await open(page);
  const id = await longest(page, 'First Light');
  await play(page, [id], null);
  try {
    await expect.poll(() => page.evaluate(() => (window as any).__player.debugElement()), { timeout: 15000 }).toBeGreaterThan(0.2);
    // Past the player's own window around a load (its pauses are ignored there).
    await page.waitForTimeout(3200);
    await page.evaluate(() => {
      const w = window as any;
      const el = w.__slopifyAudio().active as HTMLAudioElement;
      // The system's pause reaches the player, and in the same moment (no
      // render in between) a play is asked for.
      el.dispatchEvent(new Event('pause'));
      w.__player.executeCommand({ action: 'setPlaying', playing: true }, 'test');
    });
    await page.waitForTimeout(1200);
    const st = await page.evaluate(() => { const w = window as any; return { paused: w.__slopifyAudio().active.paused, playing: w.__player.playing }; });
    expect(st.paused).toBe(false);
    expect(st.playing).toBe(true);
  } finally {
    await page.evaluate(() => { const p = (window as any).__player; if (p.playing) p.toggle(); }).catch(() => {});
  }
});
