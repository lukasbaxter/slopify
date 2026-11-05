// Per-account settings (profile picture aside, which lives on the Jellyfin
// user itself): playback quality and the app theme. Stored in Jellyfin's
// DisplayPreferences for client "conduit", so they follow the account to any
// device; pushed live to the account's other open clients over the relay.

import { t, N_ } from '../i18n.js';

export const QUALITIES = [
  { id: 'original', label: N_('Lossless (original file)'), hint: N_('FLAC / whatever was ripped. Bit-perfect; phones stream it as Apple Lossless.') },
  { id: 'high', label: N_('Very high (320 kbps)'), hint: N_('MP3 transcode. Good for a phone on data.'), bitrate: 320000 },
  { id: 'normal', label: N_('Normal (160 kbps)'), bitrate: 160000 },
  { id: 'low', label: N_('Low (96 kbps)'), bitrate: 96000 },
];

// Crossfade lengths offered (seconds; 0 = off), as Spotify's slider runs 0-12.
export const CROSSFADES = [0, 1, 2, 3, 5, 8, 12];
export const crossfadeLabel = (sec) => { const n = Number(sec) || 0; return n ? (n === 1 ? t('1 second') : t('{n} seconds', { n })) : t('Off'); };

// The four colours that define the look; everything else is derived.
export const DEFAULT_THEME = { accent: '#1ed760', bg: '#121212', surface: '#1f1f1f', fg: '#ffffff' };

export const THEME_PRESETS = [
  { name: 'Spotify', theme: DEFAULT_THEME },
  { name: N_('Midnight'), theme: { accent: '#4c8dff', bg: '#0b1020', surface: '#151d33', fg: '#ffffff' } },
  { name: N_('Ember'), theme: { accent: '#ff7a3d', bg: '#151010', surface: '#241a18', fg: '#fff5ee' } },
  { name: N_('Orchid'), theme: { accent: '#c77dff', bg: '#120f18', surface: '#1e1826', fg: '#ffffff' } },
  { name: N_('Mono'), theme: { accent: '#ffffff', bg: '#000000', surface: '#161616', fg: '#ffffff' } },
  { name: N_('Paper'), theme: { accent: '#1a7f4b', bg: '#f4f1ea', surface: '#ffffff', fg: '#141414' } },
];

const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
function hexToRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbToHex([r, g, b]) { return `#${[r, g, b].map((x) => clamp(x).toString(16).padStart(2, '0')).join('')}`; }
function mix(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(A.map((x, i) => x + (B[i] - x) * t)); }
function isLight(hex) { const [r, g, b] = hexToRgb(hex); return (r * 299 + g * 587 + b * 114) / 1000 > 140; }
function luminance(hex) { const [r, g, b] = hexToRgb(hex).map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; }
function contrast(a, b) { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); }
// The label for something filled with this colour: whichever of black and white reads.
const inkOn = (hex) => (contrast(hex, '#000000') >= contrast(hex, '#ffffff') ? '#000000' : '#ffffff');

/** Push a theme into the CSS variables the whole app is painted from. */
export function applyTheme(theme) {
  // A colour that is not a colour (a hand-edited pref, an old client) falls
  // back to the default one; a throw here used to unmount the whole app.
  const t = { ...DEFAULT_THEME };
  for (const k of Object.keys(DEFAULT_THEME)) if (theme && hexToRgb(theme[k])) t[k] = theme[k];
  const s = document.documentElement.style;
  const light = isLight(t.bg);
  const fgDim = mix(t.fg, t.bg, light ? .28 : .3);
  const set = (k, v) => s.setProperty(k, v);
  // The accent is also text (the playing song, links). On a light page it has
  // to read on a hovered row too, so a pale one is taken darker until it does.
  let accent = t.accent;
  if (light) for (let i = 0; i < 12 && contrast(accent, mix(t.bg, t.fg, .2)) < 4.5; i++) accent = mix(accent, '#000000', .1);
  set('--accent', accent);
  set('--accent-hover', mix(accent, light ? '#000000' : '#ffffff', .12));
  set('--accent-press', mix(accent, '#000000', .12));
  set('--seek-accent', accent);
  set('--on-accent', inkOn(accent));
  set('--on-fg', inkOn(t.fg));
  set('--bg-base', t.bg);
  set('--bg-highlight', t.surface);
  set('--bg-elevated', t.surface);
  set('--bg-elevated-hi', mix(t.surface, t.fg, .08));
  set('--card', mix(t.bg, t.surface, .5));
  set('--card-hover', mix(t.surface, t.fg, .06));
  set('--tint', light ? '#0000001a' : '#ffffff1a');
  set('--tint-hi', light ? '#00000024' : '#ffffff24');
  set('--tint-press', light ? '#00000036' : '#ffffff36');
  set('--fg', t.fg);
  set('--fg-dim', fgDim);
  set('--fg-chrome', fgDim);
  set('--fg-rgb', hexToRgb(t.fg).join(','));
  // The theme's own ink, for a sheet that opens inside a dark place and has to get it back.
  set('--theme-fg', t.fg);
  set('--theme-fg-rgb', hexToRgb(t.fg).join(','));
  set('--theme-fg-dim', fgDim);
  set('--theme-on-fg', inkOn(t.fg));
  set('--fg-sub', light ? fgDim : '#a7a7a7');
  set('--fg-faint', light ? fgDim : '#727272');
  set('--black', light ? '#e6e3dc' : '#000');
  // Fixed greys from the dark design, as tokens: same values on a dark theme.
  set('--page', light ? t.bg : '#121212');
  set('--page-rgb', light ? hexToRgb(t.bg).join(',') : '18,18,18');
  set('--chip', light ? mix(t.surface, t.fg, .08) : '#2a2a2a');
  set('--field', light ? mix(t.surface, t.fg, .05) : '#1f1f1f');
  set('--sheet', light ? t.surface : '#282828');
  set('--green', light ? accent : '#1ed760');
  set('--danger', light ? '#b3261e' : '#f3727f');
  set('--danger-bg', light ? '#fbe4e2' : '#2a1618');
  s.colorScheme = light ? 'light' : 'dark';
  document.documentElement.dataset.light = light ? '1' : '';
}

export function themeEquals(a, b) {
  const A = { ...DEFAULT_THEME, ...(a || {}) }, B = { ...DEFAULT_THEME, ...(b || {}) };
  return ['accent', 'bg', 'surface', 'fg'].every((k) => A[k].toLowerCase() === B[k].toLowerCase());
}
