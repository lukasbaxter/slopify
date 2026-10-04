"""Slopify: your self-hosted music server's playback sessions in Home Assistant.

One config entry signs in as one Slopify account. When that account is an
admin, the entry follows the whole household: every account on the server
gets its own player, accounts added or removed in Slopify come and go here
within a minute, and every speaker the server drives gets a player whose
sources are the household's accounts.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
import logging
from pathlib import Path
from typing import Any

from homeassistant.components import websocket_api
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_URL, CONF_VERIFY_SSL, Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration
import voluptuous as vol

from .api import (
    InvalidAuth,
    NotFound,
    PasswordChangeRequired,
    SlopifyApi,
    SlopifyError,
    SlopifySession,
)
from .const import CLIENT_KIND, CLIENT_NAME, CONF_HOUSEHOLD, CONF_TOKEN, DOMAIN

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.BUTTON, Platform.MEDIA_PLAYER]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
CARDS_URL = "/slopify_static"
# entity_id -> the Slopify media player entity (for the cards' lyrics).
PLAYERS: dict[str, Any] = {}
# Long enough for a healthy server to answer the hello, short enough that a
# slow one does not hold up Home Assistant's start; the entity shows
# unavailable until it connects either way.
FIRST_CONNECT_WAIT = 10.0
HOUSEHOLD_EVERY = timedelta(seconds=60)


@dataclass
class Account:
    """One Slopify account this entry follows."""

    user_id: str
    name: str
    api: SlopifyApi
    session: SlopifySession = field(init=False)
    main: bool = False
    listeners: list[Callable[[], None]] = field(default_factory=list)

    def notify(self) -> None:
        """Tell this account's listeners its session changed."""
        for listener in list(self.listeners):
            listener()


@dataclass
class SlopifyData:
    """What one config entry holds while loaded."""

    main: Account
    accounts: dict[str, Account] = field(default_factory=dict)
    # Called with each account added after setup, and each one removed.
    on_added: list[Callable[[Account], None]] = field(default_factory=list)
    on_removed: list[Callable[[Account], None]] = field(default_factory=list)
    # Any account's session changed (the speaker players follow all of them).
    listeners: list[Callable[[], None]] = field(default_factory=list)
    admin: bool = False
    household: bool = False

    @property
    def api(self) -> SlopifyApi:
        """The entry's own account's API."""
        return self.main.api

    @property
    def session(self) -> SlopifySession:
        """The entry's own account's session."""
        return self.main.session

    def notify_all(self) -> None:
        """Tell the speaker players something changed."""
        for listener in list(self.listeners):
            listener()


type SlopifyConfigEntry = ConfigEntry[SlopifyData]


def _session_for(hass: HomeAssistant, entry: SlopifyConfigEntry, data: SlopifyData | None, account: Account) -> None:
    def changed() -> None:
        account.notify()
        if data is not None:
            data.notify_all()

    def auth_failed() -> None:
        if account.main:
            entry.async_start_reauth(hass)
        elif data is not None:
            # A household sign-in revoked in the app: drop it; the next
            # household check signs that account in again.
            hass.async_create_task(_drop(data, account.user_id))

    account.session = SlopifySession(
        account.api,
        f"ha-{entry.entry_id}" if account.main else f"ha-{entry.entry_id}-{account.user_id[:12]}",
        name=CLIENT_NAME,
        kind=CLIENT_KIND,
        on_change=changed,
        on_auth_failed=auth_failed,
    )
    account.session.start(
        lambda coro: entry.async_create_background_task(hass, coro, f"{DOMAIN} session {account.name}")
    )


async def _drop(data: SlopifyData, user_id: str) -> None:
    account = data.accounts.pop(user_id, None)
    if account is None:
        return
    await account.session.stop()
    for callback_ in list(data.on_removed):
        callback_(account)
    data.notify_all()


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve and load the Slopify cards, and answer their lyrics requests."""
    version = (await async_get_integration(hass, DOMAIN)).version
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARDS_URL, str(Path(__file__).parent / "frontend"), cache_headers=False)]
    )
    add_extra_js_url(hass, f"{CARDS_URL}/slopify-cards.js?v={version}")
    websocket_api.async_register_command(hass, ws_lyrics)
    return True


@websocket_api.websocket_command({vol.Required("type"): "slopify/lyrics", vol.Required("entity_id"): str})
@websocket_api.async_response
async def ws_lyrics(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The lyrics of the song a Slopify player shows: [{start (ms) | null, text}]."""
    player = PLAYERS.get(msg["entity_id"])
    if player is None:
        connection.send_error(msg["id"], "not_found", "Not a Slopify player")
        return
    lines = await player.async_lyrics()
    connection.send_result(msg["id"], {"lines": lines})


