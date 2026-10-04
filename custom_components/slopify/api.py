"""Talking to a Slopify server: its REST API and its session socket.

Nothing in here depends on Home Assistant, so the protocol can be tested
against a fake server on its own.

The session socket (/api/ws) is how every Slopify client follows and steers
the account's playback. This client joins it the way a phone remote would:
it announces itself as a controller that cannot play (so no app offers it as
an output), receives the roster of clients and speakers with what the active
one is playing, and routes commands to whichever client is making the sound.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import contextlib
import json
import logging
import random
import secrets
import time
from typing import Any
from urllib.parse import quote

import aiohttp
from yarl import URL

_LOGGER = logging.getLogger(__name__)

REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=20)
# The server closes a socket whose token it does not know with this code.
WS_CLOSE_BAD_TOKEN = 4003
# Every 25 s, like the apps: the server treats a client silent for 30 s as gone
# when the same client id reconnects.
WS_PING_EVERY = 25.0
WS_HELLO_TIMEOUT = 15.0
RECONNECT_MIN = 1.0
RECONNECT_MAX = 60.0
# A connection that lasted this long resets the reconnect backoff.
STABLE_AFTER = 30.0


class SlopifyError(Exception):
    """Anything that went wrong talking to Slopify."""


class CannotConnect(SlopifyError):
    """The server could not be reached."""


class NotSlopify(SlopifyError):
    """Something answered at that address, but it is not a Slopify server."""


class InvalidAuth(SlopifyError):
    """Wrong username or password, or the token was revoked."""


class PasswordChangeRequired(SlopifyError):
    """The account must change its password in the Slopify app first."""


class TooManyAttempts(SlopifyError):
    """The server is rate limiting sign-in attempts."""


class NotFound(SlopifyError):
    """The library has no such item."""


def normalize_url(raw: str) -> str:
    """Turn what someone typed into the server's base URL.

    Accepts a bare host ("music.example.com", "192.168.1.5:8090"), a full URL,
    or a link copied out of the app (query and fragment are dropped).
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("empty url")
    if "://" not in text:
        text = f"http://{text}"
    url = URL(text)
    if url.scheme not in ("http", "https") or not url.host:
        raise ValueError(f"not an http(s) url: {raw}")
    path = url.path.rstrip("/")
    return str(url.with_path(path or "/").with_query(None).with_fragment(None)).rstrip("/")


