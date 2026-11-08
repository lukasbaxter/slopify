import { test, expect, type Browser, type Page } from '@playwright/test';
import { instrument, albumIds, play, closeAll } from './player-helpers';
import { login, waitForLibrary } from './helpers';

// Moving the music to another device of mine: the queue goes on there as it
// would have here. The receiving device dropped what the queue was played
// from (album normalization, more of an artist at its end) and, shuffled, the
// queue's real order, so shuffle off there kept the scramble.
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

test('a transfer carries the context and the unshuffled order to the other device', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  const a = await device(browser);
  const b = await device(browser);
  const { albumId, ids } = await albumIds(a, 'First Light');
  await a.evaluate(() => (window as any).__player.setShuffle('on'));
  try {
    await play(a, ids, albumId);
    const shuffled = await a.evaluate(() => (window as any).__player.queue.map((t: any) => t.Id));
    expect(shuffled).not.toEqual(ids);
    // A moves the music to B.
    const bId = await b.evaluate(() => (window as any).__player.relay.id);
    await expect.poll(() => a.evaluate((x) => (window as any).__player.relayDevices.some((d: any) => d.relayClientId === x), bId), { timeout: 15000 }).toBe(true);
    await a.evaluate((x) => { const p = (window as any).__player; return p.setDevice(p.relayDevices.find((d: any) => d.relayClientId === x)); }, bId);
    // B has it: its own queue, in A's shuffled order.
    await expect.poll(() => b.evaluate(() => { const p = (window as any).__player; return p.mirroring ? null : p.queue.map((t: any) => t.Id); }), { timeout: 15000 }).toEqual(shuffled);
    expect(await b.evaluate(() => (window as any).__player.contextId)).toBe(albumId);
    // Shuffle off on B: the album's own order, the song playing kept.
    await b.evaluate(() => (window as any).__player.setShuffle('off'));
    expect(await b.evaluate(() => (window as any).__player.queue.map((t: any) => t.Id))).toEqual(ids);
  } finally {
    await a.evaluate(() => (window as any).__player.setShuffle('off')).catch(() => {});
    await b.evaluate(() => { const p = (window as any).__player; p.setShuffle('off'); if (p.playing) p.toggle(); }).catch(() => {});
  }
});
