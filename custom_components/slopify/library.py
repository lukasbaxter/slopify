"""The Slopify library in Home Assistant's media browser, search and play_media.

Content ids are plain strings:

    album:<id>  artist:<id>  playlist:<id>  genre:<name>  track:<id>
    radio:<track or artist id>   songs that go with it
    liked       the account's Liked Songs
    top         the account's most played songs of the last four weeks
    <list>#<track id>   that list, starting at that song (what a song picked
                        inside an album or playlist plays)

play_media also takes a share link copied from the app, a bare id, or plain
words, which are searched for (the media type, when given, picks albums,
artists, playlists or songs).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import random
import re
import time
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

from homeassistant.components.media_player import (
    BrowseMedia,
    MediaClass,
    MediaType,
    SearchMedia,
    SearchMediaQuery,
)

from .api import NotFound, SlopifyApi
from .const import LETTER_FOLDERS_OVER

ImageUrl = Callable[[str, str, str], str]

HEX_ID = re.compile(r"^[0-9a-f]{32}$")
IMAGE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LIST_CACHE_SECONDS = 120

ROOT = "root"
RECENT, NEW, TOP, LIKED = "recent", "new", "top", "liked"
PLAYLISTS, ALBUMS, ARTISTS, GENRES = "playlists", "albums", "artists", "genres"


class MediaNotFound(Exception):
    """Nothing in the library matches what was asked for."""


class UnsupportedMedia(Exception):
    """Something Slopify cannot play (a URL, a media source)."""


@dataclass
class Playable:
    """Songs to play, and where in them to start."""

    track_ids: list[str]
    index: int = 0
    title: str = ""


def valid_image_id(value: str | None) -> bool:
    """Whether a browse image id is safe to put in a request path."""
    return bool(value and IMAGE_ID.match(value))


def letter_of(name: str) -> str:
    """Folder letter for a name: "The Beatles" files under B, digits under #."""
    text = re.sub(r"^(the|a|an)\s+", "", (name or "").strip(), flags=re.IGNORECASE)
    first = text[:1].upper()
    return first if "A" <= first <= "Z" else "#"


def _ids(tracks: list[dict[str, Any]]) -> list[str]:
    return [t["id"] for t in tracks if isinstance(t, dict) and isinstance(t.get("id"), str)]


def _start_at(ids: list[str], track_id: str | None) -> int:
    if track_id and track_id in ids:
        return ids.index(track_id)
    return 0


