# Casting checks

Plays through a real Slopify server on speakers, real or virtual, and checks
start, clock, pause, resume, seek, volume, next, track end and stop.

Run the server on a Linux box on the speakers' LAN (Node's mDNS on macOS
can't see other devices):

```
CLIAIRPLAY=/path/to/cliairplay tools/device-lab/cast-server.sh start <music dir>
SLOPIFY_URL=http://<that box>:8095 SLOPIFY_USER=admin SLOPIFY_PASSWORD='lab password 123' \
  node tools/device-lab/cast-check.mjs --list
SLOPIFY_URL=... node tools/device-lab/cast-check.mjs "Lab DLNA" "Lab AirPlay" "Lab Sonos" "Lab Roku"
```

Use tracks of 30 s or more (the end-of-track check seeks to 6 s before the end).
Don't point it at speakers people are listening to: it takes them over.

## Virtual speakers

| Speaker | What it is | Where |
|---|---|---|
| Lab DLNA | gmrender-resurrect, a real DLNA renderer | `../receivers/` |
| Lab AirPlay, Lab AirPlay Locked | shairport-sync (AirPlay 1), the second with a password | `../receivers/` |
| Lab Sonos | Sonos simulator: ZonePlayer description, AVTransport, RenderingControl | `devices.mjs` |
| Lab Roku | Roku simulator: ECP, Play on Roku | `devices.mjs` |

```
node tools/device-lab/sim/devices.mjs --roku "Lab Roku" --sonos "Lab Sonos"
```

There are no emulators for Roku, Sonos or Apple TV, so the two simulators are
built from the public APIs and from what Music Assistant and Home Assistant
send to real units. They answer SSDP like the real thing, and they really
fetch and decode each stream in real time with ffmpeg (no sound), so a bad URL
or format fails here the way it would on the device. They are not the
vendors' firmware: AirPlay 2 over PTP, Apple TV pairing and Sonos S2 quirks
still need a real device.

Fire TV runs Android: test the Slopify TV app on an Android TV emulator
without Google services (see the main README in this folder).
