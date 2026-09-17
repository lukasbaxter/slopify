import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';
import { enrichPass, enrichStatus, type Fetcher } from './enrich.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-enrich-'));

// A fake LrcLib: exact get answers for "River" titles with synced lyrics,
// search finds a plain-only candidate within 3 s for "Signal" titles, marks
// "Static" titles instrumental, and knows nothing about the rest.
const calls: string[] = [];
const fetcher: Fetcher = async (url) => {
  calls.push(url);
  const u = new URL(url); const title = u.searchParams.get('track_name') || ''; const dur = Number(u.searchParams.get('duration') || 0);
  if (u.pathname.endsWith('/get')) {
    if (/river/i.test(title)) return { status: 200, json: async () => ({ id: 1, trackName: title, artistName: 'x', albumName: 'y', duration: dur, instrumental: false, plainLyrics: 'a\nb', syncedLyrics: '[00:00.50] a\n[00:02.00] b' }) };
    if (/static/i.test(title)) return { status: 200, json: async () => ({ id: 2, trackName: title, artistName: 'x', albumName: 'y', duration: dur, instrumental: true, plainLyrics: null, syncedLyrics: null }) };
    return { status: 404, json: async () => ({}) };
  }
  if (/signal/i.test(title)) return { status: 200, json: async () => [{ id: 3, trackName: title, artistName: 'x', albumName: 'y', duration: 999, instrumental: false, plainLyrics: 'far', syncedLyrics: null }, { id: 4, trackName: title, artistName: 'x', albumName: 'y', duration: 7, instrumental: false, plainLyrics: 'plain words', syncedLyrics: null }] };
  return { status: 200, json: async () => [] };
};

describe('enrichment: lyrics for every song', () => {
  const db = openDb(DATA);
  beforeAll(async () => { await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA }); }, 120000);
  it('resolves sidecar, synced, plain and instrumental; queues the rest with retries', async () => {
    const before = (db.prepare("SELECT COUNT(*) n FROM tracks t WHERE NOT EXISTS (SELECT 1 FROM lyrics l WHERE l.track_id = t.id)").get() as any).n;
    expect(before).toBe(8);
    const r = await enrichPass(db, { fetcher });
    expect(r.done + r.missing + r.instrumental).toBe(8);
    const st = enrichStatus(db);
    expect(st.lyrics.done + (st.lyrics.missing || 0)).toBe(30);
    expect(st.kinds.synced).toBeGreaterThanOrEqual(22);
    if (r.instrumental) expect(st.kinds.instrumental).toBe(r.instrumental);
    const missing = st.missing;
    for (const m of missing) { expect(m.lyrics_tries).toBe(1); expect(m.lyrics_next).toBeGreaterThan(Date.now() + 80000000); }
  });
  it('does not ask twice (answers are cached) and retries only when due', async () => {
    const n = calls.length;
    const r = await enrichPass(db, { fetcher });
    expect(r.done + r.missing + r.instrumental).toBe(0);
    expect(calls.length).toBe(n);
  });
  it('a sidecar never loses to a fetched answer', () => {
    const side = (db.prepare("SELECT COUNT(*) n FROM lyrics WHERE source = 'sidecar'").get() as any).n;
    expect(side).toBe(22);
  });
});
