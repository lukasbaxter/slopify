"""Diagnostics: the sessions as this integration sees them, sign-ins redacted."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.const import CONF_PASSWORD
from homeassistant.core import HomeAssistant

from . import SlopifyConfigEntry
from .model import targets

TO_REDACT = {"token", CONF_PASSWORD, "artUrl"}


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: SlopifyConfigEntry) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    data = entry.runtime_data
    accounts = {}
    for account in data.accounts.values():
        s = account.session
        accounts[account.name] = {
            "main": account.main,
            "connected": s.connected,
            "last_error": s.last_error,
            "client_id": s.client_id,
            "active_client": s.active_id,
            "players": async_redact_data(s.players, TO_REDACT),
            "sources": [t.__dict__ for t in targets(s.players, s.lan_devices)],
            "queue_lengths": {k: len(v) for k, v in s.queues.items()},
            "remembered": async_redact_data(s.remembered or {}, TO_REDACT),
            "remembered_queue_length": len(s.remembered_queue),
        }
    return {
        "entry": {"data": async_redact_data(dict(entry.data), TO_REDACT), "options": dict(entry.options)},
        "admin": data.admin,
        "household": data.household,
        "speakers": [
            {k: d.get(k) for k in ("id", "kind", "name", "model", "viaClient")} for d in data.session.lan_devices
        ],
        "accounts": accounts,
    }
