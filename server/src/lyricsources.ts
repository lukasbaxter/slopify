// Where Sync Lyrics looks for a song's lyrics after LrcLib: NetEase Cloud
// Music (time-synced LRC, a huge catalogue well beyond Chinese music) and
// Genius (plain text, nearly every song with words). Matching here is only a
// first filter on title, artist and (NetEase) duration; the real check is
// lining the candidate up with the song's vocals, which a wrong song fails.
import type { LyricLine } from './lyrics.js';
import { parseLrc, isSynced } from './lyrics.js';

export type Candidate = { source: 'netease' | 'genius'; kind: 'synced' | 'plain'; lines: LyricLine[]; title: string; artist: string };
export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const defaultFetch: Fetch = (url, init) => fetch(url, { ...init, headers: { 'User-Agent': UA, ...init?.headers }, signal: AbortSignal.timeout(15000) }) as any;

// Titles compare without "(feat. X)" credits and punctuation; a remix or
// live version keeps its words, so it does not match the plain song.
export const normTitle = (t: string) => String(t || '').normalize('NFKC').toLowerCase()
  .replace(/\s*[([](?:feat|ft|with|prod)\.?\s[^)\]]*[)\]]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// A library title often carries more than the catalogues do: "Biutyful With
// Angel Moon", "Song - Remastered 2011", "Song (Radio Edit)". These are the
// forms worth searching for and matching on; the alignment that follows is
// what proves a match, so generous here costs nothing.
export function titleVariants(t: string): string[] {
  const v = new Set<string>([String(t || '').trim()]);
  const noBrackets = String(t || '').replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
  v.add(noBrackets);
  v.add(String(t || '').split(/\s+[-–—]\s+/)[0].trim());
  v.add(noBrackets.split(/\s+[-–—]\s+/)[0].replace(/\s+(?:feat\.?|ft\.?|featuring|with|x)\s+.*$/i, '').trim());
  return [...v].filter(Boolean);
}
const sameTitle = (theirs: string, ours: string) => {
  const mine = new Set(titleVariants(ours).map(normTitle));
  return titleVariants(theirs).some((x) => mine.has(normTitle(x)));
};

const normName = (t: string) => String(t || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const sameArtist = (theirs: string, ours: string) => { const a = normName(theirs), b = normName(ours); return Boolean(a && b) && (a.includes(b) || b.includes(a)); };

// --- NetEase ----------------------------------------------------------------

// Credit lines NetEase puts at the top of an LRC ("作词 : X", "Producer: Y").
const CREDIT = /^\s*(?:作词|作曲|编曲|制作人|混音|母带|和声|录音|监制|出品|吉他|贝斯|鼓|lyrics?|music|composer|producer|writer|arranger|mixed by|mastered by)s?\s*[:：]/i;

export function cleanNetease(lrc: string): LyricLine[] | null {
  if (!lrc || /纯音乐/.test(lrc)) return null; // "pure music": no lyrics
  const lines = parseLrc(lrc).filter((l) => l.text && !CREDIT.test(l.text));
  return lines.length >= 4 ? lines : null;
}

export async function fromNetease(q: { artist: string; title: string; durationMs: number }, f: Fetch = defaultFetch): Promise<Candidate | null> {
  const H = { headers: { Referer: 'https://music.163.com' } };
  const seen = new Set<number>();
  const hits: any[] = [];
  for (const title of titleVariants(q.title)) {
    const r = await f(`https://music.163.com/api/search/get?${new URLSearchParams({ s: `${q.artist} ${title}`, type: '1', limit: '10' })}`, H);
    if (!r.ok) throw new Error(`netease search ${r.status}`);
    for (const s of ((await r.json())?.result?.songs || []) as any[]) {
      if (seen.has(s.id) || !sameTitle(s.name, q.title) || !(s.artists || []).some((a: any) => sameArtist(a.name, q.artist)) || Math.abs((s.duration || 0) - q.durationMs) > 4000) continue;
      seen.add(s.id); hits.push(s);
    }
    if (hits.length) break;
  }
  for (const s of hits.slice(0, 3)) {
    const lr = await f(`https://music.163.com/api/song/lyric?id=${s.id}&lv=1&kv=1&tv=-1`, H);
    if (!lr.ok) continue;
    const lines = cleanNetease((await lr.json())?.lrc?.lyric || '');
    if (lines) return { source: 'netease', kind: isSynced(lines) ? 'synced' : 'plain', lines, title: s.name, artist: (s.artists || []).map((a: any) => a.name).join(', ') };
  }
  return null;
}

// --- Genius -----------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

// The inner HTML of every <div> whose opening tag matches `open`, nested divs
// included (Genius wraps the lyrics in containers holding further divs).
function divsMatching(html: string, open: RegExp): { start: number; end: number; inner: string }[] {
  const out: { start: number; end: number; inner: string }[] = [];
  const re = new RegExp(open.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const innerStart = m.index + m[0].length;
    const tag = /<div\b[^>]*>|<\/div>/gi;
    tag.lastIndex = innerStart;
    let depth = 1, t: RegExpExecArray | null, end = html.length;
    while ((t = tag.exec(html))) {
      depth += t[0][1] === '/' ? -1 : 1;
      if (depth === 0) { end = t.index; break; }
    }
    out.push({ start: m.index, end: end + 6, inner: html.slice(innerStart, end) });
    re.lastIndex = end;
  }
  return out;
}

export function parseGeniusHtml(html: string): LyricLine[] | null {
  const parts = divsMatching(html, /<div[^>]*data-lyrics-container="true"[^>]*>/);
  if (!parts.length) return null;
  const text = parts.map((p) => {
    let inner = p.inner;
    // Headers Genius puts inside the container ("3 Contributors", "Lyrics").
    for (const x of divsMatching(inner, /<div[^>]*data-exclude-from-selection="true"[^>]*>/).reverse()) inner = inner.slice(0, x.start) + inner.slice(x.end);
    return decode(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
  }).join('\n');
  const lines = text.split('\n').map((l) => l.trim())
    .filter((l) => l && !/^\[[^\]]*\]$/.test(l)) // [Verse 1], [Chorus: X]
    .map((t) => ({ start: null, text: t }));
  return lines.length >= 4 ? lines : null;
}

export async function fromGenius(q: { artist: string; title: string }, f: Fetch = defaultFetch): Promise<Candidate | null> {
  let hits: any[] = [];
  for (const title of titleVariants(q.title)) {
    const r = await f(`https://genius.com/api/search/multi?${new URLSearchParams({ q: `${q.artist} ${title}` })}`);
    if (!r.ok) throw new Error(`genius search ${r.status}`);
    const sections: any[] = (await r.json())?.response?.sections || [];
    hits = sections.filter((s) => s.type === 'song').flatMap((s) => s.hits || []).map((h) => h.result)
      .filter((s: any) => s && !/genius/i.test(s.primary_artist?.name || '') // translation and romanization pages
        && sameTitle(s.title, q.title) && sameArtist(s.artist_names || s.primary_artist?.name || '', q.artist));
    if (hits.length) break;
  }
  for (const s of hits.slice(0, 2)) {
    const page = await f(s.url);
    if (!page.ok) continue;
    const lines = parseGeniusHtml(await page.text());
    if (lines) return { source: 'genius', kind: 'plain', lines, title: s.title, artist: s.artist_names || s.primary_artist?.name };
  }
  return null;
}
