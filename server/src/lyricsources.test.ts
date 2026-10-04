import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGeniusHtml, cleanNetease, fromNetease, fromGenius, normTitle } from './lyricsources.js';

// Real responses, trimmed: Genius' page for Coldplay "Biutyful" and NetEase's
// search and lyric answers for it.
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const geniusPage = fs.readFileSync(path.join(FIX, 'genius-biutyful.html'), 'utf8');
const neSearch = JSON.parse(fs.readFileSync(path.join(FIX, 'netease-search.json'), 'utf8'));
const neLyric = JSON.parse(fs.readFileSync(path.join(FIX, 'netease-lyric.json'), 'utf8'));
const res = (body: any, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body, text: async () => String(body) });

describe('reading Genius', () => {
  it('takes the lyric lines and leaves out the contributors header and [section] labels', () => {
    const lines = parseGeniusHtml(geniusPage)!;
    expect(lines.length).toBeGreaterThan(10);
    const all = lines.map((l) => l.text).join('\n');
    expect(all).not.toMatch(/Contributor|Translations|^\[/m);
    expect(lines.every((l) => l.start === null)).toBe(true);
    expect(all.toLowerCase()).toContain('beautiful life');
  });
  it('a page without lyrics gives nothing', () => {
    expect(parseGeniusHtml('<html><body><p>Lyrics for this song have yet to be released</p></body></html>')).toBeNull();
  });
});

describe('reading NetEase', () => {
  it('drops the songwriter credit lines and keeps the timed lyrics', () => {
    const lines = cleanNetease(neLyric.lrc.lyric)!;
    expect(lines[0].text).toBe('All I know is I love you so');
    expect(lines.every((l) => !/作词|作曲/.test(l.text))).toBe(true);
    expect(lines.filter((l) => l.start != null).length).toBe(lines.length);
  });
  it('"pure music" means no lyrics', () => {
    expect(cleanNetease('[00:00.00] 纯音乐，请欣赏')).toBeNull();
  });
});

describe('finding a song', () => {
  const ne = async (url: string) => (url.includes('/search/') ? res(neSearch) : res(neLyric));
  it('NetEase: same title, same artist, length within 4 s', async () => {
    const c = await fromNetease({ artist: 'Coldplay', title: 'Biutyful', durationMs: 192000 }, ne as any);
    expect(c).toMatchObject({ source: 'netease', kind: 'synced', title: 'Biutyful' });
  });
  it('NetEase: a different length is a different recording', async () => {
    expect(await fromNetease({ artist: 'Coldplay', title: 'Biutyful', durationMs: 260000 }, ne as any)).toBeNull();
  });
  it('Genius: right song only; translations and other artists are skipped', async () => {
    const search = { response: { sections: [{ type: 'song', hits: [
      { result: { title: 'Biutyful (Traducción al Español)', artist_names: 'Genius Traducciones al Español', primary_artist: { name: 'Genius Traducciones al Español' }, url: 'x' } },
      { result: { title: 'Biutyful', artist_names: 'Coldplay', primary_artist: { name: 'Coldplay' }, url: 'https://genius.com/Coldplay-biutyful-lyrics' } },
    ] }] } };
    const f = async (url: string) => (url.includes('/api/search') ? res(search) : res(geniusPage));
    expect(await fromGenius({ artist: 'Coldplay', title: 'Biutyful' }, f as any)).toMatchObject({ source: 'genius', kind: 'plain', artist: 'Coldplay' });
    expect(await fromGenius({ artist: 'SOSA', title: 'Its Time to Move' }, f as any)).toBeNull();
  });
  it('a featured credit does not stop a match; a remix is not the plain song', () => {
    expect(normTitle('Stay (feat. Justin Bieber)')).toBe(normTitle('Stay'));
    expect(normTitle('Fireflies (Adam Young Remix)')).not.toBe(normTitle('Fireflies'));
  });
});
