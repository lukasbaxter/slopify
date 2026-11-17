// The charts, the same for everyone (Billboard, Apple Music, Deezer, and
// TikTok's viral songs through the label playlists that track them), and
// playlists the server pulls in to grow the library. Every song on them the
// library lacks is put in line for Soulseek (songfetch.ts), charts first;
// a chart shows what the library has, in chart order.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import type { TaskDef } from './tasks.js';
import { matchTrack } from './explore.js';
import { wantSong } from './songfetch.js';
import { coverArt } from './homemixes.js';
import { renderTypeCover } from './typecover.js';
import { checkPhoto } from './madeforyou.js';

export type Entry = { artist: string; title: string; album?: string | null; durationS?: number | null };
type Fetch = typeof fetch;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const unescape = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&#0*39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();

// Billboard's chart pages: each row's title (h3#title-of-a-story) and artist.
export function parseBillboard(html: string): Entry[] {
  const out: Entry[] = [];
  for (const c of html.split('o-chart-results-list-row-container').slice(1)) {
    const t = /<h3[^>]*id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>/.exec(c);
    const a = /<span class="\s*c-label\s+a-no-trucate[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(c);
    if (t && a) out.push({ title: unescape(t[1]), artist: unescape(a[1]) });
  }
  return out;
}
async function billboard(f: Fetch, slug: string): Promise<Entry[]> {
  const r = await f(`https://www.billboard.com/charts/${slug}/`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Billboard ${slug}: HTTP ${r.status}`);
  return parseBillboard(await r.text());
}
async function apple(f: Fetch, country: string): Promise<Entry[]> {
  const r = await f(`https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/100/songs.json`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Apple Music ${country}: HTTP ${r.status}`);
  return ((await r.json() as any).feed?.results || []).map((x: any) => ({ title: String(x.name || ''), artist: String(x.artistName || '') }));
}
async function deezer(f: Fetch): Promise<Entry[]> {
  const r = await f('https://api.deezer.com/chart/0/tracks?limit=100', { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Deezer: HTTP ${r.status}`);
  return ((await r.json() as any).data || []).map((x: any) => ({ title: String(x.title || ''), artist: String(x.artist?.name || ''), album: x.album?.title ?? null, durationS: x.duration ?? null }));
}

// Spotify playlists (made by users and labels; Spotify's own are closed to
// outside apps) through an app's client credentials (SPOTIFY_CLIENT_ID/SECRET).
export function spotifyClient(id: string, secret: string, f: Fetch = fetch) {
  let tok: { v: string; until: number } | null = null;
  const token = async () => {
    if (tok && tok.until > Date.now() + 60000) return tok.v;
    const r = await f('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Spotify sign-in: HTTP ${r.status}`);
    const j = await r.json() as any; tok = { v: j.access_token, until: Date.now() + (j.expires_in || 3600) * 1000 };
    return tok.v;
  };
  return {
    enabled: !!(id && secret),
    async playlist(ref: string, max = 1000): Promise<{ name: string; entries: Entry[] }> {
      const pid = /([A-Za-z0-9]{22})/.exec(ref)?.[1];
      if (!pid) throw new Error(`not a Spotify playlist: ${ref}`);
      const H = { Authorization: `Bearer ${await token()}` };
      const meta = await f(`https://api.spotify.com/v1/playlists/${pid}?fields=name`, { headers: H, signal: AbortSignal.timeout(20000) });
      if (!meta.ok) throw new Error(`Spotify playlist ${pid}: HTTP ${meta.status}`);
      const name = String((await meta.json() as any).name || '');
      const entries: Entry[] = [];
      let url: string | null = `https://api.spotify.com/v1/playlists/${pid}/tracks?limit=100&fields=next,items(track(name,artists(name),album(name),duration_ms))`;
      while (url && entries.length < max) {
        const r: Response = await f(url, { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(20000) });
        if (r.status === 429) { await new Promise((res) => setTimeout(res, Math.min(60, Number(r.headers.get('retry-after')) || 5) * 1000)); continue; }
        if (!r.ok) throw new Error(`Spotify playlist ${pid}: HTTP ${r.status}`);
        const j = await r.json() as any;
        for (const it of j.items || []) {
          const t = it?.track; if (!t?.name || !t.artists?.length) continue;
          entries.push({ title: t.name, artist: t.artists.map((a: any) => a.name).join(', '), album: t.album?.name ?? null, durationS: t.duration_ms ? Math.round(t.duration_ms / 1000) : null });
        }
        url = j.next;
      }
      return { name, entries };
    },
  };
}
export type Spotify = ReturnType<typeof spotifyClient>;

