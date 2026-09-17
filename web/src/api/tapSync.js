// The maths behind the speaker calibration (src/components/Calibrate.jsx):
// given onset frames from the shadow stream and the user's taps, find the
// speaker's delay. Plain JS so it can be tested outside the browser.
export const MIN_TAPS = 8;

/**
 * The lag L that best explains the taps: score(L) = how much onset energy sits
 * at (tap - L) for every tap. `coarse`, when known, restricts the search to
 * the lags a reaction tap allows (the true lag is a little BEFORE it, never
 * after), which is what breaks the beat's periodic ambiguity.
 */
export function solveLag(framesIn, taps, coarse) {
  const frames = framesIn.slice().sort((a, b) => a.t - b.t);
  const N = frames.length;
  if (N < 100 || taps.length < MIN_TAPS) return null;
  const t = Float64Array.from(frames, (x) => x.t), raw = Float64Array.from(frames, (x) => x.f);
  // Take out what is sustained: onset = flux above its local (±0.4 s) mean.
  const dt = (t[N - 1] - t[0]) / (N - 1) || 0.01;
  const w = Math.max(1, Math.round(0.4 / dt));
  const pre = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) pre[i + 1] = pre[i] + raw[i];
  const o = new Float64Array(N);
  let max = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - w), b = Math.min(N, i + w + 1);
    o[i] = Math.max(0, raw[i] - (pre[b] - pre[a]) / (b - a));
    if (o[i] > max) max = o[i];
  }
  if (!max) return null;
  for (let i = 0; i < N; i++) o[i] /= max;
  // Onset energy near a track time, weighted by a 25 ms Gaussian (tap jitter).
  const sigma = 0.025;
  const near = (x) => {
    const from = x - 3 * sigma, to = x + 3 * sigma;
    let lo = 0, hi = N;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < from) lo = m + 1; else hi = m; }
    let s = 0;
    for (let i = lo; i < N && t[i] <= to; i++) { const d = (t[i] - x) / sigma; s += o[i] * Math.exp(-0.5 * d * d); }
    return s;
  };
  const t0 = t[0], t1 = t[N - 1];
  // Mean onset energy over the taps that fall inside the recording at this lag.
  const score = (L) => {
    let s = 0, n = 0;
    for (const tp of taps) { const x = tp - L; if (x < t0 || x > t1) continue; s += near(x); n++; }
    return n >= taps.length / 2 ? s / n : -1;
  };
  const step = 0.005;
  const scan = (lo, hi, weight = () => 1) => {
    let best = { L: 0, s: -Infinity }, sum = 0, n = 0;
    for (let L = lo; L <= hi + 1e-9; L += step) {
      const s = score(L); if (s < 0) continue;
      sum += s; n++;
      if (s * weight(L) > best.s) best = { L, s: s * weight(L), raw: s };
    }
    return { best, mean: n ? sum / n : 0 };
  };
  const wide = scan(-3, 3);
  // A reaction tap lands after the sound, never before, so the lag sits below
  // the coarse figure by one reaction time: typically ~0.2 s, rarely outside
  // 0.1-0.4. The search covers that spread and, when a fast tempo leaves two
  // beats inside it, leans to the one implying a typical reaction.
  const reaction = (L) => { const d = (coarse - 0.2 - L) / 0.15; return Math.exp(-0.5 * d * d); };
  const pick = coarse != null ? scan(coarse - 0.5, coarse + 0.08, reaction).best : wide.best;
  if (!Number.isFinite(pick.s)) return null;
  const quality = wide.mean > 0 ? (pick.raw ?? pick.s) / wide.mean : 0;
  return { offset: Math.round(pick.L * 1000) / 1000, quality, taps: taps.length };
}

