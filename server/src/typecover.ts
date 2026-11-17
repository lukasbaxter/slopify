// Covers for the "type" playlists (Rock Classics, Christmas Hits, Hot 100),
// drawn the way Spotify's editors draw theirs:
//  - one flat, saturated colour from a small fixed palette (Spotify gives its
//    editors about 15 to pick from, the same ones as its Browse tiles);
//  - an artist from the playlist, cut out of their photo, big and bleeding
//    off the bottom edge;
//  - the title in a heavy grotesque, tight tracking, set large enough to read
//    as a thumbnail.
// Styles:
//   editorial - cutout on the colour, title bottom-left in front of it
//   behind    - huge title across the top, the cutout standing in front of it
//   duotone   - the 2015 Spotify look: the whole photo gradient-mapped
//               between a dark and a light colour (needs no cutout)
//   thisis    - "THIS IS" over the artist's name, cutout below
//   chart     - two-colour gradient and a giant number (Top 50, Hot 100)
//   object    - no artist: one big cartoon object and the title (Jazz Vibes)
// Any style can carry a prop or two: flat one-colour objects (Microsoft's
// Fluent emoji High Contrast set, MIT, assets/props) and a drawn ornament,
// usually a shade of the background so they stay quiet.
// Text is drawn as outlines (opentype.js), so it looks the same on every
// server whatever fonts it has installed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions, type Sharp } from 'sharp';
import opentype from 'opentype.js';

export type CoverStyle = 'editorial' | 'behind' | 'duotone' | 'thisis' | 'chart' | 'object';
// A flat, one-colour object on the cover (a sax, an ornament): width `size`
// and centre x, y, as fractions of the cover. Without x and y it finds room
// itself: the spot that covers the least of the artist and the title, top
// corners first; no room, no prop. `hang` makes it an ornament on a string
// from the top edge (img unused). `front` puts it in front of the artist.
// `tint` recolours a one-colour SVG (assets/props are Fluent emoji's High
// Contrast set: #212121, with white for the cut-out details).
export type Prop = { img?: Buffer; x?: number; y?: number; size: number; rot?: number; front?: boolean; tint?: string; hang?: boolean };
export type CoverSpec = {
  title: string;
  style: CoverStyle;
  color?: string;           // background; default picked from the title
  color2?: string;          // second colour (duotone light end, chart gradient end)
  label?: string;           // small line above or under the title ("BILLBOARD", "THIS IS")
  cutout?: Buffer;          // PNG with alpha, the artist without a background
  photo?: Buffer;           // the plain photo (duotone, or when there is no cutout)
  props?: Prop[];
  size?: number;
};

// Spotify's Browse palette: saturated mid-tones that carry white type.
export const PALETTE = [
  '#E13300', '#1E3264', '#8D67AB', '#E8115B', '#148A08', '#BA5D07', '#477D95', '#509BF5',
  '#AF2896', '#27856A', '#DC148C', '#8C1932', '#E91429', '#0D73EC', '#608108', '#7D4B32',
];

const FONTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
const load = (f: string) => { const b = fs.readFileSync(path.join(FONTS, f)); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
let fonts: { black: opentype.Font; bold: opentype.Font } | null = null;
function font() {
  if (!fonts) fonts = {
    black: load('Figtree-Black.ttf'),
    bold: load('Figtree-Bold.ttf'),
  };
  return fonts;
}

export function pickColor(title: string) {
  let h = 2166136261;
  for (const c of title.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return PALETTE[(h >>> 0) % PALETTE.length];
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luma = (hex: string) => { const [r, g, b] = rgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
export const mix = (a: string, b: string, t: number) => '#' + rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');

// opentype's own toPathData() writes NaN for some coordinates (seen with
// Figtree's "t" at x = 356.9), which makes the renderer drop the rest of the
// line; so the path string is written here.
const n = (v: number) => (Math.round(v * 100) / 100).toString();
function pathData(p: opentype.Path) {
  return p.commands.map((c: any) => c.type === 'Z' ? 'Z'
    : c.type === 'Q' ? `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`
    : c.type === 'C' ? `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`
    : `${c.type}${n(c.x)} ${n(c.y)}`).join('');
}

// One line of text as an SVG path, with tracking in em/1000.
function line(f: opentype.Font, text: string, size: number, x: number, baseline: number, tracking = -30) {
  let d = '', pen = x;
  const glyphs = f.stringToGlyphs(text);
  glyphs.forEach((g, i) => {
    d += pathData(g.getPath(pen, baseline, size));
    pen += (g.advanceWidth ?? 0) * size / f.unitsPerEm + tracking * size / 1000;
    if (i < glyphs.length - 1) pen += f.getKerningValue(g, glyphs[i + 1]) * size / f.unitsPerEm;
  });
  return { d, width: pen - x - tracking * size / 1000 };
}
// For tests: one line of the heavy title font as path data.
export const titlePath = (text: string, size: number, x: number, baseline: number, tracking = 0) => line(font().black, text, size, x, baseline, tracking).d;
const widthOf = (f: opentype.Font, text: string, size: number, tracking = -30) => line(f, text, size, 0, 0, tracking).width;

// Break the title into at most `maxLines` lines and find the biggest size
// that fits `boxW`, preferring balanced lines ("Rock / Classics").
function fit(f: opentype.Font, title: string, boxW: number, maxSize: number, maxLines: number, tracking = -30) {
  const words = title.split(/\s+/).filter(Boolean);
  let best = { lines: [title], size: 0 };
  const splits = (ws: string[], n: number): string[][] => {
    if (n === 1) return [[ws.join(' ')]];
    const out: string[][] = [[ws.join(' ')]];
    for (let i = 1; i < ws.length; i++) for (const rest of splits(ws.slice(i), n - 1)) out.push([ws.slice(0, i).join(' '), ...rest]);
    return out;
  };
  for (const lines of splits(words, Math.min(maxLines, words.length))) {
    const w = Math.max(...lines.map((l) => widthOf(f, l, 100, tracking)));
    const size = Math.min(maxSize, (boxW / w) * 100);
    // A little bonus for fewer lines so short titles stay on one line.
    if (size * (1 + 0.04 * (maxLines - lines.length)) > best.size * (1 + 0.04 * (maxLines - best.lines.length))) best = { lines, size };
  }
  return best;
}

// The cutout trimmed to the person, scaled to `h` tall (or `w` wide, whichever binds).
async function person(cut: Buffer, maxW: number, maxH: number) {
  const trimmed = await sharp(cut).ensureAlpha().trim({ threshold: 10 }).png().toBuffer({ resolveWithObject: true });
  const { width, height } = trimmed.info;
  const k = Math.min(maxW / width, maxH / height);
  const w = Math.round(width * k), h = Math.round(height * k);
  return { buf: await sharp(trimmed.data).resize(w, h).png().toBuffer(), w, h };
}

async function duotone(photo: Buffer, S: number, dark: string, light: string) {
  const [d, l] = [rgb(dark), rgb(light)];
  const g = await sharp(photo).resize(S, S, { fit: 'cover', position: sharp.strategy.attention })
    .grayscale().normalise().raw().toBuffer();
  const out = Buffer.alloc(S * S * 3);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = d[c] + ((l[c] - d[c]) * g[i]) / 255;
  return sharp(out, { raw: { width: S, height: S, channels: 3 } }).png().toBuffer();
}

// A Christmas ornament, flat: ball, cap and string in one colour.
export function ornament(string = 0.6) {
  const top = Math.round(200 * string);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="${200 + top}" viewBox="0 ${-top} 200 ${200 + top}">
    <line x1="100" y1="${-top}" x2="100" y2="40" stroke="#212121" stroke-width="5"/>
    <circle cx="100" cy="124" r="76" fill="#212121"/>
    <rect x="78" y="36" width="44" height="20" rx="3" fill="#212121"/>
    <rect x="24" y="112" width="152" height="9" fill="white"/><rect x="28" y="136" width="144" height="9" fill="white"/></svg>`);
}

export const tintSvg = (svg: Buffer, color: string, holes: string) =>
  Buffer.from(svg.toString().replace(/(fill|stroke)="(#212121|black)"/g, `$1="${color}"`).replace(/(fill|stroke)="(white|#fff(fff)?)"/gi, `$1="${holes}"`));

type Placed = Prop & { img: Buffer; x: number; y: number };
async function propLayers(props: Placed[], S: number, bg: string): Promise<OverlayOptions[]> {
  const out: OverlayOptions[] = [];
  for (const p of props) {
    const w = Math.round(p.size * S);
    const src = p.tint ? tintSvg(p.img, p.tint, bg) : p.img;
    let img = sharp(await sharp(src, { density: 600 }).resize({ width: w, kernel: 'lanczos3' }).png().toBuffer());
    if (p.rot) img = img.rotate(p.rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
    // Composite needs the layer on the canvas: clip what hangs off an edge.
    const l = Math.round(p.x * S - info.width / 2), t = Math.round(p.y * S - info.height / 2);
    const x0 = Math.max(0, -l), y0 = Math.max(0, -t);
    const cw = Math.min(info.width - x0, S - Math.max(0, l)), ch = Math.min(info.height - y0, S - Math.max(0, t));
    if (cw > 0 && ch > 0) out.push({ input: await sharp(data).extract({ left: x0, top: y0, width: cw, height: ch }).toBuffer(), left: Math.max(0, l), top: Math.max(0, t) });
  }
  return out;
}

// What is already on the cover, on a coarse grid, so props can find room.
const G = 64;
class Room {
  cells = new Uint8Array(G * G);
  constructor(private S: number) {}
  get size() { return this.S; }
  box(x0: number, y0: number, x1: number, y1: number) {
    const k = G / this.S;
    for (let y = Math.max(0, Math.floor(y0 * k)); y < Math.min(G, Math.ceil(y1 * k)); y++)
      for (let x = Math.max(0, Math.floor(x0 * k)); x < Math.min(G, Math.ceil(x1 * k)); x++) this.cells[y * G + x] = 1;
  }
  async person(buf: Buffer, left: number, top: number) {
    const m = await sharp(buf).metadata();
    const gw = Math.max(1, Math.round((m.width ?? 1) * G / this.S)), gh = Math.max(1, Math.round((m.height ?? 1) * G / this.S));
    const a = await sharp(buf).ensureAlpha().extractChannel(3).resize(gw, gh, { fit: 'fill' }).raw().toBuffer();
    const ox = Math.round(left * G / this.S), oy = Math.round(top * G / this.S);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const X = ox + x, Y = oy + y;
      if (a[y * gw + x] > 60 && X >= 0 && X < G && Y >= 0 && Y < G) this.cells[Y * G + X] = 1;
    }
  }
  // Share of the box (fractions of the cover) already taken.
  taken(cx: number, cy: number, w: number, h: number) {
    const x0 = Math.round((cx - w / 2) * G), x1 = Math.round((cx + w / 2) * G), y0 = Math.round((cy - h / 2) * G), y1 = Math.round((cy + h / 2) * G);
    let n = 0, all = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { all++; if (x >= 0 && x < G && y >= 0 && y < G && this.cells[y * G + x]) n++; }
    return all ? n / all : 1;
  }
  // The emptiest spot for a w x h box, inside the cover, top corners first.
  find(w: number, h: number) {
    let best: { x: number; y: number; score: number } | null = null;
    const m = 0.03;
    for (let cy = h / 2 + m; cy <= 1 - h / 2 - m; cy += 0.02) for (let cx = w / 2 + m; cx <= 1 - w / 2 - m; cx += 0.02) {
      const t = this.taken(cx, cy, w, h);
      const score = t + 0.04 * cy + 0.02 * (0.5 - Math.abs(cx - 0.5));
      if (t <= 0.08 && (!best || score < best.score)) best = { x: cx, y: cy, score };
    }
    if (best) this.box((best.x - w / 2) * this.S, (best.y - h / 2) * this.S, (best.x + w / 2) * this.S, (best.y + h / 2) * this.S);
    return best;
  }
}

// Fixed spots stay; the rest find room (an ornament hangs from the top edge
// on a string long enough to reach its spot).
async function place(props: Prop[], room: Room): Promise<Placed[]> {
  const out: Placed[] = [];
  for (const p of props) {
    if (p.hang) {
      const at = p.x != null && p.y != null ? { x: p.x, y: p.y } : room.find(p.size, p.size);
      if (!at) continue;
      const st = Math.max(0.05, at.y / p.size - 0.62);
      out.push({ ...p, img: ornament(st), x: at.x, y: (p.size * (1 + st)) / 2 });
      continue;
    }
    if (!p.img) continue;
    const m = await sharp(p.img).metadata();
    const h = p.size * ((m.height ?? 1) / (m.width ?? 1));
    if (p.x != null && p.y != null) {
      room.box((p.x - p.size / 2) * room.size, (p.y - h / 2) * room.size, (p.x + p.size / 2) * room.size, (p.y + h / 2) * room.size);
      out.push({ ...p, img: p.img, x: p.x, y: p.y }); continue;
    }
    const at = room.find(p.size, h);
    if (at) out.push({ ...p, img: p.img, x: at.x, y: at.y });
  }
  return out;
}

export async function renderTypeCover(spec: CoverSpec): Promise<Buffer> {
  const S = spec.size ?? 640;
  const { black, bold } = font();
  const bg = spec.color ?? pickColor(spec.title);
  const ink = luma(bg) > 0.62 ? '#121212' : '#FFFFFF';
  const pad = Math.round(S * 0.065);
  const layers: OverlayOptions[] = [];
  let personAt = -1, hasPerson = false; // where the artist sits in the stack, for the props
  const room = new Room(S);
  const putPerson = async (l: OverlayOptions & { input: Buffer; left: number; top: number }) => {
    personAt = layers.length; hasPerson = true; layers.push(l); await room.person(l.input, l.left, l.top);
  };
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${body}</svg>`);
  let base = sharp({ create: { width: S, height: S, channels: 4, background: bg } });
  const shade = `<defs><linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></linearGradient></defs>`;

  const titleBlock = (f: opentype.Font, maxLines: number, maxSize: number, anchor: 'top' | 'bottom', tracking = -35) => {
    const { lines, size } = fit(f, spec.title, S - pad * 2, maxSize, maxLines, tracking);
    const lh = size * 0.9;
    const asc = size * 0.74;
    const top = anchor === 'top' ? pad + asc : S - pad - lh * (lines.length - 1);
    const out = { size, lines, d: lines.map((l, i) => line(f, l, size, pad, top + i * lh, tracking).d).join(''), bottom: top + lh * (lines.length - 1), top: top - asc };
    room.box(pad, out.top, pad + Math.max(...lines.map((l) => widthOf(f, l, size, tracking))), out.bottom + size * 0.22);
    return out;
  };

  if (spec.style === 'duotone') {
    const src = spec.photo ?? spec.cutout;
    if (src) base = sharp(await duotone(src, S, mix(bg, '#000000', 0.55), spec.color2 ?? mix(bg, '#FFFFFF', 0.55)));
    personAt = layers.length;
    const t = titleBlock(black, 3, S * 0.2, 'bottom');
    layers.push({ input: svg(`${shade}<rect width="${S}" height="${S}" fill="url(#sh)"/><path d="${t.d}" fill="#fff"/>`) });
  } else if (spec.style === 'chart') {
    const c2 = spec.color2 ?? mix(bg, '#000000', 0.6);
    const t = titleBlock(black, 2, S * 0.4, 'bottom', -45);
    const lab = spec.label ? line(bold, spec.label.toUpperCase(), S * 0.05, pad, pad + S * 0.04, 60).d : '';
    if (spec.label) room.box(pad, pad, pad + widthOf(bold, spec.label.toUpperCase(), S * 0.05, 60), pad + S * 0.06);
    const cut = spec.cutout ? await person(spec.cutout, S * 0.62, S * 0.7) : null;
    layers.push({ input: svg(`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="${S}" height="${S}" fill="url(#g)"/>`) });
    if (cut) await putPerson({ input: cut.buf, left: S - cut.w + Math.round(S * 0.04), top: S - cut.h }); else personAt = layers.length;
    layers.push({ input: svg(`${cut ? shade + `<rect width="${S}" height="${S}" fill="url(#sh)"/>` : ''}<path d="${lab}" fill="${ink}"/><path d="${t.d}" fill="${ink}"/>`) });
  } else if (spec.style === 'thisis') {
    const lab = line(bold, (spec.label ?? 'THIS IS').toUpperCase(), S * 0.055, pad, pad + S * 0.045, 80);
    room.box(pad, pad, pad + lab.width, pad + S * 0.06);
    const { lines, size } = fit(black, spec.title, S - pad * 2, S * 0.17, 2, -35);
    const y0 = pad + S * 0.045 + S * 0.03 + size * 0.74;
    const name = lines.map((l, i) => line(black, l, size, pad, y0 + i * size * 0.9).d).join('');
    const textBottom = y0 + (lines.length - 1) * size * 0.9 + size * 0.1;
    room.box(pad, pad, pad + Math.max(...lines.map((l) => widthOf(black, l, size, -35))), textBottom + size * 0.12);
    const cut = spec.cutout ? await person(spec.cutout, S * 0.92, S - textBottom - S * 0.02) : null;
    if (cut) await putPerson({ input: cut.buf, left: Math.round((S - cut.w) / 2), top: S - cut.h }); else personAt = layers.length;
    layers.push({ input: svg(`<path d="${lab.d}" fill="${ink}"/><path d="${name}" fill="${ink}"/>`) });
  } else if (spec.style === 'behind') {
    const t = titleBlock(black, 2, S * 0.3, 'top', -45);
    layers.push({ input: svg(`<path d="${t.d}" fill="${ink}"/>`) });
    // The head may cover the bottom of the last line's letters, never more, so
    // the title still reads.
    const cut = spec.cutout ? await person(spec.cutout, S * 0.95, S - t.bottom + t.size * 0.15) : null;
    if (cut) await putPerson({ input: cut.buf, left: Math.round((S - cut.w) / 2), top: S - cut.h }); else personAt = layers.length;
  } else if (spec.style === 'object') {
    personAt = 0;
    const t = titleBlock(black, 3, S * 0.2, 'top', -40);
    layers.push({ input: svg(`<path d="${t.d}" fill="${ink}"/>`) });
  } else {
    // Wide groups may run off both sides rather than shrink to a strip.
    const cut = spec.cutout ? await person(spec.cutout, S * 1.25, S * 0.9) : null;
    if (cut) {
      const left = cut.w > S ? Math.round((S - cut.w) / 2) : Math.min(S - cut.w, Math.round(S * 0.58 - cut.w / 2));
      const buf = cut.w > S ? await sharp(cut.buf).extract({ left: -left, top: 0, width: S, height: cut.h }).toBuffer() : cut.buf;
      await putPerson({ input: buf, left: Math.max(0, left), top: S - cut.h });
    } else {
      personAt = layers.length;
      if (spec.photo) base = sharp(await sharp(spec.photo).resize(S, S, { fit: 'cover', position: sharp.strategy.attention }).png().toBuffer());
    }
    const t = titleBlock(black, 3, S * 0.19, 'bottom');
    layers.push({ input: svg(`${shade}<rect width="${S}" height="${S}" fill="url(#sh)" opacity="${cut ? 0.6 : 1}"/><path d="${t.d}" fill="#fff"/>`) });
  }
  if (spec.props?.length) {
    const placed = await place(spec.props, room);
    const back = await propLayers(placed.filter((p) => !p.front), S, bg);
    const front = await propLayers(placed.filter((p) => p.front), S, bg);
    if (personAt < 0) personAt = 0;
    layers.splice(personAt, 0, ...back);
    layers.splice(personAt + back.length + (hasPerson ? 1 : 0), 0, ...front);
  }
  return base.composite(layers).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

// So a demo can be run straight from the command line.
export const fontsDir = FONTS;
export const hasFonts = () => fs.existsSync(path.join(FONTS, 'Figtree-Black.ttf'));

// ---- Home's own covers: Daily Mix, stations, top mixes (Spotify's 2025 look).
// Colours sampled from Spotify's tiles; each tile keeps the one it was given
// (homemixes.ts saves it).
export const DAILY_COLORS = ['#00F5F2', '#F2F944', '#FA4A34', '#D9A0D2', '#7CF27E', '#5B9BFF'];
export const STATION_COLORS = ['#FFDA7E', '#89BCF9', '#95EFB5', '#FF9CA9', '#C9A8F2', '#FFB98A'];
export const MIXBAR_COLORS = ['#F3FD47', '#EEDABE', '#5AA0F6', '#96EEB8', '#FF9CA9', '#C9A8F2'];

// Slopify's mark (web/public/favicon.svg) in one colour, `s` px square.
function logo(x: number, y: number, s: number, color: string, hole: string) {
  const k = s / 100;
  return `<g transform="translate(${x} ${y}) scale(${k})"><path d="M32 36 V26 a18 18 0 0 1 36 0 V36" fill="none" stroke="${color}" stroke-width="8"/>
    <rect x="6" y="30" width="88" height="66" rx="18" fill="${color}"/>
    <path d="M24.8 55 Q50 43.45 75.2 55" fill="none" stroke="${hole}" stroke-width="7.56" stroke-linecap="round"/>
    <path d="M29.34 67.08 Q50 57.6 70.66 67.08" fill="none" stroke="${hole}" stroke-width="6.09" stroke-linecap="round"/>
    <path d="M33.87 78.63 Q50 71.23 66.13 78.63" fill="none" stroke="${hole}" stroke-width="4.83" stroke-linecap="round"/></g>`;
}
const square = async (img: Buffer, S: number) => sharp(img, { failOn: 'none' }).rotate().resize(S, S, { fit: 'cover', position: sharp.strategy.attention }).png().toBuffer();
const svgOf = (S: number, body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${body}</svg>`);
const jpeg = (img: Sharp) => img.jpeg({ quality: 88, mozjpeg: true }).toBuffer();

// Daily Mix: the artist's photo, "Daily Mix" in a box bottom left, the
// number big in a box bottom right, the mark top left, all in the mix's colour.
export async function renderDailyMix(photo: Buffer | null, n: number, color: string, size = 640): Promise<Buffer> {
  const S = size, { black, bold } = font();
  const base = photo ? sharp(await square(photo, S)) : sharp({ create: { width: S, height: S, channels: 4, background: '#282828' } });
  const ls = S * 0.072, lab = line(bold, 'Daily Mix', ls, 0, 0, -10);
  const lx = S * 0.035, lh = ls * 1.32, ly = S * 0.92 - lh;
  const num = String(n).padStart(2, '0');
  const ns = S * 0.15, nw = widthOf(black, num, ns, 10), nh = ns * 0.95;
  const nx = S * 0.965 - nw - ns * 0.24, ny = S * 0.935 - nh;
  const body = `<rect x="${lx}" y="${ly}" width="${lab.width + ls * 0.5}" height="${lh}" fill="${color}"/>
    <path d="${line(bold, 'Daily Mix', ls, lx + ls * 0.25, ly + lh * 0.74, -10).d}" fill="#121212"/>
    <rect x="${nx}" y="${ny}" width="${nw + ns * 0.24}" height="${nh}" fill="${color}"/>
    <path d="${line(black, num, ns, nx + ns * 0.12, ny + nh * 0.86, 10).d}" fill="#121212"/>
    <circle cx="${S * 0.075}" cy="${S * 0.075}" r="${S * 0.04}" fill="${color}"/>${logo(S * 0.05, S * 0.05, S * 0.05, '#121212', color)}`;
  return jpeg(base.composite([{ input: svgOf(S, body) }]));
}

// A station (an artist's radio): a pastel colour, the artist in a big circle
// with two of the artists it brings in half out of frame either side,
// "RADIO" top right, the mark top left, the name big at the bottom.
export async function renderRadio(name: string, photos: (Buffer | null)[], color: string, size = 640): Promise<Buffer> {
  const S = size, { black, bold } = font();
  const circle = async (img: Buffer | null, d: number) => {
    const mask = svgOf(d, `<circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#fff"/>`);
    const fill = img ? await sharp(img, { failOn: 'none' }).rotate().resize(d, d, { fit: 'cover', position: sharp.strategy.attention }).png().toBuffer()
      : await sharp({ create: { width: d, height: d, channels: 4, background: mix(color, '#000000', 0.25) } }).png().toBuffer();
    return sharp(fill).composite([{ input: await sharp(mask).resize(d, d).png().toBuffer(), blend: 'dest-in' }]).png().toBuffer();
  };
  const big = Math.round(S * 0.52), small = Math.round(S * 0.37), ring = Math.round(S * 0.012);
  const cy = Math.round(S * 0.43);
  const layers: OverlayOptions[] = [];
  const side = async (img: Buffer | null, cx: number) => {
    const c = await circle(img, small);
    const left = Math.round(cx - small / 2), top = Math.round(cy - small / 2);
    const x0 = Math.max(0, -left), w = Math.min(small - x0, S - Math.max(0, left));
    if (w > 0) layers.push({ input: await sharp(c).extract({ left: x0, top: 0, width: w, height: small }).toBuffer(), left: Math.max(0, left), top });
  };
  await side(photos[1] ?? null, S * 0.14);
  await side(photos[2] ?? null, S * 0.86);
  layers.push({ input: svgOf(S, `<circle cx="${S / 2}" cy="${cy}" r="${big / 2 + ring}" fill="${color}"/>`) });
  layers.push({ input: await circle(photos[0] ?? null, big), left: Math.round(S / 2 - big / 2), top: Math.round(cy - big / 2) });
  const { lines, size: ts } = fit(black, name, S * 0.88, S * 0.15, 1, -25);
  const radio = line(bold, 'RADIO', S * 0.05, 0, 0, 120);
  layers.push({ input: svgOf(S, `${logo(S * 0.045, S * 0.04, S * 0.065, '#121212', color)}
    <path d="${line(bold, 'RADIO', S * 0.05, S * 0.955 - radio.width, S * 0.085, 120).d}" fill="#121212"/>
    <path d="${line(black, lines[0], ts, S * 0.055, S * 0.93, -25).d}" fill="#121212"/>`) });
  return jpeg(sharp({ create: { width: S, height: S, channels: 4, background: color } }).composite(layers));
}

// One of "Your top mixes": the photo full bleed, the mix's name on a bar of
// its colour across the bottom with a short tick before it, the mark top left.
export async function renderMixBar(photo: Buffer | null, label: string, color: string, size = 640): Promise<Buffer> {
  const S = size, { bold } = font();
  const base = photo ? sharp(await square(photo, S)) : sharp({ create: { width: S, height: S, channels: 4, background: '#282828' } });
  const { lines, size: ts } = fit(bold, label, S * 0.8, S * 0.085, 1, -15);
  const y = S * 0.8, h = S * 0.12;
  const body = `<rect x="0" y="${y}" width="${S * 0.04}" height="${h}" fill="${color}"/>
    <rect x="${S * 0.075}" y="${y}" width="${S * 0.925}" height="${h}" fill="${color}"/>
    <path d="${line(bold, lines[0], ts, S * 0.105, y + h * 0.5 + ts * 0.35, -15).d}" fill="#121212"/>
    <circle cx="${S * 0.075}" cy="${S * 0.075}" r="${S * 0.04}" fill="${color}"/>${logo(S * 0.05, S * 0.05, S * 0.05, '#121212', color)}`;
  return jpeg(base.composite([{ input: svgOf(S, body) }]));
}
