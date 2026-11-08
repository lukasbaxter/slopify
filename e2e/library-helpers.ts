import { type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { PW } from './helpers';

// Shared by the Your Library specs (mixes-home, playlist-covers,
// library-folders, window-widths): the API as the admin, the library rows,
// a mouse drag, and a library holding exactly the given playlists.
// SHOTS=<dir> saves screenshots of the states the specs pass through.
export const SHOTS = process.env.SHOTS || '';
export const shot = async (page: Page, name: string) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
export const api = async (page: Page) => {
  const tok = (await (await page.request.post('/api/auth/login', { data: { username: 'admin', password: PW } })).json()).token;
  const h = { authorization: `Bearer ${tok}` };
  return {
    get: async (u: string) => (await page.request.get(u, { headers: h })).json(),
    post: async (u: string, data: any) => (await page.request.post(u, { headers: h, data })).json(),
    put: async (u: string, data: any) => (await page.request.put(u, { headers: h, data })).json(),
    del: async (u: string) => (await page.request.delete(u, { headers: h })).json(),
    unlike: async (id: string) => page.request.delete(`/api/likes/${id}`, { headers: h }),
  };
};
export const uniq = () => Math.random().toString(36).slice(2, 6);
// Songs from four albums with different covers, one song each.
export const fourAlbums = async (a: Awaited<ReturnType<typeof api>>) => {
  const albums = (await a.get('/api/albums?limit=100')).items.filter((x: any) => x.cover);
  const seen = new Set<string>(); const out: any[] = [];
  for (const al of albums) { if (seen.has(al.cover)) continue; seen.add(al.cover); out.push((await a.get(`/api/albums/${al.id}`)).tracks); }
  return out.slice(0, 4);
};
export const rows = (page: Page) => page.locator('.sidebar .liblist [data-lib-row]');
export const names = async (page: Page) => (await rows(page).locator('.libitem-name').allTextContents());
export const row = (page: Page, name: string) => page.locator('.sidebar .liblist [data-lib-row]', { has: page.locator('.libitem-name', { hasText: new RegExp(`^${name}$`) }) });
export const centre = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2, h: b.height }; };
export async function mouseDrag(page: Page, from: Locator, to: { x: number; y: number }, opts: { hold?: (page: Page) => Promise<void>; midway?: (page: Page) => Promise<void> } = {}) {
  const a = await centre(from);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + ((to.x - a.x) * i) / steps, a.y + ((to.y - a.y) * i) / steps); await page.waitForTimeout(16);
    if (i === 10 && opts.midway) { await page.waitForTimeout(250); await opts.midway(page); }
  }
  await page.waitForTimeout(120);
  await opts.hold?.(page);
  await page.mouse.up();
  await page.waitForTimeout(350);
}
// The library holding exactly these playlists (a song each), in this order, nothing in folders.
export async function freshLibrary(page: Page, n: string[]) {
  const a = await api(page);
  const layout = await a.get('/api/library/layout');
  for (const f of layout.folders) await a.del(`/api/library/folders/${f.id}`);
  for (const p of (await a.get('/api/playlists')).items) await a.del(`/api/playlists/${p.id}`);
  for (const al of (await a.get('/api/likes/albums')).items) await a.unlike(al.id);
  const songs = n.length ? (await fourAlbums(a)).map((t: any) => t[0].id) : [];
  const ids: string[] = [];
  for (const [i, name] of n.entries()) ids.push((await a.post('/api/playlists', { name, trackIds: [songs[i % songs.length]] })).id);
  await a.put('/api/library/layout', { order: ids, folders: {} });
  return ids;
}
