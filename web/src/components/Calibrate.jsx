import React, { useEffect, useRef, useState } from 'react';
import { solveLag } from '../api/tapSync.js';

// Speaker timing calibration for the visualizer.
//
// A speaker tells us the position it is decoding, not the position that is
// coming out of it; the gap is its output buffer and neither Cast nor BluOS
// reports it. The person listening can measure it, so this asks them to tap:
//
//   1. Conduit pauses, jumps ahead and plays. Tap when the music comes back.
//      That is a reaction, so it lands a little after the truth, but it pins
//      the delay to within a fraction of a second (the coarse estimate).
//   2. Tap along to the beat for a while. Taps to a beat are anticipatory and
//      land within tens of milliseconds of it, but a beat repeats, so on their
//      own they cannot say WHICH beat; step 1 settles that.
//
// The silent shadow stream that feeds the bars is analysed for onsets (spectral
// flux) with its own track time attached, the taps are stamped with the
// position the speaker REPORTED at that instant, and the lag that lines them
// up is the speaker's delay. Nothing is assumed about the device, no
// microphone is involved, and the number is stored per speaker on the relay
// so everyone in the house gets it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BEAT_SECONDS = 12;     // how long the tap-along phase runs

/**
 * Onset strength per frame from the shadow stream: half-wave rectified
 * spectral flux below 8 kHz, ~100 frames a second, each stamped with the
 * stream's own track time.
 */
function startRecorder(shadow) {
  const sh = shadow();
  if (!sh) return null;
  const an = sh.ctx.createAnalyser();
  an.fftSize = 1024; an.smoothingTimeConstant = 0;
  sh.source.connect(an);
  const n = an.frequencyBinCount, cur = new Uint8Array(n), prev = new Uint8Array(n);
  const top = Math.min(n, Math.ceil(8000 / (sh.ctx.sampleRate / an.fftSize)));
  const frames = [];
  let havePrev = false;
  const timer = setInterval(() => {
    if (sh.loading || sh.paused) { havePrev = false; return; }
    an.getByteFrequencyData(cur);
    if (havePrev) {
      let f = 0;
      for (let k = 1; k < top; k++) { const d = cur[k] - prev[k]; if (d > 0) f += d; }
      frames.push({ t: sh.position, f });
    }
    prev.set(cur); havePrev = true;
  }, 10);
  return { frames, stop() { clearInterval(timer); try { sh.source.disconnect(an); } catch { /* already gone */ } } };
}

