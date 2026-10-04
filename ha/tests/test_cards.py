"""The Now Playing card: served, loaded for every dashboard, and its lyrics."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator, WebSocketGenerator

from .fake_slopify import T1, T2, FakeSlopify, now_playing, row
from .test_media_player import E, settle

WEB = {"id": "web-1", "name": "Web Player (1)", "kind": "web", "canPlay": True, "sameNetwork": True}


async def test_the_card_is_served_and_loaded(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_client: ClientSessionGenerator
) -> None:
    client = await hass_client()
    resp = await client.get("/slopify_static/slopify-cards.js")
    assert resp.status == 200
    assert "slopify-now-playing" in await resp.text()
    loaded_urls = hass.data.get("frontend_extra_module_url")
    urls = set(getattr(loaded_urls, "urls", loaded_urls) or [])
    assert any("/slopify_static/slopify-cards.js" in u for u in urls), urls


async def test_lyrics_for_the_song_playing(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify, hass_ws_client: WebSocketGenerator
) -> None:
    await fake.send_queue("web-1", [row(T1), row(T2)])
    await fake.set_roster(players=[{**WEB, "nowPlaying": now_playing(T2, queue_index=1)}], active="web-1")
    await settle(hass, fake)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "slopify/lyrics", "entity_id": E})
    res = await ws.receive_json()
    assert res["success"]
    assert res["result"]["lines"][0] == {"start": 1000, "text": "Please could you stop the noise"}

    await fake.set_roster(players=[{**WEB, "nowPlaying": now_playing(T1, queue_index=0)}], active="web-1")
    await settle(hass, fake)
    await ws.send_json({"id": 2, "type": "slopify/lyrics", "entity_id": E})
    assert (await ws.receive_json())["result"]["lines"] == []

    await ws.send_json({"id": 3, "type": "slopify/lyrics", "entity_id": "media_player.nope"})
    assert not (await ws.receive_json())["success"]
