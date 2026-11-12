# Slopify server API contract (for the native iOS client)

Source of truth: `server/src/*.ts` (Fastify). Cross-checked against how the web client
(`web/src/api/*.js`, `web/src/player/usePlayer.js`, `web/src/App.jsx`) and the old
React Native shell (`mobile/App.js`, `mobile/servers.js`, `mobile/hmac.js`) call it.
Anything not pinned down is marked **UNSURE**.

Conventions used below:

- `?` after a field = optional / may be absent. `| null` = always present, may be null.
- All JSON keys are camelCase unless shown otherwise (a few upstream-shaped objects use
  snake_case, called out where they appear).
- "auth" = needs a signed-in user token. "admin" = needs a token of an `admin` user.
- Times are **Unix epoch milliseconds** unless stated. Durations over HTTP are **ms**
  (`durationMs`). Positions over the realtime socket are **seconds (float)**. See §12.

---

## 0. Contents

1. Transport, errors, rate limits
2. Ids
3. Auth, sessions, demo, password reset
4. Server identity and the home/main address flow (HMAC proof)
5. Core object shapes (Track, Album, Artist, Playlist)
6. Library / home / browse / search
7. Albums, artists, tracks, genres
8. Playlists, folders, Your Library layout
9. Likes and follows
10. Lyrics (+ synced format, lyric sync jobs)
11. Artwork
12. Streaming (file, HLS AAC ladder, ALAC HLS, MP3, whole file, warm)
13. Downloads / offline
14. Recommendations: mixes, radio, daily mixes, discover, radar, AI playlists
15. Play logging, history, top songs
16. Prefs / settings
17. Speakers, groups, casting (REST side)
18. Lidarr downloads, requests, Spotify import, jobs, reports
19. Admin endpoints (only what an admin user sees in Settings)
20. Realtime session protocol (`/api/ws`)
21. Gotchas checklist
22. Endpoint index

---

## 1. Transport, errors, rate limits

- Base URL: whatever the user typed (normalised, see §4). All API paths start with `/api/`.
  The web app is served from `/` on the same origin; ignore it.
- Request bodies: `Content-Type: application/json` unless stated (image uploads and the
  Spotify upload are raw bytes).
- No response compression is configured server side (a reverse proxy may add it).
- CORS is wide open (`origin: true`); irrelevant for a native client.
- `HEAD` works on every `GET` route (Fastify default).
- Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`.

### Error shape

Every JSON error is:

```json
{ "error": "human readable message" }
```

Login validation failures add `issues` (zod issue array). Status codes used:

| Code | Meaning in Slopify |
|---|---|
| 400 | Bad body / params (`error` says which) |
| 401 | `{"error":"unauthorized"}`: no/unknown token. Web client treats any 401 (except on login) as "signed out, go to sign-in". Login: `"wrong username or password"` |
| 403 | `"password change required"` (see §3.4), `"admin only"`, `"Not available in the demo"` |
| 404 | Not found. API 404s are `{"error":"..."}`; some binary routes (art, image, segments) answer 404 with an empty body |
| 409 | Conflict (name taken, upload already running, retry not allowed, start pairing first) |
| 413 | Too large (uploads > 12 MB, zip > 4 GB) |
| 416 | Range not satisfiable (stream) |
| 429 | Rate limited (`"too many attempts, try again in a minute"` for login) |
| 502 | Upstream (Lidarr, speaker) failed; `error` is the upstream message |
| 503 | Feature not configured (Lidarr, brain, speakers) or transcoder `"busy"` / `"transcode failed"` |

### Rate limits

- Global: `RATE_MAX` per client IP per minute (default **600**). Behind NAT the whole house
  shares one bucket, so do not poll aggressively.
- Exempt: all HLS routes (`/api/stream/:id/hls/...`, `/whole/`, `/warm`) and the playlist zip.
- `/api/image/:id`: own bucket of 6000/min.
- Login / register / admin password reset: `LOGIN_RATE_MAX` per IP per minute (default 10),
  plus 10 wrong passwords per account per minute.
- Demo guest creation: 20/hour/IP. Problem reports: 10/hour.

---

## 2. Ids

| Thing | Format | Notes |
|---|---|---|
| Track | 32 lowercase hex (`^[0-9a-f]{32}$`) | MD5 of the **decoded audio**. Retagging/moving keeps it; replacing the file with a different encode gives a **new id**. Many endpoints validate this regex. |
| Album | 32 lowercase hex | sha1(`album:` + normalised album artist + `\|` + album) truncated. Same shape as a track id. |
| Artist | 32 lowercase hex | sha1(`artist:` + normalised name) truncated. Same shape. |
| Playlist | `pl_` + 24 hex | |
| Library folder | `fd_` + 24 hex | |
| User | 32 hex | |
| Token | 43 chars base64url (32 random bytes) | Opaque. |
| Artwork hash | 40 lowercase hex (sha1 of source bytes) | Values of `cover`, `image`, `banner` fields. |
| Genre tile id | `genre:<name>` | Only in `/api/browse`. |
| Speaker id | `<kind>:<...>` e.g. `cast:...`, `bluos:192.168.1.20`, `airplay:...`, `upnp:...`, `bridge:...`, `roku:...`, `tv:<host>` | Opaque string, max 128. |
| Socket client id | `^[\w-]{4,64}$`, never starting with `server:` | Client-chosen, persisted per install (web uses `c_<random>`). The server's virtual speaker client is `server:<userId>`. |
| Lidarr download id | integer | `/api/downloads` `id`. |
| Job id | 16 hex | `/api/jobs/:id`. |

Album, artist and track ids are indistinguishable by shape. Use `GET /api/items/:id` to find
out what an id is (§7). Likes use one endpoint for all three (§9).

---

## 3. Auth

### 3.1 Token transport

- Preferred: `Authorization: Bearer <token>` on every request.
- `?token=<token>` query param is honoured **only on GET and HEAD**. This exists for media
  URLs (AVPlayer, image loaders, speakers). A token in the query of POST/PUT/PATCH/DELETE is
  ignored (request is treated as unsigned, 401).
- No cookies are used anywhere.
- Tokens **do not expire**. They die only on logout, revocation in Settings › Devices,
  password change (all other tokens of the account), admin password reset, or account delete.
  On the socket a revoked token closes the connection with code **4003**.
- Server logs mask `token`, `api_key`, `key` query values.

Web client also sends `X-Slopify-User: <userId>` (only for its service worker cache; the
server ignores it). Not needed natively.

### 3.2 Sign in

`POST /api/auth/login` (public)

Body:

| Field | Type | Req | Notes |
|---|---|---|---|
| `username` | string 1-64 | yes | Case-sensitive lookup on `users.name` (rate-limit key is lowercased) |
| `password` | string 1-256 | yes | |
| `device` | string ≤80 | no, default `"web"` | Shown in Settings › Devices. iOS: the device model, e.g. `"iPhone 16"` |
| `kind` | `"web"` \| `"desktop"` \| `"phone"` \| `"service"` | no, default `"web"` | Anything else is a 400. iOS: `"phone"` |

Extra fields (the web sends `deviceId`) are ignored.

200:

```json
{
  "token": "Qm9n...43chars",
  "user": { "id": "3f2a...32hex", "name": "lukas", "role": "admin", "mustChangePassword": false }
}
```

Errors: 400 (`issues` present), 401 `wrong username or password`, 429.

### 3.3 Me / sign out / devices

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/api/auth/me` | auth (allowed while password change is forced) | - | `User` = `{ id, name, role: "admin"\|"user", mustChangePassword: bool }` |
| POST | `/api/auth/logout` | auth | none | `{ "ok": true }`; deletes this token, closes its socket |
| GET | `/api/auth/devices` | auth | - | `{ devices: [{ id: string(8 chars, token prefix), device: string, kind: string, created: ms, lastSeen: ms\|null, current: bool }] }` newest-seen first. `kind` may also be `household` or `speaker` |
| DELETE | `/api/auth/devices/:id` | auth | - | `{ "ok": true }` (revokes every token of this account whose first 8 chars match) |
| POST | `/api/auth/password` | auth (allowed while forced) | `{ current?: string, password: string(8-256) }` | `{ "ok": true }`. `current` is required unless `mustChangePassword`. 400 `password must be at least 8 characters`, 401 `current password is wrong`. All **other** tokens of the account (except speaker tokens) are revoked; this one stays |
| POST | `/api/users/me/avatar` | auth | raw image bytes, `Content-Type: image/jpeg\|png\|webp\|gif\|application/octet-stream`, ≤12 MB | `{ "ok": true }`; stored as 512x512 JPEG. 400 `not an image`, 413 |
| GET | `/api/users/:id/avatar` | **public** | - | `image/jpeg`, `Cache-Control: private, no-cache`, `ETag`. 404 when none. Send `If-None-Match` for 304 |

### 3.4 Forced password change

A user with `mustChangePassword: true` (first admin with the default `admin` password, or after
an admin reset) gets **403 `{"error":"password change required"}`** on every endpoint except
`/api/auth/password`, `/api/auth/me`, `/api/auth/logout`. The socket refuses them too
(close 4003 `password change required`). Flow: login → see `mustChangePassword` → show a
"choose a new password" screen → `POST /api/auth/password { password }` (no `current`).

### 3.5 Register with an invite

There is no self sign-up. An admin makes an invite link; the code is the `invite` here.

`POST /api/auth/register` (public): `{ invite: string, username: /^[a-z0-9_.-]{2,32}$/i, password: string(8-256) }`

200: same as login but the token is registered with `device: "web", kind: "web"`:
`{ token, user: { id, name, role: "user", mustChangePassword: false } }`.
Errors: 400 (validation message or `invite is invalid or expired`), 409 `that name is taken`.

Invite links: the web builds them from `{ code }` (see §19). **UNSURE** of the exact web
link format (likely `<base>/?invite=<code>`); a native client only needs the code.

### 3.6 Password reset

No email flow. An admin resets another user's password (`POST /api/users/:id/password`, §19),
gets a temporary password (`xxxx-xxxx-xxxx`), passes it on; the user signs in with it and is
forced to choose a new one (§3.4).

### 3.7 Demo / guest mode

`POST /api/auth/demo` (public), body `{ device?: string }`.

- Non-demo server: **204 No Content** (empty body). Call it on the sign-in screen to decide
  whether to show the form at all.
- Demo server (`DEMO=1`): 200 `{ token, user, demo: true }`. The guest is a fresh account
  named `Guest <6 hex>`, **role `admin`**, cloned from the template account (likes, album
  likes, follows, plays, prefs, playlists). Guests idle for 24 h are deleted (their token
  then 401s).
- Guest writes allowed: logout, `POST /api/plays`, `POST /api/stream/warm`, `POST /api/reports`,
  `PATCH /api/prefs`, `PUT|DELETE /api/likes/:id`, `POST /api/playlists`,
  `PATCH|DELETE /api/playlists/:id`, `POST /api/playlists/:id/tracks|move`,
  `DELETE /api/playlists/:id/tracks/:pos`. Every other non-GET is 403
  `Not available in the demo`. `GET /api/users` returns only the guest itself.
- Detect a guest by `user.name` starting with `"Guest "` (no flag on `/api/auth/me`), or by
  remembering `demo: true` from the sign-in response.

### 3.8 Persisting the session client-side

The web keeps `{ token, userId, ... }` in localStorage key `slopify.session`. Natively:
store token + userId + base URL(s) in the Keychain. On launch, call `GET /api/auth/me`; 401
means sign in again. Also open the socket (§20); close code 4003 means the same.

