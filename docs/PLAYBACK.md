# Playback: fast starts, instant skips, and what the buttons mean

Written 2026-09-22, after a night on the road showed two faults: a new song
started anywhere from 4 s to 40 s in, and hunting through a queue was slow.
Both are fixed. This is what was wrong, what the code does now, and the
measurements, so none of it has to be rediscovered.

## The bug that mattered: iOS does not believe an open playlist

The server transcodes on demand: one ffmpeg per (track, profile) writing 4 s
AAC segments into `/data/transcodes`, an EVENT playlist while it runs, closed
with `#EXT-X-ENDLIST` when it finishes.

Handing iOS that open playlist is the whole problem. RFC 8216 says a client
SHOULD NOT start within three target durations of the end of a playlist with
no ENDLIST, and SHOULD reload it no more than once per target duration. So
AVFoundation treats a still-being-written playlist as live:

- Served 1 segment, it plays those 4 s and then waits a full 4 s to learn
  there is more. That was the original slow start.
- Served 4 segments (a first attempt at "more runway"), it jumps to the live
  edge instead. The nginx log for *fairy song* caught it exactly: the phone
  got 4 segments, re-fetched a second later, saw 13, and asked for
  `s0010/s0011/s0012` first. **That is the 40-seconds-in report.**
- `#EXT-X-START:TIME-OFFSET=0` does not save you: the spec explicitly says
  the offset SHOULD NOT be within three target durations of the end of a
  playlist with no ENDLIST, and Apple's own guidance is to use a small
  positive offset (0.01) rather than 0 anyway.

### The fix: synthesise the finished playlist

ffmpeg's segment boundaries are deterministic. AAC frames are 1024 samples,
and the muxer cuts at the first frame at or past each *k* x 4 s mark, so for
a known sample rate every `EXTINF` is known before a single byte is encoded:

| Sample rate | Segment durations ffmpeg writes |
|---|---|
| 44100 | 4.017056 / 3.993833 (ceil(4 x sr / 1024) x 1024 / sr, alternating) |
| 48000 | 4.010667 / 3.989333 |
| 96000 | 4.000000 exactly |

`syntheticPlaylist(durationMs, sampleRate)` in `server/src/stream.ts` builds
the complete VOD playlist (`#EXT-X-PLAYLIST-TYPE:VOD`, every segment,
`#EXT-X-ENDLIST`) from the track's duration and sample rate in the database.
While ffmpeg is still encoding, that is what the playlist route returns, so
iOS never sees a live playlist and always starts at 0. The segment route
waits (up to 30 s, polling 50 ms) for a segment ffmpeg has not reached yet,
and gives up early once `done` exists.

Verified against real playlists at all three sample rates: same segment
count, durations within 10 microseconds, totals within 25 ms of what ffmpeg
wrote. `server/src/stream.test.ts` holds those real sequences as fixtures
(`fixtures.hls-durations.json`), so a future change to the ffmpeg flags that
breaks the assumption fails the suite.

A final sliver under 150 ms folds into the segment before it: the database
duration can be a few ms off the decoder's, and listing a segment that never
gets written would stall the player at the end of the track.

## Time to first audio, measured on the box

ffmpeg is not the bottleneck. AAC encodes at roughly 55x realtime here, so
"4 s of audio" costs about 150 ms, and a 4 minute track is fully transcoded
in about 3.5 s.

| Case | Playlist TTFB | Notes |
|---|---|---|
| cold, synthetic VOD answer | 365 ms | 41 segments listed, ENDLIST, 43 ms of that is ffmpeg spawn |
| already transcoded | 1-5 ms | `done` marker present |
| a segment ffmpeg has not reached | 3.5 s | only reachable by asking for the end of a cold track |
| over the public path, HTTP/2, warm | 17-50 ms | one reused connection |

Rejected after measuring: `-hls_time 2` (saves ~55 ms, doubles the request
count), `-hls_init_time` (ignored with `hls_list_size 0`, and it makes
`EXT-X-TARGETDURATION` change over time, which the spec forbids), fMP4
segments (no startup gain; it is the right container only if sample-accurate
gapless matters, since TS cannot signal AAC encoder delay and Apple trims a
fixed 2112 samples).

## Warming ahead

- **From the session.** `server/src/session.ts` already receives each
  client's queue and index, so on every queue or now-playing message the
  next three tracks are queued for transcode. This works for skips from the
  lock screen or another client, not just taps in the app.
- **From the client.** `POST /api/stream/warm { ids, profile }` for the next
  two items, so the server uses the profile that client actually plays.
- **Low priority, bounded.** Warms run `nice -n 10`, two at a time, and a
  slot is held until ffmpeg *exits*. Freeing the slot as soon as a track was
  merely startable fanned out to ~30 encoders and spiked load to 16.
