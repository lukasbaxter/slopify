// Your Library's folders and the order people drag into (libraryLayout.ts),
// kept per account on the server.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';
import { MIGRATIONS, openDb } from './db.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-libfolders-'));
let app: Awaited<ReturnType<typeof buildServer>>; let tok = ''; let tok2 = ''; let db: any;
const send = (method: any, url: string, payload?: any, t = tok) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${t}` } });
const get = (url: string, t = tok) => send('GET', url, undefined, t);
let albums: { id: string; name: string; cover_hash: string }[] = [];

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${tok}` } });
  const code = (await send('POST', '/api/invites', {})).json().code;
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { invite: code, username: 'other', password: 'a good password' } });
  tok2 = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'other', password: 'a good password' } })).json().token;
  // Albums with covers that differ from each other (the mistagged song's album shares its folder's cover).
  const all = db.prepare("SELECT id, name, cover_hash FROM albums WHERE cover_hash IS NOT NULL ORDER BY name").all() as any[];
  const seen = new Set<string>();
  albums = all.filter((a) => !seen.has(a.cover_hash) && seen.add(a.cover_hash));
}, 120000);
afterAll(async () => { await app.close(); });

describe('library folders and order', () => {
  let pA = '', pB = '', pC = '';
  const layout = async (t = tok) => (await get('/api/library/layout', t)).json();
  beforeAll(async () => {
    pA = (await send('POST', '/api/playlists', { name: 'A' })).json().id;
    pB = (await send('POST', '/api/playlists', { name: 'B' })).json().id;
    pC = (await send('POST', '/api/playlists', { name: 'C' })).json().id;
    await send('PUT', `/api/likes/${albums[0].id}`);
  });

  it('keeps the order the person dragged into, for every device', async () => {
    const r = await send('PUT', '/api/library/layout', { order: [pC, albums[0].id, pA, pB], folders: {} });
    expect(r.statusCode).toBe(200);
    expect((await layout()).order).toEqual([pC, albums[0].id, pA, pB]);
  });

  it('a new folder goes first; renaming it keeps its place', async () => {
    const f = (await send('POST', '/api/library/folders', { name: 'Road' })).json();
    expect(f.id).toMatch(/^fd_/);
    let l = await layout();
    expect(l.order[0]).toBe(f.id);
    expect(l.folders).toEqual([{ id: f.id, name: 'Road', items: [] }]);
    expect((await send('PATCH', `/api/library/folders/${f.id}`, { name: 'Road trips' })).statusCode).toBe(200);
    l = await layout();
    expect(l.folders[0].name).toBe('Road trips');
    expect(l.order[0]).toBe(f.id);
    expect((await send('POST', '/api/library/folders', { name: '  ' })).statusCode).toBe(400);
  });

  it('things go into a folder and come back out of it in order', async () => {
    const f = (await layout()).folders[0].id;
    await send('PUT', '/api/library/layout', { order: [pC, f, pB], folders: { [f]: [albums[0].id, pA] } });
    let l = await layout();
    expect(l.order).toEqual([pC, f, pB]);
    expect(l.folders[0].items).toEqual([albums[0].id, pA]);
    // out again, to the top
    await send('PUT', '/api/library/layout', { order: [pA, pC, f, pB], folders: { [f]: [albums[0].id] } });
    l = await layout();
    expect(l.order).toEqual([pA, pC, f, pB]);
    expect(l.folders[0].items).toEqual([albums[0].id]);
  });

  it('one level only, each thing once, and a folder deleted meanwhile gives its things back', async () => {
    const f = (await layout()).folders[0].id;
    const g = (await send('POST', '/api/library/folders', { name: 'Other' })).json().id;
    await send('PUT', '/api/library/layout', { order: [pA, pA, f, pB], folders: { [f]: [g, pC, pA], fd_gone: [albums[0].id] } });
    const l = await layout();
    expect(l.folders.find((x: any) => x.id === f).items).toEqual([pC]); // pA kept its first place, g is no child
    expect(l.order).toEqual([g, pA, f, pB, albums[0].id]);
    await send('DELETE', `/api/library/folders/${g}`);
  });

  it('deleting a folder puts what it held back where it was, and deletes none of it', async () => {
    const f = (await layout()).folders[0].id;
    await send('PUT', '/api/library/layout', { order: [pB, f, albums[0].id], folders: { [f]: [pC, pA] } });
    const r = (await send('DELETE', `/api/library/folders/${f}`)).json();
    expect(r).toEqual({ ok: true, items: [pC, pA] });
    const l = await layout();
    expect(l.folders).toEqual([]);
    expect(l.order).toEqual([pB, pC, pA, albums[0].id]);
    const mine = (await get('/api/playlists')).json().items.map((p: any) => p.id);
    for (const id of [pA, pB, pC]) expect(mine).toContain(id);
    expect((await get('/api/likes/albums')).json().items.map((a: any) => a.id)).toContain(albums[0].id);
  });

  it('a folder is the account\'s own', async () => {
    const f = (await send('POST', '/api/library/folders', { name: 'Private' })).json().id;
    expect((await send('PATCH', `/api/library/folders/${f}`, { name: 'x' }, tok2)).statusCode).toBe(404);
    expect((await send('DELETE', `/api/library/folders/${f}`, undefined, tok2)).statusCode).toBe(404);
    expect((await layout(tok2)).folders).toEqual([]);
    await send('PUT', '/api/library/layout', { order: [], folders: { [f]: [pA] } }, tok2);
    expect((await layout()).folders.find((x: any) => x.id === f).items).toEqual([]);
    await send('DELETE', `/api/library/folders/${f}`);
  });

  it('removing something from the library drops its place, so saving it again puts it on top', async () => {
    await send('PUT', '/api/library/layout', { order: [pB, albums[0].id], folders: {} });
    await send('DELETE', `/api/likes/${albums[0].id}`);
    expect((await layout()).order).toEqual([pB]);
    await send('DELETE', `/api/playlists/${pB}`);
    expect((await layout()).order).toEqual([]);
  });

  it('refuses what is not a list of ids', async () => {
    expect((await send('PUT', '/api/library/layout', { order: 'x' })).statusCode).toBe(400);
    expect((await send('PUT', '/api/library/layout', { order: ['../etc'] })).statusCode).toBe(400);
  });
});

