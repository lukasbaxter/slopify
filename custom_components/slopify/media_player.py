"""Slopify sessions and speakers as Home Assistant media players.

Account players: one per followed account. Each shows whatever that account
is playing, on any app or speaker, and controls it there; its sources are the
outputs that account's session can move to.

Speaker players: one per speaker the Slopify server drives. Each shows whose
music is on it, controls it, and offers the followed accounts as its sources:
picking "Slopify - <name>" moves that account's music onto the speaker.
"""

from __future__ import annotations

from datetime import datetime
import hashlib
import logging
import time
from typing import Any
from urllib.parse import quote

import aiohttp
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
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import PLAYERS, Account, SlopifyConfigEntry, SlopifyData, account_label
from .api import CannotConnect, NotFound, SlopifyError
from .const import BROWSE_IMAGE_SIZE, CONF_DEFAULT_SOURCE, DEFAULT_SOURCE_LAST, DOMAIN, PLAYER_IMAGE_SIZE
from .library import Library, MediaNotFound, Playable, UnsupportedMedia, valid_image_id
from .model import Target, as_dict, current_key, handoff, last_speaker_key, position_now, targets

_LOGGER = logging.getLogger(__name__)

PARALLEL_UPDATES = 0
# A reported playhead within this many seconds of where the clock says it
# should be is the same playback, not a jump: the card keeps its own clock.
POSITION_SLACK = 1.5

BROWSING = (
    MediaPlayerEntityFeature.PLAY_MEDIA
    | MediaPlayerEntityFeature.MEDIA_ENQUEUE
    | MediaPlayerEntityFeature.BROWSE_MEDIA
    | MediaPlayerEntityFeature.SEARCH_MEDIA
)
ALWAYS = MediaPlayerEntityFeature.PLAY | MediaPlayerEntityFeature.SELECT_SOURCE | BROWSING
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
    """Add a player per followed account and per server speaker, now and as they appear."""
    data = entry.runtime_data
    # Players of accounts no longer followed (household turned off, account
    # deleted while Home Assistant was down) go, devices with them.
    ent_reg, dev_reg = er.async_get(hass), dr.async_get(hass)
    for ent in er.async_entries_for_config_entry(ent_reg, entry.entry_id):
        if ent.domain == "media_player" and "-speaker-" not in ent.unique_id and ent.unique_id not in data.accounts:
            ent_reg.async_remove(ent.entity_id)
    for device in dr.async_entries_for_config_entry(dev_reg, entry.entry_id):
        ids = {i[1] for i in device.identifiers if i[0] == DOMAIN}
        if ids and not any("-speaker" in i or i in data.accounts for i in ids):
            dev_reg.async_update_device(device.id, remove_config_entry_id=entry.entry_id)
    async_add_entities([SlopifyPlayer(entry, a) for a in data.accounts.values()])

    @callback
    def added(account: Account) -> None:
        async_add_entities([SlopifyPlayer(entry, account)])

    @callback
    def removed(account: Account) -> None:
        ent_reg = er.async_get(hass)
        if entity_id := ent_reg.async_get_entity_id("media_player", DOMAIN, account.user_id):
            ent_reg.async_remove(entity_id)
        dev_reg = dr.async_get(hass)
        if device := dev_reg.async_get_device(identifiers={(DOMAIN, account.user_id)}):
            dev_reg.async_update_device(device.id, remove_config_entry_id=entry.entry_id)

    data.on_added.append(added)
    data.on_removed.append(removed)

    speakers: set[str] = set()

    @callback
    def new_speakers() -> None:
        found = [d for d in server_speakers(data) if d["id"] not in speakers]
        if found:
            speakers.update(d["id"] for d in found)
            async_add_entities([SlopifySpeaker(entry, d) for d in found])

    data.listeners.append(new_speakers)
    entry.async_on_unload(lambda: data.listeners.remove(new_speakers))
    new_speakers()


