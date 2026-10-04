"""Speaker groups: made in Home Assistant, kept by Slopify."""

from __future__ import annotations

from typing import Any

from homeassistant.components.media_player import ATTR_GROUP_MEMBERS, ATTR_INPUT_SOURCE, MediaPlayerEntityFeature
from homeassistant.const import ATTR_ENTITY_ID, ATTR_SUPPORTED_FEATURES
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from .fake_slopify import HENRY_ID, SPEAKER_DEN, SPEAKER_KITCHEN, SPEAKER_LOFT, T4, FakeSlopify, now_playing
from .test_household import settle

DEN, LOFT, KITCHEN = "media_player.den_slopify", "media_player.loft_slopify", "media_player.kitchen_slopify"


@pytest.fixture
async def speakers(hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify) -> MockConfigEntry:
    fake.admin = True
    fake.lan = [SPEAKER_KITCHEN, SPEAKER_DEN, SPEAKER_LOFT]
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    await fake.wait_for(lambda: len(fake.hellos) >= 3)
    await settle(hass, fake)
    return entry


async def call(hass: HomeAssistant, entity: str, service: str, **data: Any) -> None:
    await hass.services.async_call("media_player", service, {ATTR_ENTITY_ID: entity, **data}, blocking=True)


async def test_bluos_speakers_can_be_grouped_chromecasts_cannot(hass: HomeAssistant, speakers: MockConfigEntry) -> None:
    assert hass.states.get(DEN).attributes[ATTR_SUPPORTED_FEATURES] & MediaPlayerEntityFeature.GROUPING
    assert not hass.states.get(KITCHEN).attributes[ATTR_SUPPORTED_FEATURES] & MediaPlayerEntityFeature.GROUPING


async def test_join_and_unjoin(hass: HomeAssistant, speakers: MockConfigEntry, fake: FakeSlopify) -> None:
    await call(hass, DEN, "join", group_members=[LOFT])
    assert fake.group_calls[-1] == ("join", {"leader": "bluos:10.0.0.6", "members": ["bluos:10.0.0.7"]})
    await settle(hass, fake)
    assert hass.states.get(DEN).attributes[ATTR_GROUP_MEMBERS] == [DEN, LOFT]
    assert hass.states.get(LOFT).attributes[ATTR_GROUP_MEMBERS] == [LOFT, DEN]
    await call(hass, LOFT, "unjoin")
    assert fake.group_calls[-1] == ("unjoin", {"speaker": "bluos:10.0.0.7"})
    await settle(hass, fake)
    assert hass.states.get(DEN).attributes[ATTR_GROUP_MEMBERS] == []


async def test_only_slopify_speakers_join(hass: HomeAssistant, speakers: MockConfigEntry) -> None:
    with pytest.raises(ServiceValidationError, match="not a Slopify speaker"):
        await call(hass, DEN, "join", group_members=["media_player.slopify_lukas"])


async def test_the_server_refusing_a_group_is_explained(
    hass: HomeAssistant, speakers: MockConfigEntry, fake: FakeSlopify
) -> None:
    # Home Assistant itself refuses a member that cannot group (the Chromecast
    # lacks the feature); the server's own refusal is shown when it gets there.
    with pytest.raises(HomeAssistantError):
        await call(hass, DEN, "join", group_members=[KITCHEN])


async def test_a_grouped_speaker_shows_the_music_its_group_plays(
    hass: HomeAssistant, speakers: MockConfigEntry, fake: FakeSlopify
) -> None:
    np = now_playing(
        T4, device={"id": "bluos:10.0.0.6", "kind": "bluos", "name": "Den + Loft", "members": ["bluos:10.0.0.7"]}
    )
    await fake.set_roster(
        players=[{"id": f"server:{HENRY_ID}", "nowPlaying": np}], active=f"server:{HENRY_ID}", uid=HENRY_ID
    )
    await settle(hass, fake)
    for entity in (DEN, LOFT):
        state = hass.states.get(entity)
        assert state.state == "playing"
        assert state.attributes[ATTR_INPUT_SOURCE] == "Slopify - henrybaxter"
    assert hass.states.get(KITCHEN).state == "idle"


async def test_picking_an_account_already_on_the_group_does_not_restart_it(
    hass: HomeAssistant, speakers: MockConfigEntry, fake: FakeSlopify
) -> None:
    np = now_playing(
        T4, device={"id": "bluos:10.0.0.6", "kind": "bluos", "name": "Den + Loft", "members": ["bluos:10.0.0.7"]}
    )
    await fake.set_roster(
        players=[{"id": f"server:{HENRY_ID}", "nowPlaying": np}], active=f"server:{HENRY_ID}", uid=HENRY_ID
    )
    await settle(hass, fake)
    await call(hass, LOFT, "select_source", source="Slopify - henrybaxter")
    await settle(hass, fake)
    assert fake.commands_of(HENRY_ID) == []


async def test_a_server_without_groups_says_to_update(
    hass: HomeAssistant, speakers: MockConfigEntry, fake: FakeSlopify
) -> None:
    fake.groups_supported = False
    fake.group_calls.clear()
    with pytest.raises(ServiceValidationError, match="Update the server"):
        await call(hass, DEN, "join", group_members=[LOFT])
