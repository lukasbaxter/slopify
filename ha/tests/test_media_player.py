"""The media player: what it shows, and what each control sends."""

from __future__ import annotations

from typing import Any

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.media_player import (
    ATTR_INPUT_SOURCE,
    ATTR_INPUT_SOURCE_LIST,
    ATTR_MEDIA_ALBUM_NAME,
    ATTR_MEDIA_ARTIST,
    ATTR_MEDIA_CONTENT_ID,
    ATTR_MEDIA_CONTENT_TYPE,
    ATTR_MEDIA_DURATION,
    ATTR_MEDIA_ENQUEUE,
    ATTR_MEDIA_EXTRA,
    ATTR_MEDIA_POSITION,
    ATTR_MEDIA_POSITION_UPDATED_AT,
    ATTR_MEDIA_REPEAT,
    ATTR_MEDIA_SEEK_POSITION,
    ATTR_MEDIA_SHUFFLE,
    ATTR_MEDIA_TITLE,
    ATTR_MEDIA_VOLUME_LEVEL,
    ATTR_MEDIA_VOLUME_MUTED,
    DOMAIN as MP,
    MediaPlayerEntityFeature,
)
from homeassistant.const import ATTR_ENTITY_ID, ATTR_SUPPORTED_FEATURES
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceNotSupported, ServiceValidationError
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.diagnostics import get_diagnostics_for_config_entry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator, WebSocketGenerator

from custom_components.slopify.const import CONF_DEFAULT_SOURCE

from .fake_slopify import (
    ALBUM_KID,
    ALBUM_OK,
    ARTIST_RH,
    PLAYLIST,
    SERVER_CLIENT,
    SPEAKER_DEN,
    SPEAKER_KITCHEN,
    T1,
    T2,
    T3,
    T4,
    T5,
    FakeSlopify,
    now_playing,
    row,
)

E = "media_player.slopify_lukas"
WEB = {"id": "web-1", "name": "Web Player (1)", "kind": "web", "canPlay": True, "nowPlaying": None, "sameNetwork": True}
SPEAKERS = [{**SPEAKER_KITCHEN, "viaClient": SERVER_CLIENT}, {**SPEAKER_DEN, "viaClient": SERVER_CLIENT}]


async def play_on_web(hass: HomeAssistant, fake: FakeSlopify, tid: str = T2, **np: Any) -> None:
    """The browser is playing the album OK Computer, at song `tid`."""
    await fake.send_queue("web-1", [row(T1), row(T2), row(T3)])
    await fake.set_roster(
        players=[{**WEB, "nowPlaying": now_playing(tid, queue_index=[T1, T2, T3].index(tid), **np)}],
        lan=SPEAKERS,
        active="web-1",
    )
    await settle(hass, fake)


async def settle(hass: HomeAssistant, fake: FakeSlopify) -> None:
    await hass.async_block_till_done()
    for _ in range(5):
        await fake.wait_for(lambda: True)
        await hass.async_block_till_done()


async def call(hass: HomeAssistant, service: str, **data: Any) -> None:
    await hass.services.async_call(MP, service, {ATTR_ENTITY_ID: E, **data}, blocking=True)


async def last_command(fake: FakeSlopify, n: int = 1) -> dict[str, Any]:
    await fake.wait_for(lambda: len(fake.commands()) >= n)
    return fake.commands()[-1]


# --- what it shows -----------------------------------------------------------------


async def test_nothing_played_yet(hass: HomeAssistant, loaded: MockConfigEntry) -> None:
    state = hass.states.get(E)
    assert state.state == "idle"
    assert ATTR_MEDIA_TITLE not in state.attributes
    features = state.attributes[ATTR_SUPPORTED_FEATURES]
    assert features & MediaPlayerEntityFeature.PLAY_MEDIA and features & MediaPlayerEntityFeature.BROWSE_MEDIA
    assert not features & MediaPlayerEntityFeature.PAUSE