export type ChartDef = { id: string; title: string; big: string; label: string; words: string[]; color: string; color2: string; get: (f: Fetch, sp: Spotify | null) => Promise<Entry[]> };
const merged = async (lists: Promise<Entry[]>[]) => {
  const seen = new Set<string>(); const out: Entry[] = [];
  for (const l of await Promise.all(lists)) for (const e of l) { const k = `${e.artist.toLowerCase()}|${e.title.toLowerCase()}`; if (!seen.has(k)) { seen.add(k); out.push(e); } }
  return out;
};
export const CHARTS: ChartDef[] = [
  { id: 'hot100', title: 'Billboard Hot 100', big: 'Hot 100', label: 'Billboard', words: ['billboard', 'hot 100', 'charts', 'top songs'], color: '#E8115B', color2: '#1E3264', get: (f) => billboard(f, 'hot-100') },
  { id: 'global200', title: 'Billboard Global 200', big: 'Global 200', label: 'Billboard', words: ['global', 'global 200', 'billboard', 'charts', 'world'], color: '#148A08', color2: '#0D3B66', get: (f) => billboard(f, 'billboard-global-200') },
  { id: 'tiktok', title: 'TikTok Viral', big: 'Viral', label: 'TikTok', words: ['tiktok', 'tik tok', 'viral', 'trending'], color: '#DC148C', color2: '#1B1F3B', get: async (_f, sp) => sp?.enabled ? merged([sp.playlist('0JFatPoPq82gNcPa4esOzj', 150).then((p) => p.entries), sp.playlist('57EG9lWmdn7HHofXuQVsow', 150).then((p) => p.entries)]) : [] },
  { id: 'canada', title: 'Canadian Hot 100', big: 'Canada', label: 'Billboard Hot 100', words: ['canada', 'canadian', 'charts'], color: '#E91429', color2: '#5A0F1A', get: (f) => billboard(f, 'canadian-hot-100') },
  { id: 'apple-us', title: 'Top 100: USA', big: 'Top 100', label: 'USA', words: ['top 100', 'usa', 'us', 'apple', 'charts'], color: '#509BF5', color2: '#1E3264', get: (f) => apple(f, 'us') },
  { id: 'global', title: 'Top 100: Global', big: 'Top 100', label: 'Global', words: ['top 100', 'global', 'world', 'charts'], color: '#27856A', color2: '#0D3B66', get: (f) => deezer(f) },
  { id: 'hotrap', title: 'Hot R&B/Hip-Hop Songs', big: 'Hip-Hop', label: 'Billboard Hot', words: ['hip hop charts', 'rap charts', 'r&b charts', 'charts'], color: '#1E3264', color2: '#000000', get: (f) => billboard(f, 'r-b-hip-hop-songs') },
  { id: 'hotrock', title: 'Hot Rock Songs', big: 'Rock', label: 'Billboard Hot', words: ['rock charts', 'charts'], color: '#B3261E', color2: '#2B0A08', get: (f) => billboard(f, 'hot-rock-songs') },
  { id: 'hotcountry', title: 'Hot Country Songs', big: 'Country', label: 'Billboard Hot', words: ['country charts', 'charts'], color: '#BA5D07', color2: '#3B1D02', get: (f) => billboard(f, 'country-songs') },
  { id: 'hotdance', title: 'Hot Dance/Electronic Songs', big: 'Dance', label: 'Billboard Hot', words: ['dance charts', 'edm charts', 'charts'], color: '#0D73EC', color2: '#1B1F3B', get: (f) => billboard(f, 'dance-electronic-songs') },
  { id: 'hotlatin', title: 'Hot Latin Songs', big: 'Latin', label: 'Billboard Hot', words: ['latin charts', 'charts'], color: '#608108', color2: '#1E2A03', get: (f) => billboard(f, 'latin-songs') },
];

