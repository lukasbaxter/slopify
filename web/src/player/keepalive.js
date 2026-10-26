// Silent looping <audio> that keeps a Media Session alive while the music
// plays somewhere else (another client, or a speaker driven from here). The
// lock screen, Control Center, AirPods and the Mac's Now Playing widget only
// show a page's session while that page has playing media, so this is what
// makes the remote session show up there and take its controls. iOS lets a
// media element be started only inside a user gesture; the first tap on the
// page unlocks this one (play, then pause unless it is wanted), after which
// it can be started at any time.
//
// The media is `keepalive.wav` next to the app (tools/vite-keepalive.js: 20
// minutes of 8 kHz 8-bit mono PCM silence, generated at build), played from
// its URL so the OS seeks it with range requests. Not a 1-second loop: the
// lock screen takes its elapsed time from the element as well as from
// setPositionState, and a loop snapped it to 0 every second. Not blob: media:
// on the iPhone the clock froze at every seek target (mp3 and WAV alike), so
// each re-sync was another snap to 0. Should the clock ever freeze again the
// element is left alone after that and setPositionState carries the time.
let el = null, unlocked = false, wanted = false, bridged = false, armed = false, frozen = false, lastT = -1, lastAt = 0;
const log = [];
const note = (m) => { log.push(`${Math.round(performance.now() / 1000)}s${typeof document !== 'undefined' && document.hidden ? ' bg' : ''} ${m}`); if (log.length > 12) log.shift(); };

export const KEEPALIVE_SECONDS = 20 * 60;

const SRC = () => new URL('keepalive.wav', document.baseURI).href;

function element() {
  if (el) return el;
  el = new Audio(SRC());
  // preload none: with 'auto' every page load pulled the whole 9.6 MB file
  // (measured on a 5 Mbps link); it is only fetched once it has to play.
  el.preload = 'none'; el.setAttribute('playsinline', '');
  // No loop attribute and no seek before the first play: on the iPhone a
  // seek applied at loadedmetadata left the clock frozen for good. The
  // element starts at 0, and is moved only once it is seen advancing.
  el.addEventListener('loadedmetadata', () => note(`meta dur=${Math.round(el.duration)}`));
  el.addEventListener('ended', () => { if (wanted || bridged) { el.currentTime = 0; el.play().catch(() => {}); } });
  el.addEventListener('error', () => note(`error ${el.error?.code}`));
  el.addEventListener('playing', () => note(`playing t=${el.currentTime.toFixed(1)}`));
  el.addEventListener('pause', () => note('pause'));
  if (typeof window !== 'undefined') { window.__conduitKeepAlive = el; window.__conduitKeepAliveState = state; } // diagnostics
  return el;
}

