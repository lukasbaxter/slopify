import React, { useEffect, useRef, useState } from 'react';
import { paletteColors } from '../api/colors.js';
import Calibrate from './Calibrate.jsx';
import { createShadow } from '../api/shadowStream.js';
import { ROUTES_WEB_AUDIO } from '../player/usePlayer.js';

// The visualizer is a graphic-EQ family (audioMotion-analyzer, the spectrum
// engine Feishin ships). Settings come from the full-screen tab's ⋯ menu and
// live in the account's prefs.
//
// Audio source: the local <audio> element when this device plays. When the
// sound is on a speaker or another client, a silent shadow copy of the same
// stream is decoded and played in step with the session's playhead and
// analysed instead (src/api/shadowStream.js: buffer sources into a node with
// no path to the speakers, so nothing is heard twice; a captured <audio> was
// audible on the iPad). `offset` is the speaker's measured output delay
// (seconds, from the calibration): the shadow runs that far behind the
// reported playhead so the bars match the sound.
// iOS only lets an AudioContext run when it was resumed inside a user
// gesture, so the shadow's context is a shared one that the visualizer
// button unlocks on tap, and the shadow is never started unless that
// context is running.
let sharedCtx = null;
export function unlockShadowAudio() {
  const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctx) return null;
  if (!sharedCtx || sharedCtx.state === 'closed') {
    // Nothing from the shadow ever reaches a speaker, so render it with no output
    // device at all. That also frees it from the device's buffer size: a TV's
    // HDMI path renders audio in 100 ms blocks, so an analyser on a context tied
    // to it only saw new data ten times a second and the bars moved in steps.
    // With no sink Chromium renders in 10 ms blocks. Browsers without the option
    // ignore it (older Chromium) or throw (WebKit): then the plain context.
    try { sharedCtx = new Ctx({ sinkId: { type: 'none' } }); } catch { sharedCtx = new Ctx(); }
  }
  sharedCtx.resume?.().catch(() => {});
  return sharedCtx;
}

// The TV app (Google TV Streamer: four slow cores) spent 10.7 ms of every frame
// in the analyser's draw at an 8192-point FFT, most of a 16.7 ms frame, and
// played at 45-54 fps. At 4096 points the draw is 7 ms, at 2048 5 ms (measured
// on the Streamer, 10-26). A TV starts at 4096 and halves again while the
// engine's own frame rate stays under 50.
const IS_TV = typeof window !== 'undefined' && window.slopifyShell?.deviceForm === 'tv';
const TV_FFT = 4096, TV_FFT_MIN = 2048, TV_MIN_FPS = 50;

// A context whose clock advances in big blocks (a TV's HDMI output: 100 ms) cannot
// feed a smooth visualizer; above this the shadow copy is analysed even for local playback.
const COARSE_LATENCY = 0.04;
// Bars further than this from the sound read as late (or early): re-line the shadow.
const DRIFT_MAX = 0.1;

