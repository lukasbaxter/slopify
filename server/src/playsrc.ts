// What a play was picked from, for Home's shortcuts: the album, playlist or
// artist the listener chose, and only while the song is really part of it.
// What plays by itself afterwards (autoplay past the end of an album, a mix,
// radio) has no source and never shows up there.
//   ctx:    the player's queue context (an album id, a playlist id,
//           'artist:<id>', or something else / nothing)
//   picked: the listener chose this one song by itself (from search, say):
//           that counts as its album (a single is its own album)
import type { DB } from './db.js';

export function playSrc(db: DB, uid: string, trackId: string, ctx: unknown, picked = false): string | null {
  const has = typeof ctx === 'string' && ctx.length > 0 && ctx.length <= 80;
  if (!has && !picked) return null; // nothing was picked: nothing to look up
  const t = db.prepare('SELECT album_id, artist_ids FROM tracks WHERE id = ?').get(trackId) as { album_id: string, artist_ids: string } | undefined;
  if (!t) return null;
  if (has) {
    const ctx_ = ctx as string;
    if (ctx_ === t.album_id) return `album:${ctx_}`;
    if (ctx_.startsWith('artist:')) {
      const id = ctx_.slice(7);
      let ids: unknown = []; try { ids = JSON.parse(t.artist_ids); } catch { /* not a list */ }
      const albumArtist = (db.prepare('SELECT artist_id FROM albums WHERE id = ?').get(t.album_id) as any)?.artist_id;
      return id && ((Array.isArray(ids) && ids.includes(id)) || albumArtist === id) ? `artist:${id}` : null;
    }
    const inPl = db.prepare('SELECT 1 FROM playlists p JOIN playlist_tracks pt ON pt.playlist_id = p.id WHERE p.id = ? AND p.user_id = ? AND pt.track_id = ? LIMIT 1').get(ctx_, uid, trackId);
    return inPl ? `playlist:${ctx_}` : null;
  }
  return picked && !ctx ? `album:${t.album_id}` : null;
}

// The latest of each thing picked, newest first: [{ kind, id, at }].
export function recentSrcs(db: DB, uid: string, limit = 24): { kind: 'album' | 'playlist' | 'artist', id: string, at: number }[] {
  const rows = db.prepare('SELECT src, MAX(at) AS last FROM plays WHERE user_id = ? AND src IS NOT NULL GROUP BY src ORDER BY last DESC LIMIT ?').all(uid, limit) as { src: string, last: number }[];
  return rows.map((r) => { const i = r.src.indexOf(':'); return { kind: r.src.slice(0, i) as any, id: r.src.slice(i + 1), at: r.last }; });
}
