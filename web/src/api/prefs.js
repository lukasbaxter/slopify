// Per-account settings (profile picture aside, which lives on the Jellyfin
// user itself): playback quality and the app theme. Stored in Jellyfin's
// DisplayPreferences for client "conduit", so they follow the account to any
// device; pushed live to the account's other open clients over the relay.

export const QUALITIES = [
  { id: 'original', label: 'Lossless (original file)', hint: 'FLAC / whatever was ripped. Bit-perfect.' },
  { id: 'high', label: 'Very high (320 kbps)', hint: 'MP3 transcode. Good for a phone on data.', bitrate: 320000 },
  { id: 'normal', label: 'Normal (160 kbps)', bitrate: 160000 },
  { id: 'low', label: 'Low (96 kbps)', bitrate: 96000 },
];

// The four colours that define the look; everything else is derived.
export const DEFAULT_THEME = { accent: '#1ed760', bg: '#121212', surface: '#1f1f1f', fg: '#ffffff' };

export const THEME_PRESETS = [
  { name: 'Spotify', theme: DEFAULT_THEME },
  { name: 'Midnight', theme: { accent: '#4c8dff', bg: '#0b1020', surface: '#151d33', fg: '#ffffff' } },
  { name: 'Ember', theme: { accent: '#ff7a3d', bg: '#151010', surface: '#241a18', fg: '#fff5ee' } },
  { name: 'Orchid', theme: { accent: '#c77dff', bg: '#120f18', surface: '#1e1826', fg: '#ffffff' } },
  { name: 'Mono', theme: { accent: '#ffffff', bg: '#000000', surface: '#161616', fg: '#ffffff' } },
  { name: 'Paper', theme: { accent: '#1a7f4b', bg: '#f4f1ea', surface: '#ffffff', fg: '#141414' } },
];

const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
function hexToRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbToHex([r, g, b]) { return `#${[r, g, b].map((x) => clamp(x).toString(16).padStart(2, '0')).join('')}`; }
function mix(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(A.map((x, i) => x + (B[i] - x) * t)); }
function isLight(hex) { const [r, g, b] = hexToRgb(hex); return (r * 299 + g * 587 + b * 114) / 1000 > 140; }

/** Push a theme into the CSS variables the whole app is painted from. */
export function applyTheme(theme) {
  const t = { ...DEFAULT_THEME, ...(theme || {}) };
  const s = document.documentElement.style;
  const light = isLight(t.bg);
  const fgDim = mix(t.fg, t.bg, light ? .45 : .3);
  const set = (k, v) => s.setProperty(k, v);
  set('--accent', t.accent);
  set('--accent-hover', mix(t.accent, light ? '#000000' : '#ffffff', .12));
  set('--accent-press', mix(t.accent, '#000000', .12));
  set('--seek-accent', t.accent);
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
  set('--black', light ? '#e6e3dc' : '#000');
  document.documentElement.dataset.light = light ? '1' : '';
}

export function themeEquals(a, b) {
  const A = { ...DEFAULT_THEME, ...(a || {}) }, B = { ...DEFAULT_THEME, ...(b || {}) };
  return ['accent', 'bg', 'surface', 'fg'].every((k) => A[k].toLowerCase() === B[k].toLowerCase());
}