def server_speakers(data: SlopifyData) -> list[dict[str, Any]]:
    """The speakers the Slopify server itself drives."""
    seen: dict[str, dict[str, Any]] = {}
    for d in data.session.lan_devices:
        if str(d.get("viaClient", "")).startswith("server:"):
            seen.setdefault(str(d["id"]), d)
    return list(seen.values())


class PositionClock:
    """Playhead for Home Assistant: rewritten only when it jumps.

    Positions are extrapolated from when a report arrived (never from the
    sender's clock), and steady playback keeps the anchor, so the state is
    not rewritten every second.
    """

    def __init__(self) -> None:
        """Initialize the clock."""
        self.position: int | None = None
        self.updated_at: datetime | None = None
        self._track: str | None = None
        self._playing = False

    def update(self, item: str | None, now_playing: dict[str, Any] | None, received: float, playing: bool) -> None:
        """Take a report of `now_playing`, received at monotonic time `received`."""
        if not item or not now_playing:
            self.position = self.updated_at = self._track = None
            return
        now = dt_util.utcnow()
        pos = position_now(now_playing, time.monotonic() - received)
        expected = None
        if self.position is not None and self.updated_at is not None:
            expected = self.position + ((now - self.updated_at).total_seconds() if self._playing else 0.0)
        if self._track != item or self._playing != playing or expected is None or abs(expected - pos) > POSITION_SLACK:
            self.position, self.updated_at = round(pos), now
            self._track, self._playing = item, playing


def _raise(err: Exception, key: str, **placeholders: str) -> None:
    error = HomeAssistantError if key in ("request_failed", "not_connected") else ServiceValidationError
    raise error(translation_domain=DOMAIN, translation_key=key, translation_placeholders=placeholders or None) from err


async def send(account: Account, to: str | None, command: dict[str, Any]) -> None:
    """A command to the client making the account's sound."""
    if not to:
        raise ServiceValidationError(translation_domain=DOMAIN, translation_key="nothing_playing")
    try:
        await account.session.command(to, command)
    except CannotConnect as err:
        _raise(err, "not_connected")


def active_now_playing(account: Account) -> tuple[str | None, dict[str, Any] | None]:
    """The account's active client and what it reports, if anything plays."""
    s = account.session
    active = next((p for p in s.players if p.get("id") == s.active_id), None)
    np = active.get("nowPlaying") if active else None
    return (s.active_id, np) if isinstance(np, dict) else (None, None)


def on_devices(now_playing: dict[str, Any] | None) -> list[str]:
    """The speakers a report's music is on: the one picked and its group."""
    device = as_dict((now_playing or {}).get("device"))
    return [str(x) for x in [device.get("id"), *(device.get("members") or [])] if x]


def session_handoff(account: Account) -> dict[str, Any] | None:
    """The account's queue and playhead, from whatever plays or last played."""
    s = account.session
    active_id, np = active_now_playing(account)
    if active_id and np is not None:
        return handoff(
            np, s.queues.get(active_id, []), time.monotonic() - s.np_received.get(active_id, time.monotonic())
        )
    return handoff(s.remembered, s.remembered_queue, 0.0)


async def move_session(account: Account, target: Target, *, playing: bool) -> None:
    """Move the account's music to an output, carrying on where it is."""
    active_id, np = active_now_playing(account)
    if active_id and (
        current_key(active_id, np, account.session.players) == target.key
        or (target.key.startswith("speaker:") and target.device_id in on_devices(np))
    ):
        return
    payload = session_handoff(account)
    if payload is None:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="nothing_to_resume_for",
            translation_placeholders={"name": account.name},
        )
    await send(
        account, target.client_id, {"action": "transfer", "deviceId": target.device_id, **payload, "playing": playing}
    )


async def resolve(library: Library, media_type: str, media_id: str, **kwargs: Any) -> Playable:
    """The songs a play_media request means, with Home Assistant errors."""
    if kwargs.get("announce"):
        raise ServiceValidationError(translation_domain=DOMAIN, translation_key="no_announce")
    try:
        what = await library.resolve(media_type, media_id)
    except UnsupportedMedia as err:
        _raise(err, "unsupported_media", media_id=media_id)
    except MediaNotFound as err:
        _raise(err, "media_not_found", media_id=media_id)
    except SlopifyError as err:
        _raise(err, "request_failed", error=str(err))
    if not what.track_ids:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="media_not_found",
            translation_placeholders={"media_id": media_id},
        )
    return what


