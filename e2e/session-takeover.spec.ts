import { test, expect, type Browser, type Page } from '@playwright/test';
import { instrument, longest, play, closeAll } from './player-helpers';
import { login, waitForLibrary } from './helpers';

// Taking over a session another device plays ("play here" while mirroring):
// the song goes on here from where it is now, and a tap made meanwhile is not
// undone by the take-over finishing late.
test.beforeEach(closeAll);
test.afterEach(closeAll);

async function device(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await instrument(page);
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__updatePrefs), { timeout: 15000 }).toBe('function');
  return page;
}
// The other device plays a song; this one mirrors it.
async function playingElsewhere(browser: Browser) {
  const a = await device(browser);
  const b = await device(browser);
  const id = await longest(a, 'First Light');
  await play(a, [id], null);
  await expect.poll(() => b.evaluate((x) => { const p = (window as any).__player; return p.mirroring && p.nowPlayingId === x; }, id), { timeout: 15000 }).toBe(true);
  return { a, b, id };
}

test('taking over a mirrored session starts at its playhead now, not at the last report', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  const { a, b } = await playingElsewhere(browser);
  await expect.poll(() => a.evaluate(() => (window as any).__player.debugElement()), { timeout: 10000 }).toBeGreaterThan(1);
  // Wait for a report that is a while old (they come every 2 s), then take over.
  const expected = await b.evaluate(async () => {
    const w = window as any; const relay = w.__player.relay;
    const orig = relay.onRoster; relay.onRoster = (r: any) => { w.__roster = r; orig(r); };
    for (let k = 0; k < 200; k++) {
      await new Promise((r) => setTimeout(r, 20));
      const r = w.__roster; const np = r && (r.players || []).find((p: any) => p.id === r.activeClientId)?.nowPlaying;
      if (!np || !np.playing || np.held || typeof np.serverAt !== 'number') continue;
      const age = relay.serverNow() - np.serverAt;
      if (age < 1000 || age > 1700) continue;
      const want = relay.playheadOf(np);
      await w.__player.setDevice({ id: 'local', kind: 'local', name: 'This Web Player' });
      return want;
    }
    return null;
  });
  expect(expected).not.toBeNull();
  // Where this device's element started (its clock has only moved on since).
  const here = await b.evaluate(() => (window as any).__player.debugElement());
  console.log(`take over: session playhead ${expected.toFixed(2)}, started here at ${here.toFixed(2)}`);
  expect(here).toBeGreaterThan(expected - 0.3);
  await b.evaluate(() => { const p = (window as any).__player; if (p.playing) p.toggle(); });
});

test('a song tapped while a take-over is still loading is not replaced by it', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  const { b, id } = await playingElsewhere(browser);
  const other = await longest(b, 'Analytical');
  await b.evaluate(async (x) => {
    const w = window as any;
    const rows = await w.__jf.itemsByIds([x]);
    // "Play here", and at once a song picked here.
    void w.__player.setDevice({ id: 'local', kind: 'local', name: 'This Web Player' });
    void w.__player.playQueue(rows, 0, null);
  }, other);
  await b.waitForTimeout(3000);
  const st = await b.evaluate(() => { const w = window as any; return { current: w.__player.current?.Id, el: w.__slopifyAudio().active.dataset.track }; });
  expect(st.current).toBe(other);
  expect(st.el).toBe(other);
  expect(st.current).not.toBe(id);
  await b.evaluate(() => { const p = (window as any).__player; if (p.playing) p.toggle(); });
});
