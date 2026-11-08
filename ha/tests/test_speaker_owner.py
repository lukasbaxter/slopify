"""Each server's speakers have one player, however many entries sign in to it,
and a speaker the server stops listing goes after a while (not on a blip)."""

from __future__ import annotations

from datetime import timedelta
import logging

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import CONF_URL, CONF_USERNAME, CONF_VERIFY_SSL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from custom_components.slopify.const import CONF_TOKEN, CONF_USER_ID, DOMAIN

from .fake_slopify import BOB_ID, SERVER_ID, SPEAKER_DEN, SPEAKER_KITCHEN, FakeSlopify
from .test_household import EVERYONE, settle

KITCHEN = "media_player.kitchen_slopify"
DEN = "media_player.den_slopify"
KITCHEN_UID = f"{SERVER_ID}-speaker-{SPEAKER_KITCHEN['id']}"
DEN_UID = f"{SERVER_ID}-speaker-{SPEAKER_DEN['id']}"


def bob_entry(fake: FakeSlopify) -> MockConfigEntry:
    """A second entry on the same server, signed in as bob."""
    fake.tokens["tok-bob"] = BOB_ID
    return MockConfigEntry(
        domain=DOMAIN,
        title="bob on 127.0.0.1",
        unique_id=BOB_ID,
        data={
            CONF_URL: fake.url,
            CONF_VERIFY_SSL: True,
            CONF_USERNAME: "bob",
            CONF_USER_ID: BOB_ID,
            CONF_TOKEN: "tok-bob",
            "server_id": SERVER_ID,
        },
    )


async def setup(hass: HomeAssistant, fake: FakeSlopify, *entries: MockConfigEntry) -> None:
    """Set the entries up together, as Home Assistant does at its start."""
    for entry in entries:
        if hass.config_entries.async_get_entry(entry.entry_id) is None:
            entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entries[0].entry_id)
    await hass.async_block_till_done()
    assert all(e.state is ConfigEntryState.LOADED for e in entries)
    await settle(hass, fake)


def speaker_entities(hass: HomeAssistant) -> list[er.RegistryEntry]:
    return [e for e in er.async_get(hass).entities.values() if e.platform == DOMAIN and "-speaker-" in e.unique_id]


async def test_two_entries_on_one_server_make_each_speaker_once(
    hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify, caplog: pytest.LogCaptureFixture
) -> None:
    fake.admin = True
    fake.lan = [SPEAKER_KITCHEN, SPEAKER_DEN]
    bob = bob_entry(fake)
    with caplog.at_level(logging.ERROR):
        await setup(hass, fake, entry, bob)
    assert "does not generate unique IDs" not in caplog.text
    ents = speaker_entities(hass)
    assert sorted(e.unique_id for e in ents) == sorted([KITCHEN_UID, DEN_UID])
    # The first entry (here the admin's, following the household) has them,
    # under the same entity ids a single entry gives them.
    assert {e.config_entry_id for e in ents} == {entry.entry_id}
    assert {e.entity_id for e in ents} == {KITCHEN, DEN}
    assert hass.states.get(KITCHEN).state != "unavailable"
    assert hass.states.get("media_player.kitchen_slopify_2") is None


async def test_the_speakers_keep_their_entry_across_a_restart(
    hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify
) -> None:
    """The entry that had them keeps them, even when the other one starts first."""
    fake.admin = True
    fake.lan = [SPEAKER_KITCHEN]
    bob = bob_entry(fake)
    bob.add_to_hass(hass)
    entry.add_to_hass(hass)
    er.async_get(hass).async_get_or_create(
        "media_player", DOMAIN, KITCHEN_UID, config_entry=entry, suggested_object_id="kitchen_slopify"
    )
    await setup(hass, fake, bob, entry)
    ents = speaker_entities(hass)
    assert [(e.entity_id, e.config_entry_id) for e in ents] == [(KITCHEN, entry.entry_id)]
    assert hass.states.get(KITCHEN).attributes["source_list"] == [s for s in EVERYONE if s != "Slopify - bob"]


async def test_another_entry_takes_the_speakers_when_theirs_is_removed(
    hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify
) -> None:
    fake.admin = True
    fake.lan = [SPEAKER_KITCHEN]
    bob = bob_entry(fake)
    await setup(hass, fake, entry, bob)
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=61))
    await settle(hass, fake)
    ents = speaker_entities(hass)
    assert [(e.entity_id, e.config_entry_id) for e in ents] == [(KITCHEN, bob.entry_id)]
    state = hass.states.get(KITCHEN)
    assert state.state != "unavailable"
    assert state.attributes["source_list"] == ["Slopify - bob"]


