"""An admin sign-in follows the whole household, and speakers offer every account."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from homeassistant.components.media_player import ATTR_INPUT_SOURCE, ATTR_INPUT_SOURCE_LIST, ATTR_MEDIA_TITLE
from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from custom_components.slopify.const import CONF_HOUSEHOLD, DOMAIN

from .fake_slopify import (
    ALBUM_KID,
    HENRY_ID,
    SPEAKER_DEN,
    SPEAKER_KITCHEN,
    T4,
    T5,
    USER_ID,
    VICTORIA_ID,
    FakeSlopify,
    now_playing,
    row,
)

KITCHEN = "media_player.kitchen_slopify"
DEN = "media_player.den_slopify"
EVERYONE = ["Slopify - lukas", "Slopify - henrybaxter", "Slopify - victoria"]


@pytest.fixture
async def household(hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify) -> MockConfigEntry:
    """The integration set up with an admin sign-in, speakers on the network."""
    fake.admin = True
    fake.lan = [SPEAKER_KITCHEN, SPEAKER_DEN]
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    await fake.wait_for(lambda: len(fake.hellos) >= 3)
    await settle(hass, fake)
    return entry


async def settle(hass: HomeAssistant, fake: FakeSlopify) -> None:
    for _ in range(6):
        await hass.async_block_till_done()
        await fake.wait_for(lambda: True)


async def call(hass: HomeAssistant, entity: str, service: str, **data: Any) -> None:
    await hass.services.async_call("media_player", service, {ATTR_ENTITY_ID: entity, **data}, blocking=True)


async def test_every_account_gets_a_player(hass: HomeAssistant, household: MockConfigEntry, fake: FakeSlopify) -> None:
    for entity in ("media_player.slopify_lukas", "media_player.slopify_henrybaxter", "media_player.slopify_victoria"):
        assert hass.states.get(entity) is not None, hass.states.async_entity_ids("media_player")
    assert {h["token"] for h in fake.hellos} >= {"tok-valid", f"hh-{HENRY_ID[:6]}", f"hh-{VICTORIA_ID[:6]}"}


async def test_speakers_offer_every_account_by_profile_name(hass: HomeAssistant, household: MockConfigEntry) -> None:
    for entity in (KITCHEN, DEN):
        state = hass.states.get(entity)
        assert state.state == "idle"
        assert state.attributes[ATTR_INPUT_SOURCE_LIST] == EVERYONE


async def test_a_speaker_shows_whose_music_is_on_it(
    hass: HomeAssistant, household: MockConfigEntry, fake: FakeSlopify
) -> None:
    np = now_playing(T4, device={"id": "cast:kitchen", "kind": "cast", "name": "Kitchen"})
    await fake.set_roster(
        players=[{"id": f"server:{HENRY_ID}", "nowPlaying": np}], active=f"server:{HENRY_ID}", uid=HENRY_ID
    )
    await settle(hass, fake)
    kitchen = hass.states.get(KITCHEN)
    assert kitchen.state == "playing"
    assert kitchen.attributes[ATTR_INPUT_SOURCE] == "Slopify - henrybaxter"
    assert kitchen.attributes[ATTR_MEDIA_TITLE] == "Everything In Its Right Place"
    assert hass.states.get(DEN).state == "idle"
    assert hass.states.get("media_player.slopify_henrybaxter").attributes[ATTR_INPUT_SOURCE] == "Kitchen"

    # Its controls reach Henry's session, through Henry's sign-in.
    await call(hass, KITCHEN, "media_pause")
    await fake.wait_for(lambda: fake.commands_of(HENRY_ID))
    assert fake.commands_of(HENRY_ID)[-1] == {
        "type": "command",
        "to": f"server:{HENRY_ID}",
        "command": {"action": "toggle"},
    }
    assert fake.commands_of(USER_ID) == []


async def test_picking_an_account_brings_their_music_to_the_speaker(
    hass: HomeAssistant, household: MockConfigEntry, fake: FakeSlopify
) -> None:
    await fake.send_session(
        now_playing(T5, playing=False, position=12.0, queue_index=1), [row(T4), row(T5)], uid=VICTORIA_ID
    )
    await settle(hass, fake)
    await call(hass, DEN, "select_source", source="Slopify - victoria")
    await fake.wait_for(lambda: fake.commands_of(VICTORIA_ID))
    assert fake.commands_of(VICTORIA_ID)[-1] == {
        "type": "command",
        "to": f"server:{VICTORIA_ID}",
        "command": {
            "action": "transfer",
            "deviceId": "bluos:10.0.0.6",
            "trackIds": [T4, T5],
            "index": 1,
            "position": 12.0,
            "playing": True,
        },
    }


async def test_picking_an_account_with_nothing_to_resume_says_so(
    hass: HomeAssistant, household: MockConfigEntry
) -> None:
    with pytest.raises(ServiceValidationError, match="henrybaxter has nothing to resume"):
        await call(hass, KITCHEN, "select_source", source="Slopify - henrybaxter")


async def test_play_media_on_a_speaker(hass: HomeAssistant, household: MockConfigEntry, fake: FakeSlopify) -> None:
    await call(hass, KITCHEN, "play_media", media_content_type="album", media_content_id=f"album:{ALBUM_KID}")
    await fake.wait_for(lambda: fake.commands_of(USER_ID))
    assert fake.commands_of(USER_ID)[-1]["command"] == {
        "action": "transfer",
        "deviceId": "cast:kitchen",
        "trackIds": [T4, T5],
        "index": 0,
        "position": 0,
        "playing": True,
    }


async def test_accounts_added_and_removed_in_slopify_follow(
    hass: HomeAssistant, household: MockConfigEntry, fake: FakeSlopify
) -> None:
    newcomer = "d" * 32
    fake.users[newcomer] = "ava"
    del fake.users[VICTORIA_ID]
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=61))
    await fake.wait_for(lambda: any(h["token"] == f"hh-{newcomer[:6]}" for h in fake.hellos))
    await settle(hass, fake)
    assert hass.states.get("media_player.slopify_ava") is not None
    assert er.async_get(hass).async_get_entity_id("media_player", DOMAIN, VICTORIA_ID) is None
    assert hass.states.get("media_player.slopify_victoria") is None
    assert hass.states.get(KITCHEN).attributes[ATTR_INPUT_SOURCE_LIST] == [
        "Slopify - lukas",
        "Slopify - ava",
        "Slopify - henrybaxter",
    ]


async def test_a_revoked_household_sign_in_is_renewed(
    hass: HomeAssistant, household: MockConfigEntry, fake: FakeSlopify, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("custom_components.slopify.api.RECONNECT_MIN", 0.05)
    token = f"hh-{HENRY_ID[:6]}"
    fake.tokens.pop(token)
    hellos = sum(1 for h in fake.hellos if h["token"] == token)
    for ws in list(fake.sockets):
        if fake.socket_user.get(id(ws)) == HENRY_ID:
            await ws.close()
    await fake.wait_for(lambda: er.async_get(hass).async_get_entity_id("media_player", DOMAIN, HENRY_ID) is None)
    assert not hass.config_entries.flow.async_progress(), "no sign-in prompt for a household account"
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=61))
    await fake.wait_for(lambda: sum(1 for h in fake.hellos if h["token"] == token) > hellos)
    await settle(hass, fake)
    assert hass.states.get("media_player.slopify_henrybaxter") is not None


async def test_turning_the_household_off(hass: HomeAssistant, household: MockConfigEntry, fake: FakeSlopify) -> None:
    hass.config_entries.async_update_entry(household, options={CONF_HOUSEHOLD: False})
    await hass.async_block_till_done()
    await settle(hass, fake)
    assert hass.states.get("media_player.slopify_lukas") is not None
    assert er.async_get(hass).async_get_entity_id("media_player", DOMAIN, HENRY_ID) is None
    assert hass.states.get("media_player.slopify_henrybaxter") is None
    assert hass.states.get(KITCHEN).attributes[ATTR_INPUT_SOURCE_LIST] == ["Slopify - lukas"]


async def test_a_non_admin_follows_only_itself(hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify) -> None:
    fake.lan = [SPEAKER_KITCHEN]
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    await fake.wait_for(lambda: fake.hellos)
    await settle(hass, fake)
    assert [h["token"] for h in fake.hellos] == ["tok-valid"]
    assert hass.states.get(KITCHEN).attributes[ATTR_INPUT_SOURCE_LIST] == ["Slopify - lukas"]


async def test_removing_signs_the_household_out(
    hass: HomeAssistant, household: MockConfigEntry, fake: FakeSlopify
) -> None:
    assert await hass.config_entries.async_unload(household.entry_id)
    await hass.config_entries.async_remove(household.entry_id)
    assert set(fake.logged_out) >= {"tok-valid", f"hh-{HENRY_ID[:6]}", f"hh-{VICTORIA_ID[:6]}"}