function arm() {
  if (armed || typeof document === 'undefined') return;
  armed = true;
  const unlock = () => {
    const a = element();
    a.muted = false;
    a.play().then(() => { unlocked = true; note('unlocked'); if (!wanted && !bridged) a.pause(); off(); }).catch((e) => { note(`unlock ${e?.name}`); });
  };
  const off = () => { for (const t of ['pointerdown', 'touchend', 'keydown']) document.removeEventListener(t, unlock, true); armed = false; };
  for (const t of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(t, unlock, true);
}

// Keep the session alive (true) or let it go (false), at the session's
// position (seconds) so the element's own timeline agrees with the song.
// A remote pause shorter than 2 s (the gap between tracks, a reconnect) does
// not stop the element: every pause/play and every seek is a moment where
// iOS shows the elapsed time as 0, so both are kept rare (seeks only when
// the element is more than 4 s off).
let pauseTimer = null;
let lastPosition = 0;
// Quiet: wanted, loaded, but paused. iOS draws the lock screen's play/pause
// from the element (not from what the page declares), so while the stand-in
// plays for a paused session the lock screen shows a pause button that does
// nothing. A pause tap there quiets the stand-in instead: the button becomes
// play, and the next tap is a real play. Ends with the next want-off or play.
let quiet = false;
export function keepAlive(on, position = 0) {
  if (wanted !== !!on) note(`want ${on ? 'on' : 'off'} @${Math.round(position || 0)}`);
  if (!on && quiet) quiet = false;
  wanted = !!on;
  lastPosition = position;
  apply(position);
}
export function quietKeepAlive(on) {
  if (quiet === !!on) return;
  quiet = !!on;
  note(`quiet ${on ? 'on' : 'off'}`);
  apply(lastPosition);
}

// Held across a song change with the screen locked (usePlayer): between the
// old song's end and the new one's first sound nothing plays, and if the new
// song cannot start right away (a Siri announcement taking the audio, a slow
// connection) iOS suspends the app within ~15 s and the music is gone until
// it is opened. The silent element keeps the app a playing app meanwhile, so
// the stall watchdog keeps retrying. Separate from `wanted`, which the
// stand-in effect rewrites on every render.
export function bridgeKeepAlive(on, why = '') {
  if (bridged === !!on) return;
  bridged = !!on;
  note(`bridge ${on ? 'on' : 'off'}${why ? ` (${why})` : ''}`);
  apply(lastPosition);
}

function apply(position) {
  const a = element();
  if (wanted || bridged) {
    clearTimeout(pauseTimer); pauseTimer = null;
    // Muted when it last stopped (below): a muted element is no Now Playing
    // candidate, and iOS would not count the app as playing.
    if (a.muted) a.muted = false;
    if (quiet && !bridged) { if (!a.paused) { a.pause(); note('held quiet'); } return; }
    const p = Math.max(0, (position || 0) % KEEPALIVE_SECONDS);
    // Seek only a clock that is seen moving (two different readings while
    // playing); one that has not moved in 3 s of "playing" is frozen and is
    // left alone until it moves again. setPositionState carries the time.
    const now = performance.now();
    let moving = false;
    if (!a.paused && a.readyState >= 3) {
      if (a.currentTime !== lastT) { if (lastT >= 0) moving = true; if (frozen && lastT >= 0) { frozen = false; note(`moving again at ${a.currentTime.toFixed(1)}`); } lastT = a.currentTime; lastAt = now; }
      else if (!frozen && lastAt && now - lastAt > 3000) { frozen = true; note(`frozen at ${a.currentTime.toFixed(1)}`); }
    }
    // In the background (lock screen) the relay's position reports arrive
    // late and bunched, so the element's own clock is the better one there:
    // only a track change (> 15 s apart) moves it; in the foreground 4 s.
    const tolerance = typeof document !== 'undefined' && document.hidden ? 15 : 4;
    if (moving && !frozen && Math.abs((a.currentTime || 0) - p) > tolerance) {
      note(`seek ${a.currentTime.toFixed(1)} -> ${p.toFixed(1)}`);
      try { a.currentTime = p; } catch { /* not seekable */ }
      lastT = -1; lastAt = 0;
    }
    // Unloaded when it last stopped (below): give it its media back first.
    if (!a.getAttribute('src')) { a.src = SRC(); lastT = -1; lastAt = 0; frozen = false; note('reloaded'); }
    if (a.paused) a.play().then(() => { unlocked = true; }).catch((e) => { note(`play ${e?.name}`); if (!unlocked) arm(); });
  } else if (!a.paused && !pauseTimer) {
    // Stopped AND unloaded. A merely paused stand-in still counted to WebKit:
    // when this phone took the music back, the stand-in's pause 2 s later was
    // the last state change, and WebKit told iOS "paused" (isPlaying = false)
    // while the real player played: the lock screen's random pause icon.
    // Without media it can produce no audio and WebKit leaves it out.
    //
    // Muted first, though. WebKit's Now Playing pick is not "the element that
    // plays": it is the most recently *interacted-with* candidate, and a
    // pause() or load() that runs while WebKit still counts the moment as a
    // user gesture counts as an interaction. After a lock-screen command
    // (next while paused, on the locked phone) this timer fires 2 s later
    // still inside that gesture (WebKit logs prepareForLoad "gesture = 1"),
    // so the stand-in's own stop made it the newest candidate: Now Playing
    // went to the stopped stand-in, isPlaying = false, and stayed there while
    // the music played (the lock screen showed paused for the rest of the
    // song; tools/ios-sim, 10-26: 4 of 4 locked "next while paused"). An
    // emptied element still counted. A muted element is never a candidate
    // (MediaElementSession::canShowControlsManager), so muting it first hands
    // Now Playing straight to the playing music, with no paused blip.
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      if (wanted || bridged || a.paused) return;
      a.muted = true; a.pause(); a.removeAttribute('src'); a.load(); note('stopped, unloaded');
    }, 2000);
  }
}

/**
 * Inside a tap: unlock the stand-in now so it can start later with no tap
 * (a download about to run in the background, usePlayer). Plays and pauses
 * at once unless it is wanted by then. Only when not unlocked yet.
 */
export function primeKeepAlive() {
  if (unlocked || typeof document === 'undefined') return;
  const a = element();
  if (!a.getAttribute('src')) a.src = SRC();
  a.muted = false;
  a.play().then(() => { unlocked = true; note('unlocked (primed)'); if (!wanted && !bridged) a.pause(); }).catch((e) => note(`prime ${e?.name}`));
}

export function state() {
  const a = el;
  return { wanted, bridged, quiet, unlocked, armed, frozen, paused: a ? a.paused : null, t: a ? +a.currentTime.toFixed(1) : null, ready: a?.readyState ?? null, err: a?.error?.code ?? null, log: log.slice(-8) };
}
