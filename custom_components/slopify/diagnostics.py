"""Diagnostics: the session as this integration sees it, sign-in redacted."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.const import CONF_PASSWORD
from homeassistant.core import HomeAssistant

from . import SlopifyConfigEntry
from .const import CONF_TOKEN
from .model import targets

TO_REDACT = {CONF_TOKEN, CONF_PASSWORD, "artUrl"}


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: SlopifyConfigEntry) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    session = entry.runtime_data.session
    return {
        "entry": {"data": async_redact_data(dict(entry.data), TO_REDACT), "options": dict(entry.options)},
        "session": {
            "connected": session.connected,
            "last_error": session.last_error,
            "client_id": session.client_id,
            "active_client": session.active_id,
            "players": async_redact_data(session.players, TO_REDACT),
            "speakers": [
                {k: d.get(k) for k in ("id", "kind", "name", "model", "viaClient")} for d in session.lan_devices
            ],
            "sources": [t.__dict__ for t in targets(session.players, session.lan_devices)],
            "queue_lengths": {k: len(v) for k, v in session.queues.items()},
            "remembered": async_redact_data(session.remembered or {}, TO_REDACT),
            "remembered_queue_length": len(session.remembered_queue),
        },
    }