type Saved = { id: string; title: string; fetched: number; entries: (Entry & { track?: string | null })[]; art: string | null };
export const savedCharts = (db: DB): Saved[] => (db.prepare('SELECT * FROM charts').all() as any[]).map((r) => ({ ...r, entries: JSON.parse(r.entries) }));

// A chart's songs in chart order, only the ones the library has (matched
// again for those not yet found: they may have just been fetched).
export function chartTracks(db: DB, id: string): string[] {
  const row = db.prepare('SELECT entries FROM charts WHERE id = ?').get(id) as { entries: string } | undefined;
  if (!row) return [];
  const entries = JSON.parse(row.entries) as (Entry & { track?: string | null })[];
  let changed = false;
  for (const e of entries) if (!e.track) { const t = matchTrack(db, { artist: e.artist, title: e.title, album: e.album ?? undefined }); if (t) { e.track = t; changed = true; } }
  if (changed) db.prepare('UPDATE charts SET entries = ? WHERE id = ?').run(JSON.stringify(entries), id);
  const ids = entries.map((e) => e.track).filter((t): t is string => !!t);
  return [...new Set(ids)];
}

async function chartCover(db: DB, cacheDir: string, def: ChartDef, entries: Entry[], log?: (m: string) => void) {
  // The artist at the top of the chart, cut out, when the library knows them.
  let cutout: Buffer | undefined, who: string | null = null;
  for (const e of entries.slice(0, 5)) {
    const a = db.prepare('SELECT id, image_hash FROM artists WHERE name = ? COLLATE NOCASE').get(e.artist.split(/,| & | feat\.? | featuring | x /i)[0].trim()) as { id: string; image_hash: string | null } | undefined;
    if (!a?.image_hash) continue;
    const c = await checkPhoto(db, cacheDir, a.image_hash, { log }).catch(() => null);
    if (c?.ok && c.cutout) { cutout = c.cutout; who = a.image_hash; break; }
  }
  return coverArt(db, cacheDir, ['chart', 1, def.id, def.big, def.label, def.color, def.color2, who], () => renderTypeCover({ title: def.big, label: def.label, style: 'chart', color: def.color, color2: def.color2, cutout }));
}

export async function refreshCharts(db: DB, cacheDir: string, o: { fetcher?: Fetch; spotify?: Spotify | null; log?: (m: string) => void; only?: string[] } = {}) {
  const f = o.fetcher ?? fetch;
  const log = o.log ?? (() => {});
  let queued = 0, charts = 0;
  for (const def of CHARTS) {
    if (o.only && !o.only.includes(def.id)) continue;
    try {
      const entries = await def.get(f, o.spotify ?? null);
      if (!entries.length) { log(`${def.title}: nothing came back${def.id === 'tiktok' && !o.spotify?.enabled ? ' (needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)' : ''}`); continue; }
      const withTracks = entries.map((e, i) => {
        const r = wantSong(db, { ...e, source: `chart:${def.id}`, priority: 1000 - i });
        if (r === 'queued') queued++;
        return { ...e, track: matchTrack(db, { artist: e.artist, title: e.title, album: e.album ?? undefined }) };
      });
      const art = await chartCover(db, cacheDir, def, entries, log).catch(() => null);
      db.prepare('INSERT OR REPLACE INTO charts (id, title, fetched, entries, art) VALUES (?, ?, ?, ?, ?)').run(def.id, def.title, Date.now(), JSON.stringify(withTracks), art);
      charts++;
    } catch (e: any) { log(`${def.title}: ${e.message}`); }
  }
  return { charts, queued };
}

