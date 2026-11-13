import React, { useEffect, useRef, useState } from 'react';
import { paletteColors } from '../api/colors.js';
import Calibrate from './Calibrate.jsx';
import { createShadow } from '../api/shadowStream.js';
import { ROUTES_WEB_AUDIO } from '../player/usePlayer.js';
import { t, N_ } from '../i18n.js';

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

// Clean and glassy (owner, 11-13): thin lines, faint fills, no LEDs or spinning.
export const EQ_STYLES = [
  // "Line": Feishin's default preset (mode 10 line graph, 1.9px, prism, faint reflection).
  { id: 'line', name: N_('Line'), opts: { mode: 10, lineWidth: 1.9, fillAlpha: 0, barSpace: .7, reflexRatio: .5, reflexAlpha: .1, reflexBright: 1, showPeaks: false, ledBars: false, lumiBars: false, radial: false, mirror: 0, smoothing: .6, fftSize: 8192, maxFreq: 22050, minFreq: 20, gravity: 11, linearBoost: 4, maxDecibels: -25, minDecibels: -85 } },
  { id: 'mirror', name: N_('Mirror'), opts: { mode: 4, ledBars: false, barSpace: .2, reflexRatio: .5, reflexAlpha: .25, showPeaks: false, radial: false, mirror: -1, fillAlpha: 1, lineWidth: 0 } },
  // Glass panes: outlined, a faint fill that grows with the level.
  { id: 'glass', name: N_('Glass bars'), opts: { mode: 3, outlineBars: true, alphaBars: true, roundBars: false, lineWidth: 1.2, fillAlpha: .22, barSpace: .45, reflexRatio: .25, reflexAlpha: .12, reflexBright: 1, showPeaks: false, ledBars: false, lumiBars: false, radial: false, mirror: 0, channelLayout: 'mono' } },
  // Left and right side by side, bass meeting in the middle: how wide the mix is.
  { id: 'stereo', name: N_('Stereo'), opts: { mode: 10, channelLayout: 'dual-horizontal', lineWidth: 1.6, fillAlpha: .14, reflexRatio: .35, reflexAlpha: .1, reflexBright: 1, showPeaks: false, ledBars: false, lumiBars: false, radial: false, mirror: 0, smoothing: .65, fftSize: 8192 } },
  // A still ring: the line graph bent into a circle.
  { id: 'halo', name: N_('Halo'), opts: { mode: 10, radial: true, radius: .38, spinSpeed: 0, mirror: -1, frequencyScale: 'log', fftSize: 4096, minFreq: 30, maxFreq: 16000, lineWidth: 1.4, fillAlpha: .1, reflexRatio: 0, showPeaks: false, ledBars: false, lumiBars: false, channelLayout: 'mono', smoothing: .78 } },
  // Drawn here (DRAWERS) from audioMotion's 1/6-octave bands: smooth shapes, soft glow.
  { id: 'aurora', name: N_('Aurora'), opts: { useCanvas: false, mode: 4, minFreq: 30, maxFreq: 16000, smoothing: .8, channelLayout: 'mono' }, draw: 'aurora' },
  { id: 'orb', name: N_('Orb'), opts: { useCanvas: false, mode: 4, minFreq: 30, maxFreq: 16000, smoothing: .82, channelLayout: 'mono' }, draw: 'orb' },
];
// --- hand-drawn styles -------------------------------------------------------
// Both take the band levels (0..1, low to high), keep their own state between
// frames, and draw on a transparent canvas in the chosen colours.
const lerp = (a, b, t) => a + (b - a) * t;
// n points from the band levels, linearly resampled, lifted on a curve (the
// analyser's levels read low).
function resample(v, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (v.length - 1), j = Math.floor(x), f = x - j;
    out[i] = Math.pow(Math.max(0, lerp(v[j] || 0, v[Math.min(v.length - 1, j + 1)] || 0, f)), 0.75);
  }
  return out;
}
// A smooth path through points (quadratic curves through the midpoints).
function smoothPath(cx, pts, closed) {
  const n = pts.length; if (n < 2) return;
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  if (closed) {
    let m = mid(pts[n - 1], pts[0]); cx.moveTo(m[0], m[1]);
    for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n], mm = mid(p, q); cx.quadraticCurveTo(p[0], p[1], mm[0], mm[1]); }
    cx.closePath();
  } else {
    cx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n - 1; i++) { const mm = mid(pts[i], pts[i + 1]); cx.quadraticCurveTo(pts[i][0], pts[i][1], mm[0], mm[1]); }
    cx.lineTo(pts[n - 1][0], pts[n - 1][1]);
  }
}
const withAlpha = (c, a) => {
  const m = /^rgba?\(([^)]+)\)/.exec(c);
  if (m) { const [r, g, b] = m[1].split(',').map((x) => parseFloat(x)); return `rgba(${r},${g},${b},${a})`; }
  let h = c.replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const hGradient = (cx, x0, x1, colors, a) => {
  const g = cx.createLinearGradient(x0, 0, x1, 0);
  colors.forEach((c, i) => g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), withAlpha(c, a)));
  return g;
};