class _SlopifyMedia(MediaPlayerEntity):
    """What account and speaker players share: now playing, controls, library."""

    _attr_has_entity_name = True
    _attr_device_class = MediaPlayerDeviceClass.SPEAKER
    _attr_media_content_type = MediaType.MUSIC
    _attr_should_poll = False

    def __init__(self, entry: SlopifyConfigEntry) -> None:
        self._entry = entry
        self._data = entry.runtime_data
        self._clock = PositionClock()
        self._unmute_level = 0.5
        self._fingerprint: tuple[Any, ...] | None = None
        # Whose music this player shows right now, and its active client.
        self._account: Account | None = None
        self._active_id: str | None = None
        self._now_playing: dict[str, Any] | None = None
        self._libraries: dict[str, Library] = {}

    def _library_for(self, account: Account) -> Library:
        if account.user_id not in self._libraries:
            self._libraries[account.user_id] = Library(account.api, self.get_browse_image_url)
        return self._libraries[account.user_id]

    @property
    def _library(self) -> Library:
        return self._library_for(self._account or self._data.main)

    @callback
    def _on_change(self) -> None:
        if self.hass is None:
            return
        self._refresh()
        fingerprint = (
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
            tuple(getattr(self, "_attr_group_members", None) or ()),
        )
        if fingerprint != self._fingerprint:
            self._fingerprint = fingerprint
            self.async_write_ha_state()

    def _refresh(self) -> None:
        raise NotImplementedError

    def _register(self) -> None:
        PLAYERS[self.entity_id] = self
        self.async_on_remove(lambda: PLAYERS.pop(self.entity_id, None))

    async def async_lyrics(self) -> list[dict[str, Any]]:
        """The current song's lyrics from Slopify (empty when there are none)."""
        content = self._attr_media_content_id or ""
        if not content.startswith("track:"):
            return []
        account = self._account or self._data.main
        try:
            found = await account.api.get(f"/api/lyrics/{quote(content[6:], safe='')}")
        except SlopifyError:
            return []
        if not isinstance(found, dict) or found.get("kind") == "instrumental":
            return []
        return [
            {"start": line.get("start"), "text": str(line.get("text") or "")}
            for line in found.get("lines") or []
            if isinstance(line, dict)
        ]

    def _show(self, np: dict[str, Any] | None, *, active: bool, received: float) -> None:
        """Fill the media attributes from a nowPlaying report."""
        np = np or {}
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
        if active:
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
            self._attr_volume_level = self._attr_is_volume_muted = None
            self._attr_shuffle = self._attr_repeat = None
        self._clock.update(item, np if item else None, received, self._attr_state == MediaPlayerState.PLAYING)
        self._attr_media_position = self._clock.position
        self._attr_media_position_updated_at = self._clock.updated_at

    # --- artwork --------------------------------------------------------------

    async def async_get_media_image(self) -> tuple[bytes | None, str | None]:
        """Artwork of what is playing, fetched with that account's sign-in."""
        image = self._attr_media_image_hash
        if not image:
            return None, None
        return await (self._account or self._data.main).api.image(image, PLAYER_IMAGE_SIZE)

    async def async_get_browse_image(
        self, media_content_type: str, media_content_id: str, media_image_id: str | None = None
    ) -> tuple[bytes | None, str | None]:
        """Artwork for the media browser."""
        if not media_image_id or not valid_image_id(media_image_id):
            return None, None
        return await (self._account or self._data.main).api.image(media_image_id, BROWSE_IMAGE_SIZE)

    # --- controls -------------------------------------------------------------

    async def _send(self, command: dict[str, Any]) -> None:
        if self._account is None:
            raise ServiceValidationError(translation_domain=DOMAIN, translation_key="nothing_playing")
        await send(self._account, self._active_id, command)

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

    # --- library ----------------------------------------------------------------

    async def async_browse_media(
        self, media_content_type: MediaType | str | None = None, media_content_id: str | None = None
    ) -> BrowseMedia:
        """The library, for the media browser."""
        try:
            return await self._library.browse(media_content_id)
        except MediaNotFound as err:
            _raise(err, "media_not_found", media_id=str(media_content_id))
        except SlopifyError as err:
            _raise(err, "request_failed", error=str(err))
        raise AssertionError  # unreachable: _raise always raises

    async def async_search_media(self, query: SearchMediaQuery) -> SearchMedia:
        """Search the library."""
        try:
            return await self._library.search(query)
        except SlopifyError as err:
            _raise(err, "request_failed", error=str(err))
        raise AssertionError

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Whether the current song is liked."""
        np = self._now_playing or {}
        return {"liked": bool(np.get("liked"))} if np.get("itemId") else {}


class SlopifyPlayer(_SlopifyMedia):
    """One account's playback session."""

    _attr_name = None
    _attr_translation_key = "session"

    def __init__(self, entry: SlopifyConfigEntry, account: Account) -> None:
        """Initialize the player."""
        super().__init__(entry)
        self._me = account
        self._account = account
        self._attr_unique_id = account.user_id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, account.user_id)},
            name=f"Slopify {account.name}",
            manufacturer="Slopify",
            model="Playback session",
            entry_type=DeviceEntryType.SERVICE,
            configuration_url=account.api.url,
        )
        self._targets: list[Target] = []
        self._np_received = 0.0
        self._refresh()

    async def async_added_to_hass(self) -> None:
        """Follow the session."""
        self._register()
        self._me.listeners.append(self._on_change)
        self.async_on_remove(lambda: self._me.listeners.remove(self._on_change))
        self._on_change()

    def _refresh(self) -> None:
        s = self._me.session
        self._attr_available = s.connected
        self._targets = targets(s.players, s.lan_devices)
        self._attr_source_list = [t.name for t in self._targets]
        active_id, np = active_now_playing(self._me)
        if active_id and np is not None:
            self._active_id, self._now_playing = active_id, np
            self._np_received = s.np_received.get(active_id, time.monotonic())
            self._attr_state = MediaPlayerState.PLAYING if np.get("playing") else MediaPlayerState.PAUSED
        else:
            # Nothing is making sound: show what played last, ready to resume.
            self._active_id = None
            self._now_playing = s.remembered if isinstance(s.remembered, dict) else None
            self._np_received = s.remembered_received
            self._attr_state = MediaPlayerState.IDLE
        self._attr_supported_features = ALWAYS | (WHILE_ACTIVE if self._active_id else MediaPlayerEntityFeature(0))
        self._show(self._now_playing, active=bool(self._active_id), received=self._np_received)
        key = current_key(self._active_id, self._now_playing if self._active_id else None, s.players)
        target = next((t for t in self._targets if t.key == key), None)
        device = as_dict((self._now_playing or {}).get("device"))
        self._attr_source = target.name if target else (device.get("name") if self._active_id else None)

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
        last = last_speaker_key(self._me.session.remembered)
        if last in by_key:
            return by_key[last]
        if len(self._targets) == 1:
            return self._targets[0]
        raise ServiceValidationError(translation_domain=DOMAIN, translation_key="no_source")

    async def async_media_play(self) -> None:
        """Play, or resume the last session where it is best heard."""
        if self.state == MediaPlayerState.PAUSED:
            await self._send({"action": "toggle"})
        elif self.state == MediaPlayerState.IDLE:
            await move_session(self._me, self._start_target(), playing=True)

    async def async_select_source(self, source: str) -> None:
        """Move the session to another output, carrying on where it is."""
        await move_session(self._me, self._target_named(source), playing=self.state != MediaPlayerState.PAUSED)

    async def async_play_media(self, media_type: MediaType | str, media_id: str, **kwargs: Any) -> None:
        """Play an album, artist, playlist, song, genre, share link or search."""
        what = await resolve(self._library, str(media_type or ""), media_id, **kwargs)
        extra = kwargs.get("extra") or {}
        source = extra.get("source") if isinstance(extra, dict) else None
        enqueue = kwargs.get(ATTR_MEDIA_ENQUEUE)
        songs = {"trackIds": what.track_ids, "index": what.index, "position": 0}
        if source or not self._active_id:
            target = self._target_named(str(source)) if source else self._start_target()
            await send(
                self._me,
                target.client_id,
                {"action": "transfer", "deviceId": target.device_id, **songs, "playing": True},
            )
        elif enqueue in (MediaPlayerEnqueue.ADD, MediaPlayerEnqueue.NEXT):
            # A song picked inside an album or playlist adds that song alone.
            picked = what.track_ids[what.index : what.index + 1] if "#" in media_id else what.track_ids
            await self._send({"action": "enqueue", "trackIds": picked})
        else:
            await self._send({"action": "play", "trackIds": what.track_ids, "index": what.index, "startAt": 0})


