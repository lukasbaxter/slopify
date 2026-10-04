"""Slopify: your self-hosted music server's playback session in Home Assistant."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_URL, CONF_VERIFY_SSL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import (
    InvalidAuth,
    PasswordChangeRequired,
    SlopifyApi,
    SlopifyError,
    SlopifySession,
)
from .const import CLIENT_KIND, CLIENT_NAME, CONF_TOKEN, DOMAIN

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.MEDIA_PLAYER]
# Long enough for a healthy server to answer the hello, short enough that a
# slow one does not hold up Home Assistant's start; the entity shows
# unavailable until it connects either way.
FIRST_CONNECT_WAIT = 10.0


@dataclass
class SlopifyData:
    """What one config entry holds while loaded."""

    api: SlopifyApi
    session: SlopifySession = field(init=False)
    listeners: list[Callable[[], None]] = field(default_factory=list)

    def notify(self) -> None:
        """Tell every listener the session changed."""
        for listener in list(self.listeners):
            listener()


type SlopifyConfigEntry = ConfigEntry[SlopifyData]


async def async_setup_entry(hass: HomeAssistant, entry: SlopifyConfigEntry) -> bool:
    """Sign in with the saved token and join the account's session."""
    http = async_get_clientsession(hass, verify_ssl=entry.data.get(CONF_VERIFY_SSL, True))
    api = SlopifyApi(http, entry.data[CONF_URL], entry.data[CONF_TOKEN])
    try:
        await api.me()
    except (InvalidAuth, PasswordChangeRequired) as err:
        raise ConfigEntryAuthFailed(translation_domain=DOMAIN, translation_key="auth_failed") from err
    except SlopifyError as err:
        raise ConfigEntryNotReady(
            translation_domain=DOMAIN,
            translation_key="cannot_connect",
            translation_placeholders={"url": api.url, "error": str(err)},
        ) from err

    data = SlopifyData(api)
    data.session = SlopifySession(
        api,
        f"ha-{entry.entry_id}",
        name=CLIENT_NAME,
        kind=CLIENT_KIND,
        on_change=data.notify,
        on_auth_failed=lambda: entry.async_start_reauth(hass),
    )
    entry.runtime_data = data
    data.session.start(lambda coro: entry.async_create_background_task(hass, coro, f"{DOMAIN} session {entry.title}"))
    if not await data.session.wait_connected(FIRST_CONNECT_WAIT):
        _LOGGER.info("Slopify session at %s not connected yet; it keeps trying", api.url)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SlopifyConfigEntry) -> bool:
    """Leave the session."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.session.stop()
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Sign Home Assistant out of Slopify when the integration is removed."""
    http = async_get_clientsession(hass, verify_ssl=entry.data.get(CONF_VERIFY_SSL, True))
    api = SlopifyApi(http, entry.data[CONF_URL], entry.data[CONF_TOKEN])
    try:
        await api.logout()
    except SlopifyError as err:
        _LOGGER.debug("Could not sign out of Slopify (%s); the sign-in stays listed in the app", err)
