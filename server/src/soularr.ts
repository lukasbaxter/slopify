// What the Soulseek downloader (Soularr) is doing about each wanted album, so
// the Downloads page can say it instead of a bare "waiting in line": when it
// last searched for the album and what came back, albums it skips after a
// failed import, and when it checks the wanted list next.
//
// Soularr deletes its slskd searches and has no status API, but it logs every
// step (log_to_file = True). SOULARR_LOG points at that file (mounted read
// only); SOULARR_URL at its Web UI, whose failed-imports list Retry clears.
// Either is optional: without them the page says less, never anything wrong.
import fs from 'node:fs';

export type SearchOutcome = 'searching' | 'noresults' | 'nomatch' | 'refused' | 'matched';
export type AlbumSearch = { at: number; results: number | null; outcome: SearchOutcome };
export type SoularrStatus = {
  // When the last check of the wanted list started and ended, how long it
  // waits between checks, and so when the next one starts.
  lastStart: number | null; lastEnd: number | null; interval: number | null; next: number | null; checking: boolean;
  perCheck: number | null; // albums it searches per check (number_of_albums_to_grab)
  searches: Map<string, AlbumSearch>; // by searchKey(artist, title)
  skipped: Map<number, number>; // Lidarr album id -> last time it was skipped as a failed import
};

export const searchKey = (artist: string, title: string) =>
  `${artist} ${title}`.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const LINE = /^\[\w+\|\w+\|L\d+\] (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}): (.*)$/;
const ts = (s: string) => Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));

// One pass over the log text (oldest first).
export function parseSoularrLog(text: string, now = Date.now()): Omit<SoularrStatus, 'perCheck'> {
  const searches = new Map<string, AlbumSearch>();
  const skipped = new Map<number, number>();
  const runs: { start: number; end: number }[] = [];
  let cur: AlbumSearch | null = null;
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw.trimEnd()); if (!m) continue;
    const at = ts(m[1]); const msg = m[2]; if (!at) continue;
    if (msg.startsWith('Logging to file')) { runs.push({ start: at, end: at }); cur = null; continue; }
    if (runs.length) runs[runs.length - 1].end = at;
    let x: RegExpExecArray | null;
    if ((x = /^Searching for album: (.+)$/.exec(msg))) { cur = { at, results: null, outcome: 'searching' }; searches.set(searchKey(x[1], ''), cur); }
    else if (cur && (x = /^Search returned (\d+) results/.exec(msg))) { cur.results = Number(x[1]); cur.outcome = cur.results ? 'nomatch' : 'noresults'; }
    else if (cur && /^Failed to enqueue /.test(msg)) cur.outcome = 'refused';
    else if (cur && /^SUCCESSFUL MATCH/.test(msg)) cur.outcome = 'matched';
    else if ((x = /^Skipping failed import album: .* \(ID: (\d+)\)$/.exec(msg))) skipped.set(Number(x[1]), at);
  }
  // The wait between checks: the gap from one check's last line to the next
  // one's start (Soularr's SCRIPT_INTERVAL), the typical one of the last few.
  const gaps = runs.slice(1).map((r, i) => r.start - runs[i].end).filter((g) => g > 0).slice(-8).sort((a, b) => a - b);
  const interval = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const last = runs[runs.length - 1] ?? null;
  // Still checking: its last line is recent (it logs every few seconds while
  // it searches; a quiet minute means the check is over).
  const checking = !!last && now - last.end < 60000;
  const next = last && interval ? last.end + interval : null;
  return { lastStart: last?.start ?? null, lastEnd: last?.end ?? null, interval, next, checking, searches, skipped };
}

// The last ~2 MB of the log (it rotates at 1 MB: the current file and the one before).
function readLog(file: string): string {
  const parts: string[] = [];
  for (const f of [`${file}.1`, file]) {
    try {
      const fd = fs.openSync(f, 'r');
      try {
        const size = fs.fstatSync(fd).size; const len = Math.min(size, 1024 * 1024 + 4096);
        const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len);
        parts.push(buf.toString('utf8'));
      } finally { fs.closeSync(fd); }
    } catch { /* no such file (yet) */ }
  }
  return parts.join('\n');
}

export function soularrClient(opts: { log?: string; url?: string; fetcher?: typeof fetch }) {
  const f = opts.fetcher ?? fetch;
  const url = (opts.url || '').replace(/\/+$/, '');
  let cache: { at: number; v: SoularrStatus } | null = null;
  // number_of_albums_to_grab, from the config.ini beside the log.
  const perCheck = () => {
    if (!opts.log) return null;
    try {
      const ini = fs.readFileSync(opts.log.replace(/[^/]+$/, 'config.ini'), 'utf8');
      const m = /^\s*number_of_albums_to_grab\s*=\s*(\d+)/m.exec(ini);
      return m ? Number(m[1]) : null;
    } catch { return null; }
  };
  return {
    enabled: Boolean(opts.log),
    canClear: Boolean(url),
    status(now = Date.now()): SoularrStatus | null {
      if (!opts.log) return null;
      if (cache && now - cache.at < 5000) return cache.v;
      const text = readLog(opts.log);
      if (!text) return null;
      const v = { ...parseSoularrLog(text, now), perCheck: perCheck() };
      cache = { at: now, v };
      return v;
    },
    // Lidarr album ids Soularr skips because their import failed once.
    async failedImports(): Promise<Set<number>> {
      if (!url) return new Set();
      const r = await f(`${url}/api/failed-imports`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`Soularr failed-imports ${r.status}`);
      const j = await r.json() as any;
      const list: any[] = Array.isArray(j) ? j : Object.values(j || {});
      return new Set(list.map((x) => Number(x.album_id)).filter(Boolean));
    },
    async clearFailedImport(albumId: number) {
      if (!url) return false;
      const r = await f(`${url}/api/failed-imports/${albumId}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
      if (!r.ok && r.status !== 404) throw new Error(`Soularr failed-imports ${r.status}`);
      cache = null;
      return true;
    },
  };
}
export type Soularr = ReturnType<typeof soularrClient>;