### 3.9 Pre-sign-in endpoints

| Method | Path | Response |
|---|---|---|
| GET | `/api/healthz` (also `/healthz`) | `{ "ok": true }`. The "is a Slopify server here?" check |
| GET | `/api/i18n` | `{ language: string }` e.g. `"auto"`, `"de"`, `"pt-BR"`: server-wide UI language |

---

## 4. Server identity and the home / main address flow

The phone has two addresses for one server:

- **main**: what the user typed (usually the public https hostname).
- **home**: the server's LAN address (usually plain `http://192.168.x.y:8080`), used whenever
  reachable so audio streams over Wi-Fi without the internet round trip.

The token is the same on both (one database).

### 4.1 Normalising a typed address (`web/src/api/address.js`, same as `mobile/address.js`)

- Trim. If no scheme: bare IPv4, `*.local`, or a host without a dot → `http://`, else `https://`.
- Lowercase scheme+host, drop default port (80/443), drop trailing `/`, drop query/fragment.
- If the user typed no scheme, try both: the guess first, then the other scheme.
- Validate with `GET /api/healthz` → `{ ok: true }`.

### 4.2 `GET /api/server/addresses` (auth)

```json
{
  "key": "9c1e...64 hex",
  "lan": "http://192.168.1.85:8080",
  "public": ["https://music.example.com"]
}
```

| Field | Type | Meaning |
|---|---|---|
| `key` | 64 hex | Per-account secret = HMAC-SHA256(server secret, `shell:<userId>`). Used to verify the home address. Keep it in the Keychain. |
| `lan` | string \| null | Server's configured `PUBLIC_URL` (the LAN URL). Used as the auto "home" address. |
| `public` | string[] | Up to 5 https origins signed-in users reached this server through in the last 30 days, newest first. Use as a hint for "main" when the app was set up on the LAN. |

The RN shell refreshes this at most every 6 h (and on foreground). It adopts `lan` as home
when the user has not set one manually (`homeAuto`), home is not turned off, and `lan`'s
origin differs from main's.

### 4.3 `GET /api/server/proof?u=<userId>&n=<nonce>` (public, LAN only)

