"""Setting up Slopify: sign in once, keep only a revocable token."""

from __future__ import annotations

from collections.abc import Mapping
import contextlib
import logging
from typing import Any

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_PASSWORD, CONF_URL, CONF_USERNAME, CONF_VERIFY_SSL
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo
import voluptuous as vol
from yarl import URL

from .api import (
    CannotConnect,
    InvalidAuth,
    NotSlopify,
    PasswordChangeRequired,
    SlopifyApi,
    SlopifyError,
    TooManyAttempts,
    normalize_url,
)
from .const import (
    CLIENT_NAME,
    CONF_DEFAULT_SOURCE,
    CONF_HOUSEHOLD,
    CONF_TOKEN,
    CONF_USER_ID,
    DEFAULT_SOURCE_LAST,
    DOMAIN,
)
from .model import targets

_LOGGER = logging.getLogger(__name__)

CONF_SERVER_ID = "server_id"
PASSWORD = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD, autocomplete="current-password"))
USERNAME = TextSelector(TextSelectorConfig(type=TextSelectorType.TEXT, autocomplete="username"))
URL_FIELD = TextSelector(TextSelectorConfig(type=TextSelectorType.URL))


def _schema(defaults: Mapping[str, Any], *, url: bool = True, username: bool = True) -> vol.Schema:
    fields: dict[Any, Any] = {}
    if url:
        fields[vol.Required(CONF_URL, default=defaults.get(CONF_URL, vol.UNDEFINED))] = URL_FIELD
    if username:
        fields[vol.Required(CONF_USERNAME, default=defaults.get(CONF_USERNAME, vol.UNDEFINED))] = USERNAME
    fields[vol.Required(CONF_PASSWORD)] = PASSWORD
    if url:
        fields[vol.Optional(CONF_VERIFY_SSL, default=defaults.get(CONF_VERIFY_SSL, True))] = bool
    return vol.Schema(fields)