class Library:
    """Browse, search and resolve against one Slopify account."""

    def __init__(self, api: SlopifyApi, image_url: ImageUrl) -> None:
        """Initialize the library."""
        self._api = api
        self._image_url = image_url
        self._cache: dict[str, tuple[float, Any]] = {}

    async def _cached(self, key: str, fetch: Callable[[], Any]) -> Any:
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < LIST_CACHE_SECONDS:
            return hit[1]
        value = await fetch()
        self._cache[key] = (time.monotonic(), value)
        return value

    # --- items ----------------------------------------------------------------

    def _thumb(self, content_type: str, content_id: str, image_id: str | None) -> str | None:
        return self._image_url(content_type, content_id, image_id) if image_id and valid_image_id(image_id) else None

    def _folder(
        self,
        content_id: str,
        title: str,
        children_class: MediaClass | None = None,
        *,
        can_play: bool = False,
        thumb_id: str | None = None,
    ) -> BrowseMedia:
        return BrowseMedia(
            media_class=MediaClass.PLAYLIST if can_play else MediaClass.DIRECTORY,
            media_content_id=content_id,
            media_content_type=MediaType.PLAYLIST if can_play else "directory",
            title=title,
            can_play=can_play,
            can_expand=True,
            children_media_class=children_class,
            thumbnail=self._thumb(MediaType.PLAYLIST, content_id, thumb_id),
        )

    def album_item(self, album: dict[str, Any], *, with_artist: bool = True) -> BrowseMedia:
        """An album in a list."""
        cid = f"album:{album['id']}"
        title = album.get("name") or "Unknown album"
        if with_artist and album.get("artist"):
            title = f"{title} · {album['artist']}"
        return BrowseMedia(
            media_class=MediaClass.ALBUM,
            media_content_id=cid,
            media_content_type=MediaType.ALBUM,
            title=title,
            can_play=True,
            can_expand=True,
            thumbnail=self._thumb(MediaType.ALBUM, cid, album["id"] if album.get("cover", True) else None),
        )

    def artist_item(self, artist: dict[str, Any]) -> BrowseMedia:
        """An artist in a list."""
        cid = f"artist:{artist['id']}"
        return BrowseMedia(
            media_class=MediaClass.ARTIST,
            media_content_id=cid,
            media_content_type=MediaType.ARTIST,
            title=artist.get("name") or "Unknown artist",
            can_play=True,
            can_expand=True,
            thumbnail=self._thumb(MediaType.ARTIST, cid, artist["id"] if artist.get("image", True) else None),
        )

    def playlist_item(self, playlist: dict[str, Any]) -> BrowseMedia:
        """A playlist in a list."""
        cid = f"playlist:{playlist['id']}"
        return BrowseMedia(
            media_class=MediaClass.PLAYLIST,
            media_content_id=cid,
            media_content_type=MediaType.PLAYLIST,
            title=playlist.get("name") or "Playlist",
            can_play=True,
            can_expand=True,
            thumbnail=self._thumb(MediaType.PLAYLIST, cid, playlist["id"] if playlist.get("cover") else None),
        )

    def track_item(
        self, track: dict[str, Any], context: str | None = None, *, with_artist: bool = True, thumb: bool = True
    ) -> BrowseMedia:
        """A song; picked inside a list it plays that list from there."""
        cid = f"{context}#{track['id']}" if context else f"track:{track['id']}"
        title = track.get("title") or "Unknown song"
        if with_artist and track.get("artist"):
            title = f"{title} · {track['artist']}"
        image = track.get("albumId") if track.get("cover", True) else None
        return BrowseMedia(
            media_class=MediaClass.TRACK,
            media_content_id=cid,
            media_content_type=MediaType.TRACK,
            title=title,
            can_play=True,
            can_expand=False,
            thumbnail=self._thumb(MediaType.TRACK, cid, image) if thumb else None,
        )

    def genre_item(self, tile: dict[str, Any]) -> BrowseMedia:
        """A genre tile."""
        cid = f"genre:{quote(str(tile.get('name') or ''), safe='')}"
        return BrowseMedia(
            media_class=MediaClass.GENRE,
            media_content_id=cid,
            media_content_type=MediaType.GENRE,
            title=str(tile.get("name") or "Genre"),
            can_play=True,
            can_expand=True,
            thumbnail=self._thumb(MediaType.GENRE, cid, tile.get("coverId")),
        )

    # --- browsing -------------------------------------------------------------

    async def browse(self, content_id: str | None) -> BrowseMedia:
        """The node for a content id (the root when none)."""
        cid = content_id or ROOT
        try:
            node = await self._browse(cid)
        except NotFound as err:
            raise MediaNotFound(cid) from err
        if node is None:
            raise MediaNotFound(cid)
        return node

    async def _browse(self, cid: str) -> BrowseMedia | None:
        if cid == ROOT:
            root = BrowseMedia(
                media_class=MediaClass.DIRECTORY,
                media_content_id=ROOT,
                media_content_type="directory",
                title="Slopify",
                can_play=False,
                can_expand=True,
                can_search=True,
                children=[
                    self._folder(RECENT, "Recently played", MediaClass.ALBUM),
                    self._folder(LIKED, "Liked Songs", MediaClass.TRACK, can_play=True),
                    self._folder(PLAYLISTS, "Playlists", MediaClass.PLAYLIST),
                    self._folder(ARTISTS, "Artists", MediaClass.ARTIST),
                    self._folder(ALBUMS, "Albums", MediaClass.ALBUM),
                    self._folder(GENRES, "Genres", MediaClass.GENRE),
                    self._folder(NEW, "Newly added", MediaClass.ALBUM),
                    self._folder(TOP, "Your top songs", MediaClass.TRACK, can_play=True),
                ],
            )
            root.children_media_class = MediaClass.DIRECTORY
            return root
        if cid in (RECENT, NEW):
            home = await self._api.home()
            albums = home.get("recentAlbums" if cid == RECENT else "newestAlbums") or []
            return self._list(
                cid,
                "Recently played" if cid == RECENT else "Newly added",
                [self.album_item(a) for a in albums],
                MediaClass.ALBUM,
            )
        if cid == TOP:
            tracks = (await self._api.home()).get("topTracks") or []
            return self._list(
                cid, "Your top songs", [self.track_item(t, TOP) for t in tracks], MediaClass.TRACK, can_play=True
            )
        if cid == LIKED:
            tracks = await self._api.liked()
            return self._list(
                cid, "Liked Songs", [self.track_item(t, LIKED) for t in tracks], MediaClass.TRACK, can_play=True
            )
        if cid == PLAYLISTS:
            items = await self._api.playlists()
            return self._list(cid, "Playlists", [self.playlist_item(p) for p in items], MediaClass.PLAYLIST)
        if cid == GENRES:
            tiles = await self._api.genres()
            return self._list(cid, "Genres", [self.genre_item(t) for t in tiles], MediaClass.GENRE)
        if cid == ALBUMS or cid.startswith("albums:"):
            albums = await self._cached(ALBUMS, self._api.albums)
            return self._lettered(cid, "Albums", albums, self.album_item, MediaClass.ALBUM)
        if cid == ARTISTS or cid.startswith("artists:"):
            artists = await self._cached(ARTISTS, self._api.artists)
            return self._lettered(cid, "Artists", artists, self.artist_item, MediaClass.ARTIST)

        kind, _, rest = cid.partition(":")
        if kind == "album":
            album = await self._api.album(rest)
            node = self.album_item(album, with_artist=False)
            node.title = album.get("name") or node.title
            node.children = [
                self.track_item(t, cid, with_artist=_other_artist(t, album), thumb=False)
                for t in album.get("tracks") or []
            ]
            node.children_media_class = MediaClass.TRACK
            return node
        if kind == "playlist":
            pl = await self._api.playlist(rest)
            node = self.playlist_item(pl)
            node.children = [self.track_item(t, cid) for t in pl.get("tracks") or []]
            node.children_media_class = MediaClass.TRACK
            return node
        if kind == "artist":
            artist = await self._api.artist(rest)
            node = self.artist_item(artist)
            children = [
                BrowseMedia(
                    media_class=MediaClass.PLAYLIST,
                    media_content_id=f"radio:{rest}",
                    media_content_type=MediaType.PLAYLIST,
                    title=f"{artist.get('name') or 'Artist'} Radio",
                    can_play=True,
                    can_expand=False,
                    thumbnail=self._thumb(MediaType.PLAYLIST, f"radio:{rest}", rest if artist.get("image") else None),
                )
            ]
            children += [self.album_item(a, with_artist=False) for a in artist.get("albums") or []]
            if artist.get("appearsOn"):
                children.append(self._folder(f"appears:{rest}", "Appears On", MediaClass.ALBUM))
            node.children = children
            node.children_media_class = MediaClass.ALBUM
            return node
        if kind == "appears":
            artist = await self._api.artist(rest)
            return self._list(
                cid,
                f"{artist.get('name') or 'Artist'}: Appears On",
                [self.album_item(a) for a in artist.get("appearsOn") or []],
                MediaClass.ALBUM,
            )
        if kind == "genre":
            name = unquote(rest)
            genre = await self._api.genre(name)
            node = self.genre_item({"name": name})
            node.children = [self.album_item(a) for a in genre.get("albums") or []]
            node.children_media_class = MediaClass.ALBUM
            return node
        return None

    def _list(
        self, cid: str, title: str, children: list[BrowseMedia], children_class: MediaClass, *, can_play: bool = False
    ) -> BrowseMedia:
        node = self._folder(cid, title, children_class, can_play=can_play)
        node.children = children
        return node

    def _lettered(
        self,
        cid: str,
        title: str,
        items: list[dict[str, Any]],
        make: Callable[[dict[str, Any]], BrowseMedia],
        cls: MediaClass,
    ) -> BrowseMedia:
        def name(item: dict[str, Any]) -> str:
            return str(item.get("name") or "")

        base = cid.split(":", 1)[0]
        if ":" in cid:
            letter = cid.split(":", 1)[1]
            return self._list(cid, f"{title}: {letter}", [make(i) for i in items if letter_of(name(i)) == letter], cls)
        if len(items) <= LETTER_FOLDERS_OVER:
            return self._list(cid, title, [make(i) for i in items], cls)
        letters = sorted({letter_of(name(i)) for i in items}, key=lambda x: (x == "#", x))
        return self._list(cid, title, [self._folder(f"{base}:{x}", x, cls) for x in letters], MediaClass.DIRECTORY)

    # --- search ---------------------------------------------------------------

    async def search(self, query: SearchMediaQuery) -> SearchMedia:
        """Library search, filtered to the media classes asked for."""
        text = (query.search_query or "").strip()
        if not text:
            return SearchMedia(result=[])
        found = await self._api.search(text, limit=20)
        wanted = set(query.media_filter_classes or [])
        if query.media_content_type in (MediaType.ALBUM, MediaType.ARTIST, MediaType.PLAYLIST, MediaType.TRACK):
            wanted.add(MediaClass(str(query.media_content_type)))
        out: list[BrowseMedia] = []

        def want(cls: MediaClass) -> bool:
            return not wanted or cls in wanted

        if want(MediaClass.ARTIST):
            out += [self.artist_item(a) for a in found.get("artists") or []]
        if want(MediaClass.ALBUM):
            out += [self.album_item(a) for a in found.get("albums") or []]
        if want(MediaClass.PLAYLIST):
            needle = text.casefold()
            out += [
                self.playlist_item(p)
                for p in await self._api.playlists()
                if needle in str(p.get("name", "")).casefold()
            ]
        if want(MediaClass.TRACK):
            out += [self.track_item(t) for t in found.get("tracks") or []]
        return SearchMedia(result=out)

    # --- play_media -------------------------------------------------------------

    async def resolve(self, media_type: str | None, media_id: str) -> Playable:
        """The songs a play_media request means."""
        media_id = (media_id or "").strip()
        if not media_id:
            raise MediaNotFound("")
        if media_id.startswith(("media-source://", "/")) or (
            media_id.startswith(("http://", "https://")) and not _share_target(media_id)
        ):
            raise UnsupportedMedia(media_id)
        if media_id.startswith(("http://", "https://")):
            media_id = _share_target(media_id) or media_id
        try:
            return await self._resolve(media_type, media_id)
        except NotFound as err:
            raise MediaNotFound(media_id) from err

    async def _resolve(self, media_type: str | None, media_id: str) -> Playable:
        ctx, _, start = media_id.partition("#")
        kind, _, rest = ctx.partition(":")
        if kind == "album" and rest:
            album = await self._api.album(rest)
            ids = _ids(album.get("tracks") or [])
            return Playable(ids, _start_at(ids, start), album.get("name", ""))
        if kind == "playlist" and rest:
            pl = await self._api.playlist(rest)
            ids = _ids(pl.get("tracks") or [])
            return Playable(ids, _start_at(ids, start), pl.get("name", ""))
        if ctx == LIKED:
            ids = _ids(await self._api.liked())
            return Playable(ids, _start_at(ids, start), "Liked Songs")
        if ctx == TOP:
            ids = _ids((await self._api.home()).get("topTracks") or [])
            return Playable(ids, _start_at(ids, start), "Your top songs")
        if kind == "artist" and rest:
            artist = await self._api.artist(rest)
            ids = _ids(artist.get("tracks") or [])
            random.shuffle(ids)
            return Playable(ids, 0, artist.get("name", ""))
        if kind == "radio" and rest:
            return Playable(_ids(await self._api.mix(rest)), 0, "Radio")
        if kind == "genre" and rest:
            name = unquote(rest)
            return Playable(_ids(await self._api.genre_mix(name)), 0, name)
        if kind == "track" and rest:
            return Playable([rest], 0)
        if HEX_ID.match(media_id):
            return await self._resolve_bare(media_type, media_id)
        return await self._resolve_words(media_type, media_id)

    async def _resolve_bare(self, media_type: str | None, item_id: str) -> Playable:
        hint = str(media_type or "")
        if hint in (MediaType.ALBUM, MediaType.ARTIST, MediaType.PLAYLIST, MediaType.TRACK):
            with_hint = f"{hint}:{item_id}"
            try:
                return await self._resolve(None, with_hint)
            except NotFound:
                pass
        found = await self._api.item(item_id)
        return await self._resolve(None, f"{found.get('kind')}:{item_id}")

    async def _resolve_words(self, media_type: str | None, words: str) -> Playable:
        hint = str(media_type or "")
        needle = words.casefold()
        if hint == MediaType.PLAYLIST:
            for p in await self._api.playlists():
                if needle in str(p.get("name", "")).casefold():
                    return await self._resolve(None, f"playlist:{p['id']}")
            raise MediaNotFound(words)
        found = await self._api.search(words, limit=10)
        artists, albums, tracks = found.get("artists") or [], found.get("albums") or [], found.get("tracks") or []
        if hint == MediaType.ARTIST and artists:
            return await self._resolve(None, f"artist:{artists[0]['id']}")
        if hint == MediaType.ALBUM and albums:
            return await self._resolve(None, f"album:{albums[0]['id']}")
        if hint in (MediaType.TRACK, MediaType.MUSIC) and tracks:
            return Playable([tracks[0]["id"]], 0, tracks[0].get("title", ""))
        if hint in (MediaType.ARTIST, MediaType.ALBUM, MediaType.TRACK, MediaType.MUSIC):
            raise MediaNotFound(words)
        # No type: an exact name wins, artist before album before song.
        for artist in artists:
            if str(artist.get("name", "")).casefold() == needle:
                return await self._resolve(None, f"artist:{artist['id']}")
        for album in albums:
            if str(album.get("name", "")).casefold() == needle:
                return await self._resolve(None, f"album:{album['id']}")
        if tracks:
            return Playable([tracks[0]["id"]], 0, tracks[0].get("title", ""))
        if albums:
            return await self._resolve(None, f"album:{albums[0]['id']}")
        if artists:
            return await self._resolve(None, f"artist:{artists[0]['id']}")
        raise MediaNotFound(words)


def _other_artist(track: dict[str, Any], album: dict[str, Any]) -> bool:
    return bool(track.get("artist")) and str(track.get("artist")).casefold() != str(album.get("artist", "")).casefold()


def _share_target(url: str) -> str | None:
    """`album:<id>` etc. for a share link copied out of the Slopify app."""
    query = parse_qs(urlparse(url).query)
    for kind in ("track", "album", "artist"):
        value = (query.get(kind) or [""])[0]
        if HEX_ID.match(value):
            return f"{kind}:{value}"
    return None