export const EQ_STYLES = [
  // "Line": Feishin's default preset (mode 10 line graph, 1.9px, prism, faint reflection).
  { id: 'line', name: 'Line', opts: { mode: 10, lineWidth: 1.9, fillAlpha: 0, barSpace: .7, reflexRatio: .5, reflexAlpha: .1, reflexBright: 1, showPeaks: false, ledBars: false, lumiBars: false, radial: false, mirror: 0, smoothing: .6, fftSize: 8192, maxFreq: 22050, minFreq: 20, gravity: 11, linearBoost: 4, maxDecibels: -25, minDecibels: -85 } },
  { id: 'area', name: 'Area', opts: { mode: 10, lineWidth: 1.5, fillAlpha: .35, reflexRatio: .4, reflexAlpha: .15, showPeaks: false, ledBars: false, radial: false, mirror: 0, smoothing: .65, fftSize: 8192 } },
  { id: 'led', name: 'LED bars', opts: { mode: 6, ledBars: true, barSpace: .25, reflexRatio: 0, showPeaks: true, radial: false, mirror: 0, lumiBars: false, fillAlpha: 1, lineWidth: 0 } },
  { id: 'bars', name: 'Bars', opts: { mode: 5, ledBars: false, barSpace: .3, reflexRatio: 0, showPeaks: true, radial: false, mirror: 0, roundBars: true, fillAlpha: 1, lineWidth: 0 } },
  { id: 'mirror', name: 'Mirror', opts: { mode: 4, ledBars: false, barSpace: .2, reflexRatio: .5, reflexAlpha: .25, showPeaks: false, radial: false, mirror: -1, fillAlpha: 1, lineWidth: 0 } },
  { id: 'radial', name: 'Radial', opts: { mode: 5, radial: true, spinSpeed: 1, showPeaks: true, barSpace: .2, mirror: 0, reflexRatio: 0, ledBars: false, fillAlpha: 1, lineWidth: 0 } },
];
// 'album' = three colours pulled from the current cover (registered per track).
export const GRADIENTS = ['album', 'prism', 'classic', 'rainbow', 'orangered', 'steelblue'];
// `smoothing` 0..0.95: 0 = every frame raw (real time), higher = calmer bars.
export const DEFAULT_VIZ = { style: 'line', gradient: 'prism', smoothing: 0.6 };
export function loadVizSettings() {
  try { return { ...DEFAULT_VIZ, ...JSON.parse(localStorage.getItem('conduit.viz') || '{}') }; } catch { return { ...DEFAULT_VIZ }; }
}