export const DRAWERS = {
  // Aurora: the spectrum as one smooth wave mirrored about the middle, glowing,
  // with two fainter echoes of a moment ago behind it.
  aurora(cx, w, h, levels, st, colors) {
    const N = 56, pts = resample(levels, N);
    st.hist = st.hist || []; st.hist.unshift(pts); if (st.hist.length > 14) st.hist.length = 14;
    cx.clearRect(0, 0, w, h);
    const x0 = w * 0.06, x1 = w * 0.94, mid = h * 0.5, amp = h * 0.34;
    const layer = (vals, alpha, glow, line) => {
      // Taper the ends so the wave rises out of the middle line and back.
      const top = vals.map((v, i) => { const t = i / (N - 1), edge = Math.sin(Math.PI * t); return [lerp(x0, x1, t), mid - v * amp * (0.35 + 0.65 * edge) - 1]; });
      const bot = top.map(([x, y]) => [x, mid + (mid - y)]).reverse();
      cx.save();
      cx.beginPath(); smoothPath(cx, top, false); smoothPath(cx, bot, false); cx.closePath();
      cx.fillStyle = hGradient(cx, x0, x1, colors, alpha);
      cx.shadowColor = withAlpha(colors[Math.floor(colors.length / 2)], 0.8); cx.shadowBlur = glow;
      cx.fill();
      if (line) {
        cx.shadowBlur = glow * 0.6; cx.lineWidth = 1.4; cx.strokeStyle = hGradient(cx, x0, x1, colors, 0.95);
        cx.beginPath(); smoothPath(cx, top, false); cx.stroke();
        cx.beginPath(); smoothPath(cx, bot, false); cx.stroke();
      }
      cx.restore();
    };
    cx.globalCompositeOperation = 'lighter';
    if (st.hist[13]) layer(st.hist[13], 0.06, 0, false);
    if (st.hist[6]) layer(st.hist[6], 0.1, 0, false);
    layer(pts, 0.22, 28, true);
    cx.globalCompositeOperation = 'source-over';
    // The middle line: a hairline.
    cx.fillStyle = 'rgba(255,255,255,0.08)'; cx.fillRect(x0, mid - 0.5, x1 - x0, 1);
  },

  // Orb: a soft glowing sphere that swells with the bass; its edge ripples
  // smoothly with the rest, mirrored left and right.
  orb(cx, w, h, levels, st, colors) {
    cx.clearRect(0, 0, w, h);
    const N = 36, vals = resample(levels, N);
    const bass = (vals[0] + vals[1] + vals[2] + vals[3]) / 4;
    st.bass = lerp(st.bass ?? bass, bass, 0.25);
    st.rot = ((st.rot || 0) + 0.0015) % (Math.PI * 2); // a slow drift, so the shape never sits still
    const cx0 = w / 2, cy0 = h * 0.5, base = Math.min(w, h) * 0.2, R = base * (0.92 + st.bass * 0.3);
    const P = 96, pts = [], outer = [];
    for (let k = 0; k < P; k++) {
      const a = (k / P) * Math.PI * 2;
      // Mirrored: the same band on both sides, bass at the bottom, treble on top.
      const u = Math.abs(((a + st.rot) % (Math.PI * 2)) - Math.PI) / Math.PI;
      const x = (1 - u) * (N - 1), j = Math.floor(x), f = x - j;
      const v = lerp(vals[j], vals[Math.min(N - 1, j + 1)], f);
      const r = R * (1 + v * 0.28);
      pts.push([cx0 + Math.sin(a) * r, cy0 + Math.cos(a) * r]);
      outer.push([cx0 + Math.sin(a) * (r * 1.18 + 6), cy0 + Math.cos(a) * (r * 1.18 + 6)]);
    }
    const c0 = colors[0], c1 = colors[Math.floor(colors.length / 2)], c2 = colors[colors.length - 1];
    // The glow behind it.
    cx.save();
    const glow = cx.createRadialGradient(cx0, cy0, R * 0.2, cx0, cy0, R * 2.4);
    glow.addColorStop(0, withAlpha(c1, 0.22)); glow.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = glow; cx.fillRect(0, 0, w, h);
    // The body: colour from one side to the other, deeper toward the rim.
    cx.beginPath(); smoothPath(cx, pts, true);
    const body = cx.createLinearGradient(cx0 - R, cy0 - R, cx0 + R, cy0 + R);
    body.addColorStop(0, withAlpha(c0, 0.85)); body.addColorStop(0.5, withAlpha(c1, 0.7)); body.addColorStop(1, withAlpha(c2, 0.85));
    cx.shadowColor = withAlpha(c1, 0.9); cx.shadowBlur = 50 + st.bass * 40;
    cx.fillStyle = body; cx.fill();
    cx.shadowBlur = 0;
    // Depth: darker toward the edge, a glass highlight up and to the left.
    const shade = cx.createRadialGradient(cx0, cy0, R * 0.3, cx0, cy0, R * 1.3);
    shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,0.45)');
    cx.fillStyle = shade; cx.fill();
    const hl = cx.createRadialGradient(cx0 - R * 0.35, cy0 - R * 0.4, 0, cx0 - R * 0.35, cy0 - R * 0.4, R * 0.7);
    hl.addColorStop(0, 'rgba(255,255,255,0.35)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = hl; cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.25)'; cx.lineWidth = 1; cx.stroke();
    // The halo line around it.
    cx.beginPath(); smoothPath(cx, outer, true);
    cx.strokeStyle = withAlpha(c1, 0.35); cx.lineWidth = 1.2; cx.stroke();
    cx.restore();
  },
};
const NAMED_STOPS = { prism: ['#a35', '#e94', '#9d5', '#2cb', '#09c', '#36b'], classic: ['#0f0', '#ff0', '#f00'], rainbow: ['#817', '#f00', '#f80', '#ff0', '#0c0', '#08f', '#80f'], orangered: ['#f50', '#f30'], steelblue: ['#2a7ab0', '#a9cbe0'] };

