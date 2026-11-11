// Generates ios/Slopify/Design/Icons/IconData.swift from the web's inline SVG.
// Each entry names the JSX file and a unique anchor string; the first <svg>...</svg>
// after the anchor is parsed (svg/g/path/circle, inherited fill/stroke) and written
// out verbatim as path data, so the native glyphs never drift from the web.
//   node ios/tools/gen-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const web = path.resolve(here, '../../web/src');
const out = path.resolve(here, '../Slopify/Design/Icons/IconData.swift');
const src = {};
const read = (f) => (src[f] ??= fs.readFileSync(path.join(web, f), 'utf8'));

// [case name, file, anchor, nth svg after anchor (default 0), note]
const SVG = [
  ['homeTab', 'App.jsx', 'const TabHome', 1, 'tab bar, off'],
  ['homeTabFilled', 'App.jsx', 'const TabHome', 0, 'tab bar, on'],
  ['searchTab', 'App.jsx', 'const TabSearch', 1, 'tab bar, off; also the search field magnifier'],
  ['searchTabFilled', 'App.jsx', 'const TabSearch', 0, 'tab bar, on'],
  ['libraryTab', 'App.jsx', 'const TabLib', 1, 'tab bar, off'],
  ['libraryTabFilled', 'App.jsx', 'const TabLib', 0, 'tab bar, on'],
  ['loginMark', 'App.jsx', 'className="login-mark"', 0, 'sign-in logo, 40pt'],
  ['backChevron', 'App.jsx', 'className="mobile-back"', 0, 'detail top bar back, drawn at 18'],
  ['chevronDown', 'components/RightPanel.jsx', 'const ChevronDown', 0, 'close now playing / queue'],
  ['chevronRight', 'components/ContextMenu.jsx', 'const Chevron', 0, 'settings rows, submenu'],
  ['play', 'components/TrackRow.jsx', 'export const PlayGlyph', 0, '16 viewBox'],
  ['pause', 'components/TrackRow.jsx', 'export const PauseGlyph', 0, '16 viewBox'],
  ['shuffle', 'components/TrackRow.jsx', 'export const ShuffleGlyph', 0, '16 viewBox'],
  ['previous', 'components/FullScreen.jsx', "title={t('Previous')}", 0, '16 viewBox'],
  ['next', 'components/FullScreen.jsx', "title={t('Next')}", 0, '16 viewBox'],
  ['repeat', 'components/FullScreen.jsx', "title={t('Repeat')}", 0, '16 viewBox; repeat-one adds a badge in IconView'],
  ['spark', 'components/Player.jsx', 'className="ctl-spark"', -1, 'smart shuffle mark (24 viewBox)'],
  ['smartPick', 'components/RightPanel.jsx', 'className="qrow-rec"', -1, 'queue row smart-shuffle pick'],
  ['heart', 'components/TrackRow.jsx', 'heart: <svg', -1, 'outline'],
  ['heartFilled', 'components/TrackRow.jsx', 'heartOn: <svg', -1, 'filled, --seek-accent'],
  ['dots', 'components/TrackRow.jsx', 'const Dots', 0, '16 viewBox more'],
  ['dots24', 'components/FullScreen.jsx', 'dots: <svg', -1, 'now playing more'],
  ['plus', 'components/TrackRow.jsx', 'plus: <svg', -1, 'menu'],
  ['queue', 'components/TrackRow.jsx', 'queue: <svg', -1, 'menu, 16'],
  ['ban', 'components/TrackRow.jsx', 'ban: <svg', -1, 'menu'],
  ['radio', 'components/TrackRow.jsx', 'radio: <svg', -1, 'menu'],
  ['artist', 'components/TrackRow.jsx', 'artist: <svg', -1, 'menu'],
  ['album', 'components/TrackRow.jsx', 'album: <svg', -1, 'menu'],
  ['download', 'components/TrackRow.jsx', 'down: <svg', -1, 'menu'],
  ['trash', 'components/TrackRow.jsx', 'trash: <svg', -1, 'menu'],
  ['lyrics', 'components/TrackRow.jsx', 'lyrics: <svg', -1, 'menu, 16'],
  ['share', 'components/TrackRow.jsx', 'share: <svg', -1, 'menu, 16'],
  ['follow', 'components/TrackRow.jsx', 'follow: <svg', -1, 'menu'],
  ['edit', 'components/TrackRow.jsx', 'edit: <svg', -1, 'menu'],
  ['gear', 'components/TrackRow.jsx', 'gear: <svg', -1, 'menu'],
  ['sparkle', 'components/TrackRow.jsx', 'sparkle: <svg', -1, 'menu'],
  ['playlist', 'components/TrackRow.jsx', 'playlist: <svg', -1, 'menu'],
  ['photo', 'components/TrackRow.jsx', 'photo: <svg', -1, 'menu'],
  ['playSmall', 'components/TrackRow.jsx', 'play: <svg', -1, 'menu'],
  ['check', 'components/TrackRow.jsx', 'check: <svg', -1, 'menu check, fixed #1ed760'],
  ['pin', 'components/TrackRow.jsx', 'pin: <svg', -1, 'pinned thumbtack'],
  ['menuCheck', 'components/ContextMenu.jsx', 'className="ctx-check"', -1, 'checked sheet row (tint --accent-ink)'],
  ['downloadedMark', 'components/TrackRow.jsx', 'export const DownloadedMark', 0, '12pt green disc with black arrow'],
  ['share24', 'components/FullScreen.jsx', 'share: <svg', -1, 'now playing'],
  ['queue24', 'components/FullScreen.jsx', 'queue: <svg', -1, 'now playing bottom row'],
  ['lyrics24', 'components/Player.jsx', 'export const LyricsGlyph', 0, 'lyrics mic'],
  ['visualizer', 'components/FullScreen.jsx', 'viz: <svg', -1, 'stroke 2'],
  ['moon', 'components/FullScreen.jsx', 'moon: <svg', -1, 'sleep timer'],
  ['share16', 'components/FullScreen.jsx', 'const G16', 0, 'placeholder, replaced below'],
  ['modeAlbum', 'components/FullScreen.jsx', "['album', t('Album')", 0, 'now playing mode'],
  ['modeLyrics', 'components/FullScreen.jsx', "['lyrics', t('Lyrics')", 0, 'now playing mode'],
  ['cast', 'components/Player.jsx', 'const CastGlyph', 0, 'playing elsewhere, stroke 2'],
  ['connect', 'components/DevicePicker.jsx', 'const ConnectIcon', 0, 'device button'],
  ['volumeLow', 'components/DevicePicker.jsx', 'className="dm-volume"', 0, 'device sheet slider, left'],
  ['volumeHigh', 'components/DevicePicker.jsx', 'className="dm-volume"', 1, 'device sheet slider, right'],
  ['close', 'components/Library.jsx', 'const CloseGlyph', 0, 'x'],
  ['handle', 'components/RightPanel.jsx', 'const Handle', 0, 'queue drag handle'],
  ['clock', 'components/Library.jsx', 'const Clock', 0, ''],
  ['magnifier', 'components/Library.jsx', 'className="liked-find-field"', 0, 'find field, 16'],
  ['verified', 'components/Library.jsx', 'className="verified"', 0, 'artist hero'],
  ['musicNote', 'components/Library.jsx', 'className="hero-avatar mixmark"', 0, 'mix mark, card placeholder'],
  ['drawerProfile', null, 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0', 0, 'account drawer'],
  ['drawerHistory', null, 'M12 8v4l3 2M21 12a9 9 0 1 1-3-6.7M21 3v5h-5', 0, 'account drawer'],
  ['drawerDownloads', null, 'M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2', 0, 'account drawer'],
  ['drawerSettings', null, 'menuico:settings', 0, 'account drawer'],
  ['drawerLogOut', null, 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', 0, 'account drawer'],
  ['historyGrid', 'components/History.jsx', 'grid: <svg', -1, 'history'],
  ['historyPrev', 'components/History.jsx', 'prev: <svg', -1, 'history'],
  ['historyNext', 'components/History.jsx', 'next: <svg', -1, 'history'],
  ['historyMore', 'components/History.jsx', 'more: <svg', -1, 'history'],
  ['historyCheck', 'components/History.jsx', 'check: <svg', -1, 'history'],
  ['historyUpDown', 'components/History.jsx', 'updown: <svg', -1, 'history'],
  ['historyMusicOff', 'components/History.jsx', 'musicOff: <svg', -1, 'history'],
];
// String-map icons: [case, file, object name, key, style]
const MAPS = [
  ['libHome', 'components/Sidebar.jsx', 'ICONS', 'home', 'lib'], ['libSearch', 'components/Sidebar.jsx', 'ICONS', 'search', 'lib'],
  ['libLibrary', 'components/Sidebar.jsx', 'ICONS', 'library', 'lib'], ['libPlus', 'components/Sidebar.jsx', 'ICONS', 'plus', 'lib'],
  ['sort', 'components/Sidebar.jsx', 'ICONS', 'sort', 'lib'], ['grid', 'components/Sidebar.jsx', 'ICONS', 'grid', 'lib'],
  ['list', 'components/Sidebar.jsx', 'ICONS', 'list', 'lib'], ['folder', 'components/Sidebar.jsx', 'ICONS', 'folder', 'lib'],
  ['folderOpen', 'components/Sidebar.jsx', 'ICONS', 'folderOpen', 'lib'],
  ['devicePhone', 'components/DevicePicker.jsx', 'PHONE_ICONS', 'local', 'fill'], ['deviceCast', 'components/DevicePicker.jsx', 'PHONE_ICONS', 'cast', 'fill'],
  ['deviceSpeaker', 'components/DevicePicker.jsx', 'PHONE_ICONS', 'bluos', 'fill'], ['deviceLaptop', 'components/DevicePicker.jsx', 'PHONE_ICONS', 'relay', 'fill'],
  ['deviceDesktop', 'components/DevicePicker.jsx', 'FORM_ICONS', 'desktop', 'fill'], ['deviceTV', 'components/DevicePicker.jsx', 'FORM_ICONS', 'tv', 'fill'],
  ['deviceTablet', 'components/DevicePicker.jsx', 'FORM_ICONS', 'tablet', 'fill'],
];

function svgAfter(file, anchor, nth) {
  const s = read(file);
  const a = s.indexOf(anchor);
  if (a < 0) throw new Error(`anchor not found: ${file} ${anchor}`);
  let i = a;
  if (nth === -1) { i = s.lastIndexOf('<svg', a + anchor.length); if (i < a - 5) i = s.indexOf('<svg', a); }
  else for (let n = 0; n <= nth; n++) { i = s.indexOf('<svg', n === 0 ? a : i + 4); }
  const j = s.indexOf('</svg>', i);
  return s.slice(i, j + 6);
}

// Tiny JSX-tag parser: returns {tag, attrs, children}.
function parse(text) {
  const re = /<(\/?)(\w+)((?:\s+[\w-]+=(?:"[^"]*"|\{[^}]*\}))*)\s*(\/?)>/g;
  const root = { tag: 'root', attrs: {}, children: [] }, stack = [root];
  let m;
  while ((m = re.exec(text))) {
    const [, close, tag, rawAttrs, self] = m;
    if (close) { stack.pop(); continue; }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([\w-]+)=(?:"([^"]*)"|\{([^}]*)\})/g)) attrs[a[1]] = a[2] ?? `{${a[3]}}`;
    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  return root.children[0];
}

function paint(v) {
  if (v == null) return undefined;
  if (v === 'none') return null;
  if (v === 'currentColor') return '.current';
  if (/seek-accent/.test(v)) return '.seekAccent';
  if (/--green/.test(v)) return '.green';
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (h) { let x = h[1]; if (x.length === 3) x = [...x].map((c) => c + c).join(''); return `.rgb(0x${x.toLowerCase()})`; }
  throw new Error(`paint ${v}`);
}
const circleD = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

function flatten(node, inherited, outEls) {
  const a = node.attrs, st = { ...inherited };
  if (a.fill !== undefined) st.fill = paint(a.fill);
  if (a.stroke !== undefined) st.stroke = paint(a.stroke);
  if (a.strokeWidth) st.strokeWidth = +a.strokeWidth;
  if (a.strokeLinecap) st.cap = a.strokeLinecap;
  if (a.strokeLinejoin) st.join = a.strokeLinejoin;
  if (a.fillRule) st.evenOdd = a.fillRule === 'evenodd';
  if (a.opacity) st.opacity = +a.opacity;
  if (a.strokeOpacity) st.strokeOpacity = +a.strokeOpacity;
  if (a.transform) { const r = /rotate\(([-\d.]+) ([-\d.]+) ([-\d.]+)\)/.exec(a.transform); st.rotate = [+r[1], +r[2], +r[3]]; }
  let d = null;
  if (node.tag === 'path') d = a.d;
  if (node.tag === 'circle') d = circleD(+a.cx, +a.cy, +a.r);
  if (d) outEls.push({ d, ...st });
  for (const c of node.children) flatten(c, st, outEls);
}

function fromSvg(text) {
  const svg = parse(text);
  const vb = svg.attrs.viewBox.split(/\s+/).map(Number);
  const els = [];
  flatten(svg, { fill: '.current' }, els); // SVG default fill is black; every web glyph uses currentColor
  return { vb: vb[2], els };
}

function objMap(file, name) {
  const s = read(file);
  const i = s.indexOf(`const ${name} = {`);
  const j = s.indexOf('\n};', i);
  const body = s.slice(s.indexOf('{', i), j + 2);
  return new Function('PHONE_ICONS', `return (${body});`)(name === 'FORM_ICONS' ? objMap(file, 'PHONE_ICONS') : undefined);
}

const icons = [];
for (const [name, file, anchor, nth, note] of SVG) {
  if (name === 'share16') {
    icons.push({ name, note: 'now playing ⋯ sheet share (G16.share)', ...fromSvg(svgAfter('components/FullScreen.jsx', 'const G16', 0).replace(/[\s\S]*/, () => {
      const s = read('components/FullScreen.jsx'); const k = s.indexOf('share: <svg', s.indexOf('const G16')); return s.slice(s.indexOf('<svg', k), s.indexOf('</svg>', k) + 6);
    })) });
    continue;
  }
  if (file === null) {
    const s = read('App.jsx');
    let d = anchor;
    if (anchor === 'menuico:settings') { const k = s.indexOf('openSettings(); }}><MenuIco d="'); d = s.slice(k + 31, s.indexOf('"', k + 31)); }
    else if (!s.includes(`d="${d}"`)) throw new Error(`drawer path missing ${name}`);
    icons.push({ name, note, vb: 24, els: [{ d, fill: null, stroke: '.current', strokeWidth: 1.8, cap: 'round', join: 'round' }] });
    continue;
  }
  icons.push({ name, note, ...fromSvg(svgAfter(file, anchor, nth)) });
}
for (const [name, file, obj, key, style] of MAPS) {
  const d = objMap(file, obj)[key];
  const el = style === 'lib' ? { d, fill: null, stroke: '.current', strokeWidth: 1.9, cap: 'round', join: 'round' } : { d, fill: '.current' };
  icons.push({ name, note: `${path.basename(file)} ${obj}.${key}`, vb: 24, els: [el] });
}

const swiftStr = (s) => JSON.stringify(s);
const kw = (n) => (['repeat'].includes(n) ? `\`${n}\`` : n);
const el = (e) => {
  const parts = [`d: ${swiftStr(e.d)}`];
  parts.push(`fill: ${e.fill === undefined || e.fill === null ? 'nil' : e.fill}`);
  if (e.stroke) parts.push(`stroke: ${e.stroke}`, `lineWidth: ${e.strokeWidth ?? 1}`);
  if (e.cap) parts.push(`cap: .${e.cap}`);
  if (e.join) parts.push(`join: .${e.join}`);
  if (e.evenOdd) parts.push('evenOdd: true');
  if (e.opacity != null) parts.push(`opacity: ${e.opacity}`);
  if (e.strokeOpacity != null) parts.push(`strokeOpacity: ${e.strokeOpacity}`);
  if (e.rotate) parts.push(`rotate: (${e.rotate.join(', ')})`);
  return `IconElement(${parts.join(', ')})`;
};
let swift = `// Generated by ios/tools/gen-icons.mjs from the web's inline SVG. Do not edit by hand.\n\nimport CoreGraphics\n\nextension Icon {\n    /// The glyph's drawing, verbatim from web/src.\n    var spec: IconSpec {\n        switch self {\n`;
for (const i of icons) {
  swift += `        case .${i.name}: // ${i.note}\n            return IconSpec(viewBox: ${i.vb}, elements: [\n${i.els.map((e) => `                ${el(e)},`).join('\n')}\n            ])\n`;
}
swift += `        }\n    }\n}\n\n/// Every glyph the web app draws (UI.md 3.10, 5.12, 6.0.12, 9.2).\nenum Icon: String, CaseIterable, Sendable {\n${icons.map((i) => `    case ${kw(i.name)}`).join('\n')}\n}\n`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, swift);
console.log(`wrote ${icons.length} icons to ${out}`);