- **Browser cache.** `jf.prewarm()` fetches the playlist (retrying until it
  carries ENDLIST) and the first two segments with `fetch()`. WebKit stores
  `fetch()` responses in the disk cache and the native HLS loader reads that
  cache, though its own downloads never write to it. Segments are therefore
  served `private, max-age=604800, immutable` with a `Content-Length`.
- **Nightly.** Between 03:00 and 06:00 local, likes + playlist members +
  the last 30 days of plays are transcoded at `aac-320` through the same
  queue, then `/data/transcodes` is trimmed to 60 GB, oldest-used first
  (mtime of `done`, touched on each playlist hit). About 43 KB per second of
  audio at 320k, so the current hot set is tens of GB.

## Two audio elements

`web/src/player/usePlayer.js` keeps a playing element and a spare. As soon as
a track starts, the spare gets the next queue item's URL and `load()`. A skip
to that track swaps the elements and calls `play()`.

- No `src` teardown, so no gap and no "Not Playing" flash on the lock screen
  (iOS ends an element's media session the moment its `src` changes).
- iOS clamps `preload` to `metadata` and blocks playback until an element has
  seen a user gesture, **per element**, and `load()` inside a gesture lifts
  both restrictions. So the spare is `load()`ed once on the first
  touch/click anywhere in the app; after that it buffers unprompted.
- Each element has its own `MediaElementSource` (a source can only be made
  once per element). `webAudio().setActive(el)` moves the visualizer's tap;
  `Visualizer.jsx` already subscribed to `onSource(next, prev)`.
- If the spare will not play (not unlocked, buffer evicted, bad stream) the
  swap reverts and the normal load path runs.

## Rapid skipping

- `skipTo` moves the UI immediately, then waits 300 ms before loading if the
  previous skip was within 300 ms. Ten fast taps cost one start.
- A `startGenRef` generation is bumped per start; anything that finishes
  after a newer start began is discarded, including `loadedRef`,
  `setPlaying` and the play report.
- A play is only logged after 8 s on the same track, in both the socket path
  (`session.ts`) and the HTTP fallback, so songs skipped past no longer land
  in history or get scrobbled.
- `previous` within a track rewinds in place instead of reloading the stream.
- Per-skip drag removed: one MediaSession artwork instead of three (iOS
  fetched all of them alongside the first segments), and the queue is no
  longer re-serialised to localStorage on every track change.

## Other fixes found on the way

- **Rate limit.** 600/min keyed on `req.ip` without `trustProxy` meant every
  client behind nginx shared one bucket, and a phone pulls 40-60 segment
  requests per track. The log had real 429s mid-skip. Fastify now trusts the
  proxy and the HLS routes opt out of the limiter entirely.
- **Token touch.** `UPDATE tokens SET last_seen` ran on every request; now
  once a minute per token.
- **nginx.** `upstream slopify { keepalive 32 }` plus `proxy_set_header
  Connection ""` (every segment was opening a new connection to node), and a
  TLS session cache. Note `music.baxtergroup.io` is DNS-only on purpose:
  Cloudflare throttles the audio streams.
- **Container timezone.** It ran UTC, so the nightly job fired at the wrong
  hour. `TZ: America/Vancouver` is in the compose file.

## What the transport buttons do

Shuffle cycles **off → on → smart**, repeat cycles **off → all → one**.

| Repeat | Shuffle | End of queue |
|---|---|---|
| all | any | starts over, reshuffled if shuffle is on |
| one | any | replays the track |
| off | off / on | continues with similar songs, most similar first |
| off | smart | continues with similar songs, shuffled |

An artist context continues with more of that artist instead. Continuation
asks for an instant mix of 25, drops anything already queued or excluded
from the taste profile, and appends. If nothing comes back, a playlist or
album restarts.

The music no longer stops on any setting. Before this, repeat off plus
shuffle off parked paused on the last track unless you pressed next, which
is no use in the car or the shower. Smart shuffle is now only about
*shuffling* the additions, not about whether there are any.

## Left undone

- Offline playback (a Service Worker cache of chosen playlists) is the
  biggest remaining gap for the road.
- A native shell (Capacitor) is the only route to CarPlay and Siri; a PWA
  cannot reach either.
- Sample-accurate gapless within an album would mean fMP4 segments, which
  carry the encoder delay in an edit list where MPEG-TS cannot.
- Phones default to `aac-320`; `aac-160` would halve bytes-before-play, and
  iOS exposes no way to detect cellular, so it would be a default change.
- Casting to a PS5 is impossible, not merely unbuilt: it has no Cast
  receiver, no DLNA renderer since the PS4, no usable browser and no
  third-party app SDK. Spotify works there because Sony ships its app. The
  workable setup is music on the speakers with game audio in a headset, or
  the Denon's Video Select showing PS5 video while the AVR plays another
  source.