export default function Visualizer({ player, active, jf, settings, offset = 0, calibrate = null, onCalibrated, onCalibrateClose }) {
  const boxRef = useRef(null);
  const stageRef = useRef(null);
  const amRef = useRef(null);
  const shadowRef = useRef(null); // createShadow() of the shared context
  const [state, setState] = useState('loading'); // loading | ready | error
  // Sound comes out of this client only when it is the active player on its
  // own local output. Mirroring another client (a browser playing while you
  // look at the desktop app) counts as remote even if a paused local queue
  // is still around, so the shadow stream is what gets analysed.
  const local = !player.mirroring && player.device?.kind === 'local' && !!player.current;
  // Tapping the element needs it routed through Web Audio, which iOS never is:
  // there the shadow copy stands in for local playback too.
  // A device whose sound trails its element (a TV's WebView: 0.9 s) uses the
  // shadow too, timed to what is heard.
  const tap = local && ROUTES_WEB_AUDIO && !((player.webAudio?.()?.ctx?.baseLatency || 0) > COARSE_LATENCY) && !((player.outputLag?.() || 0) > COARSE_LATENCY);
  const trackId = player.nowPlayingId;
  const cfg = settings || DEFAULT_VIZ;
  const style = EQ_STYLES.find((x) => x.id === cfg.style) || EQ_STYLES[0];

  const shadow = () => {
    if (shadowRef.current) return shadowRef.current;
    const ctx = unlockShadowAudio();
    if (!ctx) return null;
    shadowRef.current = createShadow(ctx);
    return shadowRef.current;
  };
  useEffect(() => () => { shadowRef.current?.close(); shadowRef.current = null; }, []);
  // The session playhead as a live clock: the position the player last
  // reported plus the time since. The sync tick below reads THIS, never a
  // position captured when the effect ran.
  const clockRef = useRef({ pos: 0, at: Date.now(), playing: false });
  clockRef.current = { pos: player.position || 0, at: Date.now(), playing: !!player.playing };
  const offsetRef = useRef(0);
  offsetRef.current = Number.isFinite(offset) ? offset : 0;
  // What the speaker REPORTS right now (no offset): the calibration measures
  // the delay against this.
  const posNowRef = useRef(null); posNowRef.current = player.positionNow || null;
  const lagRef = useRef(null); lagRef.current = player.outputLag || null;
  const reported = (at = Date.now()) => {
    const lag = (c) => (c.playing && lagRef.current ? lagRef.current() : 0);
    if (posNowRef.current) return posNowRef.current() - lag(clockRef.current) + (at - Date.now()) / 1000;
    const c = clockRef.current; return c.pos - lag(c) + (c.playing ? (at - c.at) / 1000 : 0);
  };
  useEffect(() => {
    if (!active || tap) { shadowRef.current?.stop(); return undefined; }
    const sh = shadow();
    if (!sh) return undefined;
    // What is coming out of the speaker right now: reported minus its delay.
    const want = () => reported() - offsetRef.current;
    // Seeking the ORIGINAL file is not accurate on VBR rips, so every (re)sync
    // is a fresh transcode that ffmpeg starts exactly at `base`; from then on
    // the stream's clock is exact (frame-counted), and drift beyond what the
    // reported playhead jitters by is another fresh transcode.
    const load = () => {
      const at = Math.max(0, want() + sh.lead);
      if (sh.id !== trackId) sh.retried = false;
      sh.loadedAt = Date.now();
      sh.id = trackId;
      sh.load(jf.transcodeUrl(trackId, { codec: 'mp3', bitrate: 192000, startAt: at }), at);
    };
    sh.onPlaying(() => {
      // Behind at start-up (drift < 0) means ask further ahead next time.
      const drift = sh.position - want();
      sh.lead = Math.min(3, Math.max(0.2, sh.lead - drift));
      // A slow device (a TV decoding on a 1.4 GHz core) misses by a third of a
      // second on the first try, under the 0.6 s the sync tick tolerates, so the
      // bars ran visibly late for the whole track. One retry with the lead it
      // just learned lands within a frame or two; never more than one per load.
      if (Math.abs(drift) > DRIFT_MAX && !sh.retried) { sh.retried = true; load(); } else sh.retried = false;
    });
    const tick = () => {
      const c = clockRef.current;
      if (!c.playing) { if (!sh.paused) sh.stop(); return; }
      if (sh.ctx.state !== 'running') { sh.ctx.resume?.().catch(() => {}); return; } // never started before the unlock
      if (sh.id !== trackId || sh.paused) { load(); return; }
      if (sh.loading) return;
      // The shadow's clock and the player's part slowly (on the TV 0.14 s
      // in 50 s): re-line it once it is visibly off, at most every 5 s.
      const drift = sh.position - want();
      if (Math.abs(drift) > 0.6 || (Math.abs(drift) > DRIFT_MAX && Date.now() - (sh.loadedAt || 0) > 5000)) load();
    };
    // A new offset is a jump, not drift: restart the stream at the new spot.
    if (sh.offset !== offsetRef.current) { sh.offset = offsetRef.current; sh.id = null; }
    tick();
    const t = setInterval(tick, 250);
    return () => { clearInterval(t); sh.onPlaying(null); };
  }, [active, tap, trackId, player.playing, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Timing report to the server log every 10 s while the bars show (devices
  // whose console nobody can open: a TV). The playback context's output
  // timestamp says how far the sound trails what the element reports.
  useEffect(() => {
    if (!active || !player.relay?._send) return undefined;
    let last = null;
    const report = () => {
      try {
        const sh = shadowRef.current, pc = player.webAudio?.()?.ctx;
        const ts = pc?.getOutputTimestamp?.();
        const now = { wall: Date.now(), sh: sh && !sh.paused ? sh.ctx.currentTime : null };
        const rate = last && now.sh != null && last.sh != null ? (now.sh - last.sh) / ((now.wall - last.wall) / 1000) : null;
        last = now;
        const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
        player.relay._send({ type: 'diag', data: { viz: {
          mode: tap ? 'tap' : 'shadow', local, track: trackId?.slice(0, 8), reported: r3(reported()), offset: offsetRef.current,
          shadow: sh ? { pos: r3(sh.position), drift: r3(sh.position - (reported() - offsetRef.current)), lead: r3(sh.lead), loading: sh.loading, paused: sh.paused, rate: r3(rate), base: r3(sh.ctx.baseLatency), out: r3(sh.ctx.outputLatency) } : null,
          play: pc ? { base: r3(pc.baseLatency), out: r3(pc.outputLatency), state: pc.state, behind: ts && ts.performanceTime ? r3(pc.currentTime - ts.contextTime - (performance.now() - ts.performanceTime) / 1000) : null } : null,
          fps: amRef.current ? Math.round(amRef.current.fps) : null, fft: amRef.current?.fftSize ?? null,
          el: player.debugElement ? r3(player.debugElement()) : null, now: r3(player.positionNow?.()),
        } } });
      } catch { /* diagnostics only */ }
    };
    const first = setTimeout(report, 3000);
    const t = setInterval(report, 10500);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [active, tap, local, trackId, player.relay]); // eslint-disable-line react-hooks/exhaustive-deps

  const graph = () => { const wa = tap ? player.webAudio() : shadow(); wa?.ctx?.resume?.(); return wa; };

  // Graphic EQ engine.
  useEffect(() => {
    if (!active) return undefined;
    let alive = true, offSource = null, slow = null;
    setState('loading');
    (async () => {
      try {
        const mod = await import('audiomotion-analyzer');
        const AudioMotion = mod.default || mod;
        const wa = graph();
        // A superseded run (the effect re-ran while the module loaded) must
        // just stop -- it used to mark the NEW, working analyser as an error.
        if (!alive) return;
        if (!wa) { setState('error'); return; }
        const stage = stageRef.current;
        stage.innerHTML = '';
        const am = new AudioMotion(stage, {
          audioCtx: wa.ctx, source: wa.source, connectSpeakers: false,
          overlay: true, bgAlpha: 0, showBgColor: false, showScaleX: false, showScaleY: false,
          minFreq: 30, maxFreq: 16000, weightingFilter: 'D', maxFPS: 0,
          ...style.opts, gradient: cfg.gradient === 'album' ? 'classic' : cfg.gradient, smoothing: cfg.smoothing ?? style.opts.smoothing ?? .6,
          ...(IS_TV ? { fftSize: Math.min(style.opts.fftSize || 8192, TV_FFT) } : {}),
        });
        amRef.current = am;
        if (IS_TV) slow = setInterval(() => { if (!document.hidden && am.isOn && am.fps > 0 && am.fps < TV_MIN_FPS && am.fftSize > TV_FFT_MIN) am.fftSize /= 2; }, 3000);
        // Local playback re-captures the element on every new track: follow it.
        if (wa.onSource) offSource = wa.onSource((next, prev) => { try { if (prev) am.disconnectInput(prev); } catch { /* not connected */ } try { am.connectInput(next); } catch { /* ignore */ } });
        if (window.location.search.includes('debug')) window.__vizAm = am;
        setState('ready');
      } catch (e) { if (alive) { console.error('visualizer', e); setState('error'); } }
    })();
    return () => { alive = false; clearInterval(slow); offSource?.(); try { amRef.current?.destroy(); } catch {} amRef.current = null; };
  }, [active, tap, style.id, cfg.gradient]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Match album art": three colours from the cover, re-registered on every track.
  const artUrl = player.nowPlaying?.artId ? jf.imageUrl(player.nowPlaying.artId, { maxHeight: 200 }) : player.nowPlaying?.artUrl || null;
  useEffect(() => {
    const am = amRef.current;
    if (!am || cfg.gradient !== 'album' || state !== 'ready') return undefined;
    let alive = true;
    paletteColors(artUrl).then((cols) => {
      if (!alive || !amRef.current) return;
      if (cols) { try { amRef.current.registerGradient('album', { bgColor: 'transparent', colorStops: cols }); amRef.current.gradient = 'album'; } catch { /* keep current */ } }
      else amRef.current.gradient = 'classic';
    });
    return () => { alive = false; };
  }, [artUrl, cfg.gradient, state]);
  // Smoothing changes apply live to the running analyser.
  useEffect(() => { if (amRef.current && cfg.smoothing != null) amRef.current.smoothing = cfg.smoothing; }, [cfg.smoothing]);


  return (
    <div className="viz" ref={boxRef}>
      <div ref={stageRef} className="viz-stage" />
      {state === 'error' && <div className="viz-msg">The visualizer could not start here.</div>}
      {calibrate && !local && (
        <Calibrate player={player} device={calibrate} shadow={shadow} reported={reported}
          onDone={(v) => onCalibrated?.(v)} onClose={() => onCalibrateClose?.()} />
      )}
    </div>
  );
}
