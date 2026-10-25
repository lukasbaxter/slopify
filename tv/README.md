# Slopify TV

Android TV / Google TV app: the web app's now-playing view (cover, lyrics, visualizer) in a WebView, driven by the remote.
The page does the playing and owns the session; this shell adds the device name, the remote keys and a seeded login.

- Build: `./build.sh` (Gradle in the `thyrlian/android-sdk` container on the build host). Other server: `-PslopifyUrl=https://your.server`.
- First run: `adb shell am start -n com.lukasbaxter.slopify.tv/.MainActivity --es token <device token> --es userId <user id>` seeds the account, or sign in on the page with the remote.
- Remote: centre / play-pause = play/pause, left/right = previous/next, up/down = album / lyrics / visualizer, back = exit.
- The page is laid out at 1600 css px and told `devicePixelRatio = 1`, so the visualizer canvas is drawn once per screen pixel (at the TV's native 2x it ran at a few fps).
- `--es tvcss "<css>"` injects extra TV-only CSS (persisted; pass "" to clear).

## One entry per TV

A TV's home screen can run a small **Slopify TV agent** (see `tcl-launcher`'s `TvAgent.kt`: `GET /info` → `{"kind":"slopify-tv","name":…,"app":true}`, `POST /open` launches this app, port 7781, LAN only). The server's speaker sweep finds it, and from then on:

- while this app is connected from that TV, the TV's Cast entry is hidden and the app is the one "Den TV" in every device list;
- picking the TV's Cast entry while the app is closed opens the app through the agent and hands it the session as a normal player (lyrics, visualizer, the TV's own audio path); if the app does not connect within 20 s the server casts as before.
