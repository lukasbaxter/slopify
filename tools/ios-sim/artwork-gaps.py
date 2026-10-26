#!/usr/bin/env python3
"""How long Now Playing's artwork is empty after a track change.

  artwork-gaps.py <media.log> [--since HH:MM:SS] [--until HH:MM:SS]

Pairs every `Setting nowPlayingInfo artwork (id: (null))` (WebKit cleared the
artwork, usually on new MediaSession metadata) with the next artwork that has
bytes, and prints each gap and the artwork size (bytes) that arrived.
"""
import argparse, re
from datetime import datetime

ap = argparse.ArgumentParser(); ap.add_argument('log'); ap.add_argument('--since', default=''); ap.add_argument('--until', default='99')
a = ap.parse_args()
gaps, open_at = [], None
for l in open(a.log, errors='replace'):
    if 'Setting nowPlayingInfo artwork' not in l: continue
    hm = l[11:19]
    if hm < a.since or hm > a.until: continue
    t = datetime.strptime(l[:23], '%Y-%m-%d %H:%M:%S.%f')
    if '(id: (null))' in l:
        open_at = open_at or t
    elif open_at:
        m = re.search(r':(\d+) bytes', l)
        gaps.append((open_at, (t - open_at).total_seconds(), m.group(1) if m else '?')); open_at = None
for s, d, b in gaps:
    print(f'{s.strftime("%H:%M:%S.%f")[:12]} artwork empty for {d*1000:.0f} ms, then {b} bytes')
if gaps:
    ds = sorted(d for _, d, _ in gaps)
    print(f'{len(gaps)} gaps, median {ds[len(ds)//2]*1000:.0f} ms, max {ds[-1]*1000:.0f} ms')
if open_at:
    print(f'artwork still empty since {open_at.strftime("%H:%M:%S.%f")[:12]} at the end of the log')
