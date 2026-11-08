import { test, expect } from '@playwright/test';
import { open, longest } from './player-helpers';

// The remembered session (the relay's 'session' message) carries a playhead
// the server has already brought up to date on its own clock. The app added
// the time since nowPlaying.at, a stamp from the sending device's clock, to
// its own: a device whose clock was a minute off restored the song a minute
// further on (here: at its end).
test.skip(({ isMobile }) => isMobile, 'one run is enough');

test('the remembered session opens at the server\'s playhead, whatever the sender\'s clock said', async ({ page }) => {
  await open(page);
  const id = await longest(page, 'First Light');
  const at = await page.evaluate((itemId) => {
    const w = window as any;
    const now = Date.now();
    w.__player.applySession({
      // As session.ts sends it: position is positionNow() on the server's clock.
      nowPlaying: { itemId, title: 'x', artist: 'y', position: 3, playing: true, duration: 8, at: now - 60000 },
      queue: [],
      at: now + 1000,
    });
    return w.__player.positionNow();
  }, id);
  expect(await page.evaluate(() => (window as any).__player.current?.Id)).toBe(id);
  expect(at).toBeCloseTo(3, 1);
  expect(await page.evaluate(() => (window as any).__player.playing)).toBe(false);
});
