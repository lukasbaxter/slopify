#!/usr/bin/env python3
"""Bring an account's Conduit/Jellyfin world into Slopify: playlists (from
Jellyfin, in order), likes with their original timestamps (from the relay's
likes table; Jellyfin favourites as the fallback), and listening history
(the relay's listens, matched to tracks).

Tracks are matched through Slopify's Jellyfin alias id (tracks.jf_id, the
Jellyfin id of the same path), so nothing depends on tags.

  import-conduit.py --slopify https://music.baxtergroup.io --slopify-db slopify.db \
      --relay-db relay.db --jellyfin http://192.168.1.85:2101 --jf-admin USER:PASS \
      --user lukasbaxter:PASS --jf-user lukasbaxter [--jf-user henryb]
"""
import argparse, json, sqlite3, sys, time, urllib.parse, urllib.request

def req(url, method='GET', body=None, headers=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    h = {'Content-Type': 'application/json', **(headers or {})}
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(r, timeout=timeout) as res:
                t = res.read()
                return json.loads(t) if t else None
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(5 + attempt * 5); continue
            raise RuntimeError(f'{method} {url}: {e.code} {e.read()[:200]}')
    raise RuntimeError(f'{method} {url}: rate limited')

ap = argparse.ArgumentParser()
ap.add_argument('--slopify', required=True); ap.add_argument('--slopify-db', required=True)
ap.add_argument('--relay-db'); ap.add_argument('--jellyfin', required=True); ap.add_argument('--jf-admin', required=True)
ap.add_argument('--user', required=True, help='slopify user:password')
ap.add_argument('--jf-user', action='append', required=True, help='Jellyfin account name(s) to import from')
ap.add_argument('--skip-plays', action='store_true')
a = ap.parse_args()

# --- Slopify: log in, what is already there ---
su, sp = a.user.split(':', 1)
S = req(f'{a.slopify}/api/auth/login', 'POST', {'username': su, 'password': sp})
SH = {'Authorization': f"Bearer {S['token']}"}
have_pl = {(p['name'], p['trackCount']) for p in req(f'{a.slopify}/api/playlists', headers=SH)['items']}
have_likes = req(f'{a.slopify}/api/likes', headers=SH)['at']
sdb = sqlite3.connect(a.slopify_db)
by_jf = {r[0]: r[1] for r in sdb.execute('SELECT jf_id, id FROM tracks WHERE jf_id IS NOT NULL')}
print(f'slopify: {su}, {len(by_jf)} tracks with a Jellyfin alias, {len(have_pl)} playlists, {len(have_likes)} likes already')

# --- Jellyfin: admin login, resolve the source accounts ---
ju, jp = a.jf_admin.split(':', 1)
JA = 'MediaBrowser Client="slopify-import", Device="import", DeviceId="slopify-import", Version="1"'
J = req(f'{a.jellyfin}/Users/AuthenticateByName', 'POST', {'Username': ju, 'Pw': jp}, {'Authorization': JA})
JH = {'Authorization': f'{JA}, Token="{J["AccessToken"]}"'}
users = {u['Name'].lower(): u['Id'] for u in req(f'{a.jellyfin}/Users', headers=JH)}
jf_ids = [users[n.lower()] for n in a.jf_user]

def jf_items(url):
    return req(url, headers=JH).get('Items', [])

stats = {'playlists': 0, 'rows': 0, 'missing': 0, 'likes': 0, 'plays': 0}
# --- playlists ---
for uid in jf_ids:
    q = urllib.parse.urlencode({'IncludeItemTypes': 'Playlist', 'Recursive': 'true', 'Fields': 'ChildCount,Path,DateCreated', 'userId': uid, 'SortBy': 'DateCreated'})
    for p in jf_items(f'{a.jellyfin}/Items?{q}'):
        if '/data/playlists/' not in (p.get('Path') or '') and not (p.get('ChildCount') or 0): continue
        if p['Name'] in ('Liked Songs',): continue  # the like store IS Liked Songs
        items = jf_items(f'{a.jellyfin}/Playlists/{p["Id"]}/Items?{urllib.parse.urlencode({"userId": uid, "Limit": "5000"})}')
        ids = []
        for it in items:
            tid = by_jf.get(it['Id'])
            if tid: ids.append(tid)
            else: stats['missing'] += 1
        if (p['Name'], len(ids)) in have_pl: print(f'  = {p["Name"]} ({len(ids)}) already'); continue
        if not ids: print(f'  - {p["Name"]}: nothing matched'); continue
        req(f'{a.slopify}/api/playlists', 'POST', {'name': p['Name'], 'trackIds': ids}, SH)
        stats['playlists'] += 1; stats['rows'] += len(ids)
        print(f'  + {p["Name"]} ({len(ids)} of {len(items)})')
        time.sleep(0.15)

# --- likes, with timestamps ---
likes = {}
if a.relay_db:
    rdb = sqlite3.connect(a.relay_db)
    for uid in jf_ids:
        for item_id, at in rdb.execute('SELECT item_id, at FROM likes WHERE uid = ?', (uid,)):
            tid = by_jf.get(item_id)
            if tid: likes[tid] = min(likes.get(tid, at), at)
            else: stats['missing'] += 1
for uid in jf_ids:  # favourites the relay never saw
    q = urllib.parse.urlencode({'IncludeItemTypes': 'Audio', 'Recursive': 'true', 'Filters': 'IsFavorite', 'Limit': '10000', 'userId': uid})
    for it in jf_items(f'{a.jellyfin}/Items?{q}'):
        tid = by_jf.get(it['Id'])
        if tid and tid not in likes: likes[tid] = int(time.time() * 1000)
n = 0
for tid, at in sorted(likes.items(), key=lambda x: x[1]):
    if tid in have_likes: continue
    req(f'{a.slopify}/api/likes/{tid}', 'PUT', {'at': at}, SH); stats['likes'] += 1; n += 1
    if n % 100 == 0: print(f'  likes {n}...'); time.sleep(1)
    else: time.sleep(0.11)  # under the 600/min limit

# --- history: the relay's listens (ListenBrainz + Conduit) as plays ---
if a.relay_db and not a.skip_plays:
    have = {r[0] for r in sdb.execute('SELECT at FROM plays WHERE user_id = ?', (S['user']['id'],))}
    rows = []
    for uid in jf_ids:
        for ts, key in rdb.execute('SELECT ts, key FROM listens WHERE uid = ? ORDER BY ts', (uid,)):
            m = rdb.execute('SELECT id FROM matches WHERE key = ?', (key,)).fetchone()
            tid = by_jf.get(m[0]) if m and m[0] else None
            at = ts * 1000 if ts < 10**11 else ts
            if tid and at not in have: rows.append((at, tid))
        for item_id, at in rdb.execute('SELECT item_id, at FROM plays WHERE uid = ?', (uid,)):
            tid = by_jf.get(item_id)
            if tid and at not in have: rows.append((at, tid))
    rows.sort()
    for i, (at, tid) in enumerate(rows):
        req(f'{a.slopify}/api/plays', 'POST', {'trackId': tid, 'at': at, 'client': 'import'}, SH); stats['plays'] += 1
        if i % 100 == 99: print(f'  plays {i + 1}/{len(rows)}...'); time.sleep(1)
        else: time.sleep(0.11)

print(json.dumps(stats))
