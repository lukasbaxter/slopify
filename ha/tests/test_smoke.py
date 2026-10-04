"""Smoke: the entry loads, joins the session, and shows the player."""

from homeassistant.core import HomeAssistant

from .fake_slopify import FakeSlopify


async def test_loads(hass: HomeAssistant, loaded, fake: FakeSlopify) -> None:
    state = hass.states.get("media_player.slopify_lukas")
    assert state is not None, hass.states.async_entity_ids()
    assert state.state == "idle"
    hello = fake.hellos[0]
    assert hello["canPlay"] is False and hello["kind"] == "homeassistant" and hello["name"] == "Home Assistant"