- `u`: `^[\w-]{1,64}$` (the signed-in user's id). `n`: `^[0-9a-f]{16,128}$` (lowercase hex).
  The shell uses 32 random hex chars.
- Answered **only if the request comes from a private IP** (RFC1918, 100.64/10 CGNAT,
  loopback, link-local, IPv6 ULA/link-local). Otherwise **404**. 400 on bad params.
  `Cache-Control: no-store`.
- 200 `{ "proof": "<64 hex>" }` where `proof = hex(HMAC-SHA256(key = hexDecode(key), message = ASCII(n)))`.

Client check (Swift / CryptoKit):

```swift
let key = SymmetricKey(data: Data(hex: addresses.key))
let mac = HMAC<SHA256>.authenticationCode(for: Data(nonce.utf8), using: key)
let ok = constantTimeEqual(hex(mac), response.proof)
```

**Never** send the token or open the session against the home address before the proof
passes: the same private IP on another network is someone else's machine.

### 4.4 Choosing the address (what `mobile/App.js` + `servers.js` do)

1. Have `home` and the stored `{key, userId}` for this `main`.
2. Skip home on cellular if home is LAN-only (private IPv4 except 100.x Tailscale, `.local`, one-word host).
3. Else call proof on home with a short timeout: 1500 ms if this network (`<type>:<subnet>/<bits>`)
   was a home network before, else 700 ms.
4. Proof OK → use home (remember the network). Else → main.
5. Re-evaluate on every network change, on foreground, and with backoff (5 s doubling to 60 s)
   while in an error state.
6. When the base changes, move the socket (close, reconnect to the new base; §20.8) and use the
   new base for new requests. A track already playing can keep its old URL until it ends
   (the shell only switched while nothing was playing or when the old address was lost).

### 4.5 `GET /api/server` (auth)

```json
{ "id": "a1b2...32hex", "name": "Slopify on debster", "version": "0.1.160", "source": "https://github.com/...", "license": "AGPL-3.0-or-later" }
```

`id` is stable per server (also advertised over mDNS), so an app can tell the same server
behind two addresses. `version` / `source` may be `null`.

### 4.6 mDNS discovery (optional)

The server advertises `_slopify._tcp.local` with TXT `id=<serverId>`, `name=<display name>`,
SRV port = HTTP port, host `slopify-<id8>.local`. Needs `NSBonjourServices` = `_slopify._tcp`
and local-network permission on iOS. Addresses are plain http.

---

## 5. Core object shapes

### 5.1 Track (`trackOut`)

Returned anywhere a song appears (album, playlist, search, likes, mixes...).

| Field | Type | Notes |
|---|---|---|
| `id` | string (32 hex) | |
| `title` | string | |
| `artist` | string | Display credit as tagged ("A feat. B") |
| `artists` | string[] | Split credits |
| `artistIds` | string[] | Parallel to `artists` (same length, same order) |
| `albumId` | string | |
| `album` | string | |
| `albumArtist` | string | |
| `trackNo` | int \| null | |
| `discNo` | int \| null | |
| `year` | int \| null | |
| `genres` | string[] | |
| `durationMs` | int | |
| `codec` | string \| null | Raw parser name, e.g. `"FLAC"`, `"MPEG 1 Layer 3"`, `"AAC"`, `"ALAC"`, `"PCM"` |
| `bitrate` | number \| null | bits/s |
| `cover` | string \| null | Album artwork hash (40 hex) |
| `format` | object \| null | `{ codec: "FLAC"\|"MP3"\|"WAV"\|"AIFF"\|"ALAC"\|"AAC"\|"Opus"\|"Ogg Vorbis"\|<other>, lossless: bool, bitrate: number\|null, sampleRate: number\|null, bitDepth: number\|null }` |
| `gain` | object | `{ track: number\|null, album: number\|null }` dB to apply for loudness normalisation (target LUFS, peak-limited, clamped). `null` = not measured yet: play as is |
| `identity` | object | `{ state: string, score: number }` metadata-match confidence (display only) |
| `addedAt` | ms | |

Some endpoints add: `plays` (int, `/api/home` topTracks).

```json
{
  "id": "0f6c1a5e9b2d4c3a8e7f6a5b4c3d2e1f",
  "title": "Paranoid Android",
  "artist": "Radiohead",
  "artists": ["Radiohead"],
  "artistIds": ["a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4"],
  "albumId": "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  "album": "OK Computer",
  "albumArtist": "Radiohead",
  "trackNo": 2, "discNo": 1, "year": 1997,
  "genres": ["Alternative Rock"],
  "durationMs": 383000,
  "codec": "FLAC", "bitrate": 1011000,
  "cover": "5f1d...40hex",
  "format": { "codec": "FLAC", "lossless": true, "bitrate": 1011000, "sampleRate": 44100, "bitDepth": 16 },
  "gain": { "track": -6.3, "album": -5.8 },
  "identity": { "state": "matched", "score": 0.97 },
  "addedAt": 1760000000000
}
```

### 5.2 Album (`albumOut`)

| Field | Type |
|---|---|
| `id` | string |
| `name` | string |
| `artist` | string (album artist credit) |
| `artistId` | string \| null |
| `year` | int \| null |
| `trackCount` | int |
| `durationMs` | int |
| `cover` | string \| null (art hash) |
| `addedAt` | ms |

Variants: `/api/home` album rows omit `durationMs` and `addedAt`. `/api/likes/albums` rows add
`likedAt`.

### 5.3 Artist (`artistOut`)

| Field | Type |
|---|---|
| `id` | string |
| `name` | string |
| `trackCount` | int |
| `albumCount` | int |
| `image` | string \| null (portrait art hash) |
| `banner` | string \| null (wide photo hash; fetch via `/api/image/:id?kind=banner`, not `/api/art`) |

### 5.4 Playlist (`plOut`)

| Field | Type | Notes |
|---|---|---|
| `id` | `pl_...` | |
| `name` | string | |
| `userId` | string | Owner. Only own playlists are ever visible: there is no sharing |
| `created` | ms | |
| `updated` | ms | Bumped on any edit |
| `trackCount` | int | |
| `cover` | string \| null | Hash of the uploaded cover, or of the auto 2x2 mosaic (4+ distinct album covers), or the first album cover. **Changes when songs change**: use it as a cache key |
| `aiPrompt` | string \| null | Prompt it was generated from |

---

## 6. Library, home, browse, search

### `GET /api/library` (auth)

```json
{ "version": "1762800000000", "tracks": 41234, "albums": 3120, "artists": 1890,
  "lastScan": { "started": 1762790000000, "finished": 1762790400000, "files": 41234, "added": 3, "changed": 0, "removed": 1 } }
```

`version` (string) changes whenever the library changes (scan). Use it to invalidate cached
album/artist lists. `lastScan` may be `null`.

### `GET /api/home` (auth)

```json
{
  "recentAlbums": [ { "id": "...", "name": "...", "artist": "...", "artistId": "...", "year": 1997, "trackCount": 12, "cover": "..." } ],
  "topTracks":    [ { ...Track, "plays": 14 } ],
  "newestAlbums": [ { same as recentAlbums } ]
}
```

- `recentAlbums`: up to 24, albums of this user's plays, most recent first.
- `topTracks`: up to 50, most played in the last 28 days.
- `newestAlbums`: 24 most recently added to the library (everyone's).
- The web's "Daily Mix" tiles are built client-side: top artists ranked from `topTracks`
  (`artistIds`), first 6, each played via `GET /api/tracks/<artistId>/mix` (§14).

### `GET /api/browse` (auth): genre tiles for the empty search page

```json
{ "tiles": [ { "id": "genre:Hip Hop", "name": "Hip Hop", "count": 5120, "coverId": "<albumId>|null", "cover": "<hash>|null", "covers": ["<albumId>", "..."], "kind": "genre" } ] }
```

Up to 24, biggest first, `Other` last. `count` = track count. `covers` = up to 4 album ids.

### `GET /api/search?q=&limit=` (auth)

- `q`: ≤200 chars. Empty → all three arrays empty.
- `limit`: default 20, max 50 (per kind).
- Tracks: FTS5 prefix match on each word (title weighted most), bm25 ranked.
- Albums/artists: every word must appear (substring, case-insensitive) in `name + artist` /
  `name`; exact name first, then bigger first.

```json
{ "tracks": [Track], "albums": [Album], "artists": [Artist] }
```

Playlists are not searched server-side; the web filters `GET /api/playlists` by name
(substring, lowercase) and shows them as a 4th group. The web picks a "top result": the first
artist whose name starts with the query, else album, else track, else first artist/album/track.

Scoped search (inside an album, playlist, artist, liked songs, genre) is done **client-side**
over that scope's tracks (every query word must be a substring of
`title + artists + album + albumArtist`, NFKC-lowercased).

### `GET /api/gsearch?q=` (auth): "Everywhere" (beyond the library, via Lidarr)

Returns `{ albums: [], artists: [] }` when Lidarr is not configured. Slow (up to ~30 s,
web uses a 35 s timeout).

```json
{
  "albums": [ { "album_id": "mbid", "artist": "Artist", "title": "Album", "rtype": "Album", "year": "2021", "date": "2021-05-14",
                "image": "https://...|null", "total_tracks": 11, "secondary": [],
                "inLibrary": "<albumId>|null", "artistId": "<artistId>|null", "requestStatus": "queued|downloading|failed|null" } ],
  "artists": [ { "name": "Artist", "id": "<artistId>|null" } ]
}
```

Note the **snake_case** upstream fields (`album_id`, `total_tracks`). `album_id` is the
MusicBrainz release-group id, used for `POST /api/requests`.

---

## 7. Albums, artists, tracks, genres

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/api/albums` | `offset` (≥0, default 0), `limit` (1-20000, default 200), `sort=added` (newest first; default is sort-name A-Z) | `{ items: [Album], total: int, offset: int, limit: int }` |
| GET | `/api/albums/:id` | - | `{ ...Album, tracks: [Track] }` ordered disc, track no, title. 404 `no such album` |
| GET | `/api/artists` | `offset`, `limit` as above (sorted by sort name, articles dropped) | `{ items: [Artist], total, offset, limit }` |
| GET | `/api/artists/:id` | - | `{ ...Artist, followed: bool, albums: [Album], appearsOn: [Album], tracks: [Track] }`. `albums` = own albums + collabs, newest first. `appearsOn` = others' albums they feature on. `tracks` = up to 200, most played server-wide first. 404 `no such artist` |
| GET | `/api/artists/:id/popular` | - | `{ ids: [trackId] }` the artist's songs most popular first (Deezer/world popularity, then local plays). Reorder `tracks` client-side by this. Slow-ish (web timeout 15 s) |
| GET | `/api/items/:id` | - | `{ kind: "album"\|"artist"\|"track", item: Album\|Artist\|Track }`. 404 `no such item`. Not for playlists (use `/api/playlists/:id`) |
| GET | `/api/tracks/:id` | - | `Track`. 404 `no such track` |
| GET | `/api/tracks?ids=a,b,c` | `ids` comma-separated, invalid ids dropped, max 2000 | `{ items: [Track] }` in request order, unknown ids skipped. **Send ≤100 ids per call** (URL length: nginx 8 KB / Node 16 KB header limits) |
| GET | `/api/genres/:name` | `name` URL-encoded, ≤40 chars | `{ name, trackCount, albumCount, topArtists: [{ id, name, plays, albums }], albums: [Album] (≤60, most played), recent: [Album] (≤18, newest) }` |
| GET | `/api/genres/:name/tracks` | - | `{ items: [Track] }` ≤100 most played (cached 60 s) |
| GET | `/api/genres/:name/mix` | - | `{ items: [Track] }` 50 shuffled, weighted to played/liked |
| GET | `/api/discography/:artistId` | - | see below. Needs Lidarr for upstream releases; library-only albums always listed |
| GET | `/api/similar/:artistId` | - | `{ artists: [{ id, name }] }` ≤12 related artists that are in the library (Deezer, cached 24 h) |

`GET /api/discography/:id`:

```json
{
  "artist": { "name": "Radiohead", "image": "https://...|null" },
  "releases": [
    { "album_id": "mbid|null", "title": "OK Computer", "rtype": "Album", "year": "1997", "date": "1997-05-21",
      "image": "https://...|null", "total_tracks": 12, "group": "?", "artists": ["?"],
      "inLibrary": "<albumId>|null", "localName": "OK Computer|null", "requestStatus": "queued|downloading|failed|null" }
  ]
}
```

`artist` is `null` when Lidarr is off or failed. Releases with `album_id: null` are library
albums the catalog did not list. **UNSURE**: whether `group`/`artists` are ever present
(declared optional in the type; Lidarr's own type has `secondary: string[]` instead).

---

## 8. Playlists, folders, Your Library layout

All playlist routes only see **the caller's own** playlists (404 otherwise).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/playlists` | - | `{ items: [Playlist] }` most recently updated first |
| POST | `/api/playlists` | `{ name: string(1-120), trackIds?: string[] (≤5000) }` | `{ id, name }`. Unknown/invalid track ids silently dropped |
| GET | `/api/playlists/:id` | - | `{ ...Playlist, tracks: [Track] }` in playlist order. Tracks no longer in the library are skipped (so indexes can differ from server positions, see gotcha) |
| PATCH | `/api/playlists/:id` | `{ name: string(1-120) }` | `{ ok: true }` (rename only) |
| DELETE | `/api/playlists/:id` | - | `{ ok: true }` |
| POST | `/api/playlists/:id/tracks` | `{ trackIds: string[] (1-2000) }` | `{ ok: true }` appended. 400 if total would exceed 10000 |
| DELETE | `/api/playlists/:id/tracks/:pos` | - | `{ ok: true }`. `pos` = 0-based position; positions renumber after. Delete several from **highest pos first** |
| POST | `/api/playlists/:id/move` | `{ from: int≥0, to: int≥0 }` | `{ ok: true }` (no-op if out of range) |
| POST | `/api/playlists/:id/cover` | raw image bytes (jpeg/png/webp/gif/octet-stream), ≤12 MB | `{ ok: true, cover: "<hash>" }`. 400 `not an image`, 413 |
| GET | `/api/playlists/:id/recommended` | query `limit` (default 10, max 30), `seed` (int, bump for "Refresh") | `{ items: [Track] }` |
| GET | `/api/playlists/:id/zip` | - | `application/zip` stream (see §13) |

The web uses the row index in `GET /api/playlists/:id` `tracks` as the entry id for remove/move.

### 8.1 Your Library layout (order + folders, synced across devices)

A per-account arrangement of library entries (playlist ids, saved album ids, followed artist
ids, folder ids). The layout does **not** define what is in the library: the client builds the
set from `GET /api/playlists` + `GET /api/likes/albums` + `GET /api/likes/artists`, then:
ids in `order` keep their place; saved things with no place go **at the top** (newest first);
ids in `order` that are no longer saved are skipped. One level of folders only.

`GET /api/library/layout` (auth):

```json
{
  "order": ["fd_9a...", "pl_1b...", "<albumId>", "<artistId>"],
  "folders": [ { "id": "fd_9a...", "name": "Workout", "cover": "<hash>", "items": ["pl_2c...", "<albumId>"] } ]
}
```

`cover` present only if a picture was uploaded. Folder picture URL: `/api/image/fd_...`.

| Method | Path | Body | Response |
|---|---|---|---|
| PUT | `/api/library/layout` | `{ order: string[], folders?: { "<folderId>": string[] } }` ids `^[\w-]{1,64}$`, ≤20000 total | The normalised layout (same shape as GET). Server fixes rather than refuses: duplicates keep first place, folders-in-folders lifted to top, unknown folders' items moved to top |
| POST | `/api/library/folders` | `{ name: string(1-120, trimmed) }` | `{ id, name }` new folder placed first |
| PATCH | `/api/library/folders/:id` | `{ name }` | `{ ok: true }` |
| POST | `/api/library/folders/:id/cover` | raw image bytes ≤12 MB | `{ ok: true, cover: "<hash>" }` |
| DELETE | `/api/library/folders/:id` | - | `{ ok: true, items: [ids] }` contents go back to the top level where the folder was |

Every layout change accepts header **`X-Slopify-Rev: <string ≤64>`** (client-chosen mark).
The server then sends every socket of the account `{ type: "prefs", prefs: { _libraryLayout: "<rev>" } }`
(§20). A client that sees a rev it did not write re-fetches `GET /api/library/layout`.
Without the header the rev is the server timestamp.

---

## 9. Likes and follows

One endpoint family for tracks (like), albums (save to library) and artists (follow). The
server decides by id lookup (album first, then artist, then track).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/likes` | query `full=1` optional | `{ at: { "<trackId>": likedAtMs, ... } }`; with `full=1` also `items: [Track]` newest liked first |
| PUT | `/api/likes/:id` | `{ at?: ms }` (default now) | track: `{ ok: true, at }`; album: `{ ok: true, at, album: true }`; artist: `{ ok: true, at, artist: true }`. 404 `no such item` if not a 32-hex id or unknown track |
| DELETE | `/api/likes/:id` | - | `{ ok: true }` / `{ ok: true, album: true }` / `{ ok: true, artist: true }` |
| GET | `/api/likes/albums` | - | `{ items: [Album + likedAt] }` newest saved first |
| GET | `/api/likes/artists` | - | `{ items: [{ id, name, image, trackCount, albumCount, followedAt }] }` newest first |

- Track like/unlike (over HTTP or the socket) is broadcast to all the account's sockets as
  `{ type: "like", itemId, liked, at }`. Album saves / artist follows are **not** broadcast.
- Likes can also be sent over the socket: `{ type: "like", itemId, liked }` (§20). The socket
  path does not validate that the id is a track; prefer HTTP.
- "Exclude from taste profile" (dislikes) is a pref, not a like: `prefs.dislikes = { trackId: ms }` (§16).
  Mix endpoints already drop disliked ids for daily mixes; the web also filters mix/reco
  results client-side against `dislikes`.
- `GET /api/artists/:id` carries `followed`.

---

## 10. Lyrics

### `GET /api/lyrics/:trackId` (auth)

```json
{ "kind": "synced", "source": "lrclib", "lines": [ { "start": 12340, "text": "First line" }, { "start": 15010, "text": "" } ] }
```

| Field | Type | Notes |
|---|---|---|
| `kind` | `"synced"` \| `"plain"` \| `"instrumental"` | `instrumental` has `lines: []` |
| `source` | string | e.g. `lrclib`, a local `.lrc`, the aligner. Display only |
| `lines[].start` | int ms \| null | null on plain lines. **Milliseconds** |
| `lines[].text` | string | may be empty (instrumental break) |

404 `{"error":"no lyrics"}` = none known. Timed lines are sorted by start; a mixed file keeps
untimed lines in place. Highlight the last line with `start <= playhead`.

### Lyric sync (forced alignment) jobs

| Method | Path | Response |
|---|---|---|
| POST | `/api/lyrics/:trackId/sync` | `LyricJob & { already: bool }`. 404 `no such song` |
| GET | `/api/lyrics/sync?ids=a,b` (≤100) | `{ jobs: [LyricJob] }` |
| GET | `/api/lyrics/sync?mine=1` | `{ jobs: [LyricJob] }` this account's unfinished jobs (resume after relaunch) |

`LyricJob = { trackId, title: string|null, state: "queued"|"running"|"done"|"failed" (UNSURE: other terminal values), step: string|null, ahead: int (queued jobs before it), result: string|null (human outcome), requested: ms, finished: ms|null }`

Web polls every 2 s while any job is queued/running; when one ends it re-fetches the lyrics.

---

## 11. Artwork

Two routes. Both are **public** (no token needed; adding `?token=` is harmless).

### 11.1 By id: `GET /api/image/:id`

Works for album id, track id (its album cover), artist id (portrait, falls back to their
biggest album's cover), playlist id (`pl_`: uploaded cover or 2x2 mosaic), folder id (`fd_`).

| Query | Notes |
|---|---|
| `size` (or `maxHeight`) | Wanted pixel size, default 320. Served from stored sizes **64, 160, 320, 640** (next size up). Above 640: 1280 or 1920, rendered on demand from the original (falls back to 640 when no original) |
| `kind=banner` | Artist wide banner instead of portrait. 404 if the artist has no photo |
| `w` | Banner only: `w ≤ 800` → 640 px wide, else 1280 |
| `v`, `c`, `n` | Ignored by the server; the web adds them as cache-busters (`c` = first 10 chars of the playlist `cover` hash, `v` = upload time) |

- Response: `image/webp` if the `Accept` header contains `image/webp`, else `image/jpeg`.
  iOS decodes WebP natively (iOS 14+); send `Accept: image/webp,image/jpeg`.
- Caching: non-playlist: `Cache-Control: private, max-age=86400`, `Vary: Accept`.
  Playlist: `private, no-cache` + `ETag` (send `If-None-Match` → 304).
- 404 empty body when there is no picture.

### 11.2 By hash: `GET /api/art/:hash/:size.(webp|jpg)`

- `hash` 40 hex (the `cover` / `image` fields), `size` digits snapped to 64/160/320/640.
- `Cache-Control: public, max-age=31536000, immutable`. Best for album covers in grids.
- Does not serve banners, mosaics (playlist mosaic files only exist once `/api/image/pl_...`
  has rendered them) or >640 sizes: use `/api/image/:id` for those.

`GET /api/art/sizes` → `{ sizes: [64, 160, 320, 640] }`.

User avatars: `/api/users/:id/avatar` (§3.3).

---

## 12. Streaming

All stream routes: auth via `Authorization: Bearer` **or** `?token=` (AVPlayer: use
`?token=`, because HLS sub-requests must carry it; the server writes the token into every
URI inside the playlists it returns when the master/index was requested with `?token=`).

### 12.1 Original file: `GET /api/stream/:id`

- The file as stored (FLAC, MP3, M4A/ALAC/AAC, OGG/Opus, WAV, AIFF, WMA, APE, WV).
  `Content-Type` from the extension (`audio/flac`, `audio/mpeg`, `audio/mp4`, `audio/aac`,
  `audio/ogg`, `audio/wav`, `audio/aiff`, `audio/x-ms-wma`, `audio/x-ape`, `audio/x-wavpack`,
  else `application/octet-stream`).
- `Accept-Ranges: bytes`. `Range: bytes=a-b`, `bytes=a-`, `bytes=-n` supported → 206 with
  `Content-Range`; 416 when out of range. No range → 200 whole file with `Content-Length`.
- `?chunk=1`: an open-ended range (`bytes=a-`) is capped to 2 MiB (`chunk=<n>` caps to n bytes,
  16 KiB-8 MiB). Used by Chromium to avoid HTTP/2 window stalls. Not needed for AVPlayer.
- `Cache-Control: private, max-age=3600`.
- 404 `no such track`.

**Do not use this for FLAC on iOS**: AVFoundation probes a FLAC without a seek table with ~25
range requests before playing (2.7 s on home Wi-Fi, 20-30 s on bad Wi-Fi). Use ALAC HLS for
lossless on iPhone (that is what the web does on phones).

### 12.2 HLS (what the iPhone should use)

Master: `GET /api/stream/:id/hls/master.m3u8?max=<profile>&norm=<track|album>&token=<t>`

| Param | Values | Default |
|---|---|---|
| `max` | `aac-96`, `aac-160`, `aac-320`, `alac` | `aac-320` |
| `norm` | `track`, `album` (omit = no gain baked in) | none. Ignored for `alac` |

Profiles:

| Profile | Codec | Container | Bitrate (declared BANDWIDTH) |
|---|---|---|---|
| `aac-96` | AAC-LC stereo | MPEG-TS `.ts` | 96k (125000) |
| `aac-160` | AAC-LC stereo | MPEG-TS `.ts` | 160k (200000) |
| `aac-320` | AAC-LC stereo | MPEG-TS `.ts` | 320k (400000) |
| `alac` | Apple Lossless | fMP4 (`init.mp4` + `.m4s`), HLS v7 | (1500000) |

Master for an AAC max lists every rung up to `max`, **lowest first** (iOS starts on the first
variant, climbs with bandwidth). All rungs are cut on the same frame boundaries, so switches
are seamless. `alac` is a one-rung master on its own. Example (`max=aac-320`, gain -5.2 dB,
token `T`):

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=125000,CODECS="mp4a.40.2"
aac-96g-5.2/index.m3u8?token=T&abr=1
#EXT-X-STREAM-INF:BANDWIDTH=200000,CODECS="mp4a.40.2"
aac-160g-5.2/index.m3u8?token=T&abr=1
#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="mp4a.40.2"
aac-320g-5.2/index.m3u8?token=T&abr=1
```

`alac` master:

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=1500000,CODECS="alac"
alac/index.m3u8?token=T&abr=1
```

Variant names: `<profile>` or `<profile>g<gain>` where gain is dB with one decimal, `.0`
dropped (`aac-160g-5.2`, `aac-320g3`). URIs are relative to `/api/stream/:id/hls/`.

Variant playlist: `GET /api/stream/:id/hls/:variant/index.m3u8`

- Always VOD with `#EXT-X-ENDLIST` (while ffmpeg is still encoding the server synthesises the
  complete playlist from the known duration, so seeking anywhere works immediately).
