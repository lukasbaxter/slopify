import { describe, expect, it } from 'vitest';
import { parseSoularrLog, searchKey } from './soularr.js';
import { withWatcher } from './downloads.js';

// Two checks, as Soularr logs them (lines trimmed to what the parser reads).
const LOG = `[INFO|soularr|L1083] 2026-10-07T12:41:02-0700: Logging to file: /data/soularr.log
[INFO|soularr|L456] 2026-10-07T12:41:02-0700: Searching for album: Olly Murs 24 HRS (acoustic)
[INFO|soularr|L1004] 2026-10-07T12:41:37-0700: Total Downloads added: 0
[INFO|soularr|L1083] 2026-10-07T12:46:37-0700: Logging to file: /data/soularr.log
[INFO|soularr|L415] 2026-10-07T12:46:37-0700: Skipping failed import album: Green Day - 1,000 Hours (ID: 68098)
[INFO|soularr|L456] 2026-10-07T12:46:37-0700: Searching for album: Olly Murs 24 HRS (acoustic)
[INFO|soularr|L380] 2026-10-07T12:46:40-0700: User: x Folder: y in cache. Using cached value
[INFO|soularr|L481] 2026-10-07T12:46:47-0700: Search returned 29 results
[INFO|soularr|L237] 2026-10-07T12:46:47-0700: Selected release for Olly Murs: Official, United Kingdom, Digital Media, Mediums: 1, Tracks: 5, ID: 182712
[INFO|soularr|L622] 2026-10-07T12:46:51-0700: Failed to enqueue Olly Murs - 24 HRS (acoustic)
[INFO|soularr|L456] 2026-10-07T12:46:53-0700: Searching for album: Fontaines D.C. Roman Holiday
[INFO|soularr|L481] 2026-10-07T12:46:58-0700: Search returned 100 results
[INFO|soularr|L129] 2026-10-07T12:47:07-0700: SUCCESSFUL MATCH
[INFO|soularr|L456] 2026-10-07T12:47:12-0700: Searching for album: Sacconi Quartet Schubert: Death and the Maiden / Beethoven: Quartet Op. 131
[INFO|soularr|L481] 2026-10-07T12:47:17-0700: Search returned 0 results
[INFO|soularr|L456] 2026-10-07T12:47:17-0700: Searching for album: Some Band Rare One
[INFO|soularr|L481] 2026-10-07T12:47:22-0700: Search returned 12 results
[INFO|soularr|L1449] 2026-10-07T12:47:34-0700: 2: releases failed to find a match in the search results and are still wanted.
07/10/2026 12:47:34 - Waiting for 300 seconds before checking again...
`;
const t = (s: string) => Date.parse(s);

describe('Soularr log', () => {
  it('reads each album search, the skipped failed imports and when the next check is', () => {
    const st = parseSoularrLog(LOG, t('2026-10-07T19:49:00Z'));
    expect(st.searches.get(searchKey('Olly Murs', '24 HRS (acoustic)'))).toEqual({ at: t('2026-10-07T19:46:37Z'), results: 29, outcome: 'refused' });
    expect(st.searches.get(searchKey('Fontaines D.C.', 'Roman Holiday'))?.outcome).toBe('matched');
    expect(st.searches.get(searchKey('Sacconi Quartet', 'Schubert: Death and the Maiden / Beethoven: Quartet Op. 131'))?.outcome).toBe('noresults');
    expect(st.searches.get(searchKey('Some Band', 'Rare One'))).toMatchObject({ results: 12, outcome: 'nomatch' });
    expect([...st.skipped.keys()]).toEqual([68098]);
    expect(st.lastStart).toBe(t('2026-10-07T19:46:37Z'));
    expect(st.interval).toBe(300000); // one check ended 12:41:37, the next began 12:46:37
    expect(st.checking).toBe(false);
    expect(st.next).toBe(t('2026-10-07T19:47:34Z') + st.interval!);
  });

  it('is checking while its lines are fresh', () => {
    expect(parseSoularrLog(LOG, t('2026-10-07T19:47:50Z')).checking).toBe(true);
  });

  it('an album it skips after a failed import shows as failed, with why; a waiting one carries its last search', () => {
    const st = parseSoularrLog(LOG, t('2026-10-07T19:49:00Z'));
    const base = { id: 68098, albumId: 'x', artist: 'Green Day', title: '1,000 Hours', state: 'queued', reason: null } as any;
    const gd = withWatcher(base, { ...st, perCheck: 10 }, true);
    expect(gd.state).toBe('failed'); expect(gd.failedImport).toBe(true); expect(gd.reason).toMatch(/could not import/);
    const om = withWatcher({ ...base, id: 1, artist: 'Olly Murs', title: '24 HRS (acoustic)' }, { ...st, perCheck: 10 }, false);
    expect(om.state).toBe('queued'); expect(om.search).toMatchObject({ results: 29, outcome: 'refused' });
  });
});