class SlopifyApi:
    """REST calls against one Slopify server, as one account."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str | None = None) -> None:
        """Initialize the API client."""
        self._http = session
        self.url = normalize_url(url)
        self.token = token

    @property
    def http(self) -> aiohttp.ClientSession:
        """The aiohttp session in use."""
        return self._http

    @property
    def ws_url(self) -> str:
        """Address of the session socket."""
        url = URL(f"{self.url}/api/ws")
        return str(url.with_scheme("wss" if url.scheme == "https" else "ws"))

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        auth: bool = True,
    ) -> Any:
        try:
            async with self._http.request(
                method,
                f"{self.url}{path}",
                params=params,
                json=json,
                headers=self._headers() if auth else None,
                timeout=REQUEST_TIMEOUT,
            ) as resp:
                if resp.status == 401:
                    raise InvalidAuth
                if resp.status == 429:
                    raise TooManyAttempts
                body: Any = None
                with contextlib.suppress(aiohttp.ContentTypeError, ValueError):
                    body = await resp.json()
                if resp.status == 403 and isinstance(body, dict) and "password" in str(body.get("error", "")):
                    raise PasswordChangeRequired
                if resp.status == 404:
                    raise NotFound(path)
                if resp.status >= 400:
                    detail = body.get("error") if isinstance(body, dict) else None
                    raise SlopifyError(f"{method} {path}: HTTP {resp.status} {detail or ''}".strip())
                if body is None:
                    raise NotSlopify(f"{path} did not answer with JSON")
                return body
        except (aiohttp.ClientError, TimeoutError) as err:
            raise CannotConnect(str(err) or type(err).__name__) from err

    async def get(self, path: str, **params: Any) -> Any:
        """GET a JSON resource."""
        return await self._request("GET", path, params={k: str(v) for k, v in params.items() if v is not None} or None)

    async def post(self, path: str, body: Any = None) -> Any:
        """POST JSON, answer JSON."""
        return await self._request("POST", path, json=body if body is not None else {})

    async def health(self) -> None:
        """Check that a Slopify server answers at this address."""
        try:
            body = await self._request("GET", "/api/healthz", auth=False)
        except NotFound as err:
            raise NotSlopify("no /api/healthz") from err
        except (InvalidAuth, PasswordChangeRequired) as err:
            raise NotSlopify("health check wanted a login") from err
        if not (isinstance(body, dict) and body.get("ok") is True):
            raise NotSlopify("unexpected health answer")

    async def login(self, username: str, password: str, device: str) -> dict[str, Any]:
        """Sign in; keeps and returns the token, and returns the account."""
        body = await self._request(
            "POST",
            "/api/auth/login",
            json={"username": username, "password": password, "device": device, "kind": "service"},
            auth=False,
        )
        if not isinstance(body, dict) or not body.get("token") or not isinstance(body.get("user"), dict):
            raise NotSlopify("unexpected login answer")
        self.token = body["token"]
        return body

    async def me(self) -> dict[str, Any]:
        """The signed-in account; raises if its password must change first."""
        user = await self._request("GET", "/api/auth/me")
        if not isinstance(user, dict) or "id" not in user:
            raise NotSlopify("unexpected account answer")
        if user.get("mustChangePassword"):
            raise PasswordChangeRequired
        return user

    async def logout(self) -> None:
        """Revoke this token on the server."""
        await self._request("POST", "/api/auth/logout")

    async def image(self, item_id: str, size: int) -> tuple[bytes | None, str | None]:
        """Artwork for an album, artist, track or playlist id."""
        try:
            async with self._http.get(
                f"{self.url}/api/image/{item_id}",
                params={"size": str(size)},
                headers={**self._headers(), "Accept": "image/jpeg"},
                timeout=REQUEST_TIMEOUT,
            ) as resp:
                if resp.status != 200:
                    return None, None
                return await resp.read(), resp.headers.get("Content-Type", "image/jpeg")
        except (aiohttp.ClientError, TimeoutError):
            return None, None

    # --- library ------------------------------------------------------------

    async def album(self, album_id: str) -> dict[str, Any]:
        """An album with its tracks."""
        return await self.get(f"/api/albums/{album_id}")

    async def albums(self) -> list[dict[str, Any]]:
        """Every album, sorted by name."""
        return (await self.get("/api/albums", limit=20000)).get("items", [])

    async def artist(self, artist_id: str) -> dict[str, Any]:
        """An artist: albums, appears-on and tracks."""
        return await self.get(f"/api/artists/{artist_id}")

    async def artists(self) -> list[dict[str, Any]]:
        """Every artist, sorted by name."""
        return (await self.get("/api/artists", limit=20000)).get("items", [])

    async def playlists(self) -> list[dict[str, Any]]:
        """The account's playlists, most recently changed first."""
        return (await self.get("/api/playlists")).get("items", [])

    async def playlist(self, playlist_id: str) -> dict[str, Any]:
        """A playlist with its tracks."""
        return await self.get(f"/api/playlists/{playlist_id}")

    async def liked(self) -> list[dict[str, Any]]:
        """Liked songs, most recent first."""
        return (await self.get("/api/likes", full=1)).get("items", [])

    async def home(self) -> dict[str, Any]:
        """Recently played albums, top tracks, newest albums."""
        return await self.get("/api/home")

    async def genres(self) -> list[dict[str, Any]]:
        """Genre tiles, biggest first."""
        return (await self.get("/api/browse")).get("tiles", [])

    async def genre(self, name: str) -> dict[str, Any]:
        """A genre's albums and artists."""
        return await self.get(f"/api/genres/{_seg(name)}")

    async def genre_mix(self, name: str) -> list[dict[str, Any]]:
        """A shuffled sitting of a genre."""
        return (await self.get(f"/api/genres/{_seg(name)}/mix")).get("items", [])

    async def mix(self, seed_id: str) -> list[dict[str, Any]]:
        """Songs that go with a track or an artist (the seed leads for a track)."""
        return (await self.get(f"/api/tracks/{seed_id}/mix", limit=100)).get("items", [])

    async def item(self, item_id: str) -> dict[str, Any]:
        """What an id is: {kind: album|artist|track, item}."""
        return await self.get(f"/api/items/{item_id}")

    async def search(self, query: str, limit: int = 20) -> dict[str, Any]:
        """Tracks, albums and artists matching a query."""
        return await self.get("/api/search", q=query, limit=limit)


