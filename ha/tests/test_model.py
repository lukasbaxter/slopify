"""The session model: sources, the current source, and hand-offs."""

from custom_components.slopify.model import current_key, handoff, last_speaker_key, position_now, targets

from .fake_slopify import SERVER_CLIENT, SPEAKER_DEN, SPEAKER_KITCHEN, T1, T2, T3, now_playing, row

SERVER = {"id": SERVER_CLIENT, "name": "Home speakers", "kind": "server", "canPlay": False}
WEB = {"id": "web-1", "name": "Web Player (1)", "kind": "web", "canPlay": True}
DESKTOP = {"id": "desk", "name": "Studio Mac", "kind": "desktop", "canPlay": True}
REMOTE = {"id": "ha-x", "name": "Home Assistant", "kind": "homeassistant", "canPlay": False}


def test_sources_are_speakers_then_apps_that_can_play() -> None:
    lan = [{**SPEAKER_KITCHEN, "viaClient": SERVER_CLIENT}, {**SPEAKER_DEN, "viaClient": SERVER_CLIENT}]
    got = targets([SERVER, WEB, DESKTOP, REMOTE], lan)
    assert [t.name for t in got] == ["Den", "Kitchen", "Studio Mac", "Web Player (1)"]
    assert got[1].client_id == SERVER_CLIENT and got[1].device_id == "cast:kitchen"
    assert got[2].client_id == "desk" and got[2].device_id == "local"


def test_a_speaker_seen_twice_is_listed_once_and_played_by_the_server() -> None:
    lan = [{**SPEAKER_KITCHEN, "viaClient": "desk"}, {**SPEAKER_KITCHEN, "viaClient": SERVER_CLIENT}]
    got = targets([SERVER, DESKTOP], lan)
    assert [(t.name, t.client_id) for t in got if t.key.startswith("speaker:")] == [("Kitchen", SERVER_CLIENT)]


def test_a_speaker_only_a_desktop_app_can_reach_is_played_by_that_app() -> None:
    got = targets([DESKTOP], [{**SPEAKER_DEN, "viaClient": "desk"}])
    assert got[0].client_id == "desk" and got[0].device_id == SPEAKER_DEN["id"]


def test_names_stay_unique() -> None:
    twin = {**DESKTOP, "id": "desk2"}
    lan = [{**SPEAKER_KITCHEN, "name": "Studio Mac", "viaClient": SERVER_CLIENT}]
    names = [t.name for t in targets([SERVER, DESKTOP, twin], lan)]
    assert len(set(names)) == len(names) == 3
    assert "Studio Mac (speaker)" in names


def test_current_source() -> None:
    web_np = now_playing(T1)
    assert current_key("web-1", web_np, [WEB]) == "client:web-1"
    cast_np = now_playing(T1, device={"id": "cast:kitchen", "kind": "cast", "name": "Kitchen"})
    assert current_key(SERVER_CLIENT, cast_np, [SERVER]) == "speaker:cast:kitchen"
    assert current_key("desk", cast_np, [DESKTOP]) == "speaker:cast:kitchen"
    assert current_key(None, web_np, [WEB]) is None


def test_last_speaker() -> None:
    assert (
        last_speaker_key(now_playing(T1, device={"id": "cast:kitchen", "kind": "cast", "name": "Kitchen"}))
        == "speaker:cast:kitchen"
    )
    assert last_speaker_key(now_playing(T1)) is None
    assert last_speaker_key(None) is None


def test_position_runs_on_while_playing_and_stops_at_the_end() -> None:
    assert position_now(now_playing(T1, position=10.0), 2.5) == 12.5
    assert position_now(now_playing(T1, position=10.0, playing=False), 60.0) == 10.0
    assert position_now(now_playing(T1, position=200.0), 60.0) == 201.0  # the song's length


def test_handoff_carries_the_whole_queue_when_it_lines_up() -> None:
    rows = [row(T1), row(T2), row(T3)]
    got = handoff(now_playing(T2, queue_index=1, position=40.0), rows, 1.0)
    assert got == {"trackIds": [T1, T2, T3], "index": 1, "position": 41.0}


def test_handoff_sends_just_the_song_when_the_queue_is_unknown_or_stale() -> None:
    assert handoff(now_playing(T2, queue_index=1), [], 0)["trackIds"] == [T2]
    assert handoff(now_playing(T2, queue_index=0), [row(T1), row(T2)], 0)["trackIds"] == [T2]
    assert handoff(None, [row(T1)], 0) is None
