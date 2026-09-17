# Slopify desktop

The web app in a window, plus Chromecast / BluOS speakers driven from this
machine (for speakers away from home; at home the server drives them and
the desktop lists those too). Log in with the server address
(https://music.baxtergroup.io by default).

```
npm run build -w web     # at the repo root
cd desktop && npm ci
npm start                # the shipped build
npm run dev              # against the Vite dev server on :5180
npm run dist:mac         # dmg + zip in release/
```

Releases are built by `.github/workflows/release.yml` on a `v*` tag.
Trace log while running: `$TMPDIR/slopify-trace.log`.
