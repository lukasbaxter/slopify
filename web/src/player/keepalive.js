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
// The face: a second silent element, loaded and always paused, that the lock
// screen shows while a session is held paused. WebKit's Now Playing is the
// most recently interacted-with unmuted candidate (HTMLMediaElement::
// selectBestMediaSession: play/pause/load during a user gesture count), not
// the one that plays, and its play/pause button and clock follow that
// element. Held paused, the stand-in has to keep playing (silence is what
// keeps iOS from suspending the app), so it was the newest candidate after
// the tap that paused: the lock screen showed a pause button and a running
// clock over a paused song. The face is touched right after every stand-in
// call, so it is never older than the stand-in; unmuted only while holding
// (a muted element is never a candidate), it then wins with paused.
let faceEl = null, holdFace = false;
const log = [];
// The stand-in's own pauses (below), to tell them from the system's.
let ownPausePending = false, systemPausedAt = 0, resumingAfterSystemPause = false, onSystemResume = null;
/** Called when the stand-in plays again after a pause that was not ours. */
export function onStandInResumed(fn) { onSystemResume = fn; }
const ownPause = (a) => { if (!a.paused) ownPausePending = true; a.pause(); };
/** The stand-in was paused by the system (an interruption) within `ms`. */
export function standInPausedBySystem(ms) { return Date.now() - systemPausedAt < ms; }
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
  el.addEventListener('ended', () => { if (wanted || bridged) { el.currentTime = 0; el.play().catch(() => {}); touchFace(); } });
  el.addEventListener('error', () => note(`error ${el.error?.code}`));
  el.addEventListener('playing', () => {
    note(`playing t=${el.currentTime.toFixed(1)}`);
    if (holdFace) holdPaused();
    // Back after a pause that was not ours: its pause and start each moved
    // WebKit's idea of the session's position, and the lock screen came back
    // off (seconds, after a hold). usePlayer tells it the position again.
    if (resumingAfterSystemPause) { resumingAfterSystemPause = false; try { onSystemResume?.(); } catch { /* listener */ } }
  });
  // A pause that is not ours: an interruption (another app's sound, a call)
  // or iOS stopping it. WebKit then also hands the page a Media Session
  // 'pause' action (MediaSession::suspendPlayback); for a session playing on
  // another device that action is no user's (standInPausedBySystem, used by
  // usePlayer to drop it). Asked to play again at once: during the
  // interruption WebKit keeps that as the state to restore when it ends.
  el.addEventListener('pause', () => {
    const own = ownPausePending; ownPausePending = false;
    note(own ? 'pause' : 'pause (not ours)');
    if (own || el.ended || !(wanted || bridged) || (quiet && !bridged)) return;
    systemPausedAt = Date.now();
    setTimeout(() => {
      if (!(wanted || bridged) || (quiet && !bridged) || !el.paused) return;
      note('playing again after a pause not ours');
      resumingAfterSystemPause = true;
      el.play().catch((e) => { resumingAfterSystemPause = false; note(`play again ${e?.name}`); });
    }, 300);
  });
  if (typeof window !== 'undefined') { window.__conduitKeepAlive = el; window.__conduitKeepAliveState = state; } // diagnostics
  return el;
}

