import React, { useEffect, useRef, useState } from 'react';
import { paletteColors } from '../api/colors.js';
import Calibrate from './Calibrate.jsx';
import { createShadow } from '../api/shadowStream.js';

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
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctx();
  sharedCtx.resume?.().catch(() => {});
  return sharedCtx;
}

export const EQ_STYLES = [
  // "Line": Feishin's default preset (mode 10 line graph, 1.9px, prism, faint reflection).
  { id: 'line', name: 'Line', opts: { mode: 10, lineWidth: 1.9, fillAlpha: 0, barSpace: .7, reflexRatio: .5, reflexAlpha: .1, reflexBright: 1, showPeaks: false, ledBars: false, lumiBars: false, radial: false, mirror: 0, smoothing: .6, fftSize: 16384, maxFreq: 22050, minFreq: 20, gravity: 11, linearBoost: 4, maxDecibels: -25, minDecibels: -85 } },
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
  const reported = (at = Date.now()) => { const c = clockRef.current; return c.pos + (c.playing ? (at - c.at) / 1000 : 0); };
  useEffect(() => {
    if (!active || local) { shadowRef.current?.stop(); return undefined; }
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
      sh.id = trackId;
      sh.load(jf.transcodeUrl(trackId, { codec: 'mp3', bitrate: 192000, startAt: at }), at);
    };
    sh.onPlaying(() => {
      // Behind at start-up (drift < 0) means ask further ahead next time.
      const drift = sh.position - want();
      sh.lead = Math.min(3, Math.max(0.2, sh.lead - drift));
    });
    const tick = () => {
      const c = clockRef.current;
      if (!c.playing) { if (!sh.paused) sh.stop(); return; }
      if (sh.ctx.state !== 'running') { sh.ctx.resume?.().catch(() => {}); return; } // never started before the unlock
      if (sh.id !== trackId || sh.paused) { load(); return; }
      if (sh.loading) return;
      const drift = sh.position - want();
      if (Math.abs(drift) > 0.6) load();
    };
    // A new offset is a jump, not drift: restart the stream at the new spot.
    if (sh.offset !== offsetRef.current) { sh.offset = offsetRef.current; sh.id = null; }
    tick();
    const t = setInterval(tick, 250);
    return () => { clearInterval(t); sh.onPlaying(null); };
  }, [active, local, trackId, player.playing, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  const graph = () => { const wa = local ? player.webAudio() : shadow(); wa?.ctx?.resume?.(); return wa; };

  // Graphic EQ engine.
  useEffect(() => {
    if (!active) return undefined;
    let alive = true, offSource = null;
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
          minFreq: 30, maxFreq: 16000, weightingFilter: 'D', maxFPS: 60,
          ...style.opts, gradient: cfg.gradient === 'album' ? 'classic' : cfg.gradient, smoothing: cfg.smoothing ?? style.opts.smoothing ?? .6,
        });
        amRef.current = am;
        // Local playback re-captures the element on every new track: follow it.
        if (wa.onSource) offSource = wa.onSource((next, prev) => { try { if (prev) am.disconnectInput(prev); } catch { /* not connected */ } try { am.connectInput(next); } catch { /* ignore */ } });
        if (window.location.search.includes('debug')) window.__vizAm = am;
        setState('ready');
      } catch (e) { if (alive) { console.error('visualizer', e); setState('error'); } }
    })();
    return () => { alive = false; offSource?.(); try { amRef.current?.destroy(); } catch {} amRef.current = null; };
  }, [active, local, style.id, cfg.gradient]); // eslint-disable-line react-hooks/exhaustive-deps
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