export default function Calibrate({ player, device, shadow, reported, onDone, onClose }) {
  const [phase, setPhase] = useState('intro'); // intro | jump | ready | beat | result | failed
  const [round, setRound] = useState(0);
  const [msg, setMsg] = useState('');
  const [count, setCount] = useState(0);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [pulse, setPulse] = useState(0);
  const phaseRef = useRef('intro'); phaseRef.current = phase;
  const playingRef = useRef(false); playingRef.current = !!player.playing;
  const coarseRef = useRef([]);
  const jumpRef = useRef(null);   // { target, armed, at }
  const tapsRef = useRef([]);
  const recRef = useRef(null);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; recRef.current?.stop(); }, []);

  const flash = () => setPulse((p) => p + 1);

  // Step 1: pause, wait, jump ahead and play. The tap that follows is timed
  // against the position the speaker reports at that instant.
  const jump = async () => {
    setPhase('jump'); setMsg('');
    const dur = player.duration || 0;
    let target = Math.round(reported() + 6);
    if (dur && target > dur - 25) target = Math.max(0, Math.round(reported()) - 30);
    jumpRef.current = { target, armed: false, at: 0 };
    if (playingRef.current) await player.toggle();
    await sleep(1400 + Math.random() * 900);
    if (!aliveRef.current) return;
    await player.seek(target);
    jumpRef.current = { target, armed: true, at: Date.now() };
    // Devices that stay paused across a seek (Cast) need the play as well;
    // BluOS plays from the seek itself and will have reported so by now.
    setTimeout(() => { if (aliveRef.current && !playingRef.current && phaseRef.current === 'jump') player.toggle(); }, 1500);
  };

  const beat = async () => {
    setPhase('ready'); setMsg(''); setCount(0); setProgress(0);
    recRef.current?.stop();
    recRef.current = startRecorder(shadow);
    tapsRef.current = [];
    await sleep(2500);
    if (!aliveRef.current) return;
    setPhase('beat');
    const started = Date.now();
    const timer = setInterval(() => {
      const p = Math.min(1, (Date.now() - started) / (BEAT_SECONDS * 1000));
      setProgress(p);
      if (p >= 1) {
        clearInterval(timer);
        const rec = recRef.current; rec?.stop(); recRef.current = null;
        const cs = coarseRef.current.slice().sort((a, b) => a - b);
        const coarse = cs.length ? cs[cs.length >> 1] : null;
        const r = solveLag(rec?.frames || [], tapsRef.current, coarse);
        if (!aliveRef.current) return;
        if (!r || r.quality < 1.6) { setResult(r); setPhase('failed'); return; }
        setResult(r); setPhase('result');
        onDone?.(r.offset);
      }
    }, 100);
  };

  const tap = () => {
    const now = Date.now();
    const ph = phaseRef.current;
    if (ph === 'intro') { if (playingRef.current) jump(); return; }
    if (ph === 'jump') {
      const j = jumpRef.current;
      if (!j?.armed || !playingRef.current) { setMsg('Too early, wait for the music.'); return; }
      const d = reported(now) - j.target;
      if (d < 0.05) { setMsg('Too early, wait for the music.'); return; }
      if (d > 4) { setMsg('That was late. Tap the moment you hear it.'); return; }
      flash();
      coarseRef.current.push(d);
      const cs = coarseRef.current;
      // Two rounds that agree, or three and take the middle one.
      const again = cs.length < 2 || (cs.length === 2 && Math.abs(cs[0] - cs[1]) > 0.35);
      if (again) { setRound(cs.length); setMsg('Good.'); sleep(1500).then(() => { if (aliveRef.current && phaseRef.current === 'jump') jump(); }); }
      else beat();
      return;
    }
    if (ph === 'beat') { flash(); tapsRef.current.push(reported(now)); setCount(tapsRef.current.length); }
  };

  const restart = () => { coarseRef.current = []; tapsRef.current = []; setRound(0); setResult(null); setMsg(''); jump(); };

  // Space/Enter tap (grabbed before the app's play/pause shortcut), Escape leaves.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose?.(); return; }
      if (e.code !== 'Space' && e.key !== 'Enter') return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) tap();
    };
    const onUp = (e) => { if (e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); } };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onUp, true); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const name = device?.name || 'this speaker';
  const fmt = (v) => `${v > 0 ? '+' : ''}${(v * 1000).toFixed(0)} ms`;
  const stop = (e) => e.stopPropagation();
  return (
    <div className="cal" onPointerDown={(e) => { if (e.button === 0) tap(); }} role="dialog" aria-label={`Calibrate ${name}`}>
      <div className="cal-card">
        <div className="cal-title">Calibrate {name}</div>
        {phase === 'intro' && (
          <>
            <p className="cal-text">Speakers play a little behind what they report, so the bars can run ahead of the sound. Two quick steps measure {name}'s delay so the visualizer lines up.</p>
            <ol className="cal-steps">
              <li>Conduit pauses and jumps ahead. <b>Tap the moment you hear the music.</b> (Twice.)</li>
              <li><b>Tap along to the beat</b> for {BEAT_SECONDS} seconds.</li>
            </ol>
            <p className="cal-text muted">Tap anywhere, or press Space. No microphone is used.</p>
            {!player.playing && <p className="cal-text warn">Start playing on {name} first.</p>}
            <div className="cal-btns" onPointerDown={stop}>
              <button className="cal-btn" disabled={!player.playing} onClick={jump}>Start</button>
              <button className="cal-btn ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
        {phase === 'jump' && (
          <>
            <div className="cal-step">Step 1 of 2 · {round + 1}</div>
            <div className={`cal-pad ${pulse % 2 ? 'a' : 'b'}`} key={pulse}><span>Tap when you hear the music</span></div>
            <p className="cal-text muted">{msg || 'Listen…'}</p>
            <div className="cal-btns" onPointerDown={stop}><button className="cal-btn ghost" onClick={onClose}>Cancel</button></div>
          </>
        )}
        {(phase === 'beat' || phase === 'ready') && (
          <>
            <div className="cal-step">Step 2 of 2</div>
            <div className={`cal-pad ${phase === 'ready' ? 'wait' : pulse % 2 ? 'a' : 'b'}`} key={pulse}><span>{phase === 'ready' ? 'Get ready…' : 'Tap along to the beat'}</span></div>
            <div className="cal-bar"><div style={{ width: `${progress * 100}%` }} /></div>
            <p className="cal-text muted">{phase === 'ready' ? 'Next: tap on every beat.' : `${count} tap${count === 1 ? '' : 's'}`}</p>
            <div className="cal-btns" onPointerDown={stop}><button className="cal-btn ghost" onClick={onClose}>Cancel</button></div>
          </>
        )}
        {phase === 'result' && result && (
          <>
            <div className="cal-big">{fmt(result.offset)}</div>
            <p className="cal-text">{name} plays {Math.abs(result.offset * 1000).toFixed(0)} ms {result.offset >= 0 ? 'behind' : 'ahead of'} what it reports. The visualizer now uses this.</p>
            <p className="cal-text muted">Lock {result.quality >= 2.5 ? 'strong' : 'okay'} · {result.taps} taps</p>
            <div className="cal-btns" onPointerDown={stop}>
              <button className="cal-btn" onClick={onClose}>Looks right</button>
              <button className="cal-btn ghost" onClick={restart}>Try again</button>
            </div>
          </>
        )}
        {phase === 'failed' && (
          <>
            <p className="cal-text">Couldn't lock on to the beat{result ? ` (${result.taps} taps)` : ''}. Pick a part of the song with a clear beat and tap on every beat.</p>
            <div className="cal-btns" onPointerDown={stop}>
              <button className="cal-btn" onClick={restart}>Try again</button>
              <button className="cal-btn ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
