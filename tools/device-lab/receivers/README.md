# Lab receivers

Real third-party receivers for testing Slopify casting, running on a Linux lab host with no sound output.

| Receiver | Software | Name | Ports |
|---|---|---|---|
| `dlna` | gmrender-resurrect 0.3.1 (libupnp 1.14, GStreamer 1.28) | Lab DLNA | TCP 49494 (description, SOAP, GENA), SSDP 1900 |
| `airplay` | shairport-sync 5.6.2, classic AirPlay 1 | Lab AirPlay | RTSP TCP 5000, UDP 6001-6010 (control/timing/audio) |
| `airplay-pw` | same, with a password | Lab AirPlay Locked | RTSP TCP 5100, UDP 6101-6110, password `labpass` |

All three bind and advertise on the interface of the default route (override with `LAB_IFACE`). Names, ports and the
password can be changed with env vars, see the top of `run.sh`. The DLNA UDN is generated once per host and kept in
`~/apps/slopify-lab/receivers/run/dlna.uuid`. `run.sh status` prints the current addresses, UDN and ports.

## Files

- `build.sh` builds everything into `~/apps/slopify-lab/receivers/` on the lab host. Idempotent. Run it on the
  lab host, or from the Mac with `LAB_HOST=user@host` (env or `lab.env`, see `lab.env.example`); from the Mac it
  rsyncs this directory to `~/apps/slopify-lab/receivers/tools` and builds there over ssh.
- `run.sh start|stop|restart|status [dlna|airplay|airplay-pw|all]`, `run.sh logs <receiver> [n]`. Works on the lab
  host or from the Mac (same `LAB_HOST` rule).
- `pcm_rms.py` logs one line per second of the PCM a receiver actually renders.
- `airplay_meta.py` decodes the shairport-sync metadata pipe.
- `dlna_test.py` stdlib UPnP control point (SSDP discovery, full AVTransport/RenderingControl run).
- `airplay_test.py` pyatv based AirPlay 1 sender (mDNS discovery, metadata, artwork, volume, password).

## Layout on the lab host

```
~/apps/slopify-lab/receivers/
  prefix/     gmediarender, shairport-sync, autotools, libconfig
  sysroot/    -dev headers and a few binaries (ffmpeg, gst-launch, gst-libav) unpacked from apt-get download
  venv/       python 3.12 + pyatv (via uv; the system python has no pip)
  media/      test files (tone/sweep mp3, flac, wav, m4a aac/alac, ogg, opus, cover.jpg)
  logs/       dlna.log dlna-rms.log airplay.log airplay-rms.log airplay-meta.log airplay-pw*.log
  artwork/    artwork received over AirPlay, artwork/<receiver>/artwork-latest.jpg
  run/        pid files, generated shairport configs, metadata FIFOs, GStreamer registry
```

## Reading the logs

RMS log, one line per wall-clock second while audio flows:

```
2026-10-31T10:46:18.635 label=airplay state=audio frames=44000 rms_dbfs=-34.0 peak_dbfs=-30.9 total_s=6.76
```

`frames` near 44100 means real-time pacing. `state=idle` is logged once when audio stops, then every 60 s.
Volume is applied before the RMS tap on both receivers, so volume changes show up as level steps.

Metadata log (AirPlay):

```
10:46:12.866 core/minm title="Lab Tone 440"
10:46:12.866 ssnc/PICT artwork image/jpeg 10309 bytes -> .../artwork/airplay/artwork-latest.jpg
10:46:17.824 ssnc/pvol volume airplay=-6.00 out=-9.63 (min -96.30, max 0.00)
```

`dlna.log` is gmrender's own log at INFO level and shows every SOAP action, URI and GStreamer error.

## Tests

```
# DLNA, from any LAN host (serves the file itself, from the address facing the renderer)
python3 dlna_test.py --file tone.mp3                     # Range-capable server (default)
python3 dlna_test.py --file tone.mp3 --serve-mode plain  # ignores Range, like python -m http.server
python3 dlna_test.py --file tone.mp3 --serve-mode nolength

# AirPlay, on the lab host (needs the venv)
cd ~/apps/slopify-lab/receivers
venv/bin/python -I tools/airplay_test.py --file media/tone-60s.mp3 --artwork media/cover.jpg
venv/bin/python -I tools/airplay_test.py --name "Lab AirPlay Locked" --file media/tone-60s.mp3 --expect-auth-failure
venv/bin/python -I tools/airplay_test.py --name "Lab AirPlay Locked" --file media/tone-60s.mp3 --password labpass
```

## Behaviour worth knowing

- gmrender: Seek needs HTTP Range. It seeks by byte offset (`Range: bytes=N-`). If the server ignores Range,
  GStreamer errors out ("Server does not support seeking") but the transport still says PLAYING and RelTime stays
  frozen at the seek target. Without Content-Length, Seek is accepted and silently ignored, TrackDuration is 0:00:00.
- gmrender reports state PLAYING right after Play even when the stream cannot be decoded; check RelTime moves.
- Right after Seek, RelTime echoes the target string as sent (`00:00:30`), later reads use `0:00:30`.
- TrackDuration for mp3 starts as an estimate and settles after a second or so.
- Codecs that play: mp3, flac, wav, ogg vorbis, opus, m4a AAC, m4a ALAC (AAC/ALAC need gst-libav, included).
  GetProtocolInfo lists more types than that, including `audio/*`.
- Volume 0-100 is a dB scale: 30 is about -36 dB.
- shairport: plain RTSP (ANNOUNCE, SETUP, RECORD, FLUSH, SET_PARAMETER, TEARDOWN plus GET /info, POST /feedback).
  No pair-setup or auth-setup. Password uses RTSP Digest (401 then retry). TXT has `pw=true` on the locked one.
- shairport adds 1.75 s latency to the sender timestamps with pyatv (sender 1.5 s + 0.25 s fixed offset).
  Volume changes take effect almost immediately, not after the latency.
- One classic AirPlay session at a time (shairport default allow_session_interruption = no), so a second sender is refused while one plays.
- pyatv `atvremote scan` merges two RAOP services on the same IP into one device (the password flag of one leaks
  onto the other). Discover by service instance name, as `airplay_test.py` does.
- With `--manual`, `atvremote` does not know the TXT record and sends no metadata. Pass `--service-properties`
  or use `airplay_test.py`.

## Limits

- AirPlay 2 is not built. This host allows unprivileged binds from port 80 up
  (`net.ipv4.ip_unprivileged_port_start = 80`), so nqptp on 319/320 would work without sudo if AirPlay 2 is wanted.
- Receivers are started with setsid/nohup and do not survive a reboot. `run.sh start` again.
- Nothing reaches the speakers: gmrender uses fdsink (sync=true), shairport uses the stdout backend. No ALSA,
  Pulse or PipeWire backend is compiled into shairport.
