import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { history as relayHistory } from '../api/search.js';
import { usePhone } from './TrackRow.jsx';

// The profile menu's History page, built to stats.fm's user page: its
// Tailwind tokens (background #111111, foreground #181818, primary #1ed760,
// grey #a3a3a3 / #727272), its Container widths, the same sections in the
// same order with the same class recipes (see HANDOFF.md "History tab").
// Every number comes from ListenBrainz through the relay (Conduit plays, the
// Jellyfin backfill and LB's Spotify import all land there), matched to the
// library for art and playback where the song exists here.

// Range labels and the section-description suffix, verbatim from stats.fm.
const RANGES = [
  ['today', 'today', 'from today'],
  ['week', 'this week', 'from this week'],
  ['4w', '4 weeks', 'from the past 4 weeks'],
  ['6m', '6 months', 'from the past 6 months'],
  ['year', String(new Date().getFullYear()), 'from this year'],
  ['all', 'lifetime', ''],
];
const fmtN = (n) => (n ?? 0).toLocaleString('en-US');
const LL = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const fromNow = (ts) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  const u = (n, w) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  if (s < 45) return 'a few seconds ago';
  if (s < 90) return 'a minute ago';
  if (s < 2700) return u(Math.round(s / 60), 'minute');
  if (s < 5400) return 'an hour ago';
  if (s < 79200) return u(Math.round(s / 3600), 'hour');
  if (s < 129600) return 'a day ago';
  if (s < 2246400) return u(Math.round(s / 86400), 'day');
  if (s < 3888000) return 'a month ago';
  if (s < 27993600) return u(Math.round(s / 2592000), 'month');
  if (s < 47260800) return 'a year ago';
  return u(Math.round(s / 31536000), 'year');
};
const fullDate = (ts) => new Date(ts * 1000).toLocaleString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const hm = (secs) => { const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };

// stats.fm's toolbar icons (Material: grid_on, navigate_before, navigate_next, more_horiz, check, unfold_more).
const I = {
  grid: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM8 20H4v-4h4v4zm0-6H4v-4h4v4zm0-6H4V4h4v4zm6 12h-4v-4h4v4zm0-6h-4v-4h4v4zm0-6h-4V4h4v4zm6 12h-4v-4h4v4zm0-6h-4v-4h4v4zm0-6h-4V4h4v4z" /></svg>,
  prev: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>,
  next: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" /></svg>,
  more: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>,
  updown: <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 3a.75.75 0 0 1 .55.24l3.25 3.5a.75.75 0 1 1-1.1 1.02L10 4.852 7.3 7.76a.75.75 0 0 1-1.1-1.02l3.25-3.5A.75.75 0 0 1 10 3zm-3.76 9.2a.75.75 0 0 1 1.06.04l2.7 2.908 2.7-2.908a.75.75 0 1 1 1.1 1.02l-3.25 3.5a.75.75 0 0 1-1.1 0l-3.25-3.5a.75.75 0 0 1 .04-1.06z" clipRule="evenodd" /></svg>,
  musicOff: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.27 3 3 4.27l9 9v.28c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4v-1.73L19.73 21 21 19.73 4.27 3zM14 7h4V3h-6v5.18l2 2z" /></svg>,
};