class SlopifySpeaker(_SlopifyMedia):
    """A speaker the Slopify server drives, shared by everyone it follows."""

    _attr_translation_key = "speaker"

    def __init__(self, entry: SlopifyConfigEntry, speaker: dict[str, Any]) -> None:
        """Initialize the speaker player."""
        super().__init__(entry)
        self._speaker_id = str(speaker["id"])
        self._speaker_name = str(speaker.get("name") or self._speaker_id)
        self._kind = str(speaker.get("kind") or "")
        self._inputs: list[str] = []
        self._native = False
        self._native_image: str | None = None
        server = entry.data.get("server_id") or entry.unique_id
        self._attr_unique_id = f"{server}-speaker-{self._speaker_id}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{server}-speaker-{self._speaker_id}")},
            name=self._speaker_name,
            manufacturer="Slopify",
            model="Chromecast speaker" if speaker.get("kind") == "cast" else "BluOS speaker",
        )
        self._refresh()

    async def async_added_to_hass(self) -> None:
        """Follow every account's session."""
        self._register()
        self._data.listeners.append(self._on_change)
        self.async_on_remove(lambda: self._data.listeners.remove(self._on_change))
        self._on_change()

    def _accounts(self) -> list[Account]:
        rest = sorted((a for a in self._data.accounts.values() if not a.main), key=lambda a: a.name.casefold())
        return [self._data.main, *rest]

    def _target(self, account: Account) -> Target:
        return Target(f"speaker:{self._speaker_id}", self._speaker_name, f"server:{account.user_id}", self._speaker_id)

    def _refresh(self) -> None:
        speakers = server_speakers(self._data)
        me = next((d for d in speakers if str(d["id"]) == self._speaker_id), {})
        self._attr_available = self._data.session.connected and bool(me)
        own = as_dict(me.get("state"))  # the speaker on its own: volume, inputs, its own playback
        self._inputs = [str(i.get("name")) for i in own.get("inputs") or [] if i.get("name")]
        accounts = self._accounts()
        self._attr_source_list = [account_label(a) for a in accounts] + self._inputs
        # Whose music is on this speaker: playing beats paused.
        best: tuple[Account, str, dict[str, Any]] | None = None
        for account in accounts:
            active_id, np = active_now_playing(account)
            if not active_id or np is None or self._speaker_id not in on_devices(np):
                continue
            if best is None or (np.get("playing") and not best[2].get("playing")):
                best = (account, active_id, np)
        self._native = False
        features = ALWAYS
        if best:
            self._account, self._active_id, self._now_playing = best
            self._attr_state = MediaPlayerState.PLAYING if best[2].get("playing") else MediaPlayerState.PAUSED
            self._attr_source = account_label(best[0])
            received = best[0].session.np_received.get(best[1], time.monotonic())
            features |= WHILE_ACTIVE
        else:
            self._account = self._active_id = None
            received = time.monotonic()
            if own.get("state") in ("play", "stream", "pause", "connecting"):
                # Playing something of its own (an input, Spotify, the BluOS app).
                self._native = True
                self._now_playing = {"itemId": None, "title": own.get("title"), "artist": own.get("artist")}
                self._attr_state = MediaPlayerState.PLAYING if own.get("playing") else MediaPlayerState.PAUSED
                self._attr_source = own.get("input")
                features |= (
                    MediaPlayerEntityFeature.PAUSE
                    | MediaPlayerEntityFeature.STOP
                    | MediaPlayerEntityFeature.NEXT_TRACK
                    | MediaPlayerEntityFeature.PREVIOUS_TRACK
                )
            else:
                self._now_playing = None
                self._attr_state = MediaPlayerState.IDLE
                self._attr_source = None
        if isinstance(own.get("volume"), (int, float)):
            features |= (
                MediaPlayerEntityFeature.VOLUME_SET
                | MediaPlayerEntityFeature.VOLUME_STEP
                | MediaPlayerEntityFeature.VOLUME_MUTE
            )
        if me.get("kind", self._kind) == "bluos":
            features |= MediaPlayerEntityFeature.GROUPING
        self._attr_supported_features = features
        group = [str(x) for x in me.get("group") or []]
        self._attr_group_members = [e for e in (self._entity_of(x) for x in group) if e] if len(group) > 1 else []
        self._show(self._now_playing, active=bool(best), received=received)
        self._native_image = None
        if self._native:
            self._attr_media_title = own.get("title") or None
            self._attr_media_artist = own.get("artist") or None
            self._attr_media_album_name = own.get("album") or None
            image = own.get("image")
            self._native_image = image if isinstance(image, str) and image.startswith(("http://", "https://")) else None
            self._attr_media_image_hash = (
                hashlib.sha1(self._native_image.encode()).hexdigest()[:32] if self._native_image else None
            )
        # The card's volume is this speaker's own, whoever plays on it.
        if isinstance(own.get("volume"), (int, float)):
            self._attr_volume_level = max(0.0, min(1.0, float(own["volume"]) / 100))
            self._attr_is_volume_muted = self._attr_volume_level == 0 or bool(own.get("muted"))

    async def async_get_media_image(self) -> tuple[bytes | None, str | None]:
        """Artwork: Slopify's for its music, the speaker's own (Spotify, a radio) otherwise."""
        if not self._native_image:
            return await super().async_get_media_image()
        try:
            async with self._data.api.http.get(self._native_image, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return None, None
                return await resp.read(), resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
        except (aiohttp.ClientError, TimeoutError):
            return None, None

    async def _speaker_call(self, path: str, body: dict[str, Any]) -> None:
        try:
            await self._data.api.post(f"/api/speakers/{quote(self._speaker_id, safe='')}/{path}", body)
        except NotFound as err:
            _raise(err, "speaker_unsupported")
        except SlopifyError as err:
            _raise(err, "request_failed", error=str(err))

    async def async_set_volume_level(self, volume: float) -> None:
        """This speaker's own volume."""
        await self._speaker_call("volume", {"level": round(max(0.0, min(1.0, volume)) * 100)})

    async def async_media_pause(self) -> None:
        """Pause whatever plays here."""
        if self._native:
            await self._speaker_call("control", {"action": "pause"})
        else:
            await super().async_media_pause()

    async def async_media_next_track(self) -> None:
        """Next song."""
        if self._native:
            await self._speaker_call("control", {"action": "next"})
        else:
            await super().async_media_next_track()

    async def async_media_previous_track(self) -> None:
        """Previous song."""
        if self._native:
            await self._speaker_call("control", {"action": "previous"})
        else:
            await super().async_media_previous_track()

    def _registry_id(self, speaker_id: str) -> str:
        return f"{self._entry.data.get('server_id') or self._entry.unique_id}-speaker-{speaker_id}"

    def _entity_of(self, speaker_id: str) -> str | None:
        if self.hass is None:
            return None
        return er.async_get(self.hass).async_get_entity_id("media_player", DOMAIN, self._registry_id(speaker_id))

    def _speaker_of(self, entity_id: str) -> str:
        entry = er.async_get(self.hass).async_get(entity_id)
        prefix = self._registry_id("")
        if entry is None or entry.platform != DOMAIN or not entry.unique_id.startswith(prefix):
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="group_not_slopify",
                translation_placeholders={"entity_id": entity_id},
            )
        return entry.unique_id[len(prefix) :]

    async def async_join_players(self, group_members: list[str]) -> None:
        """Group these speakers with this one: picking any of them plays them all."""
        members = [self._speaker_of(e) for e in group_members if e != self.entity_id]
        try:
            await self._data.api.post("/api/speakers/groups", {"leader": self._speaker_id, "members": members})
        except NotFound as err:
            _raise(err, "groups_unsupported")
        except SlopifyError as err:
            _raise(err, "group_failed", error=str(err))

    async def async_unjoin_player(self) -> None:
        """Take this speaker out of its group."""
        try:
            await self._data.api.post("/api/speakers/groups/unjoin", {"speaker": self._speaker_id})
        except NotFound as err:
            _raise(err, "groups_unsupported")
        except SlopifyError as err:
            _raise(err, "group_failed", error=str(err))

    def _account_labelled(self, source: str) -> Account:
        wanted = (source or "").strip().casefold()
        for account in self._accounts():
            if account_label(account).casefold() == wanted or account.name.casefold() == wanted:
                return account
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="unknown_source",
            translation_placeholders={"source": source, "sources": ", ".join(self._attr_source_list or []) or "none"},
        )

    async def async_select_source(self, source: str) -> None:
        """Bring that account's music to this speaker, or play one of its own inputs."""
        wanted = (source or "").strip().casefold()
        is_account = any(account_label(a).casefold() == wanted or a.name.casefold() == wanted for a in self._accounts())
        if not is_account and wanted in (i.casefold() for i in self._inputs):
            await self._speaker_call("input", {"input": source})
            return
        account = self._account_labelled(source)
        # Already playing on other speakers of the server: picking the same
        # name here adds this speaker to them, the way people expect to group.
        active_id, np = active_now_playing(account)
        playing_on = on_devices(np) if active_id == f"server:{account.user_id}" else []
        bluos = {str(d["id"]) for d in server_speakers(self._data) if d.get("kind") == "bluos"}
        if playing_on and self._speaker_id not in playing_on and self._kind == "bluos" and playing_on[0] in bluos:
            try:
                await self._data.api.post(
                    "/api/speakers/groups", {"leader": playing_on[0], "members": [self._speaker_id]}
                )
            except NotFound as err:
                _raise(err, "groups_unsupported")
            except SlopifyError as err:
                _raise(err, "group_failed", error=str(err))
            return
        playing = not (account is self._account and self.state == MediaPlayerState.PAUSED)
        await move_session(account, self._target(account), playing=playing)

    async def async_media_play(self) -> None:
        """Resume what is paused here, or bring the main account's music here."""
        if self._native:
            await self._speaker_call("control", {"action": "play"})
        elif self.state == MediaPlayerState.PAUSED:
            await self._send({"action": "toggle"})
        elif self.state == MediaPlayerState.IDLE:
            await move_session(self._data.main, self._target(self._data.main), playing=True)

    async def async_play_media(self, media_type: MediaType | str, media_id: str, **kwargs: Any) -> None:
        """Play something here, as whoever is playing here (else the main account)."""
        account = self._account or self._data.main
        what = await resolve(self._library_for(account), str(media_type or ""), media_id, **kwargs)
        if self._account is not None and kwargs.get(ATTR_MEDIA_ENQUEUE) in (
            MediaPlayerEnqueue.ADD,
            MediaPlayerEnqueue.NEXT,
        ):
            picked = what.track_ids[what.index : what.index + 1] if "#" in media_id else what.track_ids
            await self._send({"action": "enqueue", "trackIds": picked})
            return
        target = self._target(account)
        await send(
            account,
            target.client_id,
            {
                "action": "transfer",
                "deviceId": target.device_id,
                "trackIds": what.track_ids,
                "index": what.index,
                "position": 0,
                "playing": True,
            },
        )
