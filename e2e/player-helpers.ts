import { expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Shared by the player regression specs: every audio element the player
// makes (window.__els), the debug hooks (?debug=1), and a way to play ids.
export async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__ev = []; w.__els = [];
    const Orig = window.Audio;
    const Wrapped: any = function (...a: any[]) {
      const el = new (Orig as any)(...a);
      w.__els.push(el);
      for (const t of ['playing', 'ended', 'pause']) el.addEventListener(t, () => w.__ev.push({ t, at: performance.now(), track: el.dataset.track || null }));
      return el;
    };
    Wrapped.prototype = Orig.prototype;
    w.Audio = Wrapped;
  });
}
export async function open(page: Page) {
  await instrument(page);
  await login(page);
  await page.goto('/?debug=1'); await waitForLibrary(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__updatePrefs), { timeout: 15000 }).toBe('function');
}
export const token = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '');
export async function api(page: Page, path: string, method = 'GET', data?: unknown) {
  const r = await page.request.fetch(path, { method, data, headers: { Authorization: `Bearer ${await token(page)}` } });
  return r.json();
}
export async function albumIds(page: Page, name: string) {
  const a = (await api(page, '/api/albums?limit=100')).items.find((x: any) => x.name === name);
  const tracks = (await api(page, `/api/albums/${a.id}`)).tracks;
  return { albumId: a.id as string, ids: tracks.map((t: any) => t.id) as string[], ms: tracks.map((t: any) => t.durationMs) as number[] };
}
// The album's longest song (the fixture songs run 4 to 8 s).
export async function longest(page: Page, album: string) {
  const { ids, ms } = await albumIds(page, album);
  return ids[ms.indexOf(Math.max(...ms))];
}
// Play these ids here, in a context (the session taken first: an earlier
// test's page may still be the account's active player).
export async function play(page: Page, ids: string[], ctx: string | null) {
  await expect.poll(() => page.evaluate(() => { const p = (window as any).__player; if (p.mirroring) p.relay?.claim(); return p.mirroring; }), { timeout: 15000 }).toBe(false);
  await page.evaluate(async ({ ids, ctx }) => {
    const w = window as any;
    w.__ev.length = 0;
    const rows = await w.__jf.itemsByIds(ids);
    await w.__player.playQueue(rows, 0, ctx);
  }, { ids, ctx });
}
export const activeEl = (page: Page) => page.evaluate(() => { const a = (window as any).__slopifyAudio().active; return { track: a.dataset.track || null, paused: a.paused, src: a.getAttribute('src') || '' }; });
// Devices other tests left open would be the account's active player.
export const closeAll = async ({ browser }: { browser: import('@playwright/test').Browser }) => { for (const c of browser.contexts()) await c.close().catch(() => {}); };