// Headless-UI style listbox: `relative mt-1 w-72`, button `rounded-lg bg-foreground py-2 pl-3 pr-10 shadow-md`.
function RangeListbox({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const cur = RANGES.find((r) => r[0] === value) || RANGES[2];
  return (
    <div className="sf-listbox" ref={ref}>
      <button className="sf-listbox-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="sf-truncate">{cur[1]}</span>
        <span className="sf-listbox-chev">{I.updown}</span>
      </button>
      {open && (
        <ul className="sf-listbox-opts" role="listbox">
          {RANGES.map(([k, label]) => (
            <li key={k} role="option" aria-selected={k === value} className={`sf-listbox-opt ${k === value ? 'selected' : ''}`} onClick={() => { onChange(k); setOpen(false); }}>
              {k === value && <span className="sf-listbox-check">{I.check}</span>}
              <span className="sf-truncate">{label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// stats.fm's Section: sticky header (h2 + grey description) with a round-button
// toolbar on the right. The carousel toolbar comes from the child via `tools`.
function Section({ title, description, tools, children }) {
  return (
    <section className="sf-section">
      <header className="sf-section-head">
        <div className="sf-section-titles">
          <h2>{title}</h2>
          <p className="sf-section-desc">{description}</p>
        </div>
        {tools && <div className="sf-toolbar">{tools}</div>}
      </header>
      <main>{children}</main>
    </section>
  );
}
const ToolBtn = ({ children, onClick, disabled, label }) => (
  <button className="sf-toolbtn" onClick={onClick} disabled={disabled} aria-label={label} title={label}>{children}</button>
);

// The carousel: an overflow-hidden viewport, a w-max single-row grid moved
// with translateX by whole items (160 + 16px), 300ms ease-in-out. Grid mode
// wraps every item instead. On touch screens the row also scrolls natively.
function Carousel({ items, itemHeight, render, empty }) {
  const viewport = useRef(null);
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(4);
  const [grid, setGrid] = useState(false);
  useLayoutEffect(() => {
    const el = viewport.current; if (!el) return undefined;
    const measure = () => setPerPage(Math.max(1, Math.floor(el.clientWidth / 176)));
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [items.length, grid]);
  useEffect(() => { setPage(0); }, [items]);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const tools = (
    <>
      <ToolBtn label={grid ? 'Show as carousel' : 'Show as grid'} onClick={() => setGrid((v) => !v)}><span className={grid ? 'on' : ''}>{I.grid}</span></ToolBtn>
      {!grid && <ToolBtn label="Go to previous slide" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}><span className={page === 0 ? '' : 'on'}>{I.prev}</span></ToolBtn>}
      {!grid && <ToolBtn label="Go to next slide" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}><span className={page >= pages - 1 ? '' : 'on'}>{I.next}</span></ToolBtn>}
    </>
  );
  const body = !items.length ? (
    <div className="sf-empty"><p>{empty || 'Not enough data to complete this list'}</p></div>
  ) : grid ? (
    <ul className="sf-carousel-grid">{items.map((it, i) => <li key={i}>{render(it, i)}</li>)}</ul>
  ) : (
    <div className="sf-carousel" ref={viewport}>
      <ul className="sf-carousel-row" style={{ transform: `translateX(-${page * perPage * 176}px)` }}>
        {items.map((it, i) => <li key={i} style={{ height: itemHeight }}>{render(it, i)}</li>)}
      </ul>
    </div>
  );
  return { tools, body };
}

// Listening clock: ApexCharts polarArea reproduced in SVG -- 24 equal-angle
// wedges whose radius follows the value, 2px page-colour strokes, 1px spokes,
// no rings, no axis, "13:00 - 14:00: 123 streams" tooltips.
function Clock({ values, format }) {
  const R = 150, C = 160;
  const max = Math.max(1, ...values);
  const pt = (angle, r) => [C + r * Math.cos(angle), C + r * Math.sin(angle)];
  const wedge = (i, r) => {
    const a0 = -Math.PI / 2 + (i * Math.PI) / 12, a1 = a0 + Math.PI / 12;
    const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
    return `M${C} ${C} L${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1} Z`;
  };
  const label = (i) => `${String(i).padStart(2, '0')}:00 - ${String((i + 1) % 24).padStart(2, '0')}:00`;
  return (
    <svg className="sf-clock" viewBox="0 0 320 320" role="img">
      {values.map((_, i) => { const [x, y] = pt(-Math.PI / 2 + (i * Math.PI) / 12, R); return <line key={i} x1={C} y1={C} x2={x} y2={y} className="sf-clock-spoke" />; })}
      {values.map((v, i) => (
        <path key={i} d={wedge(i, Math.max(0, (v / max) * R))} className="sf-clock-wedge"><title>{`${label(i)}: ${format(v)}`}</title></path>
      ))}
      {[[0, C, 14], [6, 310, C + 4], [12, C, 314], [18, 10, C + 4]].map(([h, x, y]) => <text key={h} x={x} y={y} className="sf-clock-hour" textAnchor="middle">{h}</text>)}
    </svg>
  );
}

// Delta badge next to a stat value: "+18%" green / "-3%" red vs the previous
// window of the same length (stats.fm's mobile cards).
function Delta({ now, before }) {
  if (before == null || (!before && !now)) return null;
  const pct = before ? Math.round(((now - before) / before) * 100) : 100;
  if (!pct) return <span className="sf-delta zero">0%</span>;
  return <span className={`sf-delta ${pct > 0 ? 'up' : 'down'}`}>{pct > 0 ? '+' : ''}{pct}%</span>;
}

// Nice axis ticks: 0 .. a rounded max in 3-4 steps.
function ticksFor(max) {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) || mag * 10;
  const out = []; for (let v = 0; v <= max + step * 0.999; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}
const shortDay = (iso) => { const d = new Date(`${iso}T00:00:00`); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

// The "Daily" / "Cumulative" line charts: two thin lines (streams bright green,
// minutes the same green at half opacity), 3-4 y ticks, x labels ~8 across,
// a hover crosshair with both values, legend dots underneath.
function LineChart({ title, points, cumulative = false }) {
  const [hover, setHover] = useState(null);
  const W = 640, H = 220, PL = 44, PR = 12, PT = 12, PB = 28;
  const rows = points.map((p, i) => ({ ...p })); // {label, streams, minutes}
  if (cumulative) { let a = 0, b = 0; for (const r of rows) { a += r.streams; b += r.minutes; r.streams = a; r.minutes = b; } }
  const n = rows.length;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.streams, r.minutes)));
  const ticks = ticksFor(max);
  const top = ticks[ticks.length - 1];
  const x = (i) => PL + (n > 1 ? (i / (n - 1)) * (W - PL - PR) : (W - PL - PR) / 2);
  const y = (v) => PT + (1 - v / top) * (H - PT - PB);
  const path = (k) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(r[k]).toFixed(1)}`).join(' ');
  const every = Math.max(1, Math.ceil(n / 8));
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = n > 1 ? Math.round(((px - PL) / (W - PL - PR)) * (n - 1)) : 0;
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const h = hover != null ? rows[hover] : null;
  return (
    <div className="sf-chart">
      <div className="sf-chart-head"><h4>{title}</h4></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="sf-chart-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} className="sf-chart-grid" />
            <text x={PL - 8} y={y(t) + 4} className="sf-chart-tick" textAnchor="end">{fmtN(t)}</text>
          </g>
        ))}
        {rows.map((r, i) => (i % every === 0 || i === n - 1) && n > 1 && (
          <text key={r.label} x={x(i)} y={H - 8} className="sf-chart-tick" textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{r.label}</text>
        ))}
        {n > 0 && <path d={path('minutes')} className="sf-line minutes" />}
        {n > 0 && <path d={path('streams')} className="sf-line streams" />}
        {h && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PT} y2={H - PB} className="sf-crosshair" />
            <circle cx={x(hover)} cy={y(h.streams)} r={4} className="sf-dot-streams" />
            <circle cx={x(hover)} cy={y(h.minutes)} r={4} className="sf-dot-minutes" />
          </g>
        )}
      </svg>
      {h && (
        <div className="sf-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <b>{h.label}</b>
          <span>{fmtN(h.streams)} stream{h.streams === 1 ? '' : 's'}</span>
          <span>{fmtN(h.minutes)} minute{h.minutes === 1 ? '' : 's'} streamed</span>
        </div>
      )}
      <div className="sf-legend"><span><i className="streams" />streams</span><span><i className="minutes" />minutes streamed</span></div>
    </div>
  );
}

export default function History({ jf, player, me, onOpenArtist, onOpenAlbum, onOpenSettings }) {
  const name = me?.Name || 'You';
  const [range, setRange] = useState(() => localStorage.getItem('conduit.histRange2') || '4w');
  const phone = usePhone();
  const [data, setData] = useState({});
  const [recent, setRecent] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [more, setMore] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => { try { localStorage.setItem('conduit.histRange2', range); } catch {} }, [range]);
  useEffect(() => {
    if (data[range]) return undefined;
    let alive = true;
    relayHistory(jf, { range }).then((r) => { if (alive) setData((d) => ({ ...d, [range]: r })); })
      .catch((e) => { if (alive) setData((d) => ({ ...d, [range]: { error: e.message } })); });
    return () => { alive = false; };
  }, [range, jf]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (recent) return undefined;
    let alive = true;
    relayHistory(jf, { recent: 1 }).then((r) => { if (alive) setRecent(r.listens || []); }).catch(() => { if (alive) setRecent([]); });
    return () => { alive = false; };
  }, [jf]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = async () => {
    if (!recent?.length || more) return;
    setMore(true);
    try { const r = await relayHistory(jf, { recent: 1, before: recent[recent.length - 1].ts }); if (!r.listens?.length) setDone(true); setRecent((cur) => [...(cur || []), ...(r.listens || [])]); }
    catch { /* keep what we have */ }
    setMore(false);
  };
  // Infinite scroll once "show all" is open: the .content panel scrolls, not the window.
  const endRef = useRef(null);
  useEffect(() => {
    if (!showAll || done) return undefined;
    const el = endRef.current; if (!el) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) loadMore(); }, { root: el.closest('.content'), rootMargin: '2000px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [showAll, done, recent]); // eslint-disable-line react-hooks/exhaustive-deps

  const st = data[range];
  const suffix = (RANGES.find((r) => r[0] === range) || RANGES[2])[2];
  // Own profile: stats.fm says "Your top tracks from the past 4 weeks".
  const desc = (what) => `Your ${what}${suffix ? ` ${suffix}` : ''}`;

  const playRow = async (rows, idx) => {
    const ids = rows.filter((r) => r.id).map((r) => r.id);
    if (!rows[idx].id) return;
    const items = await jf.itemsByIds(ids.slice(0, 100));
    const at = items.findIndex((t) => t.Id === rows[idx].id);
    if (at >= 0) player.playQueue(items, at, null);
  };
  const cover = (r, size = 320) => (r.albumId || r.id ? jf.imageUrl(r.albumId || r.id, { maxHeight: size }) : null);
  const minutes = (secs) => fmtN(Math.floor(secs / 60));
  const streams = (n) => `${fmtN(n)} stream${n === 1 ? '' : 's'}`;

  // Cards, class for class from stats.fm's TrackCard / ArtistCard / AlbumCard.
  const trackCard = (t, i) => (
    <div className="sf-track-card">
      <a role="button" tabIndex={0} onClick={() => playRow(st.topTracks, i)} title={t.id ? 'Play' : 'Not in your library'}>
        <div className="sf-square">{cover(t) ? <img src={cover(t)} alt="" loading="lazy" width={160} height={160} /> : <div className="sf-ph" />}</div>
        <h4 className="sf-clamp2">{i + 1}. {t.name}</h4>
      </a>
      <p className="sf-clamp2" title={`${minutes(t.seconds)} minutes • ${streams(t.count)}`}>
        {minutes(t.seconds)} minutes • {streams(t.count)} • <span>{t.artistId ? <a role="button" tabIndex={0} className="sf-artist-link" onClick={() => onOpenArtist(t.artistId)}>{t.artist}</a> : t.artist}</span>
      </p>
    </div>
  );
  const artistCard = (a, i) => (
    <a role="button" tabIndex={0} className="sf-artist-card" onClick={() => a.artistId && onOpenArtist(a.artistId)}>
      <div className="sf-avatar" style={{ width: 160, height: 160 }}>{a.artistId ? <img src={jf.imageUrl(a.artistId, { maxHeight: 320 })} alt="" loading="lazy" /> : <p>{(a.name || '?').slice(0, 1).toUpperCase()}</p>}</div>
      <div className="sf-artist-text">
        <h4 className="sf-clamp2">{i + 1}. {a.name}</h4>
        <p className="sf-clamp2 sf-tight">{minutes(a.seconds)} minutes • {streams(a.count)}</p>
      </div>
    </a>
  );
  const albumCard = (a, i) => (
    <a role="button" tabIndex={0} className="sf-album-card" onClick={() => a.albumId && onOpenAlbum(a.albumId)}>
      <div className="sf-square">{a.albumId ? <img src={jf.imageUrl(a.albumId, { maxHeight: 320 })} alt="" loading="lazy" width={160} height={160} /> : <div className="sf-ph" />}</div>
      <div className="sf-album-text">
        <h4 className="sf-clamp2">{i + 1}. {a.name}</h4>
        <p className="sf-truncate">{minutes(a.seconds)} minutes • {streams(a.count)}</p>
      </div>
    </a>
  );

  const tracks = Carousel({ items: st?.topTracks || [], itemHeight: 276, render: trackCard });
  const artists = Carousel({ items: st?.topArtists || [], itemHeight: 262, render: artistCard });
  const albums = Carousel({ items: st?.topAlbums || [], itemHeight: 255, render: albumCard });

  // Recent streams grouped by calendar day, newest first, with a sticky day label.
  const shownRecent = showAll ? (recent || []) : (recent || []).slice(0, 8);
  const groups = [];
  for (const l of shownRecent) { const day = LL(l.ts); const g = groups[groups.length - 1]; if (g && g.day === day) g.rows.push(l); else groups.push({ day, rows: [l] }); }

  const avatar = jf.userImageUrl({ maxHeight: 384 });
  return (
    <div className="content sf">
      {/* Hero band: bg-foreground pt-20; container; avatar 192 with a 2px page ring; name h1 extrabold. */}
      <div className="sf-hero">
        <div className="sf-container">
          <section className="sf-profile">
            <div className="sf-avatar-ring">
              <div className="sf-avatar" style={{ width: 192, height: 192 }}>
                <img src={avatar} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'grid'; }} />
                <p style={{ display: 'none' }}>{name.slice(0, 1).toUpperCase()}</p>
              </div>
            </div>
            <div className="sf-profile-text">
              <span className="sf-name-row"><h1>{name}</h1></span>
              <span className="sf-handle">@{(me?.Name || '').toLowerCase()}</span>
              {st?.connected && (
                <div className="sf-friends">
                  <span>{fmtN(st.total)} streams</span>
                  {st.sources?.spotify ? <><span className="sf-dot-wrap"><span className="sf-dot" /></span><span>{fmtN(st.sources.spotify)} from Spotify</span></> : null}
                  <span className="sf-dot-wrap"><span className="sf-dot" /></span>
                  <button className="sf-textbtn" onClick={onOpenSettings}>Edit profile</button>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="sf-container sf-body">
        {/* Range listbox (right on desktop) + the six text-only stat cards. */}
        <section className="sf-stats-row">
          {phone ? (
            /* Phone: the range as Spotify-style chips instead of a listbox. */
            <div className="sf-range-chips">
              {RANGES.map(([k, label]) => <button key={k} className={`pill ${k === range ? 'on' : ''}`} onClick={() => setRange(k)}>{label}</button>)}
            </div>
          ) : (
            <div className="sf-listbox-wrap"><RangeListbox value={range} onChange={setRange} /></div>
          )}
          {st?.connected ? (
            <ul className="sf-stats">
              {[['streams', st.streams, st.prev?.streams], ['minutes streamed', st.minutes, st.prev?.minutes], ['hours streamed', Math.round(st.minutes / 60), st.prev ? Math.round(st.prev.minutes / 60) : null], ['days streamed', st.daysStreamed, st.prev?.daysStreamed], ['different tracks', st.uniqueTracks, st.prev?.uniqueTracks], ['different artists', st.uniqueArtists, st.prev?.uniqueArtists], ['different albums', st.uniqueAlbums, st.prev?.uniqueAlbums]].map(([label, value, before]) => (
                <li key={label}><h3 className="sf-truncate">{fmtN(value)}<Delta now={value} before={before} /></h3><span className="sf-stat-label">{label}</span></li>
              ))}
            </ul>
          ) : st && !st.error && !st.connected ? (
            <div className="sf-gate">
              <div className="sf-blur">
                <ul className="sf-stats">{['minutes streamed', 'hours streamed', 'streams'].map((l) => <li key={l}><h3>?</h3><span className="sf-stat-label">{l}</span></li>)}</ul>
              </div>
              <div className="sf-gate-msg"><p>Connect ListenBrainz under Settings › Scrobbling to see your streaming history</p><button className="sf-textbtn" onClick={onOpenSettings}>Open settings</button></div>
            </div>
          ) : st?.error ? (
            <p className="sf-grey">Could not load history: {st.error}</p>
          ) : (
            <ul className="sf-stats">{[0, 1, 2, 3, 4, 5].map((i) => <li key={i}><div className="sf-skel-row"><span className="sf-skel-text" style={{ width: '50%', height: 28 }} /></div><span className="sf-skel-text" style={{ width: '70%' }} /></li>)}</ul>
          )}
        </section>

        {st?.connected && (
          <>
            <Section title="Top genres" description={desc('top genres')}>
              {st.topGenres.length ? (
                <ul className="sf-chips">{st.topGenres.map((g) => <li key={g.id} className="sf-chip"><a>{g.name.toLowerCase()}</a></li>)}</ul>
              ) : <div className="sf-empty"><p>Not enough data to complete this list</p></div>}
            </Section>
            <Section title="Top tracks" description={desc('top tracks')} tools={tracks.tools}>{tracks.body}</Section>
            <Section title="Top artists" description={desc('top artists')} tools={artists.tools}>{artists.body}</Section>
            <Section title="Top albums" description={desc('top albums')} tools={albums.tools}>{albums.body}</Section>
            <Section title="Streams and minutes streamed per day" description={desc('listening over time')}>
              {(() => {
                const days = st.perDay || [];
                const streamed = days.filter((d) => d.count > 0).length || 1;
                // Bucket by day / week / month for the segmented control.
                const bucket = (rows, mode) => {
                  if (mode === 'day') return rows.map((d) => ({ label: shortDay(d.day), streams: d.count, minutes: d.minutes }));
                  const out = new Map();
                  for (const d of rows) {
                    const dt = new Date(`${d.day}T00:00:00`);
                    const key = mode === 'month' ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}` : (() => { const m = new Date(dt); m.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); return m.toISOString().slice(0, 10); })();
                    const cur = out.get(key) || { label: mode === 'month' ? dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) : shortDay(key), streams: 0, minutes: 0 };
                    cur.streams += d.count; cur.minutes += d.minutes; out.set(key, cur);
                  }
                  return [...out.values()];
                };
                // Granularity follows the range picker: days up to 6 months, weeks for a year, months for lifetime.
                const rows = bucket(days, days.length > 200 ? 'month' : days.length > 60 ? 'week' : 'day');
                return (
                  <>
                    <div className="sf-avg-cards">
                      <div className="sf-avg-card"><h3>{fmtN(Math.round(st.streams / streamed))}</h3><span>average streams per day</span></div>
                      <div className="sf-avg-card"><h3>{fmtN(Math.round(st.minutes / streamed))}</h3><span>average minutes per day</span></div>
                    </div>
                    <div className="sf-charts">
                      <LineChart title="Daily" points={rows} />
                      <LineChart title="Cumulative" points={rows} cumulative />
                    </div>
                  </>
                );
              })()}
            </Section>
            <Section title="Listening clocks" description={desc('listening habits throughout the day')}>
              <div className="sf-clocks">
                <div className="sf-clock-box"><Clock values={st.byHour} format={(v) => streams(v)} /><p>streams</p></div>
                <div className="sf-clock-box"><Clock values={st.byHourSeconds || st.byHour} format={(v) => (st.byHourSeconds ? hm(v) : streams(v))} /><p>minutes streamed</p></div>
              </div>
            </Section>
            <Section title="Recent streams" description="Your recently played tracks">
              {recent === null ? (
                <ul className="sf-streams">{[0, 1, 2, 3].map((i) => <li key={i} className="sf-stream-skel"><span className="sf-skel-img" /><span className="sf-skel-text" style={{ width: '15rem' }} /><span className="sf-skel-text sf-right" style={{ width: '4rem' }} /></li>)}</ul>
              ) : recent.length === 0 ? (
                <div className="sf-empty sf-empty-icon">{I.musicOff}<p>Looks like you don't have any recent streams</p></div>
              ) : (
                <>
                  {groups.map((g) => (
                    <React.Fragment key={g.day}>
                      <p className="sf-day">{g.day}</p>
                      {g.rows.map((r, i) => (
                        <a key={`${r.ts}-${i}`} role="button" tabIndex={0} className="sf-stream" onClick={() => r.id && playRow(recent.map((x) => ({ ...x, name: x.track })), recent.indexOf(r))} title={r.id ? 'Play' : 'Not in your library'}>
                          <div className="sf-stream-row">
                            <div className="sf-stream-main">
                              <div className="sf-stream-img">{cover(r, 96) ? <img src={cover(r, 96)} alt="" loading="lazy" width={48} height={48} /> : <div className="sf-ph" />}</div>
                              <div className="sf-stream-text">
                                <h4 className="sf-truncate">{r.track}</h4>
                                <p className="sf-truncate">{[r.artist, r.album, r.src === 'spotify' ? 'Spotify' : null].filter(Boolean).join(' • ')}</p>
                              </div>
                            </div>
                            <p className="sf-stream-time" title={fullDate(r.ts)}>{fromNow(r.ts)}</p>
                          </div>
                          <hr />
                        </a>
                      ))}
                    </React.Fragment>
                  ))}
                  {!showAll && recent.length > 8 && <a role="button" tabIndex={0} className="sf-showall" onClick={() => setShowAll(true)}>show all</a>}
                  {showAll && !done && <div ref={endRef} className="sf-spinner-wrap">{more && <span className="sf-spinner" />}</div>}
                  {showAll && done && <div className="sf-empty sf-empty-icon"><p>No streams to load!</p></div>}
                </>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
