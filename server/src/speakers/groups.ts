// Speaker groups belong to Slopify: a household setting saying which speakers
// play together. Picking any speaker of a group plays the whole group. A group
// is only played as one while music is on it: Slopify links the speakers with
// BluOS's own sync for as long as it plays there (so neighbouring rooms stay
// in time) and unlinks them when the music leaves.
//
// Only BluOS speakers can be grouped: independent Chromecasts cannot be kept
// in sync from outside (Google Home's own speaker groups show up as speakers).
import type { DB } from '../db.js';

const KEY = 'speaker_groups';

export type SpeakerGroups = {
  list(): string[][];
  groupOf(id: string): string[];
  join(leader: string, members: string[]): void;
  unjoin(id: string): void;
  clear(): void;
  onChange(cb: () => void): void;
};

export function speakerGroups(db: DB): SpeakerGroups {
  const listeners: (() => void)[] = [];
  const read = (): string[][] => {
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(KEY) as { v: string } | undefined;
    try {
      const v = row ? JSON.parse(row.v) : [];
      return Array.isArray(v) ? v.filter((g) => Array.isArray(g) && g.length > 1).map((g) => g.map(String)) : [];
    } catch { return []; }
  };
  const write = (groups: string[][]) => {
    const keep = groups.filter((g) => g.length > 1);
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(KEY, JSON.stringify(keep));
    for (const cb of listeners) { try { cb(); } catch { /* a listener's own problem */ } }
  };
  return {
    list: read,
    // The speaker first, then the rest of its group (alone: just itself).
    groupOf(id) {
      const g = read().find((x) => x.includes(id));
      return g ? [id, ...g.filter((x) => x !== id)] : [id];
    },
    // The members join the leader's group (as Home Assistant's join does);
    // each leaves any group it was in.
    join(leader, members) {
      const current = read().find((g) => g.includes(leader)) || [leader];
      const all = [...new Set([...current, ...members])];
      write([...read().map((g) => g.filter((x) => !all.includes(x))), all]);
    },
    unjoin(id) { write(read().map((g) => g.filter((x) => x !== id))); },
    clear() { write([]); },
    onChange(cb) { listeners.push(cb); },
  };
}