describe('the upgrade keeps the order people dragged into', () => {
  it('moves prefs.libraryOrder to the server\'s library order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-mig33-'));
    const raw = new Database(path.join(dir, 'slopify.db'));
    for (let i = 0; i < 32; i++) raw.exec(MIGRATIONS[i]);
    raw.pragma('user_version = 32');
    raw.prepare("INSERT INTO users (id, name, pass_hash, role, created) VALUES ('u1', 'u1', 'x', 'user', 1)").run();
    raw.prepare("INSERT INTO users (id, name, pass_hash, role, created) VALUES ('u2', 'u2', 'x', 'user', 1)").run();
    raw.prepare('INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?)').run('u1', JSON.stringify({ libraryOrder: ['pl_mine', 'b'.repeat(32), 'pl_faves'], theme: {} }), 1);
    raw.prepare('INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?)').run('u2', JSON.stringify({ theme: {} }), 1);
    raw.close();
    const db2 = openDb(dir);
    expect((db2.prepare('SELECT item_id FROM library_order WHERE user_id = ? ORDER BY pos').all('u1') as any[]).map((r) => r.item_id)).toEqual(['pl_mine', 'b'.repeat(32), 'pl_faves']);
    expect(db2.prepare('SELECT COUNT(*) n FROM library_order WHERE user_id = ?').get('u2')).toEqual({ n: 0 });
    db2.close();
  });
});