// 'album' = three colours pulled from the current cover (registered per track).
export const GRADIENTS = ['album', 'prism', 'classic', 'rainbow', 'orangered', 'steelblue'];
// Shown names of the gradients ('album' is labelled where the menu is built).
export const GRADIENT_NAMES = { prism: N_('Prism'), classic: N_('Classic'), rainbow: N_('Rainbow'), orangered: N_('Orangered'), steelblue: N_('Steelblue') };
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
  const bandColorsRef = useRef(NAMED_STOPS.prism); // the hand-drawn styles use the chosen gradient's colours
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
  const tickingRef = useRef(null); tickingRef.current = player.ticking || null;
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
      // Not heard yet (the player still loading or seeking: held, see
      // usePlayer's anchorAt): no bars until the sound is out.
      if (!c.playing || tickingRef.current?.() === false) { if (!sh.paused) sh.stop(); return; }
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
        if (style.draw && DRAWERS[style.draw]) {
          // Drawn here: audioMotion analyses, this canvas shows it.
          const canvas = document.createElement('canvas'); canvas.className = 'viz-drawn';
          stage.appendChild(canvas);
          const draw = DRAWERS[style.draw], st = {};
          am.onCanvasDraw = (inst) => {
            const dpr = window.devicePixelRatio || 1, w = stage.clientWidth, h = stage.clientHeight;
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
            const cx = canvas.getContext('2d'); cx.setTransform(dpr, 0, 0, dpr, 0, 0);
            draw(cx, w, h, inst.getBars().map((b) => b.value[0] || 0), st, bandColorsRef.current);
          };
        }
        if (IS_TV) slow = setInterval(() => { if (!document.hidden && am.isOn && am.fps > 0 && am.fps < TV_MIN_FPS && am.fftSize > TV_FFT_MIN) am.fftSize /= 2; }, 3000);
        // Local playback re-captures the element on every new track: follow it.
        if (wa.onSource) offSource = wa.onSource((next, prev) => { try { if (prev) am.disconnectInput(prev); } catch { /* not connected */ } try { am.connectInput(next); } catch { /* ignore */ } });
        if (window.location.search.includes('debug')) window.__vizAm = am;
        setState('ready');
      } catch (e) { if (alive) { console.error('visualizer', e); setState('error'); } }
    })();
    return () => { alive = false; clearInterval(slow); offSource?.(); try { amRef.current?.destroy(); } catch {} amRef.current = null; };
  }, [active, tap, style.id, cfg.gradient]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (cfg.gradient !== 'album') bandColorsRef.current = NAMED_STOPS[cfg.gradient] || NAMED_STOPS.prism; }, [cfg.gradient]);
  // "Match album art": three colours from the cover, re-registered on every track.
  const artUrl = player.nowPlaying?.artId ? jf.imageUrl(player.nowPlaying.artId, { maxHeight: 200 }) : player.nowPlaying?.artUrl || null;
  useEffect(() => {
    const am = amRef.current;
    if (!am || cfg.gradient !== 'album' || state !== 'ready') return undefined;
    let alive = true;
    paletteColors(artUrl).then((cols) => {
      if (!alive || !amRef.current) return;
      if (cols) { bandColorsRef.current = cols; try { amRef.current.registerGradient('album', { bgColor: 'transparent', colorStops: cols }); amRef.current.gradient = 'album'; } catch { /* keep current */ } }
      else amRef.current.gradient = 'classic';
    });
    return () => { alive = false; };
  }, [artUrl, cfg.gradient, state]);
  // Smoothing changes apply live to the running analyser.
  useEffect(() => { if (amRef.current && cfg.smoothing != null) amRef.current.smoothing = cfg.smoothing; }, [cfg.smoothing]);


  return (
    <div className="viz" ref={boxRef}>
      <div ref={stageRef} className="viz-stage" />
      {state === 'error' && <div className="viz-msg">{t('The visualizer could not start here.')}</div>}
      {calibrate && !local && (
        <Calibrate player={player} device={calibrate} shadow={shadow} reported={reported}
          onDone={(v) => onCalibrated?.(v)} onClose={() => onCalibrateClose?.()} />
      )}
    </div>
  );
}
