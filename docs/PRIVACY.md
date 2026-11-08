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
| Soulseek (through your slskd), Lidarr | Downloads, Upgrade to FLAC, filling discographies | Search terms through your own slskd / Lidarr | Off unless `SLSKD_*` / `LIDARR_*` are set |
| [Open-Meteo](https://open-meteo.com) (from the [brain](../brain/README.md)) | Weather where you listen, for recommendations | The city name from the brain's **Where you listen** setting (once, to find it), then only its latitude and longitude and the hours wanted, every hour | Leave **Where you listen** empty and `LAT` / `LON` unset, or run without the brain |
| [Hugging Face](https://huggingface.co) (from the brain) | The audio model (CLAP): downloaded on first start, and checked for a newer copy at each start | The model's name | Run without the brain |
| Whisper and Demucs model downloads (GPU image only) | The lyric aligner's models, downloaded the first time someone presses **Sync Lyrics** | The model's name | Use the slim image, or do not press Sync Lyrics |

On your local network only, never beyond it:

- The server announces itself over mDNS (`_slopify._tcp`) so Home Assistant can
  find it (`MDNS=0` to stop).
- It finds speakers (`SPEAKERS=0` to stop):

  | How | Finds |
  | --- | --- |
  | mDNS | Chromecast and Google TV, BluOS, AirPlay (Apple TV, HomePod), DIY `slopify-speaker/1` bridges |
  | SSDP (UPnP) | DLNA renderers (Sonos, HEOS, smart TVs, Kodi), Roku |
  | A sweep of its own /24 every minute, ports 8009, 11000, 7780 and 7781 | Cast devices mDNS missed, BluOS, bridges, TVs running the Slopify TV agent |

- Speakers fetch the audio they play from the server (`PUBLIC_URL`).

The Home Assistant integration talks only to your Slopify server.

If you find a request that is not listed here, please open an issue: this page
is meant to be complete.
