// Go to radio: a radio playlist of 50 songs for one listener and one seed (an
// artist, a song, an album or one of their own playlists), Spotify-style.
// One per listener and seed, kept in `radios` and handed out again while it
// is less than a day old; older, or asked with ?refresh=1, it is made again,
// so going to the same radio twice never piles up copies.
// It is not one of the listener's playlists: Your Library does not list it
// and it cannot be edited. Add to playlist keeps its songs.
// The songs and their order: buildRadio / arrangeRadio (library.ts).
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { dislikedOf } from './brain.js';
import { buildRadio, mixArtists, radioAskFor, tracksByIds, type RadioAsk, type RadioKind, type RelatedOf } from './library.js';

export const RADIO_SIZE = 50;
export const RADIO_FRESH_MS = 24 * 3600_000;
const KEEP_MS = 30 * 86400_000; // radios not asked for in a month go

// What the radio is of. `artistId`: whose radio it reads as (an artist, a
// song's or an album's first artist); `albumId`: the cover of a song or album.
export type RadioSeed = { kind: RadioKind; id: string; name: string; artistId: string | null; albumId: string | null };

export function radioSeed(db: DB, id: string, uid: string): RadioSeed | null {
  if (id.startsWith('pl_')) {
    const p = db.prepare('SELECT id, name FROM playlists WHERE id = ? AND user_id = ?').get(id, uid) as { id: string; name: string } | undefined;
    return p ? { kind: 'playlist', id: p.id, name: p.name, artistId: null, albumId: null } : null;
  }
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const ar = db.prepare('SELECT id, name FROM artists WHERE id = ?').get(id) as { id: string; name: string } | undefined;
  if (ar) return { kind: 'artist', id, name: ar.name, artistId: id, albumId: null };
  const al = db.prepare('SELECT id, name, artist_id FROM albums WHERE id = ?').get(id) as { id: string; name: string; artist_id: string | null } | undefined;
  if (al) return { kind: 'album', id, name: al.name, artistId: al.artist_id ?? null, albumId: id };
  const t = db.prepare('SELECT id, title, artist_ids, album_id FROM tracks WHERE id = ?').get(id) as { id: string; title: string; artist_ids: string; album_id: string } | undefined;
  if (t) return { kind: 'track', id, name: t.title, artistId: (JSON.parse(t.artist_ids) as string[])[0] ?? null, albumId: t.album_id };
  return null;
}

export type Radio = { ids: string[]; from: 'brain' | 'own'; made: number };
const inflight = new Map<string, Promise<Radio | null>>();

// The listener's radio for this seed: the kept one while fresh, else a new one.
export async function radioFor(db: DB, seed: RadioSeed, uid: string, ask: RadioAsk,
  o: { refresh?: boolean; now?: number; related?: RelatedOf } = {}): Promise<Radio | null> {
  const now = o.now ?? Date.now();
  const kept = db.prepare('SELECT track_ids, source, made FROM radios WHERE user_id = ? AND seed_id = ?').get(uid, seed.id) as { track_ids: string; source: string; made: number } | undefined;
  const dis = new Set(dislikedOf(db, uid));
  const out = (r: Radio): Radio => ({ ...r, ids: r.ids.filter((id) => !dis.has(id)) });
  if (kept && !o.refresh && now - kept.made < RADIO_FRESH_MS) return out({ ids: JSON.parse(kept.track_ids), from: kept.source === 'brain' ? 'brain' : 'own', made: kept.made });
  const key = `${uid}|${seed.id}`;
  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      const built = await buildRadio(db, seed, RADIO_SIZE, ask, { uid, related: o.related });
      if (!built?.tracks.length) return null;
      const ids = built.tracks.map((t) => t.id);
      db.prepare(`INSERT INTO radios (user_id, seed_id, kind, track_ids, source, made) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, seed_id) DO UPDATE SET kind = excluded.kind, track_ids = excluded.track_ids, source = excluded.source, made = excluded.made`)
        .run(uid, seed.id, seed.kind, JSON.stringify(ids), built.from, now);
      db.prepare('DELETE FROM radios WHERE made < ?').run(now - KEEP_MS);
      return { ids, from: built.from, made: now };
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  const made = await job;
  return made ? out(made) : null;
}

export function registerRadio(app: FastifyInstance, db: DB) {
  const auth = { preHandler: (app as any).requireUser };
  // Go to radio: make (or reuse) the listener's radio of :id and answer it
  // whole, songs included. ?refresh=1 makes it again now.
  app.post('/api/radio/:id', auth, async (req, reply) => {
    const uid = (req as any).user.id as string;
    const seed = radioSeed(db, String((req.params as any).id || ''), uid);
    if (!seed) return reply.code(404).send({ error: 'no such item' });
    const q = req.query as any;
    const r = await radioFor(db, seed, uid, radioAskFor(app, db, uid), { refresh: q.refresh === '1' || q.refresh === 'true' });
    if (!r) return reply.code(404).send({ error: 'nothing to play' });
    app.log.info(`radio ${seed.kind} ${seed.id.slice(0, 6)} for ${uid.slice(0, 6)}: ${r.ids.length} songs (${r.from})`);
    return {
      id: `radio:${seed.id}`, seed, made: r.made, from: r.from,
      artists: mixArtists(db, r.ids, seed.kind === 'playlist' ? null : seed.artistId),
      items: tracksByIds(db, r.ids),
    };
  });
}
