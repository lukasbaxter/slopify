#!/usr/bin/env python3
"""Point a release Slopify APK at another server, without rebuilding it.

The release build bakes its server (EXPO_PUBLIC_SLOPIFY_URL, from the
repository's SLOPIFY_URL variable) into assets/index.android.bundle, which is
Hermes bytecode. Hermes keeps its strings in one table where neighbouring
strings may overlap (the URL's first and last characters can be the end of
the string before it and the start of the one after), so the URL is replaced
in place by one of exactly the same length that keeps its first four and its
last character: NEW + "/?lab=" + padding + LAST. The page origin the app
compares against is NEW's origin, so the query is harmless.

    patch-apk.py IN.apk OUT-unsigned.apk OLD_URL NEW_URL

OLD_URL is what the release was built with (`gh variable get SLOPIFY_URL`).
NEW_URL must be no longer than OLD_URL minus 7. Sign the result afterwards
(lab.sh does: zipalign + apksigner with the lab's own key).
"""
import shutil
import sys
import zipfile

src, dst, old, new = sys.argv[1:5]
oldb = old.encode()
if not (old.startswith('http') and new.startswith('http')):
    sys.exit('both URLs must start with http')
room = len(old) - len(new) - len('/?lab=') - 1
if room < 0:
    sys.exit(f'{new} is too long to fit in place of {old} ({len(old)} chars)')
repl = (new.rstrip('/') + '/?lab=' + 'x' * (room + (1 if new.endswith('/') else 0)) + old[-1]).encode()
assert len(repl) == len(oldb), (repl, oldb)

with zipfile.ZipFile(src) as zin:
    bundle = zin.read('assets/index.android.bundle')
    n = bundle.count(oldb)
    if n == 0:
        sys.exit(f'{old} not found in the bundle: was the release built with another SLOPIFY_URL?')
    patched = bundle.replace(oldb, repl)
    with zipfile.ZipFile(dst, 'w') as zout:
        for item in zin.infolist():
            if item.filename.startswith('META-INF/') and item.filename.rsplit('.', 1)[-1] in ('SF', 'RSA', 'EC', 'DSA', 'MF'):
                continue  # the old signature; the APK is re-signed
            data = patched if item.filename == 'assets/index.android.bundle' else zin.read(item.filename)
            zi = zipfile.ZipInfo(item.filename, item.date_time)
            zi.compress_type = item.compress_type
            zi.external_attr = item.external_attr
            zout.writestr(zi, data)
print(f'replaced {n} x {old} -> {repl.decode()}')
shutil.copystat(src, dst)
