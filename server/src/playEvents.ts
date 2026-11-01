// How each song went, from the session socket's now-playing reports: how long
// it actually played, where it was when it left, and how it left. Plays only
// records that a song got past 8 s; the brain (brain.ts) needs the skips too,
// and Spotify's own history counts them the same way (ms_played, reason_end).
//
// One tracker per server, keyed by connection: a song ends when the
// connection reports another one (ended if it got near its end, else
// skipped), reports nothing, or disconnects (stopped).

export type NowPlaying = { itemId?: string; playing?: boolean; position?: number; duration?: number; shuffle?: string } | null;
export type PlayEvent = {
  user_id: string; track_id: string; at: number; ms_played: number; end_ms: number;
  duration_ms: number | null; reason: 'ended' | 'skipped' | 'stopped'; shuffle: string | null; client: string;
};
type Cur = { uid: string; client: string; id: string; at: number; played: number; pos: number; dur: number | null; playing: boolean; seen: number; shuffle: string | null };

// Near the end counts as ended: the last seconds are often a fade, and a
// report lands every 2 s.
const ENDED_WITHIN_MS = 10000;
// A gap longer than this between reports is not counted as listening (a
// sleeping phone, a dropped socket).
const MAX_GAP_MS = 15000;

export function playTracker(save: (e: PlayEvent) => void, now: () => number = Date.now) {
  const cur = new Map<string, Cur>();
  const finish = (key: string, why: 'next' | 'stop') => {
    const c = cur.get(key); if (!c) return;
    cur.delete(key);
    const nearEnd = c.dur != null && c.dur > 0 && c.pos >= c.dur - ENDED_WITHIN_MS;
    save({
      user_id: c.uid, track_id: c.id, at: c.at, ms_played: Math.round(c.played), end_ms: Math.round(c.pos),
      duration_ms: c.dur, reason: nearEnd ? 'ended' : why === 'next' ? 'skipped' : 'stopped', shuffle: c.shuffle, client: c.client,
    });
  };
  return {
    report(key: string, uid: string, client: string, np: NowPlaying, durationOf?: (id: string) => number | null) {
      const t = now();
      const c = cur.get(key);
      if (c && c.playing) c.played += Math.min(MAX_GAP_MS, Math.max(0, t - c.seen));
      const id = np && typeof np.itemId === 'string' ? np.itemId : null;
      if (c && c.id !== id) finish(key, id ? 'next' : 'stop');
      if (!id) return;
      const pos = Math.max(0, Number(np!.position) || 0) * 1000;
      const dur = Number(np!.duration) > 0 ? Number(np!.duration) * 1000 : durationOf?.(id) ?? null;
      const same = cur.get(key);
      if (same) { same.pos = pos; same.playing = !!np!.playing; same.seen = t; same.dur = dur ?? same.dur; if (np!.shuffle) same.shuffle = String(np!.shuffle); return; }
      cur.set(key, { uid, client, id, at: t - pos, played: 0, pos, dur, playing: !!np!.playing, seen: t, shuffle: np!.shuffle ? String(np!.shuffle) : null });
    },
    // Connections playing right now (reported within the gap).
    live() { const t = now(); let n = 0; for (const c of cur.values()) if (c.playing && t - c.seen < MAX_GAP_MS) n++; return n; },
    close(key: string) {
      const c = cur.get(key);
      if (c && c.playing) c.played += Math.min(MAX_GAP_MS, Math.max(0, now() - c.seen));
      finish(key, 'stop');
    },
  };
}
