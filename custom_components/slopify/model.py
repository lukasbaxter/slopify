"""What the session looks like from Home Assistant: pure functions, no I/O.

A Slopify account has one session. At most one client is *active* (making
the sound, on its own output or on a speaker it drives); every other client
mirrors it. The server itself is a client too ("Home speakers") that drives
the speakers it finds on the LAN.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any

LOCAL = "local"


@dataclass(frozen=True)
class Target:
    """Somewhere the session can be moved to (a Home Assistant source)."""

    key: str  # "speaker:<speaker id>" or "client:<client id>"
    name: str
    client_id: str  # the client that will play it
    device_id: str  # the speaker id, or "local" for that client's own output


def targets(players: list[dict[str, Any]], lan_devices: list[dict[str, Any]]) -> list[Target]:
    """Every output the session can move to, in a stable order.

    Speakers come first (the server's own before ones a desktop app can
    reach: the server needs no app left open), then the apps that can play.
    """
    server_ids = {p["id"] for p in players if p.get("kind") == "server"}
    speakers: dict[str, dict[str, Any]] = {}
    for dev in lan_devices:
        via = dev.get("viaClient")
        if not isinstance(via, str) or not via:
            continue
        have = speakers.get(dev["id"])
        if have is None or (via in server_ids and have.get("viaClient") not in server_ids):
            speakers[dev["id"]] = dev
    out = [
        Target(f"speaker:{d['id']}", str(d.get("name") or d["id"]), d["viaClient"], d["id"])
        for d in sorted(speakers.values(), key=lambda d: str(d.get("name") or "").casefold())
    ]
    apps = [p for p in players if p.get("canPlay") and p.get("kind") != "server"]
    out += [
        Target(f"client:{p['id']}", str(p.get("name") or p["id"]), p["id"], LOCAL)
        for p in sorted(apps, key=lambda p: str(p.get("name") or "").casefold())
    ]
    return _unique_names(out)


def _unique_names(items: list[Target]) -> list[Target]:
    seen: dict[str, int] = {}
    for t in items:
        seen[t.name.casefold()] = seen.get(t.name.casefold(), 0) + 1
    out: list[Target] = []
    used: set[str] = set()
    for t in items:
        name = t.name
        if seen[name.casefold()] > 1:
            name = f"{t.name} (app)" if t.key.startswith("client:") else f"{t.name} (speaker)"
        base, n = name, 2
        while name.casefold() in used:
            name, n = f"{base} {n}", n + 1
        used.add(name.casefold())
        out.append(Target(t.key, name, t.client_id, t.device_id))
    return out


def current_key(active_id: str | None, now_playing: dict[str, Any] | None, players: list[dict[str, Any]]) -> str | None:
    """The target the active client is playing on."""
    if not active_id or not now_playing:
        return None
    device = as_dict(now_playing.get("device"))
    dev_id = device.get("id")
    active = next((p for p in players if p.get("id") == active_id), None)
    if dev_id and dev_id != LOCAL and device.get("kind") not in (LOCAL, "relay"):
        return f"speaker:{dev_id}"
    if active and active.get("kind") != "server":
        return f"client:{active_id}"
    return None


def as_dict(value: Any) -> dict[str, Any]:
    """A JSON object from the wire, or an empty one."""
    return value if isinstance(value, dict) else {}


def last_speaker_key(remembered: dict[str, Any] | None) -> str | None:
    """The speaker the remembered session last played on, if it was one."""
    device = (remembered or {}).get("device")
    if (
        isinstance(device, dict)
        and device.get("id")
        and device.get("id") != LOCAL
        and device.get("kind") not in (LOCAL, "relay")
    ):
        return f"speaker:{device['id']}"
    return None


def position_now(now_playing: dict[str, Any], elapsed: float) -> float:
    """Playhead in seconds, `elapsed` seconds after the report was received."""
    pos = _num(now_playing.get("position"))
    if now_playing.get("playing"):
        pos += max(0.0, elapsed)
    duration = _num(now_playing.get("duration"))
    return min(pos, duration) if duration > 0 else pos


def handoff(
    now_playing: dict[str, Any] | None, queue_rows: list[dict[str, Any]], elapsed: float
) -> dict[str, Any] | None:
    """The queue, index and playhead to hand to another output.

    The whole queue goes along when it is known and lines up with what is
    playing, so "next" on the new output carries on where this one would
    have; otherwise just the current song (the server keeps any queue it
    already holds for that song).
    """
    if not now_playing or not isinstance(now_playing.get("itemId"), str):
        return None
    item = now_playing["itemId"]
    qi = now_playing.get("queueIndex")
    ids = [r.get("Id") for r in queue_rows if isinstance(r, dict)]
    if isinstance(qi, int) and 0 <= qi < len(ids) and ids[qi] == item and all(isinstance(i, str) for i in ids):
        track_ids, index = ids, qi
    else:
        track_ids, index = [item], 0
    return {
        "trackIds": track_ids,
        "index": index,
        "position": round(position_now(now_playing, elapsed), 3),
    }


def _num(value: Any) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return 0.0
    return out if math.isfinite(out) else 0.0
