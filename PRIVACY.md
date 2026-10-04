# What leaves your server

Slopify is built to run in your home and keep your music, your listening and
your accounts there. Nothing is sent to the Slopify project: there is no
telemetry, no analytics, no crash reporting and no account with anyone.

Some features look things up on public services. What they send is the names of
artists, albums and songs in your library (as search terms), never your
accounts, passwords or listening history, except where a row below says so.
Every lookup can be turned off.

| Service | What for | What it receives | How to turn it off |
| --- | --- | --- | --- |
| [Deezer](https://www.deezer.com) API | Artist pictures, album covers, genres, similar artists | Artist and album names | Turn off the **Fetch lyrics & artwork**, **Discovery** and **Fill in discographies** tasks (Settings › Tasks) |
| [LrcLib](https://lrclib.net) | Lyrics | Artist, title, album, duration | **Fetch lyrics & artwork** task |
| [NetEase Cloud Music](https://music.163.com), [Genius](https://genius.com) | Finding lyrics when you press **Sync Lyrics** | Artist and title | Only runs when someone presses Sync Lyrics |
| [TheAudioDB](https://www.theaudiodb.com) | Wide artist photos for artist page banners | Artist names | `THEAUDIODB_KEY=` (empty), or the **Fetch lyrics & artwork** task |
| [MusicBrainz](https://musicbrainz.org) and [ListenBrainz](https://listenbrainz.org) | The **Popular** order on artist pages | Artist names | Not yet switchable; the page falls back to your own plays when they cannot be reached |
| ListenBrainz (your account) | Scrobbling and weekly discovery playlists | **Your listening history**, sent to your own ListenBrainz account | Off unless a person adds their ListenBrainz token in Settings |
| [Anthropic](https://www.anthropic.com) (Claude) | Generated playlists | The playlist request and song and artist names from your library | Off unless `ANTHROPIC_API_KEY` is set |
| Soulseek (through your slskd), Lidarr | Downloads, Upgrade to FLAC, filling discographies | Search terms through your own slskd / Lidarr | Off unless `SLSKD_*` / `LIDARR_*` are set |

On your local network only, never beyond it:

- The server announces itself over mDNS (`_slopify._tcp`) so Home Assistant can
  find it (`MDNS=0` to stop), and finds Chromecast and BluOS speakers
  (`SPEAKERS=0` to stop).
- Speakers fetch the audio they play from the server (`PUBLIC_URL`).

The Home Assistant integration talks only to your Slopify server.

If you find a request that is not listed here, please open an issue: this page
is meant to be complete.
