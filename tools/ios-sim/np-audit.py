#!/usr/bin/env python3
"""Audit the captured media log: does the system Now Playing state follow the music?

  np-audit.py <media.log> --music ID[,ID] [--standin ID] [--since HH:MM:SS] [--until HH:MM:SS] [--app com.apple.webapp]

IDs are WebKit's per-element log identifiers (ios-sim.sh ids prints them for
Slopify's active, spare and stand-in elements). The music is "playing" while
any music element's MediaElementSession state is Playing; Now Playing is
mediaremoted's "PlaybackState changed" for the app. Reports every stretch
where Now Playing says Paused while the music plays (a wrong glyph on the lock
screen), split into blips (< 0.25 s, track changes) and flips (longer), with
the event that started each flip.
"""
import argparse, re, sys
from datetime import datetime

ap = argparse.ArgumentParser()
ap.add_argument('log'); ap.add_argument('--music', required=True); ap.add_argument('--standin', default='')
ap.add_argument('--since', default=''); ap.add_argument('--until', default='99'); ap.add_argument('--app', default='')
ap.add_argument('--blip', type=float, default=0.25)
a = ap.parse_args()
music = set(filter(None, a.music.split(','))); standin = a.standin

def ts(l):
    try: return datetime.strptime(l[:23], '%Y-%m-%d %H:%M:%S.%f')
    except ValueError: return None

ev = []
for l in open(a.log, errors='replace'):
    t = ts(l)
    if not t: continue
    hm = l[11:19]
    if hm < a.since or hm > a.until: continue
    m = re.search(r'MediaElementSession::setState\(([0-9A-F]+)\) (\w+)', l)
    if m:
        ev.append((t, 'el', m.group(1), m.group(2))); continue
    m = re.search(r'PlaybackState changed from (\w+) to (\w+) for (.*)', l)
    if m and (not a.app or a.app in m.group(3)):
        ev.append((t, 'np', None, m.group(2))); continue
    m = re.search(r'HTMLMediaElement::(pause|play)\(([0-9A-F]+)\)', l)
    if m:
        ev.append((t, 'call', m.group(2), m.group(1)))

state = {}; np = None; bad_since = None; cause = ''; out = []; last_call = ''
def music_playing(): return any(state.get(i) == 'Playing' for i in music)
def role(i): return 'stand-in' if i == standin else ('music' if i in music else i[:6])
for t, kind, el, val in ev:
    if kind == 'el': state[el] = val
    elif kind == 'np': np = val
    else: last_call = f'{val}({role(el)}) at {t.strftime("%H:%M:%S.%f")[:12]}'; continue
    bad = np == 'Paused' and music_playing()
    if bad and bad_since is None:
        bad_since = t; cause = last_call
    elif not bad and bad_since is not None:
        out.append((bad_since, (t - bad_since).total_seconds(), cause)); bad_since = None
if bad_since is not None:
    out.append((bad_since, float('nan'), cause + ' (still wrong at end of log)'))

blips = [o for o in out if o[1] < a.blip]
flips = [o for o in out if not o[1] < a.blip]
print(f'Now Playing Paused while music plays: {len(flips)} flips (>= {a.blip}s), {len(blips)} blips (< {a.blip}s)')
for s, d, c in flips:
    print(f'  FLIP {s.strftime("%H:%M:%S.%f")[:12]} for {d:.2f}s, after {c or "?"}')
if blips:
    print(f'  blips: ' + ', '.join(f'{s.strftime("%H:%M:%S")} {d*1000:.0f}ms' for s, d, c in blips))
sys.exit(1 if flips else 0)
