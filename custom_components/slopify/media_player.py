"""The Slopify session as a Home Assistant media player.

One entity per account. It shows whatever the account is playing, on any app
or speaker, and controls it there; its sources are the outputs the session can
move to (speakers and the apps that can play).
"""

from __future__ import annotations

from datetime import datetime
import logging
import time
from typing import Any

from homeassistant.components.media_player import (
    ATTR_MEDIA_ENQUEUE,
    BrowseMedia,
    MediaPlayerDeviceClass,
    MediaPlayerEnqueue,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
    MediaType,
    RepeatMode,
    SearchMedia,
    SearchMediaQuery,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import SlopifyConfigEntry
from .api import CannotConnect, SlopifyError
from .const import BROWSE_IMAGE_SIZE, CONF_DEFAULT_SOURCE, DEFAULT_SOURCE_LAST, DOMAIN, PLAYER_IMAGE_SIZE
from .library import Library, MediaNotFound, UnsupportedMedia, valid_image_id
from .model import Target, as_dict, current_key, handoff, last_speaker_key, position_now, targets

_LOGGER = logging.getLogger(__name__)

PARALLEL_UPDATES = 0
# A reported playhead within this many seconds of where the clock says it
# should be is the same playback, not a jump: the card keeps its own clock.
POSITION_SLACK = 1.5

ALWAYS = (
    MediaPlayerEntityFeature.PLAY
    | MediaPlayerEntityFeature.PLAY_MEDIA
    | MediaPlayerEntityFeature.MEDIA_ENQUEUE
    | MediaPlayerEntityFeature.BROWSE_MEDIA
    | MediaPlayerEntityFeature.SEARCH_MEDIA
    | MediaPlayerEntityFeature.SELECT_SOURCE
)
WHILE_ACTIVE = (
    MediaPlayerEntityFeature.PAUSE
    | MediaPlayerEntityFeature.STOP
    | MediaPlayerEntityFeature.SEEK
    | MediaPlayerEntityFeature.NEXT_TRACK
    | MediaPlayerEntityFeature.PREVIOUS_TRACK
    | MediaPlayerEntityFeature.VOLUME_SET
    | MediaPlayerEntityFeature.VOLUME_STEP
    | MediaPlayerEntityFeature.VOLUME_MUTE
    | MediaPlayerEntityFeature.SHUFFLE_SET
    | MediaPlayerEntityFeature.REPEAT_SET
    | MediaPlayerEntityFeature.CLEAR_PLAYLIST
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SlopifyConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add the session player for this account."""
    async_add_entities([SlopifyPlayer(entry)])


class SlopifyPlayer(MediaPlayerEntity):
    """The account's playback session."""

    _attr_has_entity_name = True
    _attr_name = None
    _attr_translation_key = "session"
    _attr_device_class = MediaPlayerDeviceClass.SPEAKER
    _attr_media_content_type = MediaType.MUSIC
    _attr_should_poll = False

    def __init__(self, entry: SlopifyConfigEntry) -> None:
        """Initialize the player."""
        self._entry = entry
        self._data = entry.runtime_data
        self._session = self._data.session
        self._library = Library(self._data.api, self.get_browse_image_url)
        username = entry.data.get("username") or "Slopify"
        self._attr_unique_id = entry.unique_id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, str(entry.unique_id))},
            name=f"Slopify {username}",
            manufacturer="Slopify",
            model="Playback session",
            entry_type=DeviceEntryType.SERVICE,
            configuration_url=self._data.api.url,
        )
        self._targets: list[Target] = []
        self._now_playing: dict[str, Any] | None = None
        self._np_elapsed_from = 0.0
        self._active_id: str | None = None
        self._anchor_track: str | None = None
        self._anchor_playing = False
        self._unmute_level = 0.5
        self._fingerprint: tuple[Any, ...] | None = None
        self._refresh()

    async def async_added_to_hass(self) -> None:
        """Follow the session."""
        self._data.listeners.append(self._on_change)
        self.async_on_remove(lambda: self._data.listeners.remove(self._on_change))
        self._on_change()

    # --- following the session ------------------------------------------------

    @callback
    def _on_change(self) -> None:
        if self.hass is None:
            return
        self._refresh()
        fingerprint = self._make_fingerprint()
        if fingerprint != self._fingerprint:
            self._fingerprint = fingerprint
            self.async_write_ha_state()

    def _make_fingerprint(self) -> tuple[Any, ...]:
        return (
            self.available,
            self._attr_state,
            self._attr_media_content_id,
            self._attr_media_title,
            self._attr_media_artist,
            self._attr_media_album_name,
            self._attr_media_image_hash,
            self._attr_media_duration,
            self._attr_media_position,
            self._attr_media_position_updated_at,
            self._attr_volume_level,
            self._attr_is_volume_muted,
            self._attr_shuffle,
            self._attr_repeat,
            self._attr_source,
            tuple(self._attr_source_list or ()),
            self._attr_supported_features,
            bool((self._now_playing or {}).get("liked")),
        )

    def _refresh(self) -> None:
        """Read the session into the entity's attributes."""
        s = self._session
        self._attr_available = s.connected
        self._targets = targets(s.players, s.lan_devices)
        self._attr_source_list = [t.name for t in self._targets]

        active = next((p for p in s.players if p.get("id") == s.active_id), None)
        np = active.get("nowPlaying") if active and isinstance(active.get("nowPlaying"), dict) else None
        if np is not None:
            self._active_id = s.active_id
            self._now_playing = np
            self._np_elapsed_from = s.np_received.get(s.active_id or "", time.monotonic())
            state = MediaPlayerState.PLAYING if np.get("playing") else MediaPlayerState.PAUSED
        else:
            # Nothing is making sound: show what played last, ready to resume.
            self._active_id = None
            self._now_playing = s.remembered if isinstance(s.remembered, dict) else None
            self._np_elapsed_from = s.remembered_received
            state = MediaPlayerState.IDLE
        self._attr_state = state
        self._attr_supported_features = ALWAYS | (WHILE_ACTIVE if self._active_id else MediaPlayerEntityFeature(0))

        np = self._now_playing or {}
        item = np.get("itemId") if isinstance(np.get("itemId"), str) else None
        self._attr_media_content_id = f"track:{item}" if item else None
        self._attr_media_title = np.get("title") or None
        self._attr_media_artist = np.get("artist") or None
        self._attr_media_album_name = np.get("album") or None
        image = np.get("albumId") or item
        self._attr_media_image_hash = image if valid_image_id(image) else None
        duration = np.get("duration")
        self._attr_media_duration = (
            round(float(duration)) if isinstance(duration, (int, float)) and duration > 0 else None
        )

        if self._active_id:
            volume = np.get("volume")
            self._attr_volume_level = (
                max(0.0, min(1.0, float(volume) / 100)) if isinstance(volume, (int, float)) else None
            )
            self._attr_is_volume_muted = self._attr_volume_level == 0 if self._attr_volume_level is not None else None
            self._attr_shuffle = np.get("shuffle") in ("on", "smart")
            self._attr_repeat = (
                RepeatMode(np["repeat"]) if np.get("repeat") in ("off", "all", "one") else RepeatMode.OFF
            )
        else:
            self._attr_volume_level = None
            self._attr_is_volume_muted = None
            self._attr_shuffle = None
            self._attr_repeat = None

        key = current_key(self._active_id, np if self._active_id else None, s.players)
        target = next((t for t in self._targets if t.key == key), None)
        device = as_dict(np.get("device"))
        self._attr_source = target.name if target else (device.get("name") if self._active_id else None)

        self._update_position(item, state)

    def _update_position(self, item: str | None, state: MediaPlayerState) -> None:
        if not item or not self._now_playing:
            self._attr_media_position = None
            self._attr_media_position_updated_at = None
            self._anchor_track = None
            return
        now = dt_util.utcnow()
        pos = position_now(self._now_playing, time.monotonic() - self._np_elapsed_from)
        playing = state == MediaPlayerState.PLAYING
        was = self._attr_media_position
        at: datetime | None = self._attr_media_position_updated_at
        expected = None
        if was is not None and at is not None:
            expected = was + ((now - at).total_seconds() if self._anchor_playing else 0.0)
        if (
            self._anchor_track != item
            or self._anchor_playing != playing
            or expected is None
            or abs(expected - pos) > POSITION_SLACK
        ):
            self._attr_media_position = round(pos)
            self._attr_media_position_updated_at = now
            self._anchor_track = item
            self._anchor_playing = playing

    # --- artwork ----------------------------------------------------------------

    async def async_get_media_image(self) -> tuple[bytes | None, str | None]:
        """Artwork of what is playing, fetched with this account's sign-in."""
        image = self._attr_media_image_hash
        if not image:
            return None, None
        return await self._data.api.image(image, PLAYER_IMAGE_SIZE)

    async def async_get_browse_image(
        self,
        media_content_type: str,
        media_content_id: str,
        media_image_id: str | None = None,
    ) -> tuple[bytes | None, str | None]:
        """Artwork for the media browser."""
        if not valid_image_id(media_image_id):
            return None, None
        return await self._data.api.image(str(media_image_id), BROWSE_IMAGE_SIZE)

    # --- controls ---------------------------------------------------------------

    async def _send(self, command: dict[str, Any], to: str | None = None) -> None:
        target = to or self._active_id
        if not target:
            raise ServiceValidationError(translation_domain=DOMAIN, translation_key="nothing_playing")
        try:
            await self._session.command(target, command)
        except CannotConnect as err:
            raise HomeAssistantError(translation_domain=DOMAIN, translation_key="not_connected") from err

    async def async_media_play(self) -> None:
        """Play, or resume the last session where it is best heard."""
        if self.state == MediaPlayerState.PAUSED:
            await self._send({"action": "toggle"})
        elif self.state == MediaPlayerState.IDLE:
            payload = handoff(self._now_playing, self._session.remembered_queue, 0.0)
            if payload is None:
                raise ServiceValidationError(translation_domain=DOMAIN, translation_key="nothing_to_resume")
            await self._transfer(self._start_target(), payload, playing=True)

    async def async_media_pause(self) -> None:
        """Pause."""
        if self.state == MediaPlayerState.PLAYING:
            await self._send({"action": "toggle"})

    async def async_media_stop(self) -> None:
        """Stop (Slopify pauses: the session and its place are kept)."""
        await self.async_media_pause()

    async def async_media_next_track(self) -> None:
        """Next song."""
        await self._send({"action": "next"})

    async def async_media_previous_track(self) -> None:
        """Previous song (or back to the start of this one)."""
        await self._send({"action": "previous"})

    async def async_media_seek(self, position: float) -> None:
        """Seek to a position in seconds."""
        await self._send({"action": "seek", "pos": max(0.0, float(position))})

    async def async_set_volume_level(self, volume: float) -> None:
        """Set the output's volume."""
        await self._send({"action": "setVolume", "level": round(max(0.0, min(1.0, volume)) * 100)})

    async def async_mute_volume(self, mute: bool) -> None:
        """Mute by turning the volume to 0; unmute back to where it was."""
        if mute:
            if self.volume_level:
                self._unmute_level = self.volume_level
            await self.async_set_volume_level(0.0)
        else:
            await self.async_set_volume_level(self._unmute_level or 0.5)

    async def async_set_shuffle(self, shuffle: bool) -> None:
        """Shuffle on or off."""
        await self._send({"action": "setShuffle", "mode": "on" if shuffle else "off"})

    async def async_set_repeat(self, repeat: RepeatMode) -> None:
        """Repeat off, all or one."""
        await self._send({"action": "setRepeat", "mode": str(repeat)})

    async def async_clear_playlist(self) -> None:
        """Remove the songs added to the queue (the playing list stays)."""
        await self._send({"action": "queueClear"})

    # --- outputs ----------------------------------------------------------------

    def _target_named(self, name: str) -> Target:
        wanted = (name or "").strip().casefold()
        for t in self._targets:
            if t.name.casefold() == wanted:
                return t
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="unknown_source",
            translation_placeholders={"source": name, "sources": ", ".join(t.name for t in self._targets) or "none"},
        )

    def _start_target(self) -> Target:
        """Where to start when nothing is playing."""
        by_key = {t.key: t for t in self._targets}
        default = self._entry.options.get(CONF_DEFAULT_SOURCE, DEFAULT_SOURCE_LAST)
        if default != DEFAULT_SOURCE_LAST and default in by_key:
            return by_key[default]
        last = last_speaker_key(self._session.remembered)
        if last in by_key:
            return by_key[last]
        if len(self._targets) == 1:
            return self._targets[0]
        raise ServiceValidationError(translation_domain=DOMAIN, translation_key="no_source")

    async def _transfer(self, target: Target, payload: dict[str, Any], *, playing: bool) -> None:
        await self._send(
            {"action": "transfer", "deviceId": target.device_id, **payload, "playing": playing},
            to=target.client_id,
        )

    async def async_select_source(self, source: str) -> None:
        """Move the session to another output, carrying on where it is."""
        target = self._target_named(source)
        s = self._session
        if self._active_id:
            if current_key(self._active_id, self._now_playing, s.players) == target.key:
                return
            payload = handoff(
                self._now_playing, s.queues.get(self._active_id, []), time.monotonic() - self._np_elapsed_from
            )
        else:
            payload = handoff(self._now_playing, s.remembered_queue, 0.0)
        if payload is None:
            raise ServiceValidationError(translation_domain=DOMAIN, translation_key="nothing_to_resume")
        await self._transfer(target, payload, playing=self.state != MediaPlayerState.PAUSED)

    # --- library ----------------------------------------------------------------

    async def async_play_media(self, media_type: MediaType | str, media_id: str, **kwargs: Any) -> None:
        """Play an album, artist, playlist, song, genre, share link or search."""
        if kwargs.get("announce"):
            raise ServiceValidationError(translation_domain=DOMAIN, translation_key="no_announce")
        try:
            what = await self._library.resolve(str(media_type or ""), media_id)
        except UnsupportedMedia as err:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="unsupported_media",
                translation_placeholders={"media_id": media_id},
            ) from err
        except MediaNotFound as err:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="media_not_found",
                translation_placeholders={"media_id": media_id},
            ) from err
        except SlopifyError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="request_failed",
                translation_placeholders={"error": str(err)},
            ) from err
        if not what.track_ids:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="media_not_found",
                translation_placeholders={"media_id": media_id},
            )

        extra = kwargs.get("extra") or {}
        source = extra.get("source") if isinstance(extra, dict) else None
        enqueue = kwargs.get(ATTR_MEDIA_ENQUEUE)
        songs = {"trackIds": what.track_ids, "index": what.index, "position": 0}
        if source:
            await self._transfer(self._target_named(str(source)), songs, playing=True)
        elif not self._active_id:
            await self._transfer(self._start_target(), songs, playing=True)
        elif enqueue in (MediaPlayerEnqueue.ADD, MediaPlayerEnqueue.NEXT):
            # A song picked inside an album or playlist adds that song alone.
            picked = what.track_ids[what.index : what.index + 1] if "#" in media_id else what.track_ids
            await self._send({"action": "enqueue", "trackIds": picked})
        else:
            await self._send({"action": "play", "trackIds": what.track_ids, "index": what.index, "startAt": 0})

    async def async_browse_media(
        self,
        media_content_type: MediaType | str | None = None,
        media_content_id: str | None = None,
    ) -> BrowseMedia:
        """The library, for the media browser."""
        try:
            return await self._library.browse(media_content_id)
        except MediaNotFound as err:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="media_not_found",
                translation_placeholders={"media_id": str(media_content_id)},
            ) from err
        except SlopifyError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="request_failed",
                translation_placeholders={"error": str(err)},
            ) from err

    async def async_search_media(self, query: SearchMediaQuery) -> SearchMedia:
        """Search the library."""
        try:
            return await self._library.search(query)
        except SlopifyError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="request_failed",
                translation_placeholders={"error": str(err)},
            ) from err

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Whether the current song is liked."""
        np = self._now_playing or {}
        return {"liked": bool(np.get("liked"))} if np.get("itemId") else {}