// Loaded inside a tap (the load is the interaction that makes it a
// candidate at all), metadata only, muted until a hold.
function primeFace() {
  if (typeof document === 'undefined') return;
  if (!faceEl) {
    faceEl = new Audio();
    faceEl.preload = 'metadata'; faceEl.muted = true; faceEl.setAttribute('playsinline', '');
    if (typeof window !== 'undefined') window.__conduitFace = faceEl; // diagnostics
  }
  if (!faceEl.getAttribute('src')) { faceEl.src = SRC(); faceEl.load(); note('face loaded'); }
  // Played once, muted, and paused again at once. Locked, an element that
  // has never played is no Now Playing candidate outside a user gesture
  // (MediaElementSession::canShowControlsManager: "hasn't fired playing
  // notification"), and that is when a session paused on another device has
  // to show paused: WebKit cleared Now Playing instead (tools/ios-sim, 10-26).
  if (!facePlayed && !facePriming) {
    const f = faceEl;
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
    const declared = ms?.playbackState;
    facePriming = true; f.muted = true;
    f.play().then(() => {
      facePlayed = true; facePriming = false; note('face played once'); f.pause(); touchFace();
      // Its play and pause set the page's MediaSession state inside WebKit;
      // give the page's own declaration back.
      // Only 'paused': declaring 'playing' makes the Media Session WebKit's
      // current session, which supports no seeking (usePlayer declarePlayback).
      try { if (ms && declared === 'paused') ms.playbackState = declared; } catch { /* unsupported */ }
    }).catch((e) => { facePriming = false; note(`face play ${e?.name}`); });
  }
}
let facePlayed = false, facePriming = false;
let faceArmed = false;
function armFace() {
  if (faceArmed || typeof document === 'undefined') return;
  faceArmed = true;
  const tap = () => { primeFace(); touchFace(); for (const t of ['pointerdown', 'touchend', 'keydown']) document.removeEventListener(t, tap, true); };
  for (const t of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(t, tap, true);
}
// Held paused, the session's clock must stand still. Any element that starts
// playing sets the page's MediaSession to "playing" inside WebKit
// (MediaSession::willBeginPlayback), whatever the page declared, and from
// then on WebKit counts the position on from setPositionState: the
// stand-in's start after a pause did that, and each Now Playing refresh
// (every 5 s) moved the lock screen's paused clock on by 5 s (tools/ios-sim,
// 10-26: 3 of 5 lock-screen pauses). Declaring paused again once the
// stand-in plays stops the count where it is.
function holdPaused() {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
  if (!ms) return;
  try { ms.playbackState = 'paused'; note('held: told paused'); } catch { /* unsupported */ }
}
function touchFace() {
  const f = faceEl;
  // Not while its one play is under way: a pause now would abort it.
  if (!f || !f.getAttribute('src') || facePriming) return;
  f.muted = !holdFace;
  // Held, the stand-in plays muted. WebKit's Now Playing is the newest
  // candidate by user interaction, and outside a user gesture (the session
  // paused on another device, the phone locked and untouched) the face cannot
  // be made newer than the stand-in: the playing stand-in stayed Now Playing,
  // pause button and a clock running past the song's end; muted for one pick
  // only, the face won and lost again the moment the stand-in was unmuted
  // (tools/ios-sim, 10-26). A muted element is never a candidate. The
  // stand-in keeps playing (silence either way), and WebKit kept the audio
  // session at MediaPlayback / LongFormAudio while it was muted.
  const a = el;
  if (holdFace && a && !a.paused && !a.muted) a.muted = true;
  try { f.pause(); } catch { /* not ready */ }
}

function arm() {
  if (armed || typeof document === 'undefined') return;
  armed = true;
  const unlock = () => {
    const a = element();
    a.muted = false;
    a.play().then(() => { unlocked = true; note('unlocked'); if (!wanted && !bridged) { a.muted = true; ownPause(a); } touchFace(); off(); }).catch((e) => { note(`unlock ${e?.name}`); });
    primeFace(); touchFace();
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
export function keepAlive(on, position = 0, held = false) {
  if (wanted !== !!on) note(`want ${on ? 'on' : 'off'} @${Math.round(position || 0)}`);
  if (!on && quiet) quiet = false;
  if (holdFace !== (!!on && !!held)) note(`face ${on && held ? 'on' : 'off'}`);
  holdFace = !!on && !!held;
  armFace();
  // Unlocked by the first tap, not only after a start has failed: a session
  // handed to another device while the phone is locked, with no tap since
  // the app opened, otherwise found the stand-in locked (NotAllowedError) and
  // the lock screen empty (tools/ios-sim, 10-26). Left muted after the
  // unlock when it is not wanted: a paused, unmuted, just-touched stand-in
  // would be WebKit's Now Playing over the music the same tap starts.
  if (!unlocked) arm();
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
  applyStandIn(position);
  touchFace();
}
function applyStandIn(position) {
  const a = element();
  if (wanted || bridged) {
    clearTimeout(pauseTimer); pauseTimer = null;
    // Muted when it last stopped (below), or while a held session shows the
    // face (touchFace): unmuted for anything else.
    if (a.muted && !holdFace) a.muted = false;
    if (quiet && !bridged) { if (!a.paused) { ownPause(a); note('held quiet'); } return; }
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
      a.muted = true; ownPause(a); a.removeAttribute('src'); a.load(); ownPausePending = false; note('stopped, unloaded'); touchFace(); // load() drops the queued pause event
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
  a.play().then(() => { unlocked = true; note('unlocked (primed)'); if (!wanted && !bridged) { a.muted = true; ownPause(a); } touchFace(); }).catch((e) => note(`prime ${e?.name}`));
  primeFace(); touchFace();
}

/** The stand-in element, if made (usePlayer: which element plays). */
export function standInElement() { return el; }

export function state() {
  const a = el;
  return { wanted, bridged, quiet, unlocked, armed, frozen, face: faceEl ? (!faceEl.getAttribute('src') ? 'empty' : faceEl.muted ? 'muted' : 'held') : 'none', facePlayed, paused: a ? a.paused : null, t: a ? +a.currentTime.toFixed(1) : null, ready: a?.readyState ?? null, err: a?.error?.code ?? null, log: log.slice(-8) };
}
