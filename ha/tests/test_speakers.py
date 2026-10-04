"""A speaker player is the whole speaker: its volume, its inputs, its own playback."""

from __future__ import annotations

from typing import Any

from homeassistant.components.media_player import (
    ATTR_INPUT_SOURCE,
    ATTR_INPUT_SOURCE_LIST,
    ATTR_MEDIA_TITLE,
    ATTR_MEDIA_VOLUME_LEVEL,
    MediaPlayerEntityFeature,
)
from homeassistant.const import ATTR_ENTITY_ID, ATTR_SUPPORTED_FEATURES
from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from .fake_slopify import HENRY_ID, SPEAKER_DEN, SPEAKER_KITCHEN, T4, FakeSlopify, now_playing
from .test_household import settle

DEN = "media_player.den_slopify"
OWN = {
    "volume": 40,
    "muted": False,
    "state": "stream",
    "playing": True,
    "title": "Evening news",
    "artist": None,
    "input": "HDMI ARC",
    "inputs": [{"id": "input2", "name": "HDMI ARC"}, {"id": "Spotify", "name": "Spotify"}],
}


@pytest.fixture
async def speakers(hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify) -> MockConfigEntry:
    fake.admin = True
    fake.lan = [SPEAKER_KITCHEN, SPEAKER_DEN]
    fake.speaker_states[SPEAKER_DEN["id"]] = dict(OWN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    await fake.wait_for(lambda: len(fake.hellos) >= 3)
    await settle(hass, fake)
    return entry


async def call(hass: HomeAssistant, service: str, **data: Any) -> None:
    await hass.services.async_call("media_player", service, {ATTR_ENTITY_ID: DEN, **data}, blocking=True)


async def test_a_speaker_shows_what_it_plays_on_its_own(hass: HomeAssistant, speakers: MockConfigEntry) -> None:
    state = hass.states.get(DEN)
    assert state.state == "playing"
    assert state.attributes[ATTR_MEDIA_TITLE] == "Evening news"
    assert state.attributes[ATTR_INPUT_SOURCE] == "HDMI ARC"
    assert state.attributes[ATTR_MEDIA_VOLUME_LEVEL] == 0.4
    assert state.attributes[ATTR_INPUT_SOURCE_LIST] == [
        "Slopify - lukas",
        "Slopify - henrybaxter",
        "Slopify - victoria",
        "HDMI ARC",
        "Spotify",
    ]
    assert state.attributes[ATTR_SUPPORTED_FEATURES] & MediaPlayerEntityFeature.VOLUME_SET


async def test_its_own_controls(hass: HomeAssistant, speakers: MockConfigEntry, fake: FakeSlopify) -> None:
    await call(hass, "volume_set", volume_level=0.25)
    await call(hass, "media_pause")
    await call(hass, "select_source", source="Spotify")
    assert fake.speaker_calls == [
        ("bluos:10.0.0.6", "volume", {"level": 25}),
        ("bluos:10.0.0.6", "control", {"action": "pause"}),
        ("bluos:10.0.0.6", "input", {"input": "Spotify"}),
    ]


async def test_slopify_music_on_it_still_uses_its_own_volume(
    hass: HomeAssistant, speakers: MockConfigEntry, fake: FakeSlopify
) -> None:
    np = now_playing(T4, volume=90, device={"id": "bluos:10.0.0.6", "kind": "bluos", "name": "Den"})
    await fake.set_roster(
        players=[{"id": f"server:{HENRY_ID}", "nowPlaying": np}], active=f"server:{HENRY_ID}", uid=HENRY_ID
    )
    await settle(hass, fake)
    state = hass.states.get(DEN)
    assert state.attributes[ATTR_INPUT_SOURCE] == "Slopify - henrybaxter"
    assert state.attributes[ATTR_MEDIA_VOLUME_LEVEL] == 0.4
    await call(hass, "media_pause")
    await fake.wait_for(lambda: fake.commands_of(HENRY_ID))
    assert fake.commands_of(HENRY_ID)[-1]["command"] == {"action": "toggle"}
    assert all(c[1] != "control" for c in fake.speaker_calls)