async def test_shows_what_the_account_is_playing(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    await play_on_web(hass, fake, volume=70, shuffle="smart", repeat="one")
    state = hass.states.get(E)
    assert state.state == "playing"
    a = state.attributes
    assert a[ATTR_MEDIA_TITLE] == "Paranoid Android"
    assert a[ATTR_MEDIA_ARTIST] == "Radiohead"
    assert a[ATTR_MEDIA_ALBUM_NAME] == "OK Computer"
    assert a[ATTR_MEDIA_CONTENT_ID] == f"track:{T2}"
    assert a[ATTR_MEDIA_CONTENT_TYPE] == "music"
    assert a[ATTR_MEDIA_DURATION] == 202
    assert a[ATTR_MEDIA_POSITION] == 30.0
    assert a[ATTR_MEDIA_VOLUME_LEVEL] == 0.7
    assert a[ATTR_MEDIA_VOLUME_MUTED] is False
    assert a[ATTR_MEDIA_SHUFFLE] is True
    assert a[ATTR_MEDIA_REPEAT] == "one"
    assert a[ATTR_INPUT_SOURCE] == "Web Player (1)"
    assert a[ATTR_INPUT_SOURCE_LIST] == ["Den", "Kitchen", "Web Player (1)"]
    assert a["liked"] is False
    assert a[ATTR_SUPPORTED_FEATURES] & MediaPlayerEntityFeature.PAUSE
    assert "SECRET" not in str(a), "the speaker token in artUrl never reaches Home Assistant"


async def test_playing_on_a_speaker_shows_the_speaker_as_source(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    np = now_playing(T4, playing=False, device={"id": "cast:kitchen", "kind": "cast", "name": "Kitchen"})
    await fake.set_roster(players=[{"id": SERVER_CLIENT, "nowPlaying": np}], lan=SPEAKERS, active=SERVER_CLIENT)
    await settle(hass, fake)
    state = hass.states.get(E)
    assert state.state == "paused"
    assert state.attributes[ATTR_INPUT_SOURCE] == "Kitchen"


async def test_after_the_music_stops_it_shows_the_last_session(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    await play_on_web(hass, fake)
    remembered = now_playing(
        T2,
        playing=False,
        position=95.0,
        queue_index=1,
        device={"id": "cast:kitchen", "kind": "cast", "name": "Kitchen"},
    )
    await fake.set_roster(players=[WEB], active=None)
    await fake.send_session(remembered, [row(T1), row(T2), row(T3)])
    await settle(hass, fake)
    state = hass.states.get(E)
    assert state.state == "idle"
    assert state.attributes[ATTR_MEDIA_TITLE] == "Paranoid Android"
    assert state.attributes[ATTR_MEDIA_POSITION] == 95.0
    assert ATTR_INPUT_SOURCE not in state.attributes


async def test_position_is_only_rewritten_when_it_jumps(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify, freezer: FrozenDateTimeFactory
) -> None:
    await play_on_web(hass, fake, position=30.0)
    first = hass.states.get(E).attributes[ATTR_MEDIA_POSITION_UPDATED_AT]
    for second in (31.0, 32.0, 33.0):
        freezer.tick(1)
        await fake.set_roster(players=[{**WEB, "nowPlaying": now_playing(T2, queue_index=1, position=second)}])
        await settle(hass, fake)
        assert hass.states.get(E).attributes[ATTR_MEDIA_POSITION_UPDATED_AT] == first
    freezer.tick(1)
    await fake.set_roster(players=[{**WEB, "nowPlaying": now_playing(T2, queue_index=1, position=120.0)}])
    await settle(hass, fake)
    state = hass.states.get(E)
    assert state.attributes[ATTR_MEDIA_POSITION] == 120.0
    assert state.attributes[ATTR_MEDIA_POSITION_UPDATED_AT] != first


# --- controls --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("service", "data", "command"),
    [
        ("media_pause", {}, {"action": "toggle"}),
        ("media_stop", {}, {"action": "toggle"}),
        ("media_next_track", {}, {"action": "next"}),
        ("media_previous_track", {}, {"action": "previous"}),
        ("media_seek", {ATTR_MEDIA_SEEK_POSITION: 61.5}, {"action": "seek", "pos": 61.5}),
        ("volume_set", {ATTR_MEDIA_VOLUME_LEVEL: 0.35}, {"action": "setVolume", "level": 35}),
        ("volume_up", {}, {"action": "setVolume", "level": 80}),
        ("volume_mute", {ATTR_MEDIA_VOLUME_MUTED: True}, {"action": "setVolume", "level": 0}),
        ("shuffle_set", {ATTR_MEDIA_SHUFFLE: True}, {"action": "setShuffle", "mode": "on"}),
        ("repeat_set", {ATTR_MEDIA_REPEAT: "all"}, {"action": "setRepeat", "mode": "all"}),
        ("clear_playlist", {}, {"action": "queueClear"}),
    ],
)
async def test_controls_go_to_the_client_making_the_sound(
    hass: HomeAssistant,
    loaded: MockConfigEntry,
    fake: FakeSlopify,
    service: str,
    data: dict[str, Any],
    command: dict[str, Any],
) -> None:
    await play_on_web(hass, fake)
    await call(hass, service, **data)
    sent = await last_command(fake)
    assert sent["to"] == "web-1"
    assert sent["command"] == command


async def test_play_and_pause_never_flip_the_wrong_way(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    await play_on_web(hass, fake)
    await call(hass, "media_play")
    await settle(hass, fake)
    assert fake.commands() == []
    await fake.set_roster(players=[{**WEB, "nowPlaying": now_playing(T2, queue_index=1, playing=False)}])
    await settle(hass, fake)
    await call(hass, "media_pause")
    await settle(hass, fake)
    assert fake.commands() == []
    await call(hass, "media_play")
    assert (await last_command(fake))["command"] == {"action": "toggle"}


async def test_unmute_restores_the_volume(hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify) -> None:
    await play_on_web(hass, fake, volume=64)
    await call(hass, "volume_mute", **{ATTR_MEDIA_VOLUME_MUTED: True})
    await fake.set_roster(players=[{**WEB, "nowPlaying": now_playing(T2, queue_index=1, volume=0)}])
    await settle(hass, fake)
    assert hass.states.get(E).attributes[ATTR_MEDIA_VOLUME_MUTED] is True
    await call(hass, "volume_mute", **{ATTR_MEDIA_VOLUME_MUTED: False})
    assert (await last_command(fake, 2))["command"] == {"action": "setVolume", "level": 64}


async def test_controls_with_nothing_playing_are_not_offered(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    with pytest.raises(ServiceNotSupported):
        await call(hass, "media_next_track")
    assert fake.commands() == []


# --- moving the music ---------------------------------------------------------------


async def test_select_source_moves_the_session_with_its_queue(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    await play_on_web(hass, fake, position=40.0)
    await call(hass, "select_source", source="Kitchen")
    sent = await last_command(fake)
    assert sent["to"] == SERVER_CLIENT
    cmd = sent["command"]
    assert cmd["action"] == "transfer" and cmd["deviceId"] == "cast:kitchen"
    assert cmd["trackIds"] == [T1, T2, T3] and cmd["index"] == 1
    assert 40.0 <= cmd["position"] < 42.0
    assert cmd["playing"] is True


async def test_select_source_to_an_app_plays_on_its_own_output(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    np = now_playing(T4, device={"id": "cast:kitchen", "kind": "cast", "name": "Kitchen"})
    await fake.set_roster(players=[{"id": SERVER_CLIENT, "nowPlaying": np}, WEB], lan=SPEAKERS, active=SERVER_CLIENT)
    await settle(hass, fake)
    await call(hass, "select_source", source="Web Player (1)")
    sent = await last_command(fake)
    assert sent["to"] == "web-1" and sent["command"]["deviceId"] == "local"
    assert sent["command"]["trackIds"] == [T4], "the server's queue is unknown here: the song goes alone"


async def test_selecting_the_current_source_does_nothing(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    await play_on_web(hass, fake)
    await call(hass, "select_source", source="Web Player (1)")
    await settle(hass, fake)
    assert fake.commands() == []


async def test_unknown_source(hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify) -> None:
    await play_on_web(hass, fake)
    with pytest.raises(ServiceValidationError, match="Available: Den, Kitchen, Web Player"):
        await call(hass, "select_source", source="Garage")


async def test_play_resumes_the_last_session_where_it_last_played(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    await fake.set_roster(lan=SPEAKERS, active=None)
    await fake.send_session(
        now_playing(
            T2,
            playing=False,
            position=95.0,
            queue_index=1,
            device={"id": "bluos:10.0.0.6", "kind": "bluos", "name": "Den"},
        ),
        [row(T1), row(T2), row(T3)],
    )
    await settle(hass, fake)
    await call(hass, "media_play")
    sent = await last_command(fake)
    assert sent["to"] == SERVER_CLIENT
    assert sent["command"] == {
        "action": "transfer",
        "deviceId": "bluos:10.0.0.6",
        "trackIds": [T1, T2, T3],
        "index": 1,
        "position": 95.0,
        "playing": True,
    }


async def test_play_with_nowhere_to_play_explains_what_to_do(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    await fake.set_roster(players=[WEB], lan=SPEAKERS, active=None)
    await fake.send_session(now_playing(T2, playing=False), [row(T2)])
    await settle(hass, fake)
    with pytest.raises(ServiceValidationError, match="does not know where to play"):
        await call(hass, "media_play")


async def test_default_source_option(hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify) -> None:
    hass.config_entries.async_update_entry(loaded, options={CONF_DEFAULT_SOURCE: "speaker:cast:kitchen"})
    await fake.set_roster(players=[WEB], lan=SPEAKERS, active=None)
    await settle(hass, fake)
    await call(hass, "play_media", media_content_type="album", media_content_id=f"album:{ALBUM_KID}")
    sent = await last_command(fake)
    assert sent["to"] == SERVER_CLIENT
    assert sent["command"] == {
        "action": "transfer",
        "deviceId": "cast:kitchen",
        "trackIds": [T4, T5],
        "index": 0,
        "position": 0,
        "playing": True,
    }


# --- play_media ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("media_type", "media_id", "ids", "index"),
    [
        ("album", f"album:{ALBUM_OK}", [T1, T2, T3], 0),
        ("track", f"album:{ALBUM_OK}#{T3}", [T1, T2, T3], 2),
        ("playlist", f"playlist:{PLAYLIST}", [T5, T2], 0),
        ("playlist", "liked", [T2], 0),
        ("playlist", "top", [T1, T4], 0),
        ("track", f"track:{T4}", [T4], 0),
        ("playlist", f"radio:{ARTIST_RH}", [T4, T1, T2], 0),
        ("genre", "genre:Alt%20Rock", [T3, T1], 0),
        ("music", f"https://music.example.com/?album={ALBUM_KID}", [T4, T5], 0),
        ("music", ALBUM_KID, [T4, T5], 0),
        ("album", "ok computer", [T1, T2, T3], 0),
        ("track", "lucky", [T3], 0),
        ("playlist", "road", [T5, T2], 0),
    ],
)
async def test_play_media_while_playing_replaces_the_queue(
    hass: HomeAssistant,
    loaded: MockConfigEntry,
    fake: FakeSlopify,
    media_type: str,
    media_id: str,
    ids: list[str],
    index: int,
) -> None:
    await play_on_web(hass, fake)
    await call(hass, "play_media", media_content_type=media_type, media_content_id=media_id)
    sent = await last_command(fake)
    assert sent["to"] == "web-1"
    assert sent["command"] == {"action": "play", "trackIds": ids, "index": index, "startAt": 0}


async def test_play_an_artist_plays_their_songs_shuffled(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    await play_on_web(hass, fake)
    await call(hass, "play_media", media_content_type="artist", media_content_id="Radiohead")
    sent = await last_command(fake)
    assert sorted(sent["command"]["trackIds"]) == sorted([T1, T2, T4])


async def test_enqueue(hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify) -> None:
    await play_on_web(hass, fake)
    await call(
        hass,
        "play_media",
        media_content_type="album",
        media_content_id=f"album:{ALBUM_KID}",
        **{ATTR_MEDIA_ENQUEUE: "add"},
    )
    assert (await last_command(fake))["command"] == {"action": "enqueue", "trackIds": [T4, T5]}
    await call(
        hass,
        "play_media",
        media_content_type="track",
        media_content_id=f"album:{ALBUM_OK}#{T2}",
        **{ATTR_MEDIA_ENQUEUE: "next"},
    )
    assert (await last_command(fake, 2))["command"] == {"action": "enqueue", "trackIds": [T2]}


async def test_play_media_on_a_named_source(hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify) -> None:
    await play_on_web(hass, fake)
    await call(
        hass,
        "play_media",
        media_content_type="album",
        media_content_id=f"album:{ALBUM_KID}",
        **{ATTR_MEDIA_EXTRA: {"source": "den"}},
    )
    sent = await last_command(fake)
    assert sent["to"] == SERVER_CLIENT
    assert sent["command"]["deviceId"] == "bluos:10.0.0.6" and sent["command"]["trackIds"] == [T4, T5]


@pytest.mark.parametrize(
    ("media_id", "message"),
    [
        ("media-source://media_source/local/song.mp3", "only plays music from its own library"),
        ("https://example.com/stream.mp3", "only plays music from its own library"),
        ("no such words anywhere", "Nothing in the Slopify library matches"),
        (f"album:{'0' * 32}", "Nothing in the Slopify library matches"),
    ],
)
async def test_play_media_errors(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify, media_id: str, message: str
) -> None:
    await play_on_web(hass, fake)
    with pytest.raises(ServiceValidationError, match=message):
        await call(hass, "play_media", media_content_type="music", media_content_id=media_id)


# --- browsing and searching --------------------------------------------------------------


async def browse(
    hass_ws_client: WebSocketGenerator, hass: HomeAssistant, content_id: str | None = None
) -> dict[str, Any]:
    client = await hass_ws_client(hass)
    msg: dict[str, Any] = {"id": 1, "type": "media_player/browse_media", "entity_id": E}
    if content_id is not None:
        msg.update(media_content_type="directory", media_content_id=content_id)
    await client.send_json(msg)
    response = await client.receive_json()
    assert response["success"], response
    return response["result"]


async def test_browse_root(hass: HomeAssistant, loaded: MockConfigEntry, hass_ws_client: WebSocketGenerator) -> None:
    root = await browse(hass_ws_client, hass)
    assert root["title"] == "Slopify" and root["can_search"] is True
    assert [c["title"] for c in root["children"]] == [
        "Recently played",
        "Liked Songs",
        "Playlists",
        "Artists",
        "Albums",
        "Genres",
        "Newly added",
        "Your top songs",
    ]


async def test_browse_an_album(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    node = await browse(hass_ws_client, hass, f"album:{ALBUM_OK}")
    assert node["title"] == "OK Computer" and node["can_play"] is True
    assert [c["title"] for c in node["children"]] == ["Airbag", "Paranoid Android", "Lucky · Radiohead, Guest"]
    assert node["children"][1]["media_content_id"] == f"album:{ALBUM_OK}#{T2}"
    assert node["thumbnail"].startswith(f"/api/media_player_proxy/{E}/browse_media/album/")


async def test_browse_an_artist(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    node = await browse(hass_ws_client, hass, f"artist:{ARTIST_RH}")
    assert [c["title"] for c in node["children"]] == ["Radiohead Radio", "Kid A", "OK Computer", "Appears On"]
    appears = await browse(hass_ws_client, hass, f"appears:{ARTIST_RH}")
    assert [c["title"] for c in appears["children"]] == ["OK Computer · Radiohead"]


@pytest.mark.parametrize(
    ("content_id", "titles"),
    [
        ("recent", ["OK Computer · Radiohead"]),
        ("new", ["Kid A · Radiohead"]),
        ("liked", ["Paranoid Android · Radiohead"]),
        ("top", ["Airbag · Radiohead", "Everything In Its Right Place · Radiohead"]),
        ("playlists", ["Road Trip"]),
        ("albums", ["OK Computer · Radiohead", "Kid A · Radiohead"]),
        ("artists", ["Radiohead"]),
        ("genres", ["Alt Rock"]),
        ("genre:Alt%20Rock", ["OK Computer · Radiohead"]),
        (f"playlist:{PLAYLIST}", ["Kid A · Radiohead", "Paranoid Android · Radiohead"]),
    ],
)
async def test_browse_lists(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_ws_client: WebSocketGenerator, content_id: str, titles: list[str]
) -> None:
    node = await browse(hass_ws_client, hass, content_id)
    assert [c["title"] for c in node["children"]] == titles


async def test_browse_a_big_library_by_letter(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_ws_client: WebSocketGenerator, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("custom_components.slopify.library.LETTER_FOLDERS_OVER", 1)
    node = await browse(hass_ws_client, hass, "albums")
    assert [c["title"] for c in node["children"]] == ["K", "O"]
    k = await browse(hass_ws_client, hass, "albums:K")
    assert [c["title"] for c in k["children"]] == ["Kid A · Radiohead"]


async def test_browse_unknown(hass: HomeAssistant, loaded: MockConfigEntry, hass_ws_client: WebSocketGenerator) -> None:
    client = await hass_ws_client(hass)
    await client.send_json(
        {
            "id": 1,
            "type": "media_player/browse_media",
            "entity_id": E,
            "media_content_type": "album",
            "media_content_id": f"album:{'0' * 32}",
        }
    )
    response = await client.receive_json()
    assert not response["success"]


async def test_search(hass: HomeAssistant, loaded: MockConfigEntry) -> None:
    result = await hass.services.async_call(
        MP, "search_media", {ATTR_ENTITY_ID: E, "search_query": "radiohead"}, blocking=True, return_response=True
    )
    titles = [r.title for r in result[E].result]
    assert titles[0] == "Radiohead"
    assert "OK Computer · Radiohead" in titles
    exact = await hass.services.async_call(
        MP, "search_media", {ATTR_ENTITY_ID: E, "search_query": "kid a"}, blocking=True, return_response=True
    )
    assert exact[E].result[0].title == "Kid A · Radiohead", "an exact name comes first"
    only_albums = await hass.services.async_call(
        MP,
        "search_media",
        {ATTR_ENTITY_ID: E, "search_query": "kid", "media_filter_classes": ["album"]},
        blocking=True,
        return_response=True,
    )
    assert [r.title for r in only_albums[E].result] == ["Kid A · Radiohead"]


# --- artwork -----------------------------------------------------------------------------


async def test_artwork_is_fetched_with_the_accounts_sign_in(
    hass: HomeAssistant,
    loaded: MockConfigEntry,
    fake: FakeSlopify,
    hass_client: ClientSessionGenerator,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await play_on_web(hass, fake)
    node = await browse(hass_ws_client, hass, f"album:{ALBUM_KID}")
    picture = hass.states.get(E).attributes["entity_picture"]
    client = await hass_client()
    resp = await client.get(picture)
    assert resp.status == 200
    assert await resp.read() == b"\xff\xd8" + ALBUM_OK.encode()
    assert f"image {ALBUM_OK} 640" in fake.requests

    resp = await client.get(node["thumbnail"])
    assert resp.status == 200
    assert await resp.read() == b"\xff\xd8" + ALBUM_KID.encode()


# --- connection ------------------------------------------------------------------------


async def test_unavailable_while_disconnected_and_back_after(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("custom_components.slopify.api.RECONNECT_MIN", 0.05)
    await play_on_web(hass, fake)
    hellos = len(fake.hellos)
    await fake.drop_sockets()
    await fake.wait_for(lambda: len(fake.hellos) > hellos or hass.states.get(E).state == "unavailable")
    await fake.wait_for(lambda: len(fake.hellos) > hellos)
    await settle(hass, fake)
    assert hass.states.get(E).state == "playing"


async def test_a_revoked_sign_in_asks_to_sign_in_again(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("custom_components.slopify.api.RECONNECT_MIN", 0.05)
    fake.tokens.pop("tok-valid")
    await fake.drop_sockets()
    await fake.wait_for(lambda: hass.config_entries.flow.async_progress())
    flows = hass.config_entries.flow.async_progress()
    assert flows[0]["context"]["source"] == "reauth"
    assert hass.states.get(E).state == "unavailable"


async def test_setup_retries_when_the_server_is_down(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(entry, data={**entry.data, "url": "http://127.0.0.1:1"})
    await hass.config_entries.async_setup(entry.entry_id)
    assert entry.state.name == "SETUP_RETRY"


async def test_setup_with_a_dead_token_starts_reauth(
    hass: HomeAssistant, entry: MockConfigEntry, fake: FakeSlopify
) -> None:
    fake.tokens.pop("tok-valid")
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    assert entry.state.name == "SETUP_ERROR"
    assert hass.config_entries.flow.async_progress()[0]["context"]["source"] == "reauth"


async def test_unload_and_remove_sign_out(hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify) -> None:
    assert await hass.config_entries.async_unload(loaded.entry_id)
    await fake.wait_for(lambda: not fake.sockets)
    assert hass.states.get(E).state == "unavailable"
    await hass.config_entries.async_remove(loaded.entry_id)
    assert fake.logged_out == ["tok-valid"]


async def test_diagnostics_never_include_the_token(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify, hass_client: ClientSessionGenerator
) -> None:
    await play_on_web(hass, fake)
    diag = await get_diagnostics_for_config_entry(hass, hass_client, loaded)
    text = str(diag)
    assert "tok-valid" not in text and "SECRET" not in text
    assert diag["accounts"]["lukas"]["connected"] is True
    assert [s["name"] for s in diag["accounts"]["lukas"]["sources"]] == ["Den", "Kitchen", "Web Player (1)"]