async def test_a_speaker_the_server_drops_goes_after_a_while(
    hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify, freezer: FrozenDateTimeFactory
) -> None:
    fake.admin = True
    fake.lan = [SPEAKER_KITCHEN, SPEAKER_DEN]
    await setup(hass, fake, entry)
    assert hass.states.get(DEN) is not None

    # Gone from the server's list: unavailable at first (a blip comes back)...
    await fake.set_roster(lan=[SPEAKER_KITCHEN])
    await settle(hass, fake)
    assert hass.states.get(DEN).state == "unavailable"
    freezer.tick(timedelta(minutes=2))
    async_fire_time_changed(hass)
    await settle(hass, fake)
    assert er.async_get(hass).async_get_entity_id("media_player", DOMAIN, DEN_UID) == DEN

    # ...and gone for good once it stays away.
    freezer.tick(timedelta(minutes=11))
    async_fire_time_changed(hass)
    await settle(hass, fake)
    assert er.async_get(hass).async_get_entity_id("media_player", DOMAIN, DEN_UID) is None
    assert hass.states.get(DEN) is None
    assert hass.states.get(KITCHEN).state != "unavailable"

    # Back on the network later: a player again, under its old name.
    await fake.set_roster(lan=[SPEAKER_KITCHEN, SPEAKER_DEN])
    await settle(hass, fake)
    assert hass.states.get(DEN) is not None


async def test_a_blip_does_not_remove_a_speaker(
    hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify, freezer: FrozenDateTimeFactory
) -> None:
    fake.admin = True
    fake.lan = [SPEAKER_KITCHEN, SPEAKER_DEN]
    await setup(hass, fake, entry)
    await fake.set_roster(lan=[SPEAKER_KITCHEN])
    await settle(hass, fake)
    freezer.tick(timedelta(minutes=5))
    async_fire_time_changed(hass)
    await settle(hass, fake)
    await fake.set_roster(lan=[SPEAKER_KITCHEN, SPEAKER_DEN])
    await settle(hass, fake)
    freezer.tick(timedelta(minutes=12))
    async_fire_time_changed(hass)
    await settle(hass, fake)
    assert er.async_get(hass).async_get_entity_id("media_player", DOMAIN, DEN_UID) == DEN
    assert hass.states.get(DEN).state != "unavailable"


async def test_speakers_stay_while_the_server_is_away(
    hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify, freezer: FrozenDateTimeFactory
) -> None:
    """Not connected says nothing about the speakers: none are removed."""
    fake.admin = True
    fake.lan = [SPEAKER_KITCHEN, SPEAKER_DEN]
    await setup(hass, fake, entry)
    fake.ws_down = True
    await fake.drop_sockets()
    await settle(hass, fake)
    assert hass.states.get(DEN).state == "unavailable"
    freezer.tick(timedelta(minutes=30))
    async_fire_time_changed(hass)
    await settle(hass, fake)
    assert er.async_get(hass).async_get_entity_id("media_player", DOMAIN, DEN_UID) == DEN
    assert er.async_get(hass).async_get_entity_id("media_player", DOMAIN, KITCHEN_UID) == KITCHEN


async def test_speakers_stay_when_home_assistant_starts_without_the_server(
    hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The players from last time stay while the session has not connected yet."""
    monkeypatch.setattr("custom_components.slopify.FIRST_CONNECT_WAIT", 0.1)
    # Gone at once, were they counted as gone: only "not connected" keeps them.
    monkeypatch.setattr("custom_components.slopify.media_player.SPEAKER_GONE_AFTER", timedelta(0))
    fake.admin = True
    fake.lan = [SPEAKER_KITCHEN, SPEAKER_DEN]
    fake.ws_down = True
    entry.add_to_hass(hass)
    er.async_get(hass).async_get_or_create(
        "media_player", DOMAIN, DEN_UID, config_entry=entry, suggested_object_id="den_slopify"
    )
    await setup(hass, fake, entry)
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=61))
    await settle(hass, fake)
    assert er.async_get(hass).async_get_entity_id("media_player", DOMAIN, DEN_UID) == DEN