class SlopifyConfigFlow(ConfigFlow, domain=DOMAIN):
    """Add a Slopify account."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialize the flow."""
        self._discovered: dict[str, Any] = {}

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> SlopifyOptionsFlow:
        """Options: where to start playing when nothing is playing."""
        return SlopifyOptionsFlow()

    async def _sign_in(self, user_input: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
        """Sign in; returns the entry data, or form errors."""
        try:
            url = normalize_url(user_input[CONF_URL])
        except ValueError:
            return {}, {CONF_URL: "invalid_url"}
        verify_ssl = bool(user_input.get(CONF_VERIFY_SSL, True))
        api = SlopifyApi(async_get_clientsession(self.hass, verify_ssl=verify_ssl), url)
        try:
            await api.health()
            await api.login(user_input[CONF_USERNAME], user_input[CONF_PASSWORD], CLIENT_NAME)
            user = await api.me()
        except PasswordChangeRequired:
            await _sign_out(api)
            return {}, {"base": "password_change_required"}
        except InvalidAuth:
            return {}, {"base": "invalid_auth"}
        except TooManyAttempts:
            return {}, {"base": "too_many_attempts"}
        except NotSlopify:
            return {}, {CONF_URL: "not_slopify"}
        except CannotConnect as err:
            _LOGGER.debug("Cannot reach Slopify at %s: %s", url, err)
            return {}, {CONF_URL: "cannot_connect"}
        except SlopifyError:
            _LOGGER.exception("Unexpected answer from Slopify at %s", url)
            return {}, {"base": "unknown"}
        server_id = None
        # An older server has no /api/server: discovery just cannot recognize it.
        with contextlib.suppress(SlopifyError):
            server_id = (await api.get("/api/server")).get("id")
        return {
            CONF_URL: api.url,
            CONF_VERIFY_SSL: verify_ssl,
            CONF_USERNAME: user.get("name") or user_input[CONF_USERNAME],
            CONF_USER_ID: user["id"],
            CONF_TOKEN: api.token,
            CONF_SERVER_ID: server_id,
        }, {}

    async def _discard(self, data: Mapping[str, Any]) -> None:
        """Sign out a token this flow made but will not keep."""
        api = SlopifyApi(
            async_get_clientsession(self.hass, verify_ssl=data.get(CONF_VERIFY_SSL, True)),
            data[CONF_URL],
            data[CONF_TOKEN],
        )
        await _sign_out(api)

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Server address and the account to sign in with."""
        errors: dict[str, str] = {}
        if user_input is not None:
            data, errors = await self._sign_in(user_input)
            if not errors:
                await self.async_set_unique_id(data[CONF_USER_ID], raise_on_progress=False)
                if self._async_current_entries_with_unique_id():
                    await self._discard(data)
                    return self.async_abort(reason="already_configured")
                return self.async_create_entry(title=_title(data), data=data)
        defaults = {**self._discovered, **(user_input or {})}
        return self.async_show_form(
            step_id="user",
            data_schema=_schema(defaults),
            errors=errors,
            description_placeholders={"discovered": self._discovered.get(CONF_URL, "")},
        )

    def _async_current_entries_with_unique_id(self) -> list[ConfigEntry]:
        return [e for e in self._async_current_entries(include_ignore=False) if e.unique_id == self.unique_id]

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> ConfigFlowResult:
        """A Slopify server announced itself on the network."""
        if discovery_info.ip_address.version != 4:
            return self.async_abort(reason="not_ipv4")
        server_id = str(discovery_info.properties.get("id") or "")
        url = f"http://{discovery_info.host}:{discovery_info.port}"
        if server_id:
            await self.async_set_unique_id(f"server-{server_id}")
            self._abort_if_unique_id_configured()
        for entry in self._async_current_entries(include_ignore=False):
            same_server = server_id and entry.data.get(CONF_SERVER_ID) == server_id
            if same_server or URL(entry.data.get(CONF_URL, "")).host == discovery_info.host:
                return self.async_abort(reason="already_configured")
        self._discovered = {CONF_URL: url}
        self.context["title_placeholders"] = {
            "name": discovery_info.properties.get("name")
            or discovery_info.hostname.removesuffix(".local.")
            or "Slopify"
        }
        return await self.async_step_user()

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """The saved sign-in stopped working (signed out, or password changed)."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Sign in again as the same account."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            data, errors = await self._sign_in({**entry.data, **user_input})
            if not errors:
                if data[CONF_USER_ID] != entry.unique_id:
                    await self._discard(data)
                    return self.async_abort(reason="wrong_account")
                return self.async_update_reload_and_abort(
                    entry,
                    data_updates={
                        CONF_TOKEN: data[CONF_TOKEN],
                        CONF_SERVER_ID: data[CONF_SERVER_ID] or entry.data.get(CONF_SERVER_ID),
                    },
                )
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=_schema(entry.data, url=False),
            errors=errors,
            description_placeholders={"url": entry.data[CONF_URL], "username": entry.data.get(CONF_USERNAME, "")},
        )

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Change the server address (moved, new domain, HTTPS)."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            data, errors = await self._sign_in(user_input)
            if not errors:
                if data[CONF_USER_ID] != entry.unique_id:
                    await self._discard(data)
                    return self.async_abort(reason="wrong_account")
                old = dict(entry.data)
                result = self.async_update_reload_and_abort(entry, title=_title(data), data={**entry.data, **data})
                if old.get(CONF_TOKEN) != data[CONF_TOKEN]:
                    await self._discard(old)
                return result
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=_schema({**entry.data, **(user_input or {})}),
            errors=errors,
        )


class SlopifyOptionsFlow(OptionsFlow):
    """Where Play starts when nothing plays, and whether to follow the household."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Pick the default source."""
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        current = self.config_entry.options.get(CONF_DEFAULT_SOURCE, DEFAULT_SOURCE_LAST)
        options = [SelectOptionDict(value=DEFAULT_SOURCE_LAST, label="Where it last played")]
        runtime = getattr(self.config_entry, "runtime_data", None)
        found = targets(runtime.session.players, runtime.session.lan_devices) if runtime else []
        options += [SelectOptionDict(value=t.key, label=t.name) for t in found]
        if current not in {o["value"] for o in options}:
            options.append(
                SelectOptionDict(value=current, label=f"{current.split(':', 1)[-1]} (not available right now)")
            )
        fields: dict[Any, Any] = {
            vol.Required(CONF_DEFAULT_SOURCE, default=current): SelectSelector(
                SelectSelectorConfig(options=options, mode=SelectSelectorMode.DROPDOWN)
            )
        }
        if runtime is None or runtime.admin:
            fields[vol.Required(CONF_HOUSEHOLD, default=self.config_entry.options.get(CONF_HOUSEHOLD, True))] = bool
        return self.async_show_form(step_id="init", data_schema=vol.Schema(fields))


def _title(data: Mapping[str, Any]) -> str:
    return f"{data.get(CONF_USERNAME) or 'Slopify'} on {URL(data[CONF_URL]).host}"


async def _sign_out(api: SlopifyApi) -> None:
    with contextlib.suppress(SlopifyError):
        await api.logout()