def _seg(text: str) -> str:
    return quote(text, safe="")


class SlopifySession:
    """One live seat in the account's session.

    Keeps a socket open (reconnecting with backoff), holds the latest roster,
    queues and remembered session, and calls ``on_change`` whenever any of it
    changes. ``on_auth_failed`` is called once if the server rejects the token;
    the session then stops trying.
    """

    def __init__(
        self,
        api: SlopifyApi,
        client_id: str,
        *,
        name: str,
        kind: str,
        on_change: Callable[[], None],
        on_auth_failed: Callable[[], None],
    ) -> None:
        """Initialize the session client."""
        self._api = api
        self._wanted_id = client_id
        self._name = name
        self._kind = kind
        self._on_change = on_change
        self._on_auth_failed = on_auth_failed
        # Same for every reconnect of this object: the server recognizes a
        # reconnect (and drops the stale socket) instead of seeing a second page.
        self._instance = secrets.token_hex(8)
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._connected_once = asyncio.Event()

        self.client_id: str | None = None
        self.user_id: str | None = None
        self.connected = False
        self.last_error: str | None = None
        self.players: list[dict[str, Any]] = []
        self.lan_devices: list[dict[str, Any]] = []
        self.active_id: str | None = None
        self.queues: dict[str, list[dict[str, Any]]] = {}
        # When each player's nowPlaying last changed, by our clock (monotonic):
        # positions are extrapolated from receipt, never from a sender's clock.
        self.np_received: dict[str, float] = {}
        self.remembered: dict[str, Any] | None = None
        self.remembered_queue: list[dict[str, Any]] = []
        self.remembered_received: float = 0.0

    # --- lifecycle ------------------------------------------------------------

    def start(self, create_task: Callable[..., asyncio.Task[None]] | None = None) -> None:
        """Start the connection loop in the background."""
        if self._task:
            return
        self._stop.clear()
        coro = self._run()
        self._task = create_task(coro) if create_task else asyncio.create_task(coro)

    async def wait_connected(self, seconds: float) -> bool:
        """Wait until the first hello is answered; False on timeout."""
        try:
            await asyncio.wait_for(self._connected_once.wait(), seconds)
        except TimeoutError:
            return False
        return True

    async def stop(self) -> None:
        """Close the socket and stop reconnecting."""
        self._stop.set()
        if self._ws is not None and not self._ws.closed:
            with contextlib.suppress(Exception):
                await self._ws.close()
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        self._set_connected(False)

    async def _run(self) -> None:
        delay = RECONNECT_MIN
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                await self._connect_once()
            except InvalidAuth:
                _LOGGER.warning("Slopify rejected the saved sign-in; reauthentication needed")
                self.last_error = "invalid_auth"
                self._set_connected(False)
                self._on_auth_failed()
                return
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, TimeoutError, OSError, SlopifyError) as err:
                self.last_error = str(err) or type(err).__name__
                if self.connected or delay == RECONNECT_MIN:
                    _LOGGER.debug("Slopify session connection failed: %s", self.last_error)
            except Exception:
                _LOGGER.exception("Unexpected error in the Slopify session")
                self.last_error = "unexpected error"
            self._set_connected(False)
            if self._stop.is_set():
                return
            if time.monotonic() - started > STABLE_AFTER:
                delay = RECONNECT_MIN
            wait = delay * (0.8 + random.random() * 0.4)
            delay = min(delay * 2, RECONNECT_MAX)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), wait)

    async def _connect_once(self) -> None:
        async with self._api.http.ws_connect(
            self._api.ws_url,
            heartbeat=30,
            max_msg_size=16 * 1024 * 1024,
            timeout=aiohttp.ClientWSTimeout(ws_close=10),
        ) as ws:
            self._ws = ws
            await ws.send_json(
                {
                    "type": "hello",
                    "token": self._api.token,
                    "clientId": self.client_id or self._wanted_id,
                    "instance": self._instance,
                    "name": self._name,
                    "kind": self._kind,
                    "canPlay": False,
                }
            )
            first = await asyncio.wait_for(ws.receive(), WS_HELLO_TIMEOUT)
            if first.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED):
                if WS_CLOSE_BAD_TOKEN in (ws.close_code, first.data):
                    raise InvalidAuth
                raise CannotConnect(f"socket closed during hello ({ws.close_code})")
            if first.type != aiohttp.WSMsgType.TEXT:
                raise NotSlopify("unexpected first frame")
            hello = _loads(first.data)
            if not hello or hello.get("type") != "hello-ok":
                raise NotSlopify("no hello-ok")
            self._reset()
            self.client_id = str(hello.get("clientId") or self._wanted_id)
            self.user_id = hello.get("userId")
            self.last_error = None
            self._set_connected(True, notify=False)
            self._connected_once.set()
            self._on_change()
            pinger = asyncio.create_task(self._ping(ws))
            try:
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = _loads(msg.data)
                        if data:
                            self._handle(data)
                    elif msg.type == aiohttp.WSMsgType.ERROR:
                        break
            finally:
                pinger.cancel()
                self._ws = None
            if ws.close_code == WS_CLOSE_BAD_TOKEN:
                raise InvalidAuth
            raise CannotConnect(f"socket closed ({ws.close_code})")

    async def _ping(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        while not ws.closed:
            await asyncio.sleep(WS_PING_EVERY)
            with contextlib.suppress(Exception):
                await ws.send_json({"type": "ping"})

    def _set_connected(self, value: bool, notify: bool = True) -> None:
        if self.connected == value:
            return
        self.connected = value
        if notify:
            self._on_change()

    def _reset(self) -> None:
        self.players, self.lan_devices, self.active_id = [], [], None
        self.queues, self.np_received = {}, {}

    # --- incoming -------------------------------------------------------------

    def _handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "roster":
            self._roster(msg)
        elif kind == "queue":
            sender = msg.get("from")
            if isinstance(sender, str):
                queue = msg.get("queue")
                if isinstance(queue, list):
                    self.queues[sender] = queue
                else:
                    self.queues.pop(sender, None)
                self._on_change()
        elif kind == "session":
            np = msg.get("nowPlaying")
            self.remembered = np if isinstance(np, dict) else None
            queue = msg.get("queue")
            self.remembered_queue = queue if isinstance(queue, list) else []
            self.remembered_received = time.monotonic()
            self._on_change()
        elif kind == "like":
            item, liked = msg.get("itemId"), bool(msg.get("liked"))
            changed = False
            for player in self.players:
                np = player.get("nowPlaying")
                if isinstance(np, dict) and np.get("itemId") == item and np.get("liked") != liked:
                    np["liked"] = liked
                    changed = True
            if changed:
                self._on_change()

    def _roster(self, msg: dict[str, Any]) -> None:
        now = time.monotonic()
        before = {p.get("id"): p.get("nowPlaying") for p in self.players}
        players = [p for p in msg.get("players") or [] if isinstance(p, dict) and isinstance(p.get("id"), str)]
        for p in players:
            pid = p["id"]
            if pid not in before or before[pid] != p.get("nowPlaying"):
                self.np_received[pid] = now
        ids = {p["id"] for p in players}
        self.np_received = {k: v for k, v in self.np_received.items() if k in ids}
        self.queues = {k: v for k, v in self.queues.items() if k in ids}
        self.players = players
        self.lan_devices = [d for d in msg.get("lanDevices") or [] if isinstance(d, dict) and d.get("id")]
        active = msg.get("activeClientId")
        self.active_id = active if isinstance(active, str) else None
        self._on_change()

    # --- outgoing -------------------------------------------------------------

    async def command(self, to: str, command: dict[str, Any]) -> None:
        """Route a command to one client of the account."""
        ws = self._ws
        if ws is None or ws.closed or not self.connected:
            raise CannotConnect("not connected to the Slopify session")
        await ws.send_json({"type": "command", "to": to, "command": command})


def _loads(text: Any) -> dict[str, Any] | None:
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None
