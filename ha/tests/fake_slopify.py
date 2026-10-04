"""A small Slopify server for tests: the REST routes the integration uses and
the session socket, speaking the same messages as server/src/session.ts."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import json
import secrets
from typing import Any

from aiohttp import WSMsgType, web


def hid(n: int) -> str:
    """A library id (32 hex characters)."""
    return f"{n:032x}"


USER_ID = "a" * 32
SERVER_ID = "5" * 32
SERVER_CLIENT = f"server:{USER_ID}"

ALBUM_OK = hid(0xA1)
ALBUM_KID = hid(0xA2)
ARTIST_RH = hid(0xB1)
ARTIST_FEAT = hid(0xB2)
T1, T2, T3, T4, T5 = (hid(0xC0 + i) for i in range(1, 6))
PLAYLIST = "pl_" + "9" * 24


def track(
    tid: str, title: str, album: str, album_id: str, no: int, artist: str = "Radiohead", artist_id: str = ARTIST_RH
) -> dict[str, Any]:
    return {
        "id": tid,
        "title": title,
        "artist": artist,
        "artists": [artist],
        "artistIds": [artist_id],
        "albumId": album_id,
        "album": album,
        "albumArtist": "Radiohead",
        "trackNo": no,
        "discNo": 1,
        "durationMs": 200000 + no * 1000,
        "cover": "c" * 40,
    }


TRACKS = {
    T1: track(T1, "Airbag", "OK Computer", ALBUM_OK, 1),
    T2: track(T2, "Paranoid Android", "OK Computer", ALBUM_OK, 2),
    T3: track(T3, "Lucky", "OK Computer", ALBUM_OK, 3, artist="Radiohead, Guest", artist_id=ARTIST_FEAT),
    T4: track(T4, "Everything In Its Right Place", "Kid A", ALBUM_KID, 1),
    T5: track(T5, "Kid A", "Kid A", ALBUM_KID, 2),
}


def album(aid: str, name: str, tracks: list[str], year: int) -> dict[str, Any]:
    return {
        "id": aid,
        "name": name,
        "artist": "Radiohead",
        "artistId": ARTIST_RH,
        "year": year,
        "trackCount": len(tracks),
        "durationMs": 1,
        "cover": "c" * 40,
        "addedAt": 1,
    }


ALBUMS = {
    ALBUM_OK: (album(ALBUM_OK, "OK Computer", [T1, T2, T3], 1997), [T1, T2, T3]),
    ALBUM_KID: (album(ALBUM_KID, "Kid A", [T4, T5], 2000), [T4, T5]),
}


def row(tid: str) -> dict[str, Any]:
    """A queue row the way the apps publish them (Jellyfin-shaped)."""
    t = TRACKS[tid]
    return {
        "Id": tid,
        "Name": t["title"],
        "Artists": t["artists"],
        "AlbumArtist": "Radiohead",
        "Album": t["album"],
        "AlbumId": t["albumId"],
        "RunTimeTicks": t["durationMs"] * 10000,
        "ArtistItems": [],
        "AlbumArtists": [],
        "UserData": {"IsFavorite": False},
        "_queued": False,
    }


def now_playing(
    tid: str,
    *,
    playing: bool = True,
    position: float = 30.0,
    device: dict[str, Any] | None = None,
    queue_index: int = 0,
    volume: int = 70,
    shuffle: str = "off",
    repeat: str = "off",
) -> dict[str, Any]:
    t = TRACKS[tid]
    return {
        "itemId": tid,
        "title": t["title"],
        "artist": t["artist"],
        "album": t["album"],
        "artUrl": "http://x/api/image/1?token=SECRET",
        "albumId": t["albumId"],
        "artistId": t["artistIds"][0],
        "artists": [],
        "liked": False,
        "device": device or {"id": "local", "kind": "local", "name": "This Web Player"},
        "queueIndex": queue_index,
        "playing": playing,
        "position": position,
        "duration": t["durationMs"] / 1000,
        "volume": volume,
        "repeat": repeat,
        "shuffle": shuffle,
        "at": 123,
    }


SPEAKER_KITCHEN = {
    "id": "cast:kitchen",
    "kind": "cast",
    "name": "Kitchen",
    "model": "Nest Audio",
    "host": "10.0.0.5",
    "port": 8009,
}
SPEAKER_DEN = {
    "id": "bluos:10.0.0.6",
    "kind": "bluos",
    "name": "Den",
    "model": "BluOS",
    "host": "10.0.0.6",
    "port": 11000,
}


class FakeSlopify:
    """In-process Slopify server."""

    def __init__(self) -> None:
        self.password = "correct horse"
        self.must_change = False
        self.tokens: dict[str, str] = {"tok-valid": USER_ID}
        self.logged_out: list[str] = []
        self.health_ok = True
        self.hellos: list[dict[str, Any]] = []
        self.received: list[dict[str, Any]] = []
        self.sockets: list[web.WebSocketResponse] = []
        self.players: list[dict[str, Any]] = []
        self.lan: list[dict[str, Any]] = []
        self.active: str | None = None
        self.queues: dict[str, list[dict[str, Any]]] = {}
        self.session: dict[str, Any] | None = None
        self.requests: list[str] = []
        self.url = ""
        self._runner: web.AppRunner | None = None

    # --- lifecycle --------------------------------------------------------------

    async def start(self) -> str:
        app = web.Application()
        # Also served under /moved, which stands in for the server at a new address.
        for base in ("", "/moved"):
            app.router.add_get(f"{base}/api/healthz", self._health)
            app.router.add_post(f"{base}/api/auth/login", self._login)
            app.router.add_get(f"{base}/api/auth/me", self._me)
            app.router.add_post(f"{base}/api/auth/logout", self._logout)
            app.router.add_get(f"{base}/api/server", self._server)
            app.router.add_get(f"{base}/api/ws", self._ws)
            app.router.add_get(f"{base}/api/image/{{id}}", self._image)
            app.router.add_get(f"{base}/api/{{tail:.*}}", self._library)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        return self.url

    async def stop(self) -> None:
        for ws in list(self.sockets):
            await ws.close()
        if self._runner:
            await self._runner.cleanup()

    # --- session ------------------------------------------------------------------

    def roster(self) -> dict[str, Any]:
        lan = [{**d, "viaClient": d.get("viaClient", SERVER_CLIENT)} for d in self.lan]
        server = {
            "id": SERVER_CLIENT,
            "name": "Home speakers",
            "kind": "server",
            "canPlay": False,
            "nowPlaying": None,
            "sameNetwork": True,
        }
        players = [server, *[p for p in self.players if p["id"] != SERVER_CLIENT]]
        for p in self.players:
            if p["id"] == SERVER_CLIENT:
                players[0] = {**server, **p}
        return {"type": "roster", "players": players, "lanDevices": lan, "activeClientId": self.active}

    async def broadcast(self, msg: dict[str, Any]) -> None:
        for ws in list(self.sockets):
            if not ws.closed:
                await ws.send_json(msg)

    async def set_roster(
        self,
        *,
        players: list[dict[str, Any]] | None = None,
        lan: list[dict[str, Any]] | None = None,
        active: str | type[...] | None = ...,
    ) -> None:
        if players is not None:
            self.players = players
        if lan is not None:
            self.lan = lan
        if active is not ...:
            self.active = active  # type: ignore[assignment]
        await self.broadcast(self.roster())

    async def send_queue(self, sender: str, rows: list[dict[str, Any]]) -> None:
        self.queues[sender] = rows
        await self.broadcast({"type": "queue", "from": sender, "queue": rows})

    async def send_session(self, np: dict[str, Any] | None, rows: list[dict[str, Any]]) -> None:
        self.session = {"type": "session", "nowPlaying": np, "queue": rows, "at": 1}
        await self.broadcast(self.session)

    async def drop_sockets(self, code: int = 1001) -> None:
        for ws in list(self.sockets):
            await ws.close(code=code)

    def commands(self) -> list[dict[str, Any]]:
        return [m for m in self.received if m.get("type") == "command"]

    async def wait_for(self, check: Callable[[], Any], timeout: float = 5.0) -> Any:
        async with asyncio.timeout(timeout):
            while not (result := check()):
                await asyncio.sleep(0.01)
            return result

    # --- handlers -------------------------------------------------------------------

    def _user(self, request: web.Request) -> str | None:
        auth = request.headers.get("Authorization", "")
        return self.tokens.get(auth.removeprefix("Bearer ")) if auth.startswith("Bearer ") else None

    async def _health(self, request: web.Request) -> web.StreamResponse:
        if not self.health_ok:
            return web.Response(text="<html>a router</html>", content_type="text/html")
        return web.json_response({"ok": True})

    async def _login(self, request: web.Request) -> web.StreamResponse:
        body = await request.json()
        self.requests.append(f"login {body.get('username')} {body.get('device')} {body.get('kind')}")
        if body.get("username") != "lukas" or body.get("password") != self.password:
            return web.json_response({"error": "wrong username or password"}, status=401)
        token = f"tok-{secrets.token_hex(4)}"
        self.tokens[token] = USER_ID
        return web.json_response(
            {
                "token": token,
                "user": {"id": USER_ID, "name": "lukas", "role": "user", "mustChangePassword": self.must_change},
            }
        )

    async def _me(self, request: web.Request) -> web.StreamResponse:
        if not self._user(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        return web.json_response(
            {"id": USER_ID, "name": "lukas", "role": "user", "mustChangePassword": self.must_change}
        )

    async def _logout(self, request: web.Request) -> web.StreamResponse:
        token = request.headers.get("Authorization", "").removeprefix("Bearer ")
        if token not in self.tokens:
            return web.json_response({"error": "unauthorized"}, status=401)
        del self.tokens[token]
        self.logged_out.append(token)
        return web.json_response({"ok": True})

    async def _server(self, request: web.Request) -> web.StreamResponse:
        if not self._user(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        return web.json_response({"id": SERVER_ID, "name": "Slopify on test"})

    async def _image(self, request: web.Request) -> web.StreamResponse:
        if not self._user(request):
            return web.Response(status=401)
        self.requests.append(f"image {request.match_info['id']} {request.query.get('size')}")
        return web.Response(body=b"\xff\xd8" + request.match_info["id"].encode(), content_type="image/jpeg")

    async def _ws(self, request: web.Request) -> web.StreamResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        first = await ws.receive()
        hello = json.loads(first.data)
        if hello.get("type") != "hello" or hello.get("token") not in self.tokens:
            await ws.close(code=4003, message=b"bad token")
            return ws
        self.hellos.append(hello)
        self.sockets.append(ws)
        await ws.send_json(
            {"type": "hello-ok", "clientId": hello["clientId"], "userId": USER_ID, "offsets": {}, "now": 1}
        )
        await ws.send_json(self.roster())
        for sender, rows in self.queues.items():
            await ws.send_json({"type": "queue", "from": sender, "queue": rows})
        if not self.active and self.session:
            await ws.send_json(self.session)
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            self.received.append(data)
            if data.get("type") == "ping":
                await ws.send_json({"type": "pong", "now": 1})
        if ws in self.sockets:
            self.sockets.remove(ws)
        return ws

    async def _library(self, request: web.Request) -> web.StreamResponse:
        user = self._user(request)
        if not user:
            return web.json_response({"error": "unauthorized"}, status=401)
        if self.must_change:
            return web.json_response({"error": "password change required"}, status=403)
        path = "/" + request.match_info["tail"]
        self.requests.append(f"GET {path}")
        q = request.query
        tracks = lambda ids: [TRACKS[i] for i in ids]  # noqa: E731
        if path == "/albums":
            return web.json_response({"items": [a for a, _ in ALBUMS.values()], "total": len(ALBUMS)})
        if path.startswith("/albums/"):
            got = ALBUMS.get(path.split("/")[2])
            if not got:
                return web.json_response({"error": "no such album"}, status=404)
            return web.json_response({**got[0], "tracks": tracks(got[1])})
        if path == "/artists":
            return web.json_response({"items": [{"id": ARTIST_RH, "name": "Radiohead", "image": "i" * 40}]})
        if path.startswith("/artists/"):
            if path.split("/")[2] != ARTIST_RH:
                return web.json_response({"error": "no such artist"}, status=404)
            return web.json_response(
                {
                    "id": ARTIST_RH,
                    "name": "Radiohead",
                    "image": "i" * 40,
                    "albums": [ALBUMS[ALBUM_KID][0], ALBUMS[ALBUM_OK][0]],
                    "appearsOn": [ALBUMS[ALBUM_OK][0]],
                    "tracks": tracks([T1, T2, T4]),
                }
            )
        if path == "/playlists":
            return web.json_response(
                {"items": [{"id": PLAYLIST, "name": "Road Trip", "trackCount": 2, "cover": "c" * 40}]}
            )
        if path == f"/playlists/{PLAYLIST}":
            return web.json_response({"id": PLAYLIST, "name": "Road Trip", "tracks": tracks([T5, T2])})
        if path == "/likes":
            return web.json_response(
                {"at": {T2: 1}, "items": tracks([T2])} if q.get("full") == "1" else {"at": {T2: 1}}
            )
        if path == "/home":
            return web.json_response(
                {
                    "recentAlbums": [ALBUMS[ALBUM_OK][0]],
                    "topTracks": tracks([T1, T4]),
                    "newestAlbums": [ALBUMS[ALBUM_KID][0]],
                }
            )
        if path == "/browse":
            return web.json_response({"tiles": [{"id": "genre:Alt Rock", "name": "Alt Rock", "coverId": ALBUM_OK}]})
        if path == "/genres/Alt Rock":
            return web.json_response({"name": "Alt Rock", "albums": [ALBUMS[ALBUM_OK][0]]})
        if path == "/genres/Alt Rock/mix":
            return web.json_response({"items": tracks([T3, T1])})
        if path.startswith("/tracks/") and path.endswith("/mix"):
            return web.json_response({"items": tracks([T4, T1, T2])})
        if path.startswith("/items/"):
            item = path.split("/")[2]
            if item in ALBUMS:
                return web.json_response({"kind": "album", "item": ALBUMS[item][0]})
            if item in TRACKS:
                return web.json_response({"kind": "track", "item": TRACKS[item]})
            if item == ARTIST_RH:
                return web.json_response({"kind": "artist", "item": {"id": ARTIST_RH}})
            return web.json_response({"error": "no such item"}, status=404)
        if path == "/search":
            text = q.get("q", "").casefold()
            return web.json_response(
                {
                    "tracks": [t for t in TRACKS.values() if text in t["title"].casefold()],
                    "albums": [a for a, _ in ALBUMS.values() if text in f"{a['name']} {a['artist']}".casefold()],
                    "artists": [{"id": ARTIST_RH, "name": "Radiohead", "image": "i" * 40}]
                    if text in "radiohead"
                    else [],
                }
            )
        return web.json_response({"error": "not found"}, status=404)
