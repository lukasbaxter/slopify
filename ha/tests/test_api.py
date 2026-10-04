"""The protocol client against the fake server (no Home Assistant involved)."""

from __future__ import annotations

import asyncio
import socket

import aiohttp
import pytest

from custom_components.slopify import api as slopify_api
from custom_components.slopify.api import (
    CannotConnect,
    InvalidAuth,
    NotSlopify,
    PasswordChangeRequired,
    SlopifyApi,
    SlopifySession,
    normalize_url,
)

from .fake_slopify import FakeSlopify


@pytest.mark.parametrize(
    ("raw", "url"),
    [
        ("192.168.1.5:8090", "http://192.168.1.5:8090"),
        ("  https://music.example.com/  ", "https://music.example.com"),
        ("https://music.example.com/?album=abc#top", "https://music.example.com"),
        ("https://example.com/slopify/", "https://example.com/slopify"),
        ("music.local", "http://music.local"),
    ],
)
def test_normalize_url(raw: str, url: str) -> None:
    assert normalize_url(raw) == url


@pytest.mark.parametrize("raw", ["", "   ", "ftp://x.com", "http://"])
def test_normalize_url_rejects(raw: str) -> None:
    with pytest.raises(ValueError):
        normalize_url(raw)


def test_ws_url_follows_the_scheme() -> None:
    assert SlopifyApi(None, "https://m.example.com/sub").ws_url == "wss://m.example.com/sub/api/ws"  # type: ignore[arg-type]
    assert SlopifyApi(None, "http://10.0.0.2:8090").ws_url == "ws://10.0.0.2:8090/api/ws"  # type: ignore[arg-type]


async def test_login_me_and_errors(fake: FakeSlopify) -> None:
    async with aiohttp.ClientSession() as http:
        api = SlopifyApi(http, fake.url)
        await api.health()
        with pytest.raises(InvalidAuth):
            await api.login("lukas", "nope", "Home Assistant")
        body = await api.login("lukas", fake.password, "Home Assistant")
        assert api.token == body["token"]
        assert fake.requests[-1] == "login lukas Home Assistant service"
        assert (await api.me())["id"] == body["user"]["id"]
        fake.must_change = True
        with pytest.raises(PasswordChangeRequired):
            await api.me()
        with pytest.raises(PasswordChangeRequired):
            await api.albums()
        fake.health_ok = False
        with pytest.raises(NotSlopify):
            await api.health()


async def test_nothing_listening(socket_enabled: None) -> None:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    async with aiohttp.ClientSession() as http:
        with pytest.raises(CannotConnect):
            await SlopifyApi(http, f"http://127.0.0.1:{port}").health()


async def test_session_follows_the_roster_and_reconnects(fake: FakeSlopify, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(slopify_api, "RECONNECT_MIN", 0.05)
    changes: list[int] = []
    failed: list[bool] = []
    async with aiohttp.ClientSession() as http:
        session = SlopifySession(
            SlopifyApi(http, fake.url, "tok-valid"),
            "ha-test",
            name="Home Assistant",
            kind="homeassistant",
            on_change=lambda: changes.append(1),
            on_auth_failed=lambda: failed.append(True),
        )
        session.start()
        assert await session.wait_connected(5)
        assert session.client_id == "ha-test" and session.user_id
        hello = fake.hellos[0]
        assert hello["canPlay"] is False and hello["clientId"] == "ha-test"
        await fake.set_roster(
            players=[{"id": "web-1", "name": "Web Player (1)", "kind": "web", "canPlay": True, "nowPlaying": None}]
        )
        await fake.wait_for(lambda: any(p["id"] == "web-1" for p in session.players))

        await session.command("web-1", {"action": "toggle"})
        await fake.wait_for(lambda: fake.commands())
        assert fake.commands()[0] == {"type": "command", "to": "web-1", "command": {"action": "toggle"}}

        # The server goes away and comes back: the session reconnects as the
        # same client, from the same instance (a reconnect, not a second page).
        await fake.drop_sockets()
        await fake.wait_for(lambda: len(fake.hellos) == 2)
        await fake.wait_for(lambda: session.connected)
        assert fake.hellos[1]["clientId"] == "ha-test"
        assert fake.hellos[1]["instance"] == fake.hellos[0]["instance"]
        assert not failed
        await session.stop()
        assert not session.connected


async def test_a_revoked_token_stops_the_session_and_asks_for_sign_in(fake: FakeSlopify) -> None:
    failed: list[bool] = []
    async with aiohttp.ClientSession() as http:
        session = SlopifySession(
            SlopifyApi(http, fake.url, "tok-revoked"),
            "ha-test",
            name="Home Assistant",
            kind="homeassistant",
            on_change=lambda: None,
            on_auth_failed=lambda: failed.append(True),
        )
        session.start()
        await fake.wait_for(lambda: failed)
        await asyncio.sleep(0.2)
        assert failed == [True]
        assert not session.connected
        await session.stop()


async def test_command_while_disconnected_raises(fake: FakeSlopify) -> None:
    async with aiohttp.ClientSession() as http:
        session = SlopifySession(
            SlopifyApi(http, fake.url, "tok-valid"),
            "ha-test",
            name="x",
            kind="homeassistant",
            on_change=lambda: None,
            on_auth_failed=lambda: None,
        )
        with pytest.raises(CannotConnect):
            await session.command("web-1", {"action": "next"})
