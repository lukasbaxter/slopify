// Runs the web's own colour code (web/src/api/colors.js, prefs.js, and the
// clampLightness / heroTint / phoneHero / blurhashAverage functions from the
// JSX files) on fixed inputs and prints the expected values as JSON. The Swift
// tests in SlopifyTests/Design/ArtworkColorTests.swift and ThemeTests.swift use
// these numbers. Re-run after a web colour change:
//   node ios/tools/color-fixtures.mjs > ios/SlopifyTests/Design/ColorFixtures.json
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const web = path.resolve(here, '../../web/src');
const read = (p) => fs.readFileSync(path.join(web, p), 'utf8');

// Pull one top-level function out of a source file by brace matching.
function extract(src, name) {
  const i = src.search(new RegExp(`(export )?function ${name}\\(`));
  if (i < 0) throw new Error(`no ${name}`);
  let j = src.indexOf('{', src.indexOf(')', i)), depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1).replace(/^export /, '');
  }
  throw new Error(`unbalanced ${name}`);
}

// --- deterministic pixel sets (40x40 RGBA) -----------------------------------
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function pixels(kind, seed) {
  const r = rng(seed), out = new Array(40 * 40 * 4);
  for (let p = 0; p < 1600; p++) {
    let c;
    if (kind === 'noise') c = [r() * 256, r() * 256, r() * 256];
    else if (kind === 'red-on-black') c = p % 5 === 0 ? [200 + r() * 40, 30 + r() * 20, 40 + r() * 20] : [r() * 10, r() * 10, r() * 10];
    else if (kind === 'blue-gradient') c = [20, 40 + (p % 40) * 3, 120 + Math.floor(p / 40) * 3];
    else if (kind === 'grey') c = [128 + r() * 8, 128 + r() * 8, 128 + r() * 8];
    else if (kind === 'white') c = [250, 250, 250];
    else if (kind === 'two-tone') c = p < 900 ? [230, 180, 40] : [40, 90, 200];
    out[p * 4] = Math.floor(c[0]); out[p * 4 + 1] = Math.floor(c[1]); out[p * 4 + 2] = Math.floor(c[2]); out[p * 4 + 3] = 255;
  }
  return out;
}
const sets = { noise: pixels('noise', 1), redOnBlack: pixels('red-on-black', 2), blueGradient: pixels('blue-gradient', 3), grey: pixels('grey', 4), white: pixels('white', 5), twoTone: pixels('two-tone', 6) };

// --- run colors.js with a fake canvas that hands back our pixels -------------
let current = null;
globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: current }) }) }) };
globalThis.Image = class { set src(v) { this._src = v; setTimeout(() => this.onload(), 0); } };
const colors = await import(url.pathToFileURL(path.join(web, 'api/colors.js')).href);
const vibrant = {}, palette = {};
for (const [k, px] of Object.entries(sets)) {
  current = px; vibrant[k] = await colors.vibrantColor(`fixture:${k}`);
  // paletteColors samples 48x48; repeat the 40x40 set to fill it.
  current = Array.from({ length: 48 * 48 * 4 }, (_, i) => px[i % px.length]); palette[k] = await colors.paletteColors(`fixture:${k}`);
}

// --- JSX helpers ------------------------------------------------------------
const playerSrc = read('components/Player.jsx'), libSrc = read('components/Library.jsx');
const fns = new Function(`${extract(playerSrc, 'clampLightness')}
const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
${extract(libSrc, 'blurhashAverage')}
${extract(libSrc, 'heroTint')}
${extract(libSrc, 'hexRgb')}
${extract(libSrc, 'phoneHero')}
return { clampLightness, blurhashAverage, heroTint, phoneHero };`)();

// What the browser paints for `color-mix(in srgb, hsl(H S% L%) 55%, #121212)` (CSS Color 4).
function cssHsl(h, s, l) {
  s /= 100; l /= 100;
  const f = (n) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((v) => v * 255);
}
function paint(css) {
  const m = /color-mix\(in srgb, hsl\((\d+) (\d+)% (\d+)%\) 55%, #121212\)/.exec(css);
  if (!m) return css;
  const rgb = cssHsl(+m[1], +m[2], +m[3]).map((c) => Math.round(c * 0.55 + 18 * 0.45));
  return '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
}

const clampInputs = [[0, 0, 0], [255, 255, 255], [10, 20, 30], [200, 30, 40], [120, 60, 200], [60, 70, 70], [250, 240, 10], [30, 215, 96]];
const clamp = clampInputs.map((rgb) => ({ in: rgb, out: fns.clampLightness(rgb) }));
const heroInputs = [[0, 0, 0], [255, 255, 255], [10, 20, 30], [200, 30, 40], [120, 60, 200], [60, 70, 70], [250, 240, 10], [30, 215, 96], [128, 129, 128]];
const hero = heroInputs.map((rgb) => ({ in: rgb, css: fns.heroTint(rgb, true), hex: paint(fns.heroTint(rgb, true)) }));
const phoneHero = ['#e8115b', '#1e3264', '#8d67ab', '#e13300', '#148a08', '#0d73ec', '#7d4b32', '#ba5d07', '#5038a0', '#3d3c3c']
  .map((hex) => ({ in: hex, hex: paint(fns.phoneHero(hex)) }));
const blurhash = ['LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'L6PZfSi_.AyE_3t7t7R**0o#DgR4', 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH', 'xx'].map((h) => ({ in: h, out: fns.blurhashAverage(h) }));

// --- prefs.js applyTheme with a fake document --------------------------------
let prefsSrc = read('api/prefs.js').replace(/^import .*$/gm, '').replace(/\bN_\(/g, '((s)=>s)(').replace(/\bt\(/g, '((s)=>s)(');
const vars = {};
globalThis.document = { documentElement: { style: { setProperty: (k, v) => { vars[k] = v; } }, dataset: {} } };
const prefs = await import('data:text/javascript;base64,' + Buffer.from(prefsSrc).toString('base64'));
const themeInputs = [...prefs.THEME_PRESETS.map((p) => ({ name: p.name, theme: p.theme })),
  { name: 'custom-light-pale-accent', theme: { accent: '#ffe066', bg: '#fafafa', surface: '#ffffff', fg: '#202020' } },
  { name: 'custom-bad-keys', theme: { accent: 'nope', bg: '#203040', surface: '#123', fg: '#eeeeee' } }];
const themes = themeInputs.map(({ name, theme }) => {
  for (const k of Object.keys(vars)) delete vars[k];
  prefs.applyTheme(theme);
  return { name, theme, vars: { ...vars }, colorScheme: document.documentElement.style.colorScheme, light: document.documentElement.dataset.light === '1' };
});

console.log(JSON.stringify({ sets, vibrant, palette, clamp, hero, phoneHero, blurhash, themes }));