- `#EXT-X-TARGETDURATION:5`, segments ~4 s (`EXTINF` exact, e.g. `4.017063`), named
  `s0000.ts`, `s0001.ts`... or `s0000.m4s` + `#EXT-X-MAP:URI="init.mp4?token=T"` for alac.
- Query: `token`, `abr=1` (set by the master; means "requested by an ABR ladder"),
  `pre=1` (a pre-warm, not a play press: low priority).
- Requesting an index directly without `abr` also sets that profile as this user's "last
  profile" for server-side warming.
- `Cache-Control: no-store`, type `application/vnd.apple.mpegurl`.
- 404 `no such profile` (unknown variant or a gain the server never handed out), 404 `no such
  track`, 503 `{"error":"busy"}` (transcoder slots full for 20 s) or `"transcode failed"`.
  First request for an uncached song waits until the first segment is written (normally
  well under a second; up to 30 s worst case).

Segment: `GET /api/stream/:id/hls/:variant/:seg` (`s\d{4}.ts|m4s` or `init.mp4`)

- A segment not written yet **blocks up to 30 s** until it is (do not treat slowness as failure).
  404 if the transcode died.
- `Content-Length` set; `Cache-Control: private, max-age=604800, immutable`; type
  `video/mp2t` (.ts), `video/mp4` (init), `video/iso.segment` (.m4s).

### 12.3 Normalisation (ReplayGain-style)

- `gain.track` / `gain.album` on a Track = dB to apply. `null` = not measured yet.
- HLS AAC: pass `norm=track` (or `album` when playing an album in order) and the server bakes
  the gain into the transcode. If the gain is not measured yet, the master is served at 0 dB
  and measurement is queued. **Lossless (`alac`, original file) never has gain baked in**: apply
  it yourself (linear = 10^(dB/20); AVPlayer `volume` cannot exceed 1.0, so positive gains need
  an `AVAudioMix`/`MTAudioProcessingTap` or AVAudioEngine; most gains are negative).
- Web prefs: `normalize` (bool, default on). Rule (`usePlayer.js`): use `album` gain when the
  queue context (`ctx`) equals the track's `albumId`, else `track`; album falls back to track gain.

### 12.4 Warming (start faster, skip faster)

- `POST /api/stream/warm` (auth, guests allowed) body
  `{ ids: string[] (≤10), profile?: "aac-96"|"aac-160"|"aac-320"|"alac", norm?: "track"|"album"|null }`
  → `{ ok: true, queued: int, active: int, foreground: int, live: int, waiting: int }`.
  Queues low-priority transcodes of the start rung (`aac-96`) and the chosen profile.
  Unmeasured songs with `norm` are measured first.
- The server also warms the next 5 queue items itself whenever the active client reports a
  new track over the socket (§20), using the user's last-requested profile.
- The web additionally pre-fetches `GET .../hls/<startVariant>/index.m3u8?pre=1&token=` and the
  first 2 segments (plus `init.mp4`) of upcoming tracks so they sit in the URL cache.

### 12.5 Whole-song AAC file: `GET /api/stream/:id/whole/:profile?norm=`

- `profile` = `aac-96|aac-160|aac-320` (or a gain variant). With `norm`, the server picks the
  gain variant itself. `audio/mp4` (.m4a, faststart), ranged, `Cache-Control: private,
  max-age=86400, immutable`.
- Waits for the full transcode (can take a while for a cold song). 503 `busy`/`transcode failed`.
- 404 `no whole file for lossless` for `alac`.
- Use for offline downloads and for buffering a whole song ahead (dead zones).

### 12.6 Progressive MP3: `GET /api/stream/:id/mp3?bitrate=<bps>&startAt=<seconds>`

- Live ffmpeg transcode, `audio/mpeg`, `Accept-Ranges: none`, `Cache-Control: no-store`.
  `bitrate` in **bits/s** (64000-320000, default 320000); `startAt` seconds (float) to seek.
- No ranges: seeking = new request with `startAt`. Only for clients without HLS; not needed on iOS.

`GET /api/stream/:id/track.<ext>`: the original with a file-like name (for speakers that sniff
extensions); `track.mp3` on a non-MP3 or with `bitrate`/`startAt` becomes the MP3 transcode.

### 12.7 Which to use on iOS (mirrors the web on iPhone)

| User quality pref | Web id | iOS request |
|---|---|---|
| Lossless | `original` | `hls/master.m3u8?max=alac` |
| Very high | `high` | `hls/master.m3u8?max=aac-320&norm=track` |
| Normal | `normal` | `hls/master.m3u8?max=aac-160&norm=track` |
| Low | `low` | `hls/master.m3u8?max=aac-96&norm=track` |

Phones read `prefs.phoneQuality` (default `"high"`); desktops/tablets read `prefs.quality`
(default `"original"`). The web caps one rung lower for a while after stalls on cellular
(`player/linkWatch.js`, client-side only).

Speakers (Cast/BluOS/AirPlay via the server) always get the original file; that is server-side.

---

## 13. Downloads / offline

The web's offline store is client-side (IndexedDB). What it fetches per song:

| Quality | URL |
|---|---|
| Lossless (and the source is FLAC/MP3/AAC/ALAC/WAV/AIFF) | `GET /api/download/:id?fmt=original&token=` |
| Otherwise | `GET /api/stream/:id/whole/<aac-96\|aac-160\|aac-320>?norm=<track\|album>&token=` (album gain when saving an album, else track gain; no `norm` if normalisation is off) |
| Cover | `GET /api/image/<albumId>?size=320` |
| Lyrics | `GET /api/lyrics/:id` |

Plays made offline are queued locally and later posted to `POST /api/plays` with
`client: "offline"` and the original `at`, oldest first (§15).

### `GET /api/download/:id?fmt=&name=` (auth)

- `fmt`: `original` (default; the file, `Content-Length` set), `flac`, `mp3` (320k), `aac`
  (256k ADTS `.aac`), `ogg` (Vorbis 320k). Unknown → original. (The web offers `wav` too; the
  server has no `wav` and returns the original. **UNSURE** whether the web converts it.)
- `name`: filename stem; default `"<artist> - <title>"`.
- `Content-Disposition: attachment; filename="..."; filename*=UTF-8''...`.
- Transcoded formats stream with no `Content-Length`. 503 `busy`.

### `GET /api/playlists/:id/zip` (auth, own playlist)

A zip of the playlist: every song as AAC 256k `.m4a` with tags + cover, named
`NN - Artist - Title.m4a`, plus `<name>.m3u8`, inside a folder named after the playlist.
Streamed as it encodes (no Content-Length). 400 `playlist is empty`, 413 if est. > ~3.8 GB.
Failed songs are skipped silently.