async def async_setup_entry(hass: HomeAssistant, entry: SlopifyConfigEntry) -> bool:
    """Sign in with the saved token and join the account's session (and the household's)."""
    http = async_get_clientsession(hass, verify_ssl=entry.data.get(CONF_VERIFY_SSL, True))
    api = SlopifyApi(http, entry.data[CONF_URL], entry.data[CONF_TOKEN])
    try:
        user = await api.me()
    except (InvalidAuth, PasswordChangeRequired) as err:
        raise ConfigEntryAuthFailed(translation_domain=DOMAIN, translation_key="auth_failed") from err
    except SlopifyError as err:
        raise ConfigEntryNotReady(
            translation_domain=DOMAIN,
            translation_key="cannot_connect",
            translation_placeholders={"url": api.url, "error": str(err)},
        ) from err

    main = Account(str(user["id"]), str(user.get("name") or entry.data.get("username") or "Slopify"), api, main=True)
    data = SlopifyData(main=main, accounts={main.user_id: main})
    entry.runtime_data = data
    _session_for(hass, entry, data, main)

    data.admin = user.get("role") == "admin"
    if data.admin and entry.options.get(CONF_HOUSEHOLD, True):
        data.household = True
        await _sync_household(hass, entry, data, initial=True)

        async def _tick(_now: object) -> None:
            await _sync_household(hass, entry, data)

        entry.async_on_unload(async_track_time_interval(hass, _tick, HOUSEHOLD_EVERY))

    if not await main.session.wait_connected(FIRST_CONNECT_WAIT):
        _LOGGER.info("Slopify session at %s not connected yet; it keeps trying", api.url)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_options_changed))
    return True


async def _options_changed(hass: HomeAssistant, entry: SlopifyConfigEntry) -> None:
    """Following the household or not changes which players exist: reload."""
    data = entry.runtime_data
    if data.admin and entry.options.get(CONF_HOUSEHOLD, True) != data.household:
        await hass.config_entries.async_reload(entry.entry_id)


def _owned_elsewhere(hass: HomeAssistant, entry: SlopifyConfigEntry) -> set[str]:
    """Accounts another Slopify entry already signs in as itself (those keep their own player)."""
    return {
        str(other.unique_id)
        for other in hass.config_entries.async_entries(DOMAIN)
        if other.entry_id != entry.entry_id and other.data.get(CONF_URL) == entry.data.get(CONF_URL)
    }


async def _sync_household(
    hass: HomeAssistant, entry: SlopifyConfigEntry, data: SlopifyData, *, initial: bool = False
) -> None:
    """Bring the followed accounts in line with the accounts on the server."""
    try:
        users = (await data.api.get("/api/users")).get("users", [])
    except SlopifyError as err:
        _LOGGER.debug("Could not list Slopify accounts: %s", err)
        return
    elsewhere = _owned_elsewhere(hass, entry)
    wanted = {
        str(u["id"]): str(u.get("name") or u["id"]) for u in users if u.get("id") and str(u["id"]) not in elsewhere
    }
    wanted[data.main.user_id] = data.main.name
    for user_id in [u for u in data.accounts if u not in wanted]:
        await _drop(data, user_id)
    for user_id, name in wanted.items():
        have = data.accounts.get(user_id)
        if have is not None:
            have.name = name
            continue
        try:
            token = (await data.api.post(f"/api/users/{user_id}/household-token", {"device": CLIENT_NAME}))["token"]
        except NotFound:
            if initial:
                _LOGGER.info(
                    "This Slopify server cannot share its accounts (update it); following %s only", data.main.name
                )
            return
        except (SlopifyError, KeyError, TypeError) as err:
            _LOGGER.debug("Could not sign in as Slopify account %s: %s", name, err)
            continue
        account = Account(user_id, name, SlopifyApi(data.api.http, data.api.url, token))
        data.accounts[user_id] = account
        _session_for(hass, entry, data, account)
        for callback_ in list(data.on_added):
            callback_(account)
    data.notify_all()


async def async_unload_entry(hass: HomeAssistant, entry: SlopifyConfigEntry) -> bool:
    """Leave the sessions."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        for account in list(entry.runtime_data.accounts.values()):
            await account.session.stop()
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Sign Home Assistant out of Slopify when the integration is removed."""
    http = async_get_clientsession(hass, verify_ssl=entry.data.get(CONF_VERIFY_SSL, True))
    api = SlopifyApi(http, entry.data[CONF_URL], entry.data[CONF_TOKEN])
    # The household sign-ins first (asking for one returns the existing one),
    # then the entry's own.
    try:
        if (await api.me()).get("role") == "admin":
            for user in (await api.get("/api/users")).get("users", []):
                token = (await api.post(f"/api/users/{user['id']}/household-token", {"device": CLIENT_NAME}))["token"]
                await SlopifyApi(http, api.url, token).logout()
    except (SlopifyError, KeyError, TypeError) as err:
        _LOGGER.debug("Could not sign the household out of Slopify: %s", err)
    try:
        await api.logout()
    except SlopifyError as err:
        _LOGGER.debug("Could not sign out of Slopify (%s); the sign-in stays listed in the app", err)


@callback
def account_label(account: Account) -> str:
    """How an account appears as a speaker's source."""
    return f"Slopify - {account.name}"
