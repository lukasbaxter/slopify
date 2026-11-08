// Ingest bugs that came back before: each test here failed on the code
// before its fix.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { Ingest } from './ingest.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe('deleting an ingested folder from the SSD', () => {
  it('a Thumbs.db or SYNO index file next to the songs never keeps the folder there forever', async () => {
    const incoming = tmp('slopify-in-'), nas = tmp('slopify-nas-'), cache = tmp('slopify-c-');
    const album = path.join(incoming, 'The Fixture Band', 'First Light');
    fs.cpSync(path.join(MUSIC, 'The Fixture Band', 'First Light'), album, { recursive: true, preserveTimestamps: true });
    const old = new Date(Date.now() - 86400000);
    for (const junk of ['Thumbs.db', 'SYNOINDEX_MEDIA_INFO', '.DS_Store']) { fs.writeFileSync(path.join(album, junk), 'x'); fs.utimesSync(path.join(album, junk), old, old); }
    const db = openDb(tmp('slopify-idb-'));
    const ing = new Ingest(db, { incomingDir: incoming, nasDir: nas, musicDir: nas, cacheDir: cache, headSeconds: 1, settleMs: 0, deleteAfter: true, deleteSettleMs: 0 });
    const st = await ing.sweep();
    expect(st.errors).toEqual([]);
    expect(st.deletedDirs).toBe(1);
    expect(fs.existsSync(album)).toBe(false);
    // The junk was never copied to the NAS.
    const nasAlbum = path.join(nas, 'The Fixture Band', 'First Light');
    expect(fs.readdirSync(nasAlbum).filter((f) => /^(Thumbs\.db|SYNO|\.DS_Store)/.test(f))).toEqual([]);
  }, 120000);
});