// Pulled playlists: a list of (Spotify) playlists the server keeps fetching
// the songs of, a batch a run, to grow the library.
export async function pullPlaylists(db: DB, sp: Spotify, o: { perRun: number; log?: (m: string) => void; everyMs?: number }) {
  const log = o.log ?? (() => {});
  const due = db.prepare('SELECT ref FROM pulled_playlists WHERE pulled IS NULL OR pulled < ? ORDER BY pulled IS NOT NULL, pulled, added LIMIT ?').all(Date.now() - (o.everyMs ?? 7 * 86400e3), o.perRun) as { ref: string }[];
  let lists = 0, queued = 0;
  for (const { ref } of due) {
    try {
      const p = await sp.playlist(ref);
      let n = 0;
      for (const e of p.entries) if (wantSong(db, { ...e, source: `playlist:${ref}`, priority: 10 }) === 'queued') n++;
      db.prepare('UPDATE pulled_playlists SET name = ?, pulled = ?, songs = ?, error = NULL WHERE ref = ?').run(p.name, Date.now(), p.entries.length, ref);
      lists++; queued += n; log(`${p.name}: ${p.entries.length} songs, ${n} new in line`);
    } catch (e: any) {
      db.prepare('UPDATE pulled_playlists SET pulled = ?, error = ? WHERE ref = ?').run(Date.now(), String(e.message).slice(0, 200), ref);
      log(`${ref}: ${e.message}`);
    }
  }
  return { lists, queued };
}

export function chartTasks(db: DB, cacheDir: string, o: { spotify: Spotify | null }): TaskDef[] {
  return [{
    id: 'charts', name: 'Charts', schedule: { mode: 'daily', at: '06:15' },
    description: 'Fetch the charts (Billboard, Apple Music, Deezer, TikTok viral) and put every song the library lacks in line to fetch',
    run: async (ctx) => {
      const r = await refreshCharts(db, cacheDir, { spotify: o.spotify, log: ctx.log });
      return `${r.charts} charts, ${r.queued} new songs in line`;
    },
  }, {
    id: 'pull', name: 'Pull playlists', schedule: { mode: 'interval', hours: 6 },
    settings: [{ key: 'perRun', label: 'Playlists per run', type: 'number', min: 1, max: 200, default: 25 }],
    description: 'Put the songs of the pulled playlists in line to fetch, a batch a run, each again weekly',
    info: () => { const r = db.prepare('SELECT COUNT(*) n, SUM(pulled IS NOT NULL) done FROM pulled_playlists').get() as { n: number; done: number | null }; return `${r.done || 0} of ${r.n} playlists pulled`; },
    run: async (ctx) => {
      if (!o.spotify?.enabled) return 'needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET';
      const r = await pullPlaylists(db, o.spotify, { perRun: ctx.setting<number>('perRun'), log: ctx.log });
      return `${r.lists} playlists pulled, ${r.queued} new songs in line`;
    },
  }];
}

// Admin: the list of pulled playlists (Spotify links or ids).
export function registerCharts(app: FastifyInstance, db: DB) {
  const admin = { preHandler: (app as any).requireAdmin };
  app.get('/api/admin/pulled-playlists', admin, async () => ({
    items: db.prepare('SELECT ref, name, added, pulled, songs, error FROM pulled_playlists ORDER BY added').all(),
    songs: db.prepare('SELECT state, COUNT(*) n FROM song_wants GROUP BY state').all(),
  }));
  app.post('/api/admin/pulled-playlists', admin, async (req, reply) => {
    const b = z.object({ refs: z.array(z.string().max(200)).max(5000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'refs: a list of Spotify playlist links or ids' });
    let added = 0;
    for (const ref of b.data.refs) {
      const id = /([A-Za-z0-9]{22})/.exec(ref)?.[1]; if (!id) continue;
      added += db.prepare('INSERT OR IGNORE INTO pulled_playlists (ref, added) VALUES (?, ?)').run(id, Date.now()).changes;
    }
    return { added };
  });
  app.delete('/api/admin/pulled-playlists/:ref', admin, async (req) => ({ removed: db.prepare('DELETE FROM pulled_playlists WHERE ref = ?').run(String((req.params as any).ref)).changes }));
}