---

## 14. Recommendations

### 14.1 `GET /api/tracks/:id/mix?limit=&mode=&tzo=&client=` (auth)

The one endpoint behind radio, autoplay, smart shuffle and Daily Mixes. `:id` can be a
**track, artist, album or playlist id**.

| Query | Values |
|---|---|
| `limit` | default 100, max 200 |
| `mode` | `continue` (default for a track: autoplay when the queue runs out), `smart` (smart shuffle), `radio` |
| `tzo` | `Date.getTimezoneOffset()` minutes (UTC-8 → `480`): picks the Daily Mix's local day |
| `client` | free string passed to the recommender (**UNSURE** of values; web does not send it) |

Behaviour:

- **Artist id, no `mode`** → that artist's **Daily Mix** for the user's local day (stable all
  day, 100 songs): `{ items: [Track], from: "brain"|"own", day: "YYYY-MM-DD" }` (**UNSURE** day
  format; it is a string compared lexically).
- Artist id, `mode=radio` → fresh artist radio. Other `mode` → fresh artist mix. `{ items }`.
- Track id → the brain recommender (if configured) first: `{ items: [seed, ...], from: "brain" }`
  (the seed track is first). Without the brain: local mix `{ items }` (seed first).
- Album/playlist id + `mode=radio` → set radio `{ items }`; without mode → local mix of the set.
- 404 `no such track` if nothing matches.
- The server excludes the last 500 ids of the session queue from brain picks.
- Web drops ids in `prefs.dislikes` from the result.

How the web uses it:

| Feature | Call |
|---|---|
| Song radio | `/api/tracks/<trackId>/mix?limit=100&mode=radio` |
| Artist/album/playlist radio | `/api/tracks/<id>/mix?limit=100&mode=radio` |
| Daily Mix tile | `/api/tracks/<artistId>/mix?tzo=...` |
| Autoplay at queue end | `/api/tracks/<lastTrackId>/mix?limit=25&mode=continue` (drop the seed, append) |
| Smart shuffle | `/api/tracks/<currentId>/mix?limit=N&mode=smart`, blended into the queue, marked |

### 14.2 Others

| Method | Path | Response |
|---|---|---|
| GET | `/api/playlists/:id/recommended?limit&seed` | `{ items: [Track] }` (§8) |
| GET | `/api/radar` | Release Radar: `{ releases: [Release] }` new releases (90 days) from artists the user likes/follows/plays. Empty without Lidarr. Can be slow the very first time (web timeout 120 s) |
| GET | `/api/similar/:artistId` | §7 |
| GET | `/api/artists/:id/popular` | §7 |
| GET | `/api/ai/status` | `{ ok: true, by: "brain" }` or `{ ok: false, reason: string }` |
| POST | `/api/ai/playlists` | body `{ prompt: string(3-1000), playlistId?: "pl_..." }` (with playlistId: regenerate into it) → `Job` (§18.4). 503 when the brain is off. Job `result`: `{ playlistId, name, regenerated, count, poolSize, requested, missing, known, tracks: [{ id, known }], by: "brain" }` |

Radar `Release`: `{ album_id, artist, title, rtype, year, date, image, total_tracks, secondary, artistId, artistName, inLibrary: albumId|null, localName: string|null, requestStatus }`
(snake_case upstream fields).

---

## 15. Play logging, history, top songs

### 15.1 How plays get logged

- **With the socket connected (normal case): do not POST plays.** The server logs a play when
  the client's `nowplaying` reports show the same `itemId` with `playing: true` for 8 s
  (once per listen; a replay from the top or repeat-one counts again). It also records skip /
  play-length events for the recommender and starts ListenBrainz scrobbling (submitted after
  half the track or 4 min).
- **Without a socket**, or for plays made offline: `POST /api/plays`.

`POST /api/plays` (auth, guests allowed): `{ trackId: 32hex, at?: ms (default now), client?: string ≤80 }`
→ `{ ok: true }` or `{ ok: true, dup: true }` (same track as the last play within 60 s).
`client: "offline"` or `"import"` skips scrobbling. The web sends `client: "web"` live.

### 15.2 `GET /api/history`

