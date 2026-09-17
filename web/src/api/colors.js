// Cover colour the way Spotify picks it: not the average (a night-time photo
// averages to grey) but the most PROMINENT saturated colour. Pixels are
// binned coarsely, each bin scored by population x saturation, and mid-tones
// are favoured so the header stays readable under white text.
//
// The image is drawn on a canvas, so it needs to be CORS-readable: same-origin
// through the /jf proxy in the browser, `Access-Control-Allow-Origin: *` from
// Jellyfin for the desktop. If the canvas is tainted we fall back to null and
// the caller keeps the blurhash average.
const cache = new Map();

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

export function vibrantColor(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return cache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const N = 40;
        const c = document.createElement('canvas'); c.width = N; c.height = N;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        const bins = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const [, s, l] = rgbToHsl(r, g, b);
          if (l < .08 || l > .92) continue;               // near-black / near-white: no
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0, s: 0, l: 0 };
          e.n++; e.r += r; e.g += g; e.b += b; e.s += s; e.l += l;
          bins.set(key, e);
        }
        let best = null, bestScore = -1;
        for (const e of bins.values()) {
          const s = e.s / e.n, l = e.l / e.n;
          const mid = l > .2 && l < .75 ? 1 : .35;
          const score = e.n * (.15 + s) * mid;
          if (score > bestScore) { bestScore = score; best = e; }
        }
        resolve(best ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : null);
      } catch { resolve(null); } // tainted canvas
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  cache.set(url, p);
  return p;
}

// Three colours from a cover for a gradient: the prominent one plus the two
// next most prominent bins that sit far enough away in hue to read as
// different colours. A cover with one dominant colour gets lighter / darker
// shifts of it instead, so the gradient is never three of the same swatch.
const pcache = new Map();
export function paletteColors(url) {
  if (!url) return Promise.resolve(null);
  if (pcache.has(url)) return pcache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const N = 48;
        const c = document.createElement('canvas'); c.width = N; c.height = N;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        const bins = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const [h, s, l] = rgbToHsl(r, g, b);
          if (l < .08 || l > .94) continue;
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0, h: 0, s: 0, l: 0 };
          e.n++; e.r += r; e.g += g; e.b += b; e.h += h; e.s += s; e.l += l;
          bins.set(key, e);
        }
        const ranked = [...bins.values()].map((e) => ({ rgb: [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)], h: e.h / e.n, s: e.s / e.n, l: e.l / e.n, score: e.n * (.15 + e.s / e.n) * (e.l / e.n > .2 && e.l / e.n < .8 ? 1 : .35) }))
          .sort((a, b) => b.score - a.score);
        const out = [];
        const hueDist = (a, b) => { const x = Math.abs(a - b); return Math.min(x, 1 - x); };
        for (const e of ranked) {
          if (out.length >= 3) break;
          if (out.every((o) => hueDist(o.h, e.h) > .08 || Math.abs(o.l - e.l) > .3) && e.s > .12) out.push(e);
        }
        if (!out.length) { resolve(null); return; }
        // Fill up with shifts of the prominent colour.
        const shift = (e, dl) => { const l = Math.max(.15, Math.min(.85, e.l + dl)); return { rgb: hslToRgb(e.h, Math.max(e.s, .35), l), h: e.h, s: e.s, l }; };
        while (out.length < 3) out.push(shift(out[0], out.length === 1 ? .22 : -.22));
        // Light to dark: audioMotion paints stop 0 at the top of the bars.
        out.sort((a, b) => b.l - a.l);
        // The bars sit on a darkened blur of the same cover, so a dark palette
        // (a night-time or sepia sleeve) vanished into it: lift every stop to
        // a readable lightness and give it enough saturation to stay a colour.
        // Softened: saturation held in a pastel-ish band, never neon.
        const floor = [.66, .54, .42];
        const lifted = out.map((e, i) => ({ h: e.h, s: Math.min(.62, Math.max(e.s, .38)), l: Math.max(e.l, floor[i]) }));
        resolve(lifted.map((e) => `rgb(${hslToRgb(e.h, e.s, e.l).join(',')})`));
      } catch (e) { console.warn('palette failed', e); resolve(null); }
    };
    img.onerror = () => { console.warn('palette image failed', url); resolve(null); };
    img.src = url;
  });
  pcache.set(url, p);
  return p;
}

function hslToRgb(h, s, l) {
  const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}
