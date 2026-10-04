"""Fixtures: a fake Slopify server and a config entry signed in to it."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

from homeassistant.const import CONF_URL, CONF_USERNAME, CONF_VERIFY_SSL
from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.slopify.const import CONF_TOKEN, CONF_USER_ID, DOMAIN

from .fake_slopify import SERVER_ID, USER_ID, FakeSlopify


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Load custom_components/ in every test."""


@pytest.fixture
async def fake(socket_enabled: Any) -> AsyncGenerator[FakeSlopify]:
    """A running fake Slopify server."""
    server = FakeSlopify()
    await server.start()
    yield server
    await server.stop()


@pytest.fixture
def entry(fake: FakeSlopify) -> MockConfigEntry:
    """A config entry signed in to the fake server."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="lukas on 127.0.0.1",
        unique_id=USER_ID,
        data={
            CONF_URL: fake.url,
            CONF_VERIFY_SSL: True,
            CONF_USERNAME: "lukas",
            CONF_USER_ID: USER_ID,
            CONF_TOKEN: "tok-valid",
            "server_id": SERVER_ID,
        },
    )


@pytest.fixture
async def loaded(hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify) -> MockConfigEntry:
    """The integration set up and connected."""
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    await fake.wait_for(lambda: fake.hellos)
    return entry