Page mode: `?limit=<≤500, default 100>&before=<ms>` (cursor: pass the last item's `at`).

```json
{
  "items": [ { "at": 1762800000000, "client": "iPhone 16|null", "track": Track } ],
  "listens": [ { "ts": 1762800000000, "id": "...", "title": "...", "artist": "...", "artistId": "...|null", "album": "...", "albumId": "...", "seconds": 383 } ]
}
```

(`listens` is the same data flattened.) Plays of tracks no longer in the library are dropped.

Stats mode: `?range=today|week|4w|6m|year&tzo=<minutes>`:

```json
{
  "connected": true, "total": 15234, "sources": {},
  "streams": 120, "minutes": 410, "daysStreamed": 6, "uniqueTracks": 88, "uniqueArtists": 40, "uniqueAlbums": 52,
  "topTracks":  [ { "id", "name", "artist", "artistId", "albumId", "count", "seconds" } ],
  "topArtists": [ { "artistId", "name", "count", "seconds" } ],
  "topAlbums":  [ { "albumId", "name", "artist", "count", "seconds" } ],
  "topGenres":  [ { "id": "Rock", "name": "Rock" } ],
  "prev": { "streams", "minutes", "daysStreamed", "uniqueTracks", "uniqueArtists", "uniqueAlbums" },
  "byHour": [24 ints], "byHourSeconds": [24 ints],
  "perDay": [ { "day": "YYYY-MM-DD", "count": 12, "minutes": 40 } ]
}
```

`week` starts Monday; `year` = calendar year; `4w`/`6m` rolling. `prev` = same numbers for the
preceding equal range. Top lists ≤50, genres ≤12.

### 15.3 Top Songs per year

| Method | Path | Response |
|---|---|---|
| GET | `/api/top-songs?tzo=` | `{ years: [{ year: int, songs: int, plays: int, top: Track\|null }] }` newest year first; only years with ≥10 distinct songs |
| GET | `/api/top-songs/:year?tzo=` | `{ year, items: [Track] }` ≤100, most played first. 400 `year required` |

"Last played track" (web): `GET /api/history?limit=1` → `items[0].track`.

---

## 16. Prefs / settings

One JSON object per account, shallow-merged on PATCH. Max 64 KB serialized.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/prefs` | - | the object (`{}` if none) |
| PATCH | `/api/prefs` | any JSON object (top-level keys replace) | the merged object. 400 `object required` / `prefs too large` |

After a PATCH, the web also sends the **same patch** over the socket (`{ type: "prefs", prefs: patch }`)
so other open clients apply it live. Send only the patch, never the whole object.

Keys the web uses (all optional; unknown keys must be preserved):

| Key | Type | Meaning / default |
|---|---|---|
| `quality` | `"original"\|"high"\|"normal"\|"low"` | desktop/tablet streaming quality, default `original` |
| `phoneQuality` | same | phone streaming quality, default `high` |
| `normalize` | bool | loudness normalisation, default true (`!== false`) |
| `crossfade` | number seconds | 0 (off), offered 0,1,2,3,5,8,12 |
| `gapless` | bool | default true |
| `theme` | `{ accent, bg, surface, fg }` hex `#rrggbb` | default `{ accent:"#1ed760", bg:"#121212", surface:"#1f1f1f", fg:"#ffffff" }` |
| `language` | string | UI language override (`"auto"`, `"de"`...) |
| `dislikes` | `{ trackId: ms }` | excluded from taste profile and mixes |
| `listenbrainz` | `{ user: string, token: string }` | ListenBrainz scrobbling credentials (`token: ""` = disconnected). The web never caches `token` on device |
| `recentSearches` | array | **UNSURE** element shape (web-defined) |
| `libraryPinned`, `libraryOrder` | various | older Your Library state, superseded by §8.1. **UNSURE** |
| `likedAt` | object | **UNSURE** legacy |
| `viz` | object | visualiser settings (web only) |
| `_libraryLayout` | string | only ever appears in socket `prefs` messages as a "re-fetch layout" ping, not stored |

---

## 17. Speakers, groups, casting (REST side)

Speakers exist only when the server runs with speakers enabled. The list a client sees comes
from the socket roster (`lanDevices`, §20.4), not REST. Playing on a speaker is a socket
`command` with `action: "transfer"` to the `server:<userId>` client (§20.6).

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/speakers/:id/volume` | `{ level: 0-100 }` | `{ ok: true }` |
| POST | `/api/speakers/:id/input` | `{ input: string }` (an `inputs[].id` from the speaker's state) | `{ ok: true }` |
| POST | `/api/speakers/:id/control` | `{ action: "play"\|"pause"\|"next"\|"previous" }` | `{ ok: true }` |
| GET | `/api/speakers/groups` | - | `{ groups: [[speakerId, ...], ...] }` (leader first) |
| POST | `/api/speakers/groups` | `{ leader: id, members: [id] (≤32) }` | `{ groups }`. BluOS only: 400 `<name> cannot be grouped: only BluOS speakers play in sync...`; 404 `no such speaker <id>` |
| POST | `/api/speakers/groups/unjoin` | `{ speaker: id }` | `{ groups }` |
| POST | `/api/speakers/groups/clear` | `{}` | `{ groups: [] }` |

Errors: 404 `speakers are off on this server`; speaker failures 502 (or the speaker's status).
These control the speaker directly (its own volume, inputs like "TV"/"Spotify" on BluOS),
independent of Slopify playback.

---

## 18. Lidarr downloads, requests, Spotify import, jobs, reports

### 18.1 Request an album: `POST /api/requests`

Body `{ album_id: "<mbid from gsearch/discography/radar>" }` →
`{ id?: int, album_id, artist, title, status: "queued"|"exists"|... }`. 503 when Lidarr is not
configured, 502 Lidarr error. Web timeout 40 s.

### 18.2 `GET /api/downloads?scope=mine|all`

503 when not configured. Can take time when Lidarr is slow (web timeout 35 s; the server
answers from its last copy after a few seconds and sets `keptAt`). Web polls every 5 s while open.

```json
{
  "scope": "mine",
  "items": [ {
    "id": 123, "albumId": "mbid", "artist": "A", "title": "T", "type": "Album", "year": "2020", "image": "https://...|null",
    "state": "downloading|adding|stuck|queued|failed|done", "total": 12, "done": 4, "queuePos": null,
    "requested": 1762800000000, "started": null, "progressAt": 1762800000000, "finished": null,
    "reason": "string|null", "via": "soulseek|torrent|usenet|download", "detail": "string|null",
    "libraryAlbumId": "<albumId>|null", "source": "request|retry|...|null", "note": "string|null", "mine": true,
    "search": { "at": 1762800000000, "results": 3, "outcome": "string" }, "failedImport": false
  } ],
  "counts": { "downloading": 1, "queued": 3 },
  "stuckAfterMs": 86400000,
  "watcher": { "name": "Soularr", "lastCheck": 0, "lastCheckEnd": 0, "next": 0, "interval": 0, "checking": false, "perCheck": 0, "wanted": 0 },
  "now": 1762800000000,
  "keptAt": 1762799990000
}
```

`watcher` may be `null`; `keptAt` only when the answer is the cached one; `search` may be null.
**UNSURE**: exact `via` values beyond what Lidarr reports as protocol. Sorted
downloading, adding, stuck, queued, failed, done.

`POST /api/downloads/:id/retry` → `{ ok: true, id }`; 409 if not failed/stuck.

### 18.3 Spotify import (2 steps, then a job)

1. `POST /api/import/spotify/upload` with the raw file (zip or JSON) as body,
   `Content-Type: application/octet-stream`, header `X-Filename: <ascii name>`. ≤512 MB pending
   per account, 3 pending files max. → `{ fileId, bytes }`. 409 upload already running, 413, 429.
2. `POST /api/import/spotify` `{ fileIds: [fileId] (1-40) }` → `Job`. Result: import counts
   (`plays`, `likes`, `playlists: { created, ... }`, `queued`, ..., `downloads: bool`). **UNSURE**
   full result shape (see `importSpotify` in `server/src/spotifyImport.ts`).

### 18.4 Jobs: `GET /api/jobs/:id`

```json
{ "id": "a1b2c3d4e5f60718", "kind": "ai-playlist|spotify-import", "state": "queued|running|done|error",
  "step": "Starting", "progress": 0.4, "info": null, "result": null, "error": null, "created": 1762800000000, "finished": null }
```

Poll every 1 s while `queued`/`running`. Jobs live in memory: gone after a server restart
(404 `no such job`) and 1 h after finishing. Only the owner sees them.

### 18.5 Problem report: `POST /api/reports`

`{ message: string(1-4000), logs?: string[] (≤500, each ≤1000), info?: object (≤16 KB) }` → `{ id }`.
Body ≤512 KB, 10/hour. User-Agent is stored as the device.

---

## 19. Admin endpoints (admin role only)

Not needed for a normal user. Listed so Settings › Admin can be built later.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/users` | - | `{ users: [{ id, name, role, must_change_pw: 0\|1, created, last_seen }] }` (**snake_case**) |
| POST | `/api/users/:id/role` | `{ role: "admin"\|"user" }` | `{ ok: true }`; 400 can't demote self |
| DELETE | `/api/users/:id` | - | `{ ok: true }`; 400 self |
| POST | `/api/users/:id/password` | `{ password?: string(8+) }` (omit for a generated one) | `{ password }` shown once; user forced to change; their tokens revoked |
| POST | `/api/users/:id/household-token` | `{ device?: string }` | `{ token }` (Home Assistant style per-account token) |
| POST | `/api/invites` | `{}` | `{ code, expires: ms }` (valid 7 days, one use) |
| GET | `/api/admin/status` | - | `{ scanning, library: { tracks, albums, artists, artistsWithImage }, speakers: [Speaker + playing], scans: [...], users, lyrics: [{ kind, n }], missingLyrics, identity: [{ state, n }], enrich, enriching }` |
| POST | `/api/admin/scan` | `{ paths?: string[] }` | full scan `{ started: true, scan }` or `{ ingested, folders }` |
| POST | `/api/admin/enrich` | - | `{ started: true }` |
| GET/POST | `/api/admin/ingest` | - | ingest status / run |
| GET | `/api/admin/cache` | - | `{ songs, heads: { songs, bytes } }` |
| GET | `/api/admin/tasks` | - | `{ tasks: [...] }` scheduled tasks |
| POST | `/api/admin/tasks/:id/run` | - | run now |
| PUT | `/api/admin/tasks/:id/settings` / `/schedule` | - | task config |
| GET | `/api/admin/lyricsync` | - | `{ states: [{ state, n }], queued }` |
| POST | `/api/admin/lyricsync/undo` | - | `{ restored }` |
| POST | `/api/admin/speakers/:id/pair` | `{}` → speaker shows PIN; `{ pin }` → `{ ok, paired }`; `{ password }` → `{ ok }` | AirPlay pairing |

Server-to-server only (never call from the app): `/api/brain/*` (header `X-Brain-Key`),
`/api/hooks/lidarr`.

---

## 20. Realtime session protocol (`/api/ws`)

Audio never flows over this socket. It is presence + state + command routing for all of one
account's clients ("devices"): which client is making sound, what it plays, its queue, and
remote control between them.

### 20.1 Connect

- URL: base URL with `http`→`ws`, `https`→`wss`, path `/api/ws`. E.g. `wss://music.example.com/api/ws`.
- No auth in the URL/headers: the first frame must be `hello` with the token. The server
  closes with **4001 `auth timeout`** if no valid hello within 10 s.
- Before hello, frames > 2048 bytes close the socket (1009). After hello: frames > 64 KB are
  ignored except `queue`; any frame > 4 MiB closes (1009).
- All frames are JSON text. Unknown types are ignored. Non-object frames ignored.
- Server pings (WS protocol ping) every 30 s; if no pong within 10 s it terminates the socket.
  URLSessionWebSocketTask answers pings automatically.
- Client sends app-level `{ type: "ping", t }` every **25 s** (also used for clock sync).

### 20.2 Close codes

| Code | Reason | Client action |
|---|---|---|
| 4000 | `replaced` | Another socket connected with the same `clientId` (a reconnect replaced this one). Do not fight it |
| 4001 | `auth timeout` | Reconnect (send hello promptly) |
| 4003 | `bad token` / `password change required` / `signed out` / `account deleted` | Stop reconnecting, go to sign-in (or password change) |
| 1009 | `too large` | A frame was too big; shrink (queue) and reconnect |
| other / network | - | Reconnect with backoff |

Reconnect backoff (web): start 1 s, double each failure, max 20 s; reset to 1 s if the
previous connection lived > 5 s. Only one socket per app instance at a time.

### 20.3 Client → server messages

#### `hello` (first frame)

```json
{ "type": "hello", "token": "<token>", "clientId": "c_k3j2h1...", "instance": "i_abc123...",
  "name": "iPhone 16", "kind": "phone", "form": "phone", "canPlay": true }
```

| Field | Type | Notes |
|---|---|---|
| `token` | string ≤256 | Speaker tokens refused |
| `clientId` | `^[\w-]{4,64}$`, not `server:*` | Persist per install. Invalid → server assigns `c_<random>`. If another account holds it, or another live socket with a different `instance` holds it, the server gives you a suffixed id. **Always adopt `hello-ok.clientId`** |
| `instance` | string ≤64 | Random per process launch. Lets the server tell a reconnect (same instance) from a second copy |
| `name` | string ≤56 | Display name. Server de-dupes within the account: `"iPhone 16 (2)"` |
| `kind` | string ≤20 | `"phone"` for iOS (web: `web`, desktop app: `desktop`, Home Assistant: `homeassistant`) |
| `form` | `"desktop"\|"laptop"\|"phone"\|"tablet"\|"tv"` | Icon others show; anything else → null |
| `canPlay` | bool, default true | false = controller only (never selected as an output) |

#### Others

| type | Payload | Meaning |
|---|---|---|
| `ping` | `{ t: <local ms> }` | Answered with `pong`. Send every 25 s and ~400 ms after `hello-ok` |
| `nowplaying` | `{ nowPlaying: NowPlaying \| null }` | **Only the active player sends this** (§20.5). On every state change and every **2 s** while playing. `null` = nothing playing (releases the session) |
| `queue` | `{ queue: [QueueItem] (≤5000) }` | Active player publishes its queue when it changes (debounced ~300 ms). Keep the serialized frame ≤ ~2.5 MB: trim from the end (web cuts to 80% repeatedly). Server drops queues > 3 MB |
| `claim` | `{}` or `{ reassert: true, ago: <ms since play was pressed here> }` | "I am now the one making sound." Send when the user presses play locally (fresh claim). After a reconnect, if you held the claim before, re-send with `reassert` (§20.7) |
| `command` | `{ to: <clientId>, command: Command }` | Remote control another client of the same account (§20.6) |
| `devices` | `{ devices: [{ id, name, kind, ... }] (≤50) }` | Speakers this client can reach itself (desktop app). iOS: send nothing / `[]` (**UNSURE**: AirPlay routes are not modelled as Slopify devices) |
| `like` | `{ itemId, liked: bool }` | Like/unlike a track, server stores + broadcasts. Prefer `PUT/DELETE /api/likes/:id` |
| `prefs` | `{ prefs: <patch object> }` | Relay a prefs patch to the account's other clients (not stored: also PATCH `/api/prefs`) |
| `sleep` | `{ minutes: 1..1440 }` \| `{ endOfTrack: true }` \| `{ off: true }` \| `{ off: true, done: true }` | Account-wide sleep timer. The server fires the timed one (sends `setPlaying false` to the active client). With `endOfTrack`, the active player itself pauses at the end of the current track and then sends `{ type: "sleep", off: true, done: true }` |
| `offset` | `{ id: <speakerId matching ^(cast\|bluos\|bridge\|upnp\|airplay\|roku):>, offset: seconds (-5..5) \| null }` | Visualiser latency per speaker (web feature; optional) |
| `diag` | `{ data: object ≤16 KB }` | Debug report to the server log, max 1 per 10 s |

### 20.4 Server → client messages

#### `hello-ok`

```json
{ "type": "hello-ok", "clientId": "c_k3j2h1...", "userId": "3f2a...", "offsets": { "cast:abc": 0.12 },
  "now": 1762800000000, "sleep": { "at": 1762803600000, "endOfTrack": false }, "web": "assets/index-abc123.js" }
```

`sleep` null when off. `web` = current web build (ignore natively). After `hello-ok` the server
sends a `roster`, then one `queue` per other client that has published one, then a `session`
message if no client is active.

On `hello-ok` the client (web) then: re-sends `claim` (reassert) if it held it, then its
last `devices`, `nowplaying`, `queue` (anything sent before `hello-ok` was dropped).

#### `pong`

`{ type: "pong", now: <server ms>, t: <echo of your t> }` (§20.9 clock sync).

#### `roster` (on every change of any client's presence, nowplaying, devices, or speakers)

```json
{
  "type": "roster",
  "players": [
    { "id": "c_desktop1", "name": "Lukas MacBook", "kind": "desktop", "form": "laptop", "canPlay": true,
      "nowPlaying": NowPlaying|null, "sameNetwork": true },
    { "id": "server:3f2a...", "name": "Home speakers", "kind": "server", "form": null, "canPlay": false,
      "nowPlaying": NowPlaying|null, "sameNetwork": true }
  ],
  "lanDevices": [
    { "id": "bluos:192.168.1.20", "kind": "bluos", "name": "Node", "model": "NODE 2i", "host": "192.168.1.20", "port": 11000,
      "group": ["bluos:192.168.1.20", "bluos:192.168.1.21"],
      "state": { "volume": 30, "muted": false, "state": "pause", "playing": false, "title": null, "artist": null, "album": null, "image": null, "input": null, "inputs": [{ "id": "...", "name": "TV" }] },
      "viaClient": "server:3f2a..." },
    { "id": "tv:192.168.1.50", "kind": "tv", "name": "Living Room TV", "model": "Slopify TV", "host": "192.168.1.50", "port": 7781, "viaClient": "server:3f2a..." }
  ],
  "activeClientId": "c_desktop1"
}
```

- `players`: every **other** client of the account (never yourself), including the virtual
  `server:<userId>` "Home speakers" client when the server has speakers on. Its `nowPlaying`
  is non-null while the server is playing on a speaker.
- `sameNetwork`: the player is on your network (LAN vs same public IP); the server client is always true.
- `lanDevices`: speakers you can pick. `viaClient` = which client drives it (the
  `server:<uid>` client for server-found speakers, or a desktop client's id for its own).
  Speaker objects may include extra kind-specific fields (`ssdp`, `swept`, `raop`, `airplay`,
  `avTransport`, ...): ignore them. `group` only when grouped (leader first); `state` when polled.
  `kind`: `cast`, `bluos`, `bridge`, `upnp`, `airplay`, `roku`, `tv`.
- `activeClientId`: client currently making sound, or null. **May be your own id.**
- Web stamps `nowPlaying.rxAt = local receipt time` for fallback clock math.

#### `queue`

`{ type: "queue", from: <clientId>, queue: [QueueItem] | null }`: another client's published
queue. Keep a map `clientId → queue`; the active client's one is the session queue.

#### `session`

`{ type: "session", nowPlaying: NowPlaying, queue: [QueueItem], at: <ms updatedAt> }`

The remembered session when nobody is active: sent on connect (if no active client) and to
everyone when the active client stops/disconnects. `nowPlaying.playing` is false and
`position` is the frozen position (seconds). Use it to show "last played" and resume here.
The web adopts it only if it has nothing loaded or its own saved playhead is older than `at`.

#### `command`

`{ type: "command", from: <clientId | "server">, command: Command }`: execute it (§20.6).
`from: "server"` = sleep timer.

#### `like`

`{ type: "like", itemId, liked: bool, at: ms }` (also echoed to the sender).

#### `prefs`

`{ type: "prefs", prefs: <patch> }`: merge into local prefs. If it contains `_libraryLayout`
(rev string) that you did not write, re-fetch `GET /api/library/layout`. (Web also handles a
legacy `_libraryChanged` key: refresh playlists.)

#### `sleep`

`{ type: "sleep", sleep: { at: ms|null, endOfTrack: bool } | null }`.

#### `offset`

`{ type: "offset", id: <speakerId>, offset: seconds | null }`.

### 20.5 Shapes

#### NowPlaying (what the active player reports; what mirrors render)

| Field | Type | Notes |
|---|---|---|
| `itemId` | trackId | |
| `title` | string | |
| `artist` | string | joined credit |
| `album` | string \| null | |
| `artUrl` | string \| null | absolute image URL (web: `/api/image/<id>?size=128&token=...`). Mirrors may build their own from `albumId` |
| `albumId` | string \| null | |
| `artistId` | string \| null | first artist |
| `artists` | `[{ Id, Name }]` | **PascalCase** (legacy Jellyfin shape) |
| `liked` | bool | |
| `device` | `{ id, kind, name, members? }` | Where sound comes out. Own output: `{ id: "local", kind: "local", name: "This Phone" }` (web `LOCAL_DEVICE`: "This Computer" / "This TV" / "This Phone" / "This Web Player"). Server speaker: speaker id/kind, `name` joined with " + " for groups, `members: [ids]` |
| `queueIndex` | int | index into the published queue |
| `playing` | bool | |
| `held` | bool | playing but not audible yet (loading/seeking/buffering): mirrors freeze the playhead |
| `position` | number **seconds** | playhead at the moment of the report (web subtracts output latency) |
| `duration` | number seconds | |
| `volume` | number 0-100 | |
| `repeat` | `"off"\|"all"\|"one"` | |
| `shuffle` | `"off"\|"on"\|"smart"` | (server speaker player: `off`/`on` only) |
| `at` | ms | sender's wall clock. **Do not do clock math with it across devices** |
| `serverAt` | ms | **added by the server** when relayed (server clock at receipt). Use this |

```json
{ "itemId": "0f6c...", "title": "Paranoid Android", "artist": "Radiohead", "album": "OK Computer",
  "artUrl": "https://music.example.com/api/image/0f6c...?size=128&token=...", "albumId": "1a2b...", "artistId": "a9b8...",
  "artists": [{ "Id": "a9b8...", "Name": "Radiohead" }], "liked": true,
  "device": { "id": "local", "kind": "local", "name": "iPhone 16" }, "queueIndex": 3,
  "playing": true, "held": false, "position": 81.42, "duration": 383.0, "volume": 80, "repeat": "off", "shuffle": "off",
  "at": 1762800000000, "serverAt": 1762800000031 }
```

#### QueueItem ("slim track", **PascalCase**, Jellyfin legacy)

```json
{ "Id": "0f6c...", "Name": "Paranoid Android", "Artists": ["Radiohead"], "AlbumArtist": "Radiohead", "Album": "OK Computer",
  "AlbumId": "1a2b...", "RunTimeTicks": 3830000000,
  "ArtistItems": [{ "Id": "a9b8...", "Name": "Radiohead" }], "AlbumArtists": [{ "Id": "a9b8...", "Name": "Radiohead" }],
  "UserData": { "IsFavorite": true }, "_queued": false, "_gain": { "track": -6.3, "album": -5.8 } }
```

- `RunTimeTicks` = duration in 100 ns ticks (`durationMs * 10000`).
- `_queued`: added with "Add to queue" (plays after current, before the rest of the context).
- `_gain`: Track `gain` or null.
- The server derives the session's track id list from `queue[].Id`. Only `Id` is required by
  the server; other clients render the rest. Map from Track: `Id=id, Name=title,
  Artists=artists, AlbumArtist=albumArtist, Album=album, AlbumId=albumId,
  ArtistItems=zip(artists, artistIds), AlbumArtists=[{Id: artistIds[0], Name: albumArtist}]`.

#### Command (client ↔ client, relayed verbatim by the server)

All positions in **seconds**.

| `action` | Fields | Receiver does |
|---|---|---|
| `play` | `trackIds: [id]`, `index: int`, `ctx?: string\|null`, `startAt?: seconds` | Play this list from `index` (honouring its own shuffle). Sent by a controller to the **active** client |
| `transfer` | `trackIds: [id]`, `queued?: [bool]` (parallel `_queued` flags), `index: int`, `position: seconds`, `playing: bool`, `ctx?: string`, `original?: [id]` (unshuffled order when shuffled), `deviceId: "local" \| <speakerId>` | Take over the session: `claim`, then start `trackIds[index]` at `position` (paused if `playing:false`) on its own output (`local`) or on that speaker. Fill in the rest of the queue after the first song starts |
| `enqueue` | `trackIds: [id]` | Add to queue (after current and other queued items), marked `_queued` |
| `queueRemove` | `index` | Remove queue entry (not the current one) |
| `queueMove` | `from`, `to` | Move queue entry |
| `queueClear` | - | Remove all `_queued` items after current |
| `skipTo` | `index` | Jump to queue index |
| `toggle` | - | Play/pause flip |
| `setPlaying` | `playing: bool` | Set state (preferred over toggle; idempotent). `from: "server"` + false = sleep timer |
| `seek` | `pos: seconds` | |
| `setVolume` | `level: 0-100` | |
| `volumeStep` | `step: 1\|-1` | Hardware volume buttons on a controller |
| `next` / `previous` | - | `previous` restarts the track if > 3 s in (receiver's rule) |
| `setRepeat` | `mode: "off"\|"all"\|"one"` | |
| `setShuffle` | `mode: "off"\|"on"\|"smart"` | |
| `patchLiked` | `itemId`, `liked: bool` | Update the heart in its queue so the next nowplaying carries it |
| `yield` | - | Sent **by the server** (`from` = the new active client): another client took over. Stop and **unload** local audio, become a mirror, and forget your claim (do not reassert later) |

`ctx` = what the queue was played from: album id, playlist id, `artist:<artistId>`
(enables "more of this artist" autoplay), `mix:<id>`, `genre:<name>` (**UNSURE** full list).

### 20.6 Device / session model

- **Active client** (`activeClientId`): the one making sound (on its own output or a speaker
  it drives). Exactly one or none per account. It sends `nowplaying` (2 s cadence) and `queue`.
- **Mirrors**: every other client. They do **not** send `nowplaying`. They render the active
  client's `nowPlaying` from the roster and its queue from `queue` messages, and route every
  control as a `command` `{ to: activeClientId }`. Mirrors extrapolate the playhead (§20.9).
- **Becoming active by playing here**: send `claim` (server makes you active, sends `yield`
  to everyone else), then start audio and report. If you start sound without a claim and
  nobody is active, your first `nowplaying` with `playing:true` also makes you active.
- **Changing the song from a mirror**: `command { to: active, command: { action: "play", ... } }`
  (do not claim; the active device keeps playing).
- **Taking over onto this device** ("play here"): `claim`, fetch the active's queue
  (`trackIds` from its `queue`, index from `nowPlaying.queueIndex` if `queue[queueIndex].Id ==
  itemId`, else just `[itemId]`), start at the extrapolated playhead.
- **Handing off to another client**: `command { to: <thatClientId>, command: { action:
  "transfer", trackIds, queued, index, position, playing, ctx, original, deviceId: "local" } }`,
  then stop your own audio immediately (you will also receive `yield` when it claims).
  If you are a mirror handing off someone else's session, build `transfer` from the active's
  queue + extrapolated position.
- **Playing on a speaker**: pick a `lanDevices` entry; send `transfer` with
  `deviceId: <speaker.id>` to `speaker.viaClient` (`server:<uid>` for server speakers). The
  server's player then becomes active and reports `nowplaying` like any client; control it
  with commands to `server:<uid>`. For a `tv:` entry or a Cast TV running the Slopify TV app,
  the server opens the TV app and forwards the transfer to it (`deviceId: "local"`).
- **Releasing**: the active client sends `nowplaying: null` (stopped) → session frozen, active
  = null, others get `session`.
- **Disconnect of the active client**: if another client of the account is still reporting
  `playing` (seen < 60 s ago), it becomes active. Otherwise the session pauses at its position
  and everyone gets `session`.
- **Server restart**: sessions are paused; the client that held the claim re-asserts on reconnect.
- **There is no "start together" / synchronized multi-device playback** for clients. Only
  BluOS speaker groups play in sync (server side, §17).
- The server persists the session (track, index, position, device, nowPlaying, queue ≤5000)
  debounced 1.5 s, so a fresh client can resume what was last playing (`session` message or
  `GET /api/session`).

### 20.7 Claim re-assertion (latest press wins)

Keep `claimed: Bool` and `claimedAt` (local ms when play was pressed here). Set on a local
play press (`claim`), clear on receiving `command.yield`. On every `hello-ok`, if `claimed`,
send `{ type: "claim", reassert: true, ago: now - claimedAt }`. The server compares with the
current holder's claim time: if the holder pressed play later, **you** get `yield`; else you
become active and the holder gets `yield`. `ago` is clamped to 7 days.

### 20.8 Moving address

When the base URL changes (home ↔ main, §4.4), connect to the new base with the same
`clientId`/`instance`, backoff reset to 1 s, and close the old socket once the new one has its
`hello-ok` (or failed). Same server, same session. Make before break: the server swaps a
reconnect in by client id silently, while the active client's socket closing first makes it
pause the session for every other device ("disconnected while active") although the phone's
own audio plays on.

### 20.9 Clock sync and playhead extrapolation

```
on pong(now, t):  rtt = local_now - t
                  if rtt >= 0 && rtt <= bestRtt + 15: bestRtt = min(bestRtt, rtt); offset = now - (t + rtt/2)
on hello-ok(now): if offset unknown: rtt = local_now - socketOpenedAt; offset = now - (local_now - rtt/2)
serverNow() = local_now + offset

playhead(np):
  if !np.playing || np.held: return np.position
  since = (np.serverAt != nil && offset known) ? serverNow() - np.serverAt : local_now - np.rxAt
  return np.position + max(0, since) / 1000      // seconds
```

Send a `ping` ~400 ms after `hello-ok` to refine quickly, then every 25 s.

### 20.10 `GET /api/session` (HTTP snapshot)

```json
{ "session": { "rev": 12, "active": "c_desktop1|null", "trackId": "...|null", "queue": ["id", "..."], "index": 3, "playing": true,
               "positionMs": 81420, "anchorAt": 1762800000000, "device": { "id", "name", "kind" }|null, "lastEventTs": 0,
               "updatedAt": 1762800000000, "claimedAt": 1762799000000, "nowPlaying": NowPlaying|null },
  "clients": [ { "id", "name", "kind", "canPlay", "lastSeen" } ],
  "now": 1762800000000 }
```

Note `positionMs` here is **ms** (session internal), `anchorAt` = now. `queue` is ids only.

---

## 21. Gotchas checklist

1. **Units**: HTTP durations are ms (`durationMs`); lyrics `start` ms; socket `position`,
   `duration`, command `pos`/`position`/`startAt` are **seconds** (float); MP3 `startAt`
   seconds, `bitrate` bits/s; QueueItem `RunTimeTicks` = 100 ns ticks; `/api/session`
   `positionMs` ms. All timestamps epoch ms.
2. **`tzo`** = JavaScript `getTimezoneOffset()`: minutes, **positive west of UTC**
   (Vancouver PST = 480). Swift: `-TimeZone.current.secondsFromGMT() / 60`.
3. **Two naming styles**: REST is camelCase (`id`, `title`); socket queue items and
   `nowPlaying.artists` are PascalCase Jellyfin legacy (`Id`, `Name`, `RunTimeTicks`). Some
   upstream objects are snake_case (`album_id`, `total_tracks`, admin `users`).
4. **Ids**: album/artist/track ids share a shape; use `/api/items/:id`. A track id changes if
   the file is replaced by a different encode; artwork for an old id still resolves
   (`gone_tracks`), but `/api/tracks?ids=` silently omits unknown ids: always map results back by id.
5. **Batching**: `/api/tracks?ids=` ≤100 ids per request.
6. **Pagination**: `/api/albums` and `/api/artists` use `offset`/`limit` (≤20000; the web fetches
   all at once with `limit=20000` and caches 10 min, invalidated by `/api/library` `version`).
   History uses a `before=<at>` cursor. Everything else returns full lists.
7. **Playlist positions**: remove by position, highest first; positions renumber after each
   change. `GET /api/playlists/:id` omits tracks no longer in the library, so after a library
   change the shown index can differ from the stored position (**UNSURE** how the web copes;
   it uses the shown index).
8. **Playlist `cover` hash changes** with contents: include it in your image cache key.
9. **Token in URLs** only on GET/HEAD. Mutations must use the header.
10. **401 anywhere** (except login) → signed out. Socket 4003 → same.
11. **Streaming on iOS**: HLS, never FLAC by file (§12.1). Segments can legitimately block up
    to 30 s; 503 `busy` is retryable after a moment.
12. **Rate limits**: 600 req/min per IP shared by the house; HLS and images are exempt/high.
    Do not poll `/api/downloads` faster than 5 s or jobs faster than 1 s.
13. **Plays**: do not POST `/api/plays` while the socket is up and you report `nowplaying` (it
    would double count; server dedups only same track within 60 s). Report `nowplaying` every
    2 s while playing, and immediately on track change, pause, seek, volume, repeat/shuffle.
14. **Mirrors never send `nowplaying`**. Only the active client does.
15. **Always adopt `hello-ok.clientId`**: it can differ from the one you sent.
16. **Queue frame size**: trim the published queue to stay under ~2.5 MB; the server drops
    > 3 MB queues and closes on > 4 MiB frames.
17. **Prefs**: PATCH merges top-level keys; nested objects (e.g. `theme`, `dislikes`) are replaced
    whole. Read-modify-write nested keys. Preserve unknown keys.
18. **Album likes / artist follows** are not pushed over the socket; refresh those lists on
    foreground.
19. **Demo guests are role `admin`** but every server-changing write is 403: hide admin UI when
    `name` starts with `"Guest "`.
20. **Home address**: only trust it after the HMAC proof; it is usually plain http, so the app
    needs an ATS exception for local networks (`NSAllowsLocalNetworking`) and local-network
    permission.
21. **Gain**: `norm` only affects AAC HLS; apply gain yourself for ALAC/original.
22. **Search** for playlists and scoped search is client-side.

---

## 22. Endpoint index

123 `/api` routes are registered; 8 are server-to-server (`/api/brain/*` x7, `/api/hooks/lidarr`).
Of the remaining 115, about 22 are admin-only. Plus `GET /healthz` and `GET /api/ws` (WebSocket).

| # | Method | Path | Auth | § |
|---|---|---|---|---|
| 1 | GET | /api/healthz | public | 3.9 |
| 2 | GET | /api/i18n | public | 3.9 |
| 3 | POST | /api/auth/login | public | 3.2 |
| 4 | POST | /api/auth/register | public | 3.5 |
| 5 | POST | /api/auth/demo | public | 3.7 |
| 6 | POST | /api/auth/logout | auth | 3.3 |
| 7 | GET | /api/auth/me | auth | 3.3 |
| 8 | POST | /api/auth/password | auth | 3.3 |
| 9 | GET | /api/auth/devices | auth | 3.3 |
| 10 | DELETE | /api/auth/devices/:id | auth | 3.3 |
| 11 | GET | /api/users/:id/avatar | public | 3.3 |
| 12 | POST | /api/users/me/avatar | auth | 3.3 |
| 13 | GET | /api/server | auth | 4.5 |
| 14 | GET | /api/server/addresses | auth | 4.2 |
| 15 | GET | /api/server/proof | public, LAN | 4.3 |
| 16 | GET | /api/library | auth | 6 |
| 17 | GET | /api/home | auth | 6 |
| 18 | GET | /api/browse | auth | 6 |
| 19 | GET | /api/search | auth | 6 |
| 20 | GET | /api/gsearch | auth | 6 |
| 21 | GET | /api/albums | auth | 7 |
| 22 | GET | /api/albums/:id | auth | 7 |
| 23 | GET | /api/artists | auth | 7 |
| 24 | GET | /api/artists/:id | auth | 7 |
| 25 | GET | /api/artists/:id/popular | auth | 7 |
| 26 | GET | /api/items/:id | auth | 7 |
| 27 | GET | /api/tracks/:id | auth | 7 |
| 28 | GET | /api/tracks | auth | 7 |
| 29 | GET | /api/genres/:name | auth | 7 |
| 30 | GET | /api/genres/:name/tracks | auth | 7 |
| 31 | GET | /api/genres/:name/mix | auth | 7 |
| 32 | GET | /api/discography/:id | auth | 7 |
| 33 | GET | /api/similar/:id | auth | 7 |
| 34 | GET | /api/playlists | auth | 8 |
| 35 | POST | /api/playlists | auth | 8 |
| 36 | GET | /api/playlists/:id | auth | 8 |
| 37 | PATCH | /api/playlists/:id | auth | 8 |
| 38 | DELETE | /api/playlists/:id | auth | 8 |
| 39 | POST | /api/playlists/:id/tracks | auth | 8 |
| 40 | DELETE | /api/playlists/:id/tracks/:pos | auth | 8 |
| 41 | POST | /api/playlists/:id/move | auth | 8 |
| 42 | POST | /api/playlists/:id/cover | auth | 8 |
| 43 | GET | /api/playlists/:id/recommended | auth | 8 |
| 44 | GET | /api/playlists/:id/zip | auth | 13 |
| 45 | GET | /api/library/layout | auth | 8.1 |
| 46 | PUT | /api/library/layout | auth | 8.1 |
| 47 | POST | /api/library/folders | auth | 8.1 |
| 48 | PATCH | /api/library/folders/:id | auth | 8.1 |
| 49 | POST | /api/library/folders/:id/cover | auth | 8.1 |
| 50 | DELETE | /api/library/folders/:id | auth | 8.1 |
| 51 | GET | /api/likes | auth | 9 |
| 52 | PUT | /api/likes/:id | auth | 9 |
| 53 | DELETE | /api/likes/:id | auth | 9 |
| 54 | GET | /api/likes/albums | auth | 9 |
| 55 | GET | /api/likes/artists | auth | 9 |
| 56 | GET | /api/lyrics/:id | auth | 10 |
| 57 | POST | /api/lyrics/:id/sync | auth | 10 |
| 58 | GET | /api/lyrics/sync | auth | 10 |
| 59 | GET | /api/image/:id | public | 11 |
| 60 | GET | /api/art/:hash/:file | public | 11 |
| 61 | GET | /api/art/sizes | public | 11 |
| 62 | GET | /api/stream/:id | auth | 12.1 |
| 63 | GET | /api/stream/:id/mp3 | auth | 12.6 |
| 64 | GET | /api/stream/:id/track.:ext | auth | 12.6 |
| 65 | GET | /api/stream/:id/hls/master.m3u8 | auth | 12.2 |
| 66 | GET | /api/stream/:id/hls/:profile/index.m3u8 | auth | 12.2 |
| 67 | GET | /api/stream/:id/hls/:profile/:seg | auth | 12.2 |
| 68 | GET | /api/stream/:id/whole/:profile | auth | 12.5 |
| 69 | POST | /api/stream/warm | auth | 12.4 |
| 70 | GET | /api/download/:id | auth | 13 |
| 71 | GET | /api/tracks/:id/mix | auth | 14.1 |
| 72 | GET | /api/radar | auth | 14.2 |
| 73 | GET | /api/ai/status | auth | 14.2 |
| 74 | POST | /api/ai/playlists | auth | 14.2 |
| 75 | POST | /api/plays | auth | 15.1 |
| 76 | GET | /api/history | auth | 15.2 |
| 77 | GET | /api/top-songs | auth | 15.3 |
| 78 | GET | /api/top-songs/:year | auth | 15.3 |
| 79 | GET | /api/prefs | auth | 16 |
| 80 | PATCH | /api/prefs | auth | 16 |
| 81 | POST | /api/speakers/:id/volume | auth | 17 |
| 82 | POST | /api/speakers/:id/input | auth | 17 |
| 83 | POST | /api/speakers/:id/control | auth | 17 |
| 84 | GET | /api/speakers/groups | auth | 17 |
| 85 | POST | /api/speakers/groups | auth | 17 |
| 86 | POST | /api/speakers/groups/unjoin | auth | 17 |
| 87 | POST | /api/speakers/groups/clear | auth | 17 |
| 88 | POST | /api/requests | auth | 18.1 |
| 89 | GET | /api/downloads | auth | 18.2 |
| 90 | POST | /api/downloads/:id/retry | auth | 18.2 |
| 91 | POST | /api/import/spotify/upload | auth | 18.3 |
| 92 | POST | /api/import/spotify | auth | 18.3 |
| 93 | GET | /api/jobs/:id | auth | 18.4 |
| 94 | POST | /api/reports | auth | 18.5 |
| 95 | GET | /api/session | auth | 20.10 |
| 96 | GET (WS) | /api/ws | hello frame | 20 |
| - | admin | /api/users, /api/users/:id/role, DELETE /api/users/:id, /api/users/:id/password, /api/users/:id/household-token, /api/invites, /api/admin/{status,scan,enrich,ingest x2,cache,tasks,tasks/:id/run,tasks/:id/settings,tasks/:id/schedule,lyricsync,lyricsync/undo,speakers/:id/pair} | admin | 19 |
