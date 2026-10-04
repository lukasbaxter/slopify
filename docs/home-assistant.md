# Slopify in Home Assistant

The Slopify integration puts your Slopify playback session in Home
Assistant as a media player. One player per Slopify account. It shows
whatever that account is playing, wherever it is playing (the web app, a
phone, the desktop app, or a Chromecast / BluOS speaker the server drives),
and controls it there.

- **Controls**: play, pause, next, previous, seek, volume, mute, shuffle,
  repeat, clear the queue.
- **Sources**: the speakers your server can see and the Slopify apps that can
  play. Picking one moves the music there and it carries on where it was, with
  the rest of the queue.
- **Media browser**: Recently played, Liked Songs, Playlists, Artists (with an
  artist radio), Albums, Genres, Newly added, Your top songs.
- **Search**: from the media browser, and for voice assistants.
- **play_media**: albums, artists, playlists, songs, genres, share links
  copied from the app, or just words ("OK Computer").
- **Live**: updates are pushed over the same socket the apps use, with no
  polling. The player's state changes the moment the music does.

Requires Home Assistant 2025.7 or newer.

## Install

### With HACS

1. In Home Assistant open **HACS**, the three-dot menu, **Custom
   repositories**.
2. Add `https://github.com/lukasbaxter/slopify` with the type
   **Integration**.
3. Find **Slopify** in HACS, open it, **Download**.
4. Restart Home Assistant.

### By hand

Copy the `custom_components/slopify` folder from this repository into the
`custom_components` folder of your Home Assistant configuration (create it if
it does not exist), so you have `config/custom_components/slopify/manifest.json`.
Restart Home Assistant.

## Set up

If your Slopify server is on the same network, Home Assistant usually finds it
on its own: look for **Slopify** under **Settings > Devices & services >
Discovered**, and select **Add**. Otherwise select **Add integration** and
search for **Slopify**.

Then fill in:

- **Server address**: the address you open Slopify at, for example
  `http://192.168.1.20:8080` or `https://music.example.com`. A discovered
  server has this filled in already.
- **Username** and **password** of the Slopify account to follow.

Home Assistant signs in once and keeps only a sign-in token, never your
password. In the Slopify app the token shows up as **Home Assistant** under
your signed-in devices, where you can revoke it at any time.

To follow several accounts (everyone in the house), add the integration once
per account. Each gets its own player, named `media_player.slopify_<username>`.

### Options

**Where to start playing** decides where Play and play media start the music
when nothing is playing anywhere:

- **Where it last played** (the default): the speaker the account last played
  on. If the music last played in an app rather than on a speaker, or that
  speaker is gone, Home Assistant asks you to pick a source instead. The one
  exception is a house with exactly one place to play, which is always used.
- A speaker or an app: always start there.

While something is playing, Play and play media go to wherever it is
playing.

## Using it

### The player

| State | Meaning |
| --- | --- |
| Playing / Paused | Something is playing (or paused) on the source shown. All controls work. |
| Idle | Nothing is playing. The card shows what played last; **Play** resumes it, from where it stopped, at the place set in the options. |
| Unavailable | Home Assistant cannot reach the Slopify server right now. It keeps retrying on its own. |

**Stop** pauses: Slopify keeps your place. **Mute** turns the volume to
zero, and unmute brings it back to where it was.

The player also has a `liked` attribute: whether the current song is in your
Liked Songs.

### Moving the music

Pick a **source** on the player card, or in an automation:

```yaml
action: media_player.select_source
target:
  entity_id: media_player.slopify_lukas
data:
  source: Kitchen
```

Speakers keep playing with nothing else open: the Slopify server drives them.
An app as a source (a browser tab, a phone, the desktop app) plays on that
device's own output. Browsers only start sound by themselves in a tab that
has already played something. The desktop app and speakers always start.

### Playing something

From the media browser, or with `media_player.play_media`:

```yaml
action: media_player.play_media
target:
  entity_id: media_player.slopify_lukas
data:
  media_content_type: album
  media_content_id: OK Computer
```

`media_content_id` can be:

| Content id | Plays |
| --- | --- |
| `album:<id>` | the album |
| `artist:<id>` | the artist's songs, shuffled |
| `radio:<artist or song id>` | songs that go with it |
| `playlist:<id>` | the playlist |
| `liked` | your Liked Songs |
| `top` | your most played songs of the last four weeks |
| `genre:<name>` | a mix of the genre |
| `track:<id>` | one song (Slopify keeps going with similar music after it) |
| a share link from the app | what it links to (song, album or artist) |
| words | a search; `media_content_type` picks `album`, `artist`, `playlist` or `track`, and without one an exact artist or album name wins, then the best matching song |

The easiest way to get an id: in the automation editor add a **Play media**
action, pick the item with the media browser there, then switch the action to
YAML to see its `media_content_id`.

Play somewhere else than where the music is now (and start there if nothing
is playing):

```yaml
action: media_player.play_media
target:
  entity_id: media_player.slopify_lukas
data:
  media_content_type: playlist
  media_content_id: liked
  extra:
    source: Living Room
```

With `enqueue: add` or `enqueue: next` the songs go into the queue to play
after the current song, the way the app's Add to queue does. Both behave the
same. `enqueue: play` and `enqueue: replace` (and no `enqueue`) start the new
music now, replacing the queue.

### Voice

The player supports media search, so Assist can find and play music in your
library ("play Radiohead on Slopify").

## Server side

Nothing to configure. The server announces itself on the network (mDNS,
`_slopify._tcp`) so Home Assistant can discover it. Two settings exist if you
need them:

| Env | Default | What it does |
| --- | --- | --- |
| `MDNS` | `1` | `0` stops the announcement (Home Assistant can still be set up by address) |
| `SERVER_NAME` | `Slopify on <host name>` | The name the discovered server is shown under |

Discovery needs the container on the host network (`network_mode: host`,
which speaker discovery also needs). In bridge mode, add the integration by
address.

## Troubleshooting

- **Not discovered**: the server must be on the host network and on the same
  network as Home Assistant, and `MDNS` must not be `0`. Add it by address
  instead. Everything else works the same.
- **"Nothing answered at that address"**: check the address and port from the
  Home Assistant machine (for example `curl http://192.168.1.20:8080/api/healthz`
  should answer `{"ok":true}`).
- **Player stays unavailable**: Home Assistant reaches the REST API but not
  the live socket. If Slopify is behind a reverse proxy, the proxy must pass
  WebSockets through for `/api/ws` (the Slopify apps need this too).
- **Home Assistant asks you to sign in again**: the sign-in was revoked in the
  app, or the account's password changed (which signs out every other
  device). Sign in again from the notification; nothing else is lost.
- **"This account has to change its password first"**: a new account (or the
  first admin) must set its own password in the Slopify app before anything
  else can use it.
- **"Pick a source" errors from Play or play media**: nothing is playing and
  Home Assistant does not know where to start. Pick a source, pass
  `extra: {source: ...}`, or set **Where to start playing** in the options.
- **Diagnostics**: Settings > Devices & services > Slopify > the three dots >
  Download diagnostics. The file never contains your sign-in.

## Removing

Settings > Devices & services > Slopify > the three dots > **Delete**. Home
Assistant signs itself out of Slopify as it goes.

## Development

The integration lives in `custom_components/slopify` beside the server, so
protocol changes and the integration change together. Its tests run against an
in-process fake Slopify server speaking the same messages as
`server/src/session.ts`:

```
python3 -m venv .venv && .venv/bin/pip install -r ha/requirements_test.txt
cd ha && ../.venv/bin/pytest
```
