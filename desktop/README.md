# Slopify desktop

The web app in a window, plus Chromecast / BluOS speakers driven from this
machine (for speakers away from home; at home the server drives them and
the desktop lists those too). Log in with the server address
(the release build fills in the repository's `SLOPIFY_URL` variable, if set).

```
npm run build -w web     # at the repo root
cd desktop && npm ci
npm start                # the shipped build
npm run dev              # against the Vite dev server on :5180
npm run dist:mac         # dmg + zip in release/
```

Releases are built by `.github/workflows/release.yml` on a `v*` tag.
Trace log while running with `SLOPIFY_TRACE=1`: `$TMPDIR/slopify-trace.log` (tokens masked).
