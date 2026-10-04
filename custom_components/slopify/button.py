"""A button that breaks up every speaker group at once."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SlopifyConfigEntry
from .api import NotFound, SlopifyError
from .const import DOMAIN

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SlopifyConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add the ungroup-all button."""
    async_add_entities([UngroupAll(entry)])


def speakers_device(entry: SlopifyConfigEntry) -> DeviceInfo:
    """The server's speakers as a whole (the household's speaker settings)."""
    server = entry.data.get("server_id") or entry.unique_id
    return DeviceInfo(
        identifiers={(DOMAIN, f"{server}-speakers")},
        name="Slopify speakers",
        manufacturer="Slopify",
        model="Speaker groups",
        configuration_url=entry.runtime_data.api.url,
    )


class UngroupAll(ButtonEntity):
    """Every speaker plays on its own again."""

    _attr_has_entity_name = True
    _attr_translation_key = "ungroup_all"

    def __init__(self, entry: SlopifyConfigEntry) -> None:
        """Initialize the button."""
        self._entry = entry
        server = entry.data.get("server_id") or entry.unique_id
        self._attr_unique_id = f"{server}-ungroup-all"
        self._attr_device_info = speakers_device(entry)

    async def async_press(self) -> None:
        """Break up every speaker group."""
        try:
            await self._entry.runtime_data.api.post("/api/speakers/groups/clear", {})
        except NotFound as err:
            raise HomeAssistantError(translation_domain=DOMAIN, translation_key="groups_unsupported") from err
        except SlopifyError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="group_failed", translation_placeholders={"error": str(err)}
            ) from err
