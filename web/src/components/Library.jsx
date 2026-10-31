import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import TrackRow, { PlayGlyph, PauseGlyph, Heart, ShuffleGlyph, LikedCover, usePhone, I as MI, shareItem } from './TrackRow.jsx';
import ContextMenu from './ContextMenu.jsx';
import { ctxOf } from '../api/context.js';
import { downloadPlaylistZip } from '../api/download.js';
import { primeKeepAlive } from '../player/keepalive.js';
import { useOfflineMode, isOffline } from '../offline/net.js';
import { canSaveOffline, useOffline, saveOffline, removeOffline, searchOffline, estimateBytes, savesLossless } from '../api/offline.js';
import { vibrantColor } from '../api/colors.js';
import { LANGUAGES, userLanguage, t, N_ } from '../i18n.js';
import { QUALITIES, THEME_PRESETS, DEFAULT_THEME, themeEquals, CROSSFADES, crossfadeLabel } from '../api/prefs.js';
import { search as relaySearch, browse as relayBrowse, discography as relayDiscography, similar as relaySimilar, requestAlbum as relayRequest, radar as relayRadar, globalSearch as relayGlobal } from '../api/search.js';
import Home, { topSongsSub } from './Home.jsx';
import History from './History.jsx';
import Downloads from './Downloads.jsx';
import { AdminSettings } from './AdminSettings.jsx';
import About from './About.jsx';
import { LogsDialog } from './Logs.jsx';
import SpotifyImport from './SpotifyImport.jsx';
import FittedTitle from './FittedTitle.jsx';
import VirtualList from './VirtualList.jsx';
import { ProgressiveImg } from './FullScreen.jsx';

export const LIKED_ID = '__liked__';

function Card({ title, subtitle, image, round, onOpen, onPlay }) {
  return (
    <div className={`card ${round ? 'round' : ''}`} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      <div className="card-art">
        {image ? <img src={image} alt="" loading="lazy" /> : <div className="ph" />}
        <button className="card-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title={t('Play')}>
          <PlayGlyph />
        </button>
      </div>
      <div className="card-title">{title}</div>
      {subtitle && <div className="card-sub">{subtitle}</div>}
    </div>
  );
}

function Shelf({ title, items, jf, round, onOpen, onPlay, onSeeAll, subtitle }) {
  if (!items.length) return null;
  return (
    <section>
      <div className="shelf-head">
        <h2 onClick={onSeeAll}>{title}</h2>
        {onSeeAll && <button onClick={onSeeAll}>{t('Show all')}</button>}
      </div>
      <div className="shelf">
        {items.map((it) => (
          <Card key={it.Id} title={it.Name}
            subtitle={subtitle ? subtitle(it) : (round ? t('Artist') : it.AlbumArtist)}
            image={jf.imageUrl(it.Id, { maxHeight: 320 })} round={round}
            onOpen={() => onOpen(it)} onPlay={() => onPlay(it)} />
        ))}
      </div>
    </section>
  );
}

// "Everywhere" searches the whole catalog (through Lidarr's metadata)
// and offers a Request button for what the library does not have.
const SEARCH_TYPES = [N_('All'), N_('Songs'), N_('Artists'), N_('Albums'), N_('Playlists'), N_('Everywhere')];

// Phone layout flag: usePhone() from TrackRow.jsx (same breakpoint as the
// phone CSS). The search page renders a flat Spotify-style result list there.

// A recent search is the thing that was opened or played from a result list:
// { q, kind, id, art, name, sub }. Spotify lists those, never the typed text.
const recentKey = (x) => `${x.kind}:${x.id}`;
// A translated sentence with {name} slots filled by elements (links, <code>).
const rich = (s, nodes) => s.split(/(\{\w+\})/).map((part, i) => { const n = /^\{(\w+)\}$/.exec(part); return n && nodes[n[1]] ? <React.Fragment key={i}>{nodes[n[1]]}</React.Fragment> : part; });

const CloseGlyph = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" /></svg>
);

// One row of the phone search list: 48pt art (round for artists), name 16,
// "Kind • detail" 13 grey. Songs are TrackRows (they carry the ⋯ menu).
function SearchRow({ image, round, name, sub, onClick, onRemove, action = null, className = '' }) {
  return (
    <div className={`srow ${round ? 'round' : ''} ${className}`} onClick={onClick} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick?.()}>
      {image ? <img className="srow-art" src={image} alt="" loading="lazy" /> : <div className="srow-art ph" />}
      <div className="srow-text">
        <span className="srow-name">{name}</span>
        {sub && <small className="srow-sub">{sub}</small>}
      </div>
      {action}
      {onRemove && (
        <button className="srow-x" onClick={(e) => { e.stopPropagation(); onRemove(); }} title={t('Remove')} aria-label={t('Remove')}>
          <CloseGlyph />
        </button>
      )}
    </div>
  );
}

// Spotify's rule of thumb for a release with no declared type: up to three
// tracks (under 30 min) is a single, up to six an EP, otherwise an album.
// Average colour straight out of Jellyfin's blurhash (its DC term is the
// mean sRGB of the image), so the hero tints itself without fetching or
// decoding the cover -- and without a canvas taint on the desktop, where the
// image is cross-origin.
const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
export function blurhashAverage(hash) {
  if (!hash || hash.length < 6) return null;
  let v = 0;
  for (const c of hash.slice(2, 6)) { const i = B83.indexOf(c); if (i < 0) return null; v = v * 83 + i; }
  return [v >> 16 & 255, v >> 8 & 255, v & 255];
}
// Spotify darkens/saturates the extracted colour so white text stays legible.
export function heroTint(rgb, phone = false) {
  if (!rgb) return null;
  let [r, g, b] = rgb.map((x) => x / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, sat = 0;
  if (max !== min) {
    const d = max - min; sat = l > .5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
  }
  if (phone) {
    // Spotify iOS headers are deep and muted (S04 navy, S05 dark green):
    // clamp S <= 65% / L <= 38% and blend 45% toward the page colour.
    sat = Math.min(.65, sat > .04 ? Math.max(sat, .3) : sat); const L = Math.min(.38, Math.max(.24, l));
    return `color-mix(in srgb, hsl(${Math.round(h * 360)} ${Math.round(sat * 100)}% ${Math.round(L * 100)}%) 55%, #121212)`;
  }
  // Spotify's header reads as a bold flat colour: saturated, mid-light.
  sat = sat > .04 ? Math.min(1, Math.max(sat * 1.3, .5)) : sat; const L = Math.min(.55, Math.max(.4, l));
  return `hsl(${Math.round(h * 360)} ${Math.round(sat * 100)}% ${Math.round(L * 100)}%)`;
}
// Fixed palette colours (mixes, browse tiles, Liked Songs) go through the
// same phone clamp as extracted ones.
function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
export function phoneHero(color) {
  const rgb = hexRgb(color);
  return rgb ? heroTint(rgb, true) : color;
}
function fmtTotal(ticks) {
  const s = Math.round((ticks || 0) / 10_000_000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? t('{h} hr {m} min', { h, m }) : t('{m} min {sec} sec', { m, sec });
}
// Spotify's phone headers: "3h 7min", "9min 39sec".
function fmtTotalShort(ticks) {
  const s = Math.round((ticks || 0) / 10_000_000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? t('{h}h {m}min', { h, m }) : t('{m}min {sec}sec', { m, sec });
}
const Clock = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z" /><path d="M8 3.25a.75.75 0 0 1 .75.75v3.25H11a.75.75 0 0 1 0 1.5H7.25V4A.75.75 0 0 1 8 3.25z" /></svg>
);
const Shuffle = () => <ShuffleGlyph size={24} />;
const Dots = () => (
  <svg viewBox="0 0 16 16" width="24" height="24" fill="currentColor"><path d="M3 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM16 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" /></svg>
);

// "All / Music / Artists" stays put on every main-pane page, like Spotify's
// home filter chips; the highlighted one says where you are.
function FilterPills({ where, setSeeAll, goHome }) {
  return (
    <div className="pills">
      <button className={`pill ${where === 'all' ? 'on' : ''}`} onClick={goHome}>{t('All')}</button>
      <button className={`pill ${where === 'albums' ? 'on' : ''}`} onClick={() => setSeeAll('albums')}>{t('Music')}</button>
      <button className={`pill ${where === 'artists' ? 'on' : ''}`} onClick={() => setSeeAll('artists')}>{t('Artists')}</button>
    </div>
  );
}

export function releaseType(album) {
  const n = album.ChildCount ?? album.SongCount ?? 0;
  const mins = (album.RunTimeTicks || 0) / 600_000_000;
  const name = album.Name || '';
  if (/various artists/i.test(album.AlbumArtist || '')) return N_('Compilation');
  if (/\b(EP)\b\s*$|\s[-–]\s*EP\s*$/i.test(name)) return N_('EP');
  if (/\s[-–]\s*Single\s*$|\(single\)$/i.test(name)) return N_('Single');
  if (n && n <= 3 && (!mins || mins < 30)) return N_('Single');
  if (n && n <= 6 && (!mins || mins < 30)) return N_('EP');
  return N_('Album');
}

export default function Library({
  jf, player, view, albums, artists, playlists, detail, setDetail, query, setQuery,
  onLike, onAddTo, onNewPlaylist, onRemoveFromPlaylist, onReorder, onOpenPlaylist, onOpenLiked, likedCount,
  onOpenArtistById, onOpenAlbumById, onExclude, onDownload,
  seeAll, setSeeAll, onEditPlaylist, onDeletePlaylist, me, onView, onOpenProfile,
  prefs, onUpdatePrefs, onUploadAvatar, avatarV, onFollowAlbum, onOpenSettings, notify,
}) {
  const [results, setResults] = useState(null);
  const phone = usePhone();
  const offline = useOffline();
  const offlineMode = useOfflineMode();
  // Phone search: tapping the field enters Spotify's focus mode (Cancel at the
  // right, browse tiles hidden, recent searches shown) until Cancel or leaving
  // the tab. Blur alone does not end it: taps on the recents would be lost.
  const [searchFocus, setSearchFocus] = useState(false);
  useEffect(() => { if (view !== 'search') setSearchFocus(false); }, [view]);
  // Cover for the Charts browse tile: the album of the most played track.
  const [chartsTop, setChartsTop] = useState(() => jf?.persisted('browse.chartsTop') || null);
  useEffect(() => {
    if (!jf) return;
    jf.topTracks({ limit: 1 }).then((t) => { const id = t[0]?.AlbumId || null; setChartsTop(id); jf._persist('browse.chartsTop', id); }).catch(() => {});
  }, [jf]);
  // Keyboard navigation in search: -1 = nothing, 0 = Top result, 1.. = songs.
  const [hi, setHi] = useState(-1);
  // Search inside the open playlist / album / Liked Songs (engine-scoped).
  const [within, setWithin] = useState('');
  const [withinRes, setWithinRes] = useState(null);
  // Recent searches are the things you actually opened or played from a
  // search (artist / album / song / playlist), never the typed string. Older
  // string entries are ignored and drop out on the next write.
  const recents = (Array.isArray(prefs?.recentSearches) ? prefs.recentSearches : []).filter((x) => x && typeof x === 'object' && x.id);
  // Browse tiles (genre buckets) for the empty search page.
  const [tiles, setTiles] = useState(() => { try { return JSON.parse(localStorage.getItem('slopify.browse') || 'null'); } catch { return null; } });
  useEffect(() => {
    if (!jf) return;
    relayBrowse(jf).then((t) => { setTiles(t); try { localStorage.setItem('slopify.browse', JSON.stringify(t)); } catch {} }).catch(() => {});
  }, [jf]);
  // A Daily Mix as a page: Jellyfin's instant mix seeded from the artist,
  // shown like a playlist (list, play, shuffle) rather than played blind.
  const openMix = async (seed, n, color) => {
    const id = `mix:${seed.Id}`;
    setDetail({ item: { Id: id, Name: t('Daily Mix {n}', { n }), Type: 'Playlist', _mix: true, _art: jf.imageUrl(seed.Id, { maxHeight: 464, full: true }), _color: color, _sub: t('{name} and more', { name: seed.Name }) }, tracks: [], kind: 'Playlist', loading: true });
    try {
      const items = await jf.instantMix(seed.Id, 50);
      setDetail((d) => (d && d.item?.Id === id ? { ...d, tracks: items, loading: false } : d));
    } catch (e) { if (!e.offline) setErr(e.message); setDetail((d) => (d && d.item?.Id === id ? { ...d, loading: false, loadFailed: true } : d)); }
  };
  // Your Top Songs <year>: the year's most played songs (server ranks the
  // account's own plays), shown like a Daily Mix.
  const openTopSongs = async (y, color) => {
    const id = `top:${y.year}`;
    setDetail({ item: { Id: id, Name: t('Your Top Songs {year}', { year: y.year }), Type: 'Playlist', _mix: true, _art: y.top ? jf.imageUrl(y.top.AlbumId, { maxHeight: 464, full: true }) : null, _color: color, _sub: topSongsSub(y.year) }, tracks: [], kind: 'Playlist', loading: true });
    try {
      const items = await jf.topSongs(y.year);
      setDetail((d) => (d && d.item?.Id === id ? { ...d, tracks: items, loading: false } : d));
    } catch (e) { if (!e.offline) setErr(e.message); setDetail((d) => (d && d.item?.Id === id ? { ...d, loading: false, loadFailed: true } : d)); }
  };
  const openRadar = async () => {
    setDetail({ item: { Id: 'radar', Name: t('Release Radar'), Type: 'Radar', _color: '#8d67ab' }, tracks: [], kind: 'Radar', releases: null });
    try {
      const r = await relayRadar(jf);
      setDetail((d) => (d && d.item?.Id === 'radar' ? { ...d, releases: r.releases || [] } : d));
    } catch (e) { setErr(e.message); setDetail((d) => (d && d.item?.Id === 'radar' ? { ...d, releases: [] } : d)); }
  };
  const openBrowse = async (tile) => {
    const genre = tile.kind === 'genre' || String(tile.id || '').startsWith('genre:') ? tile.name : null;
    setDetail({ item: { Id: `browse:${tile.id}`, Name: tile.name, Type: 'Browse', _color: tile.color, _filter: tile.filter, _genre: genre }, tracks: [], hub: null, kind: 'Browse', loading: true });
    try {
      if (genre) {
        const [hub, tr] = await Promise.all([jf.genreHub(genre), jf.genreTracks(genre)]);
        setDetail((d) => (d && d.item?.Id === `browse:${tile.id}` ? { ...d, hub, tracks: tr.slice(0, 30), loading: false } : d));
      } else {
        const r = await relaySearch(jf, '', { filter: tile.filter, limit: 50 });
        setDetail((d) => (d && d.item?.Id === `browse:${tile.id}` ? { ...d, tracks: r.tracks, loading: false } : d));
      }
    } catch { setDetail((d) => (d && d.item?.Id === `browse:${tile.id}` ? { ...d, loading: false, loadFailed: true } : d)); }
  };
  const TILE_COLORS = ['#e13300', '#1e3264', '#8d67ab', '#e8115b', '#148a08', '#0d73ec', '#7d4b32', '#ba5d07', '#477d95', '#503750', '#27856a', '#d84000', '#e1118c', '#a56752', '#4b7d9b', '#e61e32'];
  // Records what was opened or played from a search: the item (with art and
  // a "Kind • detail" line), so Recent searches lists it like Spotify's.
  const remember = (q, hit = null) => {
    if (!hit?.item?.Id || !onUpdatePrefs) return;
    const entry = { q: (q || '').trim(), kind: hit.kind, id: hit.item.Id, art: hit.item.AlbumId || hit.item.Id, name: hit.item.Name, sub: hit.sub || '' };
    const key = recentKey(entry);
    onUpdatePrefs({ recentSearches: [entry, ...recents.filter((x) => recentKey(x) !== key)].slice(0, 10) });
  };
  const forgetRecent = (entry) => onUpdatePrefs?.({ recentSearches: recents.filter((x) => recentKey(x) !== recentKey(entry)) });
  const searchRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); onView('search'); setTimeout(() => searchRef.current?.focus(), 50);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [searchType, setSearchType] = useState('All');
  // "Everywhere": Spotify's catalogue for the query, flagged with what the
  // library has and what is already requested.
  const [gres, setGres] = useState(null);
  useEffect(() => {
    if (view !== 'search' || searchType !== 'Everywhere' || !query.trim()) { setGres(null); return undefined; }
    let alive = true; const ctrl = new AbortController();
    const t = setTimeout(() => {
      relayGlobal(jf, query.trim(), ctrl.signal).then((r) => { if (alive) setGres(r); }).catch((e) => {
        if (!alive) return;
        // Any failure (a timeout aborts too) ends the spinner with a quiet
        // "couldn't search" line; the banner is kept for real errors only.
        setGres({ albums: [], artists: [], failed: true });
        if (e.name !== 'AbortError' && e.name !== 'TimeoutError') setErr(e.message);
      });
    }, 300);
    return () => { alive = false; ctrl.abort(); clearTimeout(t); };
  }, [view, query, searchType]); // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState(null);
  // An error belongs to the page it happened on, not the next one.
  useEffect(() => { setErr(null); }, [detail?.item?.Id, view, seeAll]);
  const [heroMenu, setHeroMenu] = useState(null);
  // The column header is see-through over the hero's colour band and turns
  // solid once it sticks under the top bar (Spotify does the same).
  // Every page change starts at the top; the scroller is the .content pane,
  // which React reuses between views so its scroll position would carry over.
  useEffect(() => {
    document.querySelector('.content')?.scrollTo({ top: 0 });
  }, [detail?.item?.Id, seeAll, view]);
  // Header colour: blurhash average paints instantly, the vibrant pick from
  // the cover replaces it as soon as the image is sampled.
  const [vibrant, setVibrant] = useState({});
  useEffect(() => {
    const it = detail?.item;
    if (!it || it.Id === LIKED_ID || it.Id === 'profile' || vibrant[it.Id] !== undefined) return;
    let alive = true;
    vibrantColor(jf.imageUrl(it.Id, { maxHeight: 120 })).then((rgb) => { if (alive) setVibrant((v) => ({ ...v, [it.Id]: rgb || null })); });
    return () => { alive = false; };
  }, [detail?.item?.Id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Artist page extras from the relay: the full Spotify discography flagged
  // with what the library has (the rest is requestable) and similar artists.
  const [discog, setDiscog] = useState({});
  const [simil, setSimil] = useState({});
  const [requesting, setRequesting] = useState({});
  // One failed discography fetch must not blank the artist for the whole
  // session: a failed entry counts as absent, so reopening the artist (or
  // the Retry note) fetches again.
  const loadDiscog = (it) => {
    setDiscog((d) => ({ ...d, [it.Id]: null }));
    relayDiscography(jf, it.Id, it.Name).then((r) => setDiscog((d) => ({ ...d, [it.Id]: r }))).catch(() => setDiscog((d) => ({ ...d, [it.Id]: { releases: [], failed: true } })));
  };
  useEffect(() => {
    const it = detail?.item;
    const cur = it ? discog[it.Id] : undefined;
    if (!it || detail.kind !== 'Artist' || (cur !== undefined && !cur?.failed)) return;
    let alive = true;
    loadDiscog(it);
    relaySimilar(jf, it.Id, it.Name).then((r) => { if (alive) setSimil((d) => ({ ...d, [it.Id]: r.artists || [] })); }).catch(() => {});
    return () => { alive = false; };
  }, [detail?.item?.Id, detail?.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  // Playlist page "Recommended": ten songs to add from the playlist's own
  // circle of artists (the server ranks them, minus anything the playlist has
  // or the user dislikes). Keyed by playlist id + a generation counter so
  // Refresh reseeds.
  const [reco, setReco] = useState({}); // playlistId -> { gen, items: [] | null }
  const [recoGen, setRecoGen] = useState({});
  useEffect(() => {
    const it = detail?.item;
    if (!it || detail.kind !== 'Playlist' || it.Id === LIKED_ID || it._mix || detail.loading) return undefined;
    const gen = recoGen[it.Id] || 0;
    if (reco[it.Id]?.gen === gen) return undefined;
    let alive = true;
    setReco((m) => ({ ...m, [it.Id]: { gen, items: null } }));
    (async () => {
      const have = new Set((detail.tracks || []).map((t) => t.Id));
      let out = [];
      if (have.size) {
        out = await jf.playlistRecommended(it.Id, { limit: 10, seed: gen });
      } else {
        out = await jf.topTracks({ limit: 40 }).catch(() => []);
        out = out.filter((t) => !have.has(t.Id));
      }
      if (alive) setReco((m) => ({ ...m, [it.Id]: { gen, items: out.slice(0, 10) } }));
    })().catch(() => { if (alive) setReco((m) => ({ ...m, [it.Id]: { gen, items: [] } })); });
    return () => { alive = false; };
  }, [detail?.item?.Id, detail?.kind, detail?.loading, recoGen]); // eslint-disable-line react-hooks/exhaustive-deps
  const addRecommended = async (pl, t) => {
    // Drop the row at once; the playlist refresh is onAddTo's job.
    setReco((m) => { const cur = m[pl.Id]; return cur ? { ...m, [pl.Id]: { ...cur, items: cur.items.filter((x) => x.Id !== t.Id) } } : m; });
    await onAddTo?.(pl, t);
  };

  // One vocabulary for a release's request button everywhere. The server's
  // state wins once it reports progress; until then the tap's own state shows
  // (a retry must not flash the old "failed").
  // Server vocabulary: requestStatus is queued | downloading | failed | null;
  // the POST answers status: queued | exists. 'error' is this client's own
  // "the POST itself failed".
  const PENDING = ['queued', 'exists', 'downloading'];
  const stateOf = (r) => { const mine = requesting[r.album_id]; const srv = r.requestStatus; return mine && (!srv || srv === 'failed') ? mine : srv || mine; };
  const requestUi = (st) => ({
    label: st === 'queued' ? t('Requested') : st === 'exists' ? t('Requested') : st === 'downloading' ? t('Downloading…') : st === 'failed' ? t('Retry') : st === 'error' ? t('Failed') : t('Request'),
    busy: PENDING.includes(st),
  });
  const requestRelease = async (artistId, rel) => {
    setRequesting((m) => ({ ...m, [rel.album_id]: 'queued' }));
    try {
      const r = await relayRequest(jf, rel.album_id);
      setRequesting((m) => ({ ...m, [rel.album_id]: r.status || 'queued' }));
      setDiscog((d) => { const cur = d[artistId]; if (!cur) return d; return { ...d, [artistId]: { ...cur, releases: cur.releases.map((x) => (x.album_id === rel.album_id ? { ...x, requestStatus: r.status || 'queued' } : x)) } }; });
    } catch (e) { setRequesting((m) => ({ ...m, [rel.album_id]: 'error' })); setErr(e.message); }
  };
  // While a requested release is on its way, look again every few seconds:
  // it turns playable the moment the library has it, with no new search.
  // Both polls skip hidden tabs, drop stale responses (the alive flag) and
  // give up after 30 minutes -- a request stuck in line must not poll forever.
  const POLL_MAX_MS = 30 * 60 * 1000;
  const gPending = Boolean(gres?.albums?.some((a) => !a.inLibrary && PENDING.includes(stateOf(a))));
  useEffect(() => {
    if (!gPending || !query.trim()) return undefined;
    const q = query.trim();
    let alive = true;
    const started = Date.now();
    const t = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - started > POLL_MAX_MS) { clearInterval(t); return; }
      relayGlobal(jf, q).then((r) => { if (alive) setGres(r); }).catch(() => {});
    }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [gPending, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const artistNow = detail?.kind === 'Artist' ? detail.item : null;
  const dPending = Boolean(artistNow && discog[artistNow.Id]?.releases?.some((r) => !r.inLibrary && PENDING.includes(stateOf(r))));
  useEffect(() => {
    if (!dPending) return undefined;
    const { Id, Name } = artistNow;
    let alive = true;
    const started = Date.now();
    const t = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - started > POLL_MAX_MS) { clearInterval(t); return; }
      relayDiscography(jf, Id, Name).then((r) => { if (alive) setDiscog((d) => ({ ...d, [Id]: r })); }).catch(() => {});
    }, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [dPending, artistNow?.Id]); // eslint-disable-line react-hooks/exhaustive-deps
  const headSentinelRef = useRef(null);
  const [headStuck, setHeadStuck] = useState(false);
  useEffect(() => {
    const el = headSentinelRef.current;
    if (!el) { setHeadStuck(false); return undefined; }
    const io = new IntersectionObserver(([e]) => setHeadStuck(!e.isIntersecting), { root: el.closest('.content'), rootMargin: '-6px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [detail?.item?.Id, detail?.tracks?.length]);
  const [editPl, setEditPl] = useState(null); // { name, file, preview }
  // Scrobbling form is edited locally and saved with a button (a token typed
  // character by character should not be saved 36 times).
  const [lbDraft, setLbDraft] = useState(null); // { user, token } while editing
  const [logsOpen, setLogsOpen] = useState(false); // Settings › Logs
  const [lbSaved, setLbSaved] = useState(false);
  useEffect(() => {
    const h = () => { const it = detail?.item; if (it && detail.kind === 'Playlist' && it.Id !== LIKED_ID) setEditPl({ name: it.Name, file: null, preview: null }); };
    window.addEventListener('conduit:editdetails', h);
    return () => window.removeEventListener('conduit:editdetails', h);
  }, [detail?.item?.Id, detail?.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dragIdx, setDragIdx] = useState(null);
  // Artist page "Popular": 5 rows, "See more" expands to 10, like Spotify.
  const [popularExpanded, setPopularExpanded] = useState(false);
  // Phone artist page: "Popular releases" rows first; the full discography
  // (with its filters) opens behind "See discography".
  const [discoOpen, setDiscoOpen] = useState(false);
  useEffect(() => { setDiscoOpen(false); }, [detail?.item?.Id]);
  // Follow = Jellyfin's favourite on the artist item (optimistic).
  const [followed, setFollowed] = useState({}); // artistId -> bool
  const toggleFollow = async (artist) => {
    const cur = followed[artist.Id] ?? Boolean(artist.UserData?.IsFavorite);
    setFollowed((m) => ({ ...m, [artist.Id]: !cur }));
    try { await jf.setFavorite(artist.Id, !cur); window.dispatchEvent(new CustomEvent('slopify:librarychanged')); } catch (e) { setFollowed((m) => ({ ...m, [artist.Id]: cur })); setErr(e.message); }
  };
  // Phone profile: top tracks capped at five behind "See all"; ⋯ sheet's "Change photo".
  const [profileAll, setProfileAll] = useState(false);
  const profileFileRef = useRef(null);
  // Phone settings: the Scrobbling sub-page, the option sheets, the tapped colour row.
  const [settingsSub, setSettingsSub] = useState(null); // null | 'scrobbling'
  const [settingsMenu, setSettingsMenu] = useState(null); // { x, y, kind: 'quality' | 'theme' }
  const [hexOpen, setHexOpen] = useState(null);
  useEffect(() => { setSettingsSub(null); setProfileAll(false); }, [detail?.item?.Id]);
  // Liked Songs sort on the phone ("Sort" chip): 'recent' | 'title' | 'artist' | 'album'.
  const [likedSort, setLikedSort] = useState('recent');
  const [sortMenu, setSortMenu] = useState(null);
  // Discography filter on the artist page: 'all' | 'album' | 'single' | 'compilation'.
  const [discoFilter, setDiscoFilter] = useState('all');
  const [discoLib, setDiscoLib] = useState('all'); // 'all' | 'have' | 'missing'
  // Filtering the discography must not move the page: the section keeps the
  // tallest height it has had for this artist, so a shorter list leaves blank
  // space below instead of pulling the scroll position up.
  const discoRef = useRef(null);
  const [discoMinH, setDiscoMinH] = useState(0);
  useEffect(() => { setDiscoMinH(0); }, [detail?.item?.Id]);
  // Measure only when the list can actually change size -- NOT every render
  // (the player ticks several times a second and a forced layout each time
  // made the whole app lag).
  useLayoutEffect(() => {
    const el = discoRef.current; if (!el) return;
    const h = el.offsetHeight;
    if (h > discoMinH) setDiscoMinH(h);
  }, [discoLib, discoFilter, discog, detail?.item?.Id, detail?.albums?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [overIdx, setOverIdx] = useState(null);

  useEffect(() => {
    if (view !== 'search' || !query.trim()) { setResults(null); return undefined; }
    // Jellyfin's search takes ~1s; an older query's reply must never overwrite
    // a newer one (typing "daft" showed the "daf" results, or vice versa).
    let alive = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      (isOffline() ? searchOffline(query.trim()) : relaySearch(jf, query.trim(), { signal: ctrl.signal })).then((r) => { if (alive) { setResults(r); setErr(null); setHi(-1); } }).catch((e) => { if (alive && e.name !== 'AbortError') setErr(e.message); });
    }, 60);
    return () => { alive = false; ctrl.abort(); clearTimeout(t); };
  }, [query, jf, view]);

  useEffect(() => { setWithin(''); setWithinRes(null); }, [detail?.item?.Id]);
  useEffect(() => {
    const it = detail?.item;
    if (!it || !within.trim()) { setWithinRes(null); return undefined; }
    const filter = it.Id === LIKED_ID ? `liked = "${jf.userId}"` : detail.kind === 'Album' ? `albumId = "${it.Id}"` : `playlistIds = "${it.Id}"`;
    let alive = true; const ctrl = new AbortController();
    const t = setTimeout(() => {
      relaySearch(jf, within.trim(), { filter, limit: 50, signal: ctrl.signal }).then((r) => {
        if (!alive) return;
        // Engine hits carry the ranking; take the page's own row objects (they
        // have PlaylistItemId etc.) in that order, then anything the engine
        // missed by plain substring as a safety net.
        const byId = new Map((detail.tracks || []).map((x) => [x.Id, x]));
        const q = within.trim().toLowerCase();
        const ranked = r.engine === 'meili' ? r.tracks.map((h) => { const row = byId.get(h.Id); return row ? { ...row, _snippet: h._snippet, _snippetAt: h._snippetAt } : null; }).filter(Boolean) : [];
        const seen = new Set(ranked.map((x) => x.Id));
        const local = (detail.tracks || []).filter((x) => !seen.has(x.Id) && (`${x.Name} ${(x.Artists || []).join(' ')} ${x.Album || ''}`.toLowerCase().includes(q)));
        setWithinRes([...ranked, ...local]);
      }).catch(() => { if (alive) setWithinRes((detail.tracks || []).filter((x) => `${x.Name} ${(x.Artists || []).join(' ')}`.toLowerCase().includes(within.trim().toLowerCase()))); });
    }, 80);
    return () => { alive = false; ctrl.abort(); clearTimeout(t); };
  }, [within, detail?.item?.Id, detail?.tracks?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const openAlbum = (album) => onOpenAlbumById(album.Id, album.Name ? album : null);

  const openArtist = (artist) => { setPopularExpanded(false); onOpenArtistById(artist.Id, artist); };

  const open = (it) => {
    if (it.Type === 'MusicArtist') return openArtist(it);
    if (it.Type === 'Playlist') return onOpenPlaylist(it);
    return openAlbum(it);
  };

  const playItem = async (it) => {
    try {
      let items;
      if (it.Type === 'MusicArtist') ({ items } = await jf.tracks({ artistId: it.Id, limit: 200 }));
      else if (it.Type === 'Playlist') ({ items } = await jf.playlistTracks(it.Id));
      else ({ items } = await jf.tracks({ albumId: it.Id }));
      if (items.length) player.playQueue(items, 0, ctxOf(it));
    } catch (e) { setErr(e.message); }
  };

  const startMix = async (it) => {
    try {
      const items = await jf.instantMix(it.Id);
      if (items.length) player.playQueue(items, 0);
    } catch (e) { setErr(e.message); }
  };

  const shelves = useMemo(() => {
    const shuffled = [...albums].sort(() => Math.random() - 0.5);
    return { jump: shuffled.slice(0, 8), artists: artists.slice(0, 8) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albums.length, artists.length]);

  useEffect(() => {
    if (!detail?.highlightId || !detail.tracks?.length) return;
    requestAnimationFrame(() => document.querySelector('.trackrow.hi')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }, [detail?.highlightId, detail?.tracks?.length]);
  const rowProps = (tracks, i, extra = {}, ctx = null) => ({
    track: tracks[i], n: i + 1, jf,
    active: player.nowPlayingId === tracks[i].Id,
    highlight: detail?.highlightId === tracks[i].Id,
    isPlaying: player.playing,
    onPlay: () => player.playQueue(tracks, i, ctx),
    onToggle: () => player.toggle(),
    onLike, playlists, onAddTo, onNewPlaylist,
    onOpenArtist: onOpenArtistById, onOpenAlbum: onOpenAlbumById,
    onAddToQueue: (t) => player.addToQueue([t]),
    onRadio: (t) => startMix(t),
    onExclude, onDownload,
    snippet: tracks[i]._snippet || null, snippetAt: tracks[i]._snippetAt ?? null,
    onPlayAt: (t, at) => player.playQueue(tracks, i, ctx, at),
    ...extra,
  });

  // --- detail view --------------------------------------------------------
  if (detail) {
    const { item, tracks, kind } = detail;
    const isArtist = kind === 'Artist';
    const isPlaylist = kind === 'Playlist';
    const isLiked = item.Id === LIKED_ID;
    const totalTicks = tracks.reduce((s2, t) => s2 + (t.RunTimeTicks || 0), 0);
    const tint = heroTint(vibrant[item.Id] || blurhashAverage(item.ImageBlurHashes?.Primary?.[item.ImageTags?.Primary]), phone);
    const lead = !isArtist && !isPlaylist ? (item.AlbumArtists?.[0] || null) : null;
    // The colour lives on the page wrapper so the band behind the action bar
    // (.actions::before) sees it too, not just the header.
    const banner = isArtist ? jf.bannerUrl(item) : null;
    const fixed = phone ? phoneHero : (c) => c;
    const heroStyle = item._color ? { '--hero': fixed(item._color) } : tint && !isArtist ? { '--hero': tint } : isLiked ? { '--hero': fixed('#5038a0') } : isArtist && tint ? { '--hero': tint } : undefined;

    // Drag-to-reorder for user playlists (Liked Songs is date-ordered, not reorderable).
    const dnd = (i) => (isPlaylist && !isLiked && !item._mix ? {
      draggable: true,
      onDragStart: () => setDragIdx(i),
      onDragOver: (e) => { e.preventDefault(); setOverIdx(i); },
      onDrop: (e) => {
        e.preventDefault();
        if (dragIdx != null && dragIdx !== i) onReorder(item, tracks[dragIdx], dragIdx, i);
        setDragIdx(null); setOverIdx(null);
      },
    } : {});

    if (kind === 'Radar') {
      const rels = detail.releases;
      return (
        <div className="content" style={{ '--hero': phone ? phoneHero(item._color) : item._color }}>
          <header className="hero tinted browse-hero">
            <div style={{ minWidth: 0 }}>
              <div className="kind">{t('Made for you')}</div>
              <FittedTitle text={t('Release Radar')} maxLines={2} />
              <p className="hero-meta">{rels == null ? t('Checking the last 90 days for the artists you play most…') : t('{n} new releases from the artists you play most • last 90 days', { n: rels.length })}</p>
            </div>
          </header>
          <div className="actions slim" />
          <div className="pad">
            {err && <div className="banner error">{err}</div>}
            {rels && rels.length === 0 && <p className="placeholder-note">{t('Nothing new from your top artists in the last 90 days.')}</p>}
            {rels && rels.length > 0 && (
              <div className="grid">
                {/* Two artists can share a release (splits, features): the key needs both ids. */}
                {rels.map((r) => r.inLibrary ? (
                  <Card key={`${r.album_id}:${r.artistId}`} title={r.title} subtitle={`${r.artistName} • ${r.date}`} image={jf.imageUrl(r.inLibrary, { maxHeight: 320 })}
                    onOpen={() => openAlbum({ Id: r.inLibrary, Name: r.title })} onPlay={() => playItem({ Id: r.inLibrary, Type: 'MusicAlbum' })} />
                ) : (
                  <div key={`${r.album_id}:${r.artistId}`} className="card missing">
                    <div className="card-art">
                      {r.image ? <img src={r.image} alt="" loading="lazy" /> : <div className="ph" />}
                      {(() => {
                        const { label, busy } = requestUi(stateOf(r));
                        return <button className={`card-request ${busy ? 'busy' : ''}`} disabled={busy} onClick={() => requestRelease(r.artistId, r)}>{label}</button>;
                      })()}
                    </div>
                    <div className="card-title">{r.title}</div>
                    <div className="card-sub"><button className="rowlink" onClick={() => onOpenArtistById(r.artistId)}>{r.artistName}</button> • {r.rtype ? t(r.rtype) : ''} • {r.date}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    if (kind === 'Browse') {
      const hub = detail.hub;
      const byAlbum = new Map();
      for (const x of tracks) if (x.AlbumId && !byAlbum.has(x.AlbumId)) byAlbum.set(x.AlbumId, { Id: x.AlbumId, Name: x.Album || t('Unknown album'), AlbumArtist: x.AlbumArtist || (x.Artists || [])[0] });
      // A genre mix: everything in the genre, leaning toward plays and likes.
      const playMix = async (shuffleFirst) => {
        const mix = item._genre ? await jf.genreMix(item._genre).catch(() => tracks) : tracks;
        if (!mix.length) return;
        if (shuffleFirst) player.setShuffle('on');
        player.playQueue(mix, shuffleFirst ? Math.floor(Math.random() * mix.length) : 0, item.Id);
      };
      return (
        <div className="content" style={{ '--hero': phone ? phoneHero(item._color || '#3d3c3c') : item._color || '#3d3c3c' }}>

          <header className="hero tinted browse-hero">
            <div style={{ minWidth: 0 }}>
              <div className="kind">{t('Genre')}</div>
              <FittedTitle text={item.Name} maxLines={2} />
              <p className="hero-meta">{hub ? t('{songs} songs • {albums} albums', { songs: (hub.trackCount || 0).toLocaleString(), albums: (hub.albumCount || 0).toLocaleString() }) : tracks.length ? t('{n} most played', { n: tracks.length }) : detail.loading ? t('Loading…') : detail.loadFailed ? (offlineMode ? t('Not available offline') : t('Couldn’t load this — try again')) : t('Nothing in this genre yet')}</p>
            </div>
          </header>
          <div className="actions">
            <button className="iconbtn shuffle" onClick={() => playMix(true)} title={t('Shuffle')}><Shuffle /></button>
            <button className="bigplay" onClick={() => playMix(false)} title={t('Play')}><PlayGlyph size={24} /></button>
          </div>
          <div className="pad">
            {err && <div className="banner error">{err}</div>}
            {hub?.topArtists?.length > 0 && (
              <section>
                <div className="shelf-head"><h2>{t('Top artists')}</h2></div>
                <div className="shelf">
                  {hub.topArtists.map((a) => (
                    <Card key={a.id} title={a.name} subtitle={t('Artist')} round image={jf.imageUrl(a.id, { maxHeight: 320 })} onOpen={() => onOpenArtistById(a.id)} onPlay={() => playItem({ Id: a.id, Type: 'MusicArtist', Name: a.name })} />
                  ))}
                </div>
              </section>
            )}
            {(hub?.albums?.length || byAlbum.size) > 0 && (
              <section>
                <div className="shelf-head"><h2>{t('Albums')}</h2></div>
                <div className="grid">
                  {(hub?.albums || [...byAlbum.values()].map((a) => ({ id: a.Id, name: a.Name, artist: a.AlbumArtist }))).slice(0, 18).map((a) => (
                    <Card key={a.id} title={a.name} subtitle={`${a.artist}${a.year ? ` • ${a.year}` : ''}`} image={jf.imageUrl(a.id, { maxHeight: 320 })}
                      onOpen={() => openAlbum({ Id: a.id, Name: a.name })} onPlay={() => playItem({ Id: a.id, Type: 'MusicAlbum', Name: a.name })} />
                  ))}
                </div>
              </section>
            )}
            {hub?.recent?.length > 0 && (
              <section>
                <div className="shelf-head"><h2>{t('New additions')}</h2></div>
                <div className="shelf">
                  {hub.recent.slice(0, 12).map((a) => (
                    <Card key={a.id} title={a.name} subtitle={a.artist} image={jf.imageUrl(a.id, { maxHeight: 320 })}
                      onOpen={() => openAlbum({ Id: a.id, Name: a.name })} onPlay={() => playItem({ Id: a.id, Type: 'MusicAlbum', Name: a.name })} />
                  ))}
                </div>
              </section>
            )}
            {tracks.length > 0 && (
              <section>
                <div className="shelf-head"><h2>{t('Popular')}</h2></div>
                <div className="tracklist" style={{ padding: 0 }}>
                  {tracks.map((t, i) => <TrackRow key={t.Id} {...rowProps(tracks, i, { showArt: true }, item.Id)} />)}
                </div>
              </section>
            )}
          </div>
        </div>
      );
    }

    if (kind === 'Downloads') return <Downloads jf={jf} notify={notify} onPlay={(d) => playItem({ Id: d.libraryAlbumId, Type: 'MusicAlbum', Name: d.title })} onOpen={(d) => openAlbum({ Id: d.libraryAlbumId, Name: d.title })} />;
    if (kind === 'History') {
      return <History jf={jf} player={player} me={me} onOpenArtist={onOpenArtistById} onOpenAlbum={onOpenAlbumById} onOpenSettings={onOpenSettings} />;
    }
    if (kind === 'Settings' && phone) {
      const theme = { ...DEFAULT_THEME, ...(prefs?.theme || {}) };
      const setColor = (k, v) => onUpdatePrefs({ theme: { ...theme, [k]: v } });
      const quality = QUALITIES.find((q) => q.id === (prefs?.quality || 'original')) || QUALITIES[0];
      const phoneQuality = QUALITIES.find((q) => q.id === (prefs?.phoneQuality || 'high')) || QUALITIES[1];
      const preset = THEME_PRESETS.find((p) => themeEquals(p.theme, theme));
      const cur = prefs?.listenbrainz || {};
      const Chev = () => <svg className="setrow-chev" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M6 3.5 10.5 8 6 12.5 5 11.5 8.5 8 5 4.5z" /></svg>;
      if (settingsSub === 'scrobbling') {
        const d = lbDraft || { user: cur.user || '', token: cur.token || '' };
        const dirty = d.user !== (cur.user || '') || d.token !== (cur.token || '');
        return (
          <div className="content settings-phone sub">
            <div className="settings-nav">
              <button onClick={() => setSettingsSub(null)} aria-label={t('Back')}><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M15.957 2.793a1 1 0 0 1 0 1.414L8.164 12l7.793 7.793a1 1 0 1 1-1.414 1.414L5.336 12l9.207-9.207a1 1 0 0 1 1.414 0z" /></svg></button>
              <b>{t('Scrobbling')}</b>
            </div>
            <form className="pad settings" onSubmit={async (e) => { e.preventDefault(); await onUpdatePrefs({ listenbrainz: { user: d.user.trim(), token: d.token.trim() } }); setLbDraft(null); setLbSaved(true); setTimeout(() => setLbSaved(false), 2500); }}>
              <p className="settings-caption">{t('Every song you play for at least half its length is sent to ListenBrainz as a listen. That history powers the Weekly Exploration and Daily Jams playlists on Home. Get the token from listenbrainz.org, under Settings.')}</p>
              <div className="settings-field">
                <label>{t('ListenBrainz username')}</label>
                <input className="settings-input" value={d.user} onChange={(e) => setLbDraft({ ...d, user: e.target.value })} spellCheck="false" autoCapitalize="none" placeholder={t('username')} />
              </div>
              <div className="settings-field">
                <label>{t('ListenBrainz user token')}</label>
                <input className="settings-input" type="password" value={d.token} onChange={(e) => setLbDraft({ ...d, token: e.target.value })} spellCheck="false" placeholder="xxxxxxxx-xxxx-…" />
              </div>
              <button type="submit" className="settings-save" disabled={!dirty}>{lbSaved ? t('Saved') : t('Save')}</button>
              <p className="settings-caption">{cur.token ? (cur.user ? t('Scrobbling as {user}.', { user: cur.user }) : t('Scrobbling as your account.')) : t('Scrobbling is off until a token is saved.')}</p>
              {cur.token && <button type="button" className="settings-disconnect" onClick={async () => { await onUpdatePrefs({ listenbrainz: { user: '', token: '' } }); setLbDraft(null); }}>{t('Disconnect')}</button>}
            </form>
          </div>
        );
      }
      return (
        <div className="content settings-phone">
          <div className="pad settings">
            <button className="setrow profile" onClick={onOpenProfile}>
              <span className="setrow-avatar">
                <img key={avatarV} src={jf.userImageUrl({ maxHeight: 128 })} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                <span>{(me?.Name || '?').slice(0, 1).toUpperCase()}</span>
              </span>
              <span className="setrow-text"><b>{me?.Name}</b><small>{t('View profile')}</small></span>
              <Chev />
            </button>

            <h2>{t('Playback')}</h2>
            <button className="setrow" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSettingsMenu({ x: r.left, y: r.bottom, kind: 'phoneQuality' }); }}>
              <span className="setrow-text"><b>{t('Streaming quality on phones')}</b><small>{t(phoneQuality.label)}</small></span>
              <Chev />
            </button>
            <button className="setrow" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSettingsMenu({ x: r.left, y: r.bottom, kind: 'quality' }); }}>
              <span className="setrow-text"><b>{t('Streaming quality elsewhere')}</b><small>{t(quality.label)}</small></span>
              <Chev />
            </button>
            <button className="setrow" onClick={() => onUpdatePrefs({ normalize: prefs?.normalize === false })}>
              <span className="setrow-text"><b>{t('Normalize volume')}</b><small>{prefs?.normalize === false ? t('Off') : t('On: every song at the same loudness')}</small></span>
            </button>
            <button className="setrow" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSettingsMenu({ x: r.left, y: r.bottom, kind: 'crossfade' }); }}>
              <span className="setrow-text"><b>{t('Crossfade')}</b><small>{t('{value}. Not on iPhone yet', { value: crossfadeLabel(prefs?.crossfade) })}</small></span>
              <Chev />
            </button>
            <button className="setrow" onClick={() => onUpdatePrefs({ gapless: prefs?.gapless === false })}>
              <span className="setrow-text"><b>{t('Gapless playback')}</b><small>{prefs?.gapless === false ? t('Off. Not on iPhone yet') : t('On. Not on iPhone yet')}</small></span>
            </button>

            <h2>{t('Scrobbling')}</h2>
            <button className="setrow" onClick={() => setSettingsSub('scrobbling')}>
              <span className="setrow-text"><b>{t('Scrobbling')}</b><small>{cur.token ? (cur.user ? t('On, as {user}', { user: cur.user }) : t('On, as your account')) : t('Off')}</small></span>
              <Chev />
            </button>

            <h2>{t('Import from Spotify')}</h2>
            <SpotifyImport jf={jf} />

            <h2>{t('Language')}</h2>
            <button className="setrow" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSettingsMenu({ x: r.left, y: r.bottom, kind: 'language' }); }}>
              <span className="setrow-text"><b>{t('Language')}</b><small>{LANGUAGES.find(([k]) => k === userLanguage())?.[1] || t('Automatic')}</small></span>
              <Chev />
            </button>

            <h2>{t('Appearance')}</h2>
            <button className="setrow" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSettingsMenu({ x: r.left, y: r.bottom, kind: 'theme' }); }}>
              <span className="setrow-text"><b>{t('Theme')}</b><small>{preset ? t(preset.name) : t('Custom')}</small></span>
              <Chev />
            </button>
            {[['accent', t('Accent'), t('Play button, likes, the active track')], ['bg', t('Background'), t('The page behind everything')], ['surface', t('Surface'), t('Cards, menus, the queue panel')], ['fg', t('Text'), t('Titles and icons')]].map(([k, label, hint]) => (
              <label key={k} className={`setrow color ${hexOpen === k ? 'open' : ''}`} onClick={() => setHexOpen(k)}>
                <input type="color" value={theme[k]} onChange={(e) => setColor(k, e.target.value)} />
                <span className="setrow-text"><b>{label}</b><small>{hexOpen === k ? theme[k] : hint}</small></span>
                <Chev />
              </label>
            ))}
            <button className="setrow" onClick={() => onUpdatePrefs({ theme: DEFAULT_THEME })} disabled={themeEquals(theme, DEFAULT_THEME)}>
              <span className="setrow-text"><b>{t('Reset to default')}</b></span>
            </button>
            <p className="settings-caption">{t('Saved to your account and applied to every Slopify you have open.')}</p>
            {me?.Policy?.IsAdministrator && <AdminSettings jf={jf} me={me} notify={notify} phone />}

            <h2>{t('Help')}</h2>
            <button className="setrow" onClick={() => setLogsOpen(true)}>
              <span className="setrow-text"><b>{t('Logs')}</b><small>{t('See what the app logged, report a problem')}</small></span>
              <Chev />
            </button>
            {logsOpen && <LogsDialog jf={jf} onClose={() => setLogsOpen(false)} />}
            <About jf={jf} phone />

            {settingsMenu && (
              <ContextMenu x={settingsMenu.x} y={settingsMenu.y} onClose={() => setSettingsMenu(null)}
                header={settingsMenu.kind === 'language' ? { icon: MI.gear, title: t('Language'), sub: t('Saved to your account. Automatic follows the server, then this device.') } : settingsMenu.kind === 'crossfade' ? { icon: MI.play, title: t('Crossfade'), sub: t('Songs that end by themselves fade into the next. Albums played in order stay gapless.') } : settingsMenu.kind === 'phoneQuality' ? { icon: MI.play, title: t('Streaming quality on phones'), sub: t('Applies from the next track on every phone signed in as you.') } : settingsMenu.kind === 'quality' ? { icon: MI.play, title: t('Streaming quality elsewhere'), sub: t('Desktop and tablet. Applies from the next track. Speakers always get the original file.') } : { icon: MI.photo, title: t('Theme'), sub: t('Applied to every Slopify you have open, instantly.') }}
                items={settingsMenu.kind === 'language'
                  ? [['', t('Automatic')], ...LANGUAGES].map(([k, label]) => ({ key: `l${k}`, label, icon: userLanguage() === k ? MI.check : null, onClick: () => onUpdatePrefs({ language: k }) }))
                  : settingsMenu.kind === 'crossfade'
                  ? CROSSFADES.map((sec) => ({ key: `x${sec}`, label: crossfadeLabel(sec), icon: (Number(prefs?.crossfade) || 0) === sec ? MI.check : null, onClick: () => onUpdatePrefs({ crossfade: sec }) }))
                  : settingsMenu.kind === 'phoneQuality'
                  ? QUALITIES.map((q) => ({ key: q.id, label: t(q.label), icon: q.id === phoneQuality.id ? MI.check : null, onClick: () => onUpdatePrefs({ phoneQuality: q.id }) }))
                  : settingsMenu.kind === 'quality'
                  ? QUALITIES.map((q) => ({ key: q.id, label: t(q.label), icon: q.id === quality.id ? MI.check : null, onClick: () => onUpdatePrefs({ quality: q.id }) }))
                  : THEME_PRESETS.map((p) => ({ key: p.name, label: t(p.name), icon: preset?.name === p.name ? MI.check : <span className="theme-dot" style={{ background: p.theme.accent }} />, onClick: () => onUpdatePrefs({ theme: p.theme }) }))} />
            )}
          </div>
        </div>
      );
    }
    if (kind === 'Settings') {
      const theme = { ...DEFAULT_THEME, ...(prefs?.theme || {}) };
      const setColor = (k, v) => onUpdatePrefs({ theme: { ...theme, [k]: v } });
      return (
        <div className="content">

          <div className="pad settings">
            <h1 className="greeting">{t('Settings')}</h1>

            <section className="settings-section">
              <h2>{t('Profile')}</h2>
              <div className="settings-row">
                <label className="settings-avatar" title={t('Choose photo')}>
                  <img key={avatarV} src={jf.userImageUrl({ maxHeight: 256 })} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                  <span>{t('Choose photo')}</span>
                  <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadAvatar(f); e.target.value = ''; }} />
                </label>
                <div>
                  <div className="settings-name">{me?.Name}</div>
                  <div className="settings-hint">{t('Profile picture is stored on your account and shows on every device.')}</div>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h2>{t('Playback')}</h2>
              <div className="settings-field">
                <label>{t('Streaming quality')}</label>
                <select value={prefs?.quality || 'original'} onChange={(e) => onUpdatePrefs({ quality: e.target.value })}>
                  {QUALITIES.map((q) => <option key={q.id} value={q.id}>{t(q.label)}</option>)}
                </select>
                <div className="settings-hint">{(() => { const h = QUALITIES.find((q) => q.id === (prefs?.quality || 'original'))?.hint; return h ? t(h) : t('Applies from the next track. Speakers always get the original file.'); })()}</div>
              </div>
              <div className="settings-field">
                <label>{t('Normalize volume')}</label>
                <select value={prefs?.normalize === false ? 'off' : 'on'} onChange={(e) => onUpdatePrefs({ normalize: e.target.value === 'on' })}>
                  <option value="on">{t('On')}</option>
                  <option value="off">{t('Off')}</option>
                </select>
                <div className="settings-hint">{t('Every song at the same loudness, like Spotify’s Normal (-14 LUFS). An album played in order keeps its own balance. Not applied on speakers or to lossless on iPhone.')}</div>
              </div>
              <div className="settings-field">
                <label>{t('Crossfade')}</label>
                <select value={String(Number(prefs?.crossfade) || 0)} onChange={(e) => onUpdatePrefs({ crossfade: Number(e.target.value) })}>
                  {CROSSFADES.map((sec) => <option key={sec} value={sec}>{crossfadeLabel(sec)}</option>)}
                </select>
                <div className="settings-hint">{t('Songs that end by themselves fade into the next. Albums played in order stay gapless. On computers and Android, not on iPhone or speakers yet.')}</div>
              </div>
              <div className="settings-field">
                <label>{t('Gapless playback')}</label>
                <select value={prefs?.gapless === false ? 'off' : 'on'} onChange={(e) => onUpdatePrefs({ gapless: e.target.value === 'on' })}>
                  <option value="on">{t('On')}</option>
                  <option value="off">{t('Off')}</option>
                </select>
                <div className="settings-hint">{t('The next song starts the moment one ends, so live albums and mixes play through. On computers and Android.')}</div>
              </div>
            </section>

            <section className="settings-section">
              <h2>{t('Scrobbling & discovery')}</h2>
              <div className="settings-hint" style={{ marginBottom: 12 }}>
                {rich(t('Every song you play for at least half its length is sent to {service} as a listen.'), { service: <a href="https://listenbrainz.org" target="_blank" rel="noreferrer">ListenBrainz</a> })}
                {' '}{t('That history powers the Weekly Exploration / Daily Jams playlists on Home. Get the token from listenbrainz.org → Settings.')}
              </div>
              {(() => {
                const cur = prefs?.listenbrainz || {};
                const d = lbDraft || { user: cur.user || '', token: cur.token || '' };
                const dirty = d.user !== (cur.user || '') || d.token !== (cur.token || '');
                return (
                  <form className="lb-form" onSubmit={async (e) => { e.preventDefault(); await onUpdatePrefs({ listenbrainz: { user: d.user.trim(), token: d.token.trim() } }); setLbDraft(null); setLbSaved(true); setTimeout(() => setLbSaved(false), 2500); }}>
                    <div className="settings-field">
                      <label>{t('ListenBrainz username')}</label>
                      <input className="settings-input" value={d.user} onChange={(e) => setLbDraft({ ...d, user: e.target.value })} spellCheck="false" placeholder={t('username')} />
                    </div>
                    <div className="settings-field" style={{ marginTop: 10 }}>
                      <label>{t('ListenBrainz user token')}</label>
                      <input className="settings-input" type="password" value={d.token} onChange={(e) => setLbDraft({ ...d, token: e.target.value })} spellCheck="false" placeholder="xxxxxxxx-xxxx-…" />
                    </div>
                    <div className="settings-actions">
                      <button type="submit" className="primary" disabled={!dirty}>{lbSaved ? t('Saved') : t('Save')}</button>
                      {cur.token && <button type="button" className="btn-secondary" onClick={async () => { await onUpdatePrefs({ listenbrainz: { user: '', token: '' } }); setLbDraft(null); }}>{t('Disconnect')}</button>}
                      <span className="settings-hint" style={{ margin: 0 }}>{cur.token ? (cur.user ? t('Scrobbling as {user}.', { user: cur.user }) : t('Scrobbling as your account.')) : t('Scrobbling is off until a token is saved.')}</span>
                    </div>
                  </form>
                );
              })()}
            </section>

            <section className="settings-section">
              <h2>{t('Import from Spotify')}</h2>
              <SpotifyImport jf={jf} />
            </section>

            <section className="settings-section">
              <h2>{t('Language')}</h2>
              <div className="settings-field">
                <select value={userLanguage()} onChange={(e) => onUpdatePrefs({ language: e.target.value })}>
                  <option value="">{t('Automatic')}</option>
                  {LANGUAGES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                <div className="settings-hint">{t('Saved to your account. Automatic follows the server, then this device.')}</div>
              </div>
            </section>

            <section className="settings-section">
              <h2>{t('Appearance')}</h2>
              <div className="settings-hint" style={{ marginBottom: 12 }}>{t('Saved to your account and applied to every Slopify you have open, instantly.')}</div>
              <div className="theme-presets">
                {THEME_PRESETS.map((p) => (
                  <button key={p.name} className={`theme-preset ${themeEquals(p.theme, theme) ? 'on' : ''}`} onClick={() => onUpdatePrefs({ theme: p.theme })} style={{ '--p-bg': p.theme.bg, '--p-surface': p.theme.surface, '--p-accent': p.theme.accent, '--p-fg': p.theme.fg }}>
                    <span className="theme-swatch"><i /><i /><i /></span>
                    {t(p.name)}
                  </button>
                ))}
              </div>
              <div className="theme-colors">
                {[['accent', t('Accent'), t('Play button, likes, the active track')], ['bg', t('Background'), t('The page behind everything')], ['surface', t('Surface'), t('Cards, menus, the queue panel')], ['fg', t('Text'), t('Titles and icons')]].map(([k, label, hint]) => (
                  <label key={k} className="theme-color">
                    <input type="color" value={theme[k]} onChange={(e) => setColor(k, e.target.value)} />
                    <span className="theme-color-body"><b>{label}</b><small>{hint}</small></span>
                    <code>{theme[k]}</code>
                  </label>
                ))}
              </div>
              <button className="btn-secondary" style={{ marginTop: 16 }} onClick={() => onUpdatePrefs({ theme: DEFAULT_THEME })} disabled={themeEquals(theme, DEFAULT_THEME)}>{t('Reset to default')}</button>
            </section>

            {me?.Policy?.IsAdministrator && <AdminSettings jf={jf} me={me} notify={notify} />}

            <section className="settings-section">
              <h2>{t('Help')}</h2>
              <div className="settings-hint" style={{ marginBottom: 12 }}>{t('What this device logged. Something wrong? Send a report with it.')}</div>
              <button className="btn-secondary" onClick={() => setLogsOpen(true)}>{t('Logs and problem reports')}</button>
              {logsOpen && <LogsDialog jf={jf} onClose={() => setLogsOpen(false)} />}
            </section>
            <About jf={jf} />
          </div>
        </div>
      );
    }

    if (kind === 'Profile') {
      const avatar = jf.userImageUrl({ maxHeight: 464 });
      return (
        <div className="content" style={{ '--hero': '#4a4a4a' }}>

          <header className="hero profile">
            <label className="hero-cover profile-avatar editable" title={t('Choose photo')}>
              <img key={avatarV} src={avatar} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'grid'; }} />
              <span className="profile-initial" style={{ display: 'none' }}>{(item.Name || '?').slice(0, 1).toUpperCase()}</span>
              <span className="hero-cover-edit">{t('Choose photo')}</span>
              <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadAvatar(f); e.target.value = ''; }} />
            </label>
            <div style={{ minWidth: 0 }}>
              <div className="kind">{t('Profile')}</div>
              <FittedTitle text={item.Name} maxLines={2} />
              <p className="hero-meta">{phone ? (playlists.length === 1 ? t('1 public playlist') : t('{n} public playlists', { n: playlists.length })) : <b>{playlists.length === 1 ? t('1 Public Playlist') : t('{n} Public Playlists', { n: playlists.length })}</b>}</p>
            </div>
          </header>
          {phone ? (
            /* Spotify's profile: an outlined "Edit" pill + ⋯ under the name. */
            <div className="actions profile-actions">
              <label className="btn-secondary">
                {t('Edit')}
                <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadAvatar(f); e.target.value = ''; }} />
              </label>
              <button className="iconbtn more" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHeroMenu({ x: r.left, y: r.bottom + 4 }); }} title={t('More options')}><Dots /></button>
              {heroMenu && (
                <ContextMenu x={heroMenu.x} y={heroMenu.y} onClose={() => setHeroMenu(null)}
                  header={{ icon: <span className="sheet-initial">{(item.Name || '?').slice(0, 1).toUpperCase()}</span>, title: item.Name, sub: t('Profile') }}
                  items={[
                    { label: t('Change photo'), icon: MI.photo, onClick: () => profileFileRef.current?.click() },
                    { label: t('Settings'), icon: MI.gear, onClick: () => onOpenSettings?.() },
                  ]} />
              )}
              <input ref={profileFileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadAvatar(f); e.target.value = ''; }} />
            </div>
          ) : (
            <div className="actions slim" />
          )}
          <div className="pad">
            {err && <div className="banner error">{err}</div>}
            {detail.topArtists?.length > 0 && (
              <section>
                <div className="shelf-head"><h2>{t('Top artists this month')}</h2></div>
                <p className="shelf-sub">{t('Only visible to you')}</p>
                <div className="shelf">
                  {detail.topArtists.map((a) => (
                    <Card key={a.Id} title={a.Name} subtitle={t('Artist')} round image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                      onOpen={() => onOpenArtistById(a.Id)} onPlay={() => startMix({ Id: a.Id })} />
                  ))}
                </div>
              </section>
            )}
            {tracks.length > 0 && (
              <section>
                <div className="shelf-head"><h2>{t('Top tracks this month')}</h2></div>
                <p className="shelf-sub">{t('Only visible to you')}</p>
                <div className="tracklist" style={{ padding: 0 }}>
                  {(phone && !profileAll ? tracks.slice(0, 5) : tracks).map((t, i) => <TrackRow key={t.Id} {...rowProps(tracks, i, { showArt: true }, 'profile')} />)}
                </div>
                {phone && tracks.length > 5 && (
                  <button className="btn-secondary seeall" onClick={() => setProfileAll((v) => !v)}>{profileAll ? t('See less') : t('See all')}</button>
                )}
              </section>
            )}
            {playlists.length > 0 && (
              <section>
                <div className="shelf-head"><h2>{t('Public Playlists')}</h2></div>
                <div className="shelf">
                  {playlists.map((p) => (
                    <Card key={p.Id} title={p.Name} subtitle={t('By {name}', { name: item.Name })} image={jf.imageUrl(p.Id, { maxHeight: 320 })}
                      onOpen={() => onOpenPlaylist(p)} onPlay={() => playItem(p)} />
                  ))}
                </div>
              </section>
            )}
            {detail.loading && <p className="placeholder-note">{t('Loading…')}</p>}
          </div>
        </div>
      );
    }

    // Offline, an artist never opened with a connection: nothing to show
    // (the page would sit on its skeleton title for good).
    if (isArtist && offlineMode && !detail.loading && !item.Name) {
      return (
        <div className="content offline-empty">
          <h2>{t('Not available offline')}</h2>
          <p>{t('Open this artist once with a connection, and they show up here offline too.')}</p>
        </div>
      );
    }

    // Phone: no black "dots" pane between pages; the page slides in with a
    // skeleton title and the cover, and fills as the data lands.
    if (detail.loading && !item.Name && !phone) {
      return (
        <div className="content loading-screen">
          <div className="dots"><i /><i /><i /></div>
        </div>
      );
    }

    const SORTS = [['recent', t('Recently added')], ['title', t('Title')], ['artist', t('Artist')], ['album', t('Album')]];
    return (
      <div className={`content ${phone && isLiked ? 'liked-page' : ''}`} style={heroStyle}>
        {err && <div className="banner error">{err}</div>}

        {/* Spotify's Liked Songs: "Find in Liked Songs" + Sort chip pinned at the very top, above the cover. */}
        {phone && isLiked && (
          <div className="liked-find">
            <label className="liked-find-field">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M7 1.75a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5zM.25 7a6.75 6.75 0 1 1 12.096 4.12l3.184 3.185a.75.75 0 1 1-1.06 1.06L11.284 12.18A6.75 6.75 0 0 1 .25 7z" /></svg>
              <input value={within} onChange={(e) => setWithin(e.target.value)} placeholder={t('Find in Liked Songs')} spellCheck="false" />
              {within && <button type="button" onClick={() => setWithin('')} aria-label={t('Clear')}>×</button>}
            </label>
            <button className="pill sortchip" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSortMenu({ x: r.left, y: r.bottom }); }}>{t('Sort')}</button>
            {sortMenu && (
              <ContextMenu x={sortMenu.x} y={sortMenu.y} onClose={() => setSortMenu(null)} header={{ icon: MI.playlist, title: t('Sort by'), sub: SORTS.find(([k]) => k === likedSort)?.[1] }}
                items={SORTS.map(([k, label]) => ({ key: k, label, icon: k === likedSort ? MI.check : null, onClick: () => setLikedSort(k) }))} />
            )}
          </div>
        )}

        {(() => {
          const canEdit = isPlaylist && !isLiked && !item._mix;
          return (
            <header className={`hero ${isArtist ? 'artist' : ''} ${banner ? 'with-banner' : ''} ${tint || isLiked ? 'tinted' : ''}`} style={banner ? { '--banner': `url("${banner}")` } : undefined}>
              {isLiked ? (
                <LikedCover />
              ) : phone && item._mix ? (
                /* The page cover is the Home card's composite: photo with the mix-name band. */
                <div className="hero-cover mixart" style={{ '--mix': item._color }}>
                  <img src={item._art} alt="" />
                  <div className="mixband">{item.Name}</div>
                </div>
              ) : banner ? null : (
                <button
                  className={`hero-cover ${canEdit ? 'editable' : ''}`}
                  onClick={canEdit ? () => setEditPl({ name: item.Name, file: null, preview: null }) : undefined}
                  title={canEdit ? t('Choose photo') : undefined}
                  disabled={!canEdit}
                >
                  {item._art ? <img src={item._art} alt="" /> : <ProgressiveImg lo={jf.imageUrl(item.Id, { maxHeight: 320 })} hi={jf.imageUrl(item.Id, { maxHeight: 464, full: true })} alt="" />}
                  {canEdit && <span className="hero-cover-edit">{t('Choose photo')}</span>}
                </button>
              )}
              <div style={{ minWidth: 0 }}>
                {isArtist ? (
                  <span className="verified">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                      <path d="M12 2 9.6 4.6 6.1 4l-.6 3.5L2 9.6 4.6 12 2 14.4l3.5 2.1.6 3.5 3.5-.6L12 22l2.4-2.6 3.5.6.6-3.5 3.5-2.1L19.4 12 22 9.6l-3.5-2.1-.6-3.5-3.5.6L12 2zm-1.2 13.6L7 11.8l1.4-1.4 2.4 2.4 4.8-4.8L17 9.4l-6.2 6.2z" />
                    </svg>
                    {t('Verified Artist')}
                  </span>
                ) : (
                  <div className="kind">{isLiked || item._mix ? t('Playlist') : kind === 'Album' ? t(releaseType({ ...item, ChildCount: item.ChildCount ?? tracks.length, RunTimeTicks: item.RunTimeTicks || totalTicks })) : kind === 'Playlist' ? t('Playlist') : kind}</div>
                )}
                {canEdit ? (
                  <button className="hero-title-edit" onClick={() => setEditPl({ name: item.Name, file: null, preview: null })} title={t('Edit details')}>
                    <FittedTitle text={item.Name} maxLines={2} />
                  </button>
                ) : item.Name ? (
                  <FittedTitle text={item.Name} maxLines={2} />
                ) : (
                  <i className="sk-line sk-title" aria-hidden="true" />
                )}
                {phone && !isArtist ? (
                  /* Spotify iOS: owner line (avatar + name, bold), then
                     "Playlist • 3h 7min" / "Album • 2025" in grey. */
                  <p className="hero-meta phone">
                    {lead && (
                      <span className="hero-owner">
                        <img className="hero-avatar" src={jf.imageUrl(lead.Id, { maxHeight: 48 })} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                        <button className="rowlink strong" onClick={() => onOpenArtistById(lead.Id)}>{lead.Name}</button>
                        {(item.AlbumArtists || []).slice(1).map((a) => (
                          <React.Fragment key={a.Id}>, <button className="rowlink strong" onClick={() => onOpenArtistById(a.Id)}>{a.Name}</button></React.Fragment>
                        ))}
                      </span>
                    )}
                    {isPlaylist && !item._mix && (
                      <span className="hero-owner">
                        <img className="hero-avatar" src={jf.userImageUrl({ maxHeight: 48 })} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'grid'; }} />
                        <span className="hero-avatar initial" style={{ display: 'none' }}>{(me?.Name || '?').slice(0, 1).toUpperCase()}</span>
                        <button className="rowlink strong" onClick={onOpenProfile}>{me?.Name || t('You')}</button>
                      </span>
                    )}
                    {item._mix && <span className="hero-owner"><span className="hero-avatar mixmark" style={{ '--mix': item._color }}><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6 3v7.4A2.5 2.5 0 1 0 7.5 12.7V5.2l6-1.5v5.7A2.5 2.5 0 1 0 15 11.7V1.5L6 3z" /></svg></span><b>{t('Made for you')}</b></span>}
                    <span className="hero-stats">
                      {kind === 'Album'
                        ? [t(releaseType({ ...item, ChildCount: item.ChildCount ?? tracks.length, RunTimeTicks: item.RunTimeTicks || totalTicks })), item.ProductionYear].filter(Boolean).join(' • ')
                        : isLiked ? (tracks.length === 1 ? t('Playlist • 1 song') : t('Playlist • {n} songs', { n: tracks.length }))
                        : item._mix ? [item._sub, totalTicks ? fmtTotalShort(totalTicks) : null].filter(Boolean).join(' • ')
                        : [t('Playlist'), totalTicks ? fmtTotalShort(totalTicks) : t('{n} songs', { n: tracks.length })].join(' • ')}
                    </span>
                  </p>
                ) : (
                <p className="hero-meta">
                  {lead && (
                    <>
                      <img className="hero-avatar" src={jf.imageUrl(lead.Id, { maxHeight: 48 })} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                      <button className="rowlink strong" onClick={() => onOpenArtistById(lead.Id)}>{lead.Name}</button>
                      {(item.AlbumArtists || []).slice(1).map((a) => (
                        <React.Fragment key={a.Id}>, <button className="rowlink strong" onClick={() => onOpenArtistById(a.Id)}>{a.Name}</button></React.Fragment>
                      ))}
                      {item.ProductionYear ? <> • {item.ProductionYear}</> : null}
                      {' • '}
                    </>
                  )}
                  {isPlaylist && !item._mix && <><button className="rowlink strong" onClick={onOpenProfile}>{me?.Name || t('You')}</button>{' • '}</>}
                  {item._mix && <><b>{t('Made for you')}</b>{item._sub ? ` • ${item._sub}` : ''}{' • '}</>}
                  {isArtist ? t('{n} songs in your library', { n: tracks.length }) : t('{n} songs', { n: tracks.length })}
                  {!isArtist && totalTicks ? `, ${fmtTotal(totalTicks)}` : ''}
                </p>
                )}
              </div>
            </header>
          );
        })()}

        <div className="actions">
          {(() => {
            const here = player.contextId === ctxOf(item);
            const showPause = here && player.playing;
            const shuffled = player.shuffle !== 'off';
            const all = (fn) => tracks.length && fn(tracks);
            const isFollowed = isArtist ? (followed[item.Id] ?? Boolean(item.UserData?.IsFavorite)) : false;
            // Download for offline: what is kept of this list, and the actions.
            const dl = canSaveOffline() && !item._mix && !isArtist && tracks.length ? (() => {
              const held = offline.collections?.find((c) => c.id === item.Id) || null;
              const busy = offline.active?.id === item.Id ? offline.active : null;
              const okind = isLiked ? 'liked' : kind === 'Album' ? 'album' : 'playlist';
              const download = async () => {
                // Inside this tap: let the silent stand-in start later, so the
                // download keeps going with the app in the background.
                if (!player.playing) primeKeepAlive();
                const gb = estimateBytes(tracks, savesLossless(jf)) / 1e9;
                if (!held && gb > 1 && !window.confirm(t('{n} songs, about {gb} GB. Download for offline?', { n: tracks.length, gb: gb.toFixed(1) }))) return;
                try {
                  const when = await saveOffline(jf, item, okind, tracks);
                  notify?.(when === 'later' ? t('You’re offline. It downloads when you’re back online.') : held ? t('Downloading the rest') : t('Downloading {n} songs. Keep Slopify open until it finishes.', { n: tracks.length }), 4000);
                }
                catch (e) { notify?.(e.message, 5000); }
              };
              const remove = async () => { if (window.confirm(t('Remove the downloaded songs of "{name}" from this device?', { name: item.Name }))) { await removeOffline(item.Id); notify?.(t('Download removed')); } };
              return { held, busy, download, remove };
            })() : null;
            const heroItems = [
              { label: t('Add to queue'), icon: MI.queue, offline: true, onClick: () => all((t) => player.addToQueue(t)) },
              isArtist ? { label: isFollowed ? t('Unfollow') : t('Follow'), icon: MI.follow, onClick: () => toggleFollow(item) } : null,
              !isLiked ? { label: t('Go to radio'), icon: MI.radio, onClick: () => startMix(item) } : null,
              tracks.length ? { label: t('Add to playlist'), icon: MI.plus, sub: [
                { label: t('New playlist'), icon: MI.plus, onClick: () => onNewPlaylist?.(tracks[0]) },
                // One POST with every id (the API takes an array), one toast --
                // not a request and a toast per track.
                ...playlists.filter((p) => p.Id !== item.Id).map((p) => ({ key: p.Id, label: p.Name, onClick: async () => {
                  try { await jf.addToPlaylist(p.Id, tracks.map((t) => t.Id)); notify?.(t('Added to {name}', { name: p.Name })); window.dispatchEvent(new CustomEvent('slopify:librarychanged')); }
                  catch (e) { setErr(e.message); }
                } })),
              ] } : null,
              lead ? { label: t('Go to artist'), icon: MI.artist, offline: true, onClick: () => onOpenArtistById(lead.Id) } : null,
              kind === 'Album' ? { label: item.UserData?.IsFavorite ? t('Remove from Your Library') : t('Save to Your Library'), icon: item.UserData?.IsFavorite ? MI.heartOn : MI.heart, onClick: () => onFollowAlbum?.(item, !item.UserData?.IsFavorite) } : null,
              kind === 'Album' || isArtist ? { label: t('Share'), icon: MI.share, onClick: () => shareItem({ kind: isArtist ? 'artist' : 'album', id: item.Id, title: item.Name, by: isArtist ? null : lead?.Name }) } : null,
              // Kept for offline (api/offline.js): the same actions as the header's download button.
              ...(dl ? [
                dl.held
                  ? { label: dl.busy ? t('Remove download ({done}/{total})', { done: dl.busy.done, total: dl.busy.total }) : t('Remove download'), icon: MI.trash, offline: true, onClick: dl.remove }
                  : { label: t('Download for offline'), icon: MI.down, offline: true, onClick: dl.download },
                dl.held && dl.held.have < tracks.length && !dl.busy ? { label: t('Update download ({have}/{total})', { have: dl.held.have, total: tracks.length }), icon: MI.down, offline: true, onClick: dl.download } : null,
              ] : []),
              isPlaylist && !isLiked && !item._mix && tracks.length ? { label: t('Download as zip'), icon: MI.down, onClick: () => downloadPlaylistZip(jf, item, notify) } : null,
              isPlaylist && !isLiked && !item._mix ? { sep: true } : null,
              isPlaylist && !isLiked && !item._mix ? { label: t('Edit details'), icon: MI.edit, onClick: () => setEditPl({ name: item.Name, file: null, preview: null }) } : null,
              isPlaylist && !isLiked && !item._mix ? { label: t('Delete'), icon: MI.trash, danger: true, onClick: () => { if (window.confirm(t('Delete "{name}"?', { name: item.Name }))) onDeletePlaylist(item); } } : null,
            ];
            const heroHeader = { image: isLiked ? null : (item._art || jf.imageUrl(item.Id, { maxHeight: 120 })), icon: isLiked ? <LikedCover className="ctxmenu-head-liked" heart={45} /> : undefined, round: isArtist, title: item.Name, sub: isArtist ? t('Artist') : isLiked || isPlaylist ? t('Playlist') : kind === 'Album' ? (lead?.Name || t('Album')) : kind };
            return (
              <>
                <button
                  className="bigplay"
                  onClick={() => (here ? player.toggle() : tracks.length && player.playQueue(tracks, 0, ctxOf(item)))}
                  title={showPause ? t('Pause') : t('Play')}
                >
                  {showPause ? <PauseGlyph size={24} /> : <PlayGlyph size={24} />}
                </button>
                {(!isArtist || phone) && (
                  <button className={`iconbtn shuffle ${shuffled ? 'on' : ''}`} onClick={() => player.setShuffle(shuffled ? 'off' : 'on')} title={shuffled ? t('Disable shuffle') : t('Enable shuffle')}>
                    <Shuffle />
                  </button>
                )}
                {kind === 'Album' && (() => { const saved = Boolean(item.UserData?.IsFavorite); return (
                  <button className={`iconbtn ${saved ? 'on' : ''}`} onClick={() => onFollowAlbum?.(item, !saved)} title={saved ? t('Remove from Your Library') : t('Save to Your Library')}>
                    <Heart on={saved} size={24} />
                  </button>
                ); })()}
                {isArtist && (
                  <button className={`btn-secondary follow ${isFollowed ? 'on' : ''}`} onClick={() => toggleFollow(item)} title={isFollowed ? t('Unfollow') : t('Follow')}>
                    {isFollowed ? t('Following') : t('Follow')}
                  </button>
                )}
                {dl && (() => {
                  // Spotify's download button: an outline arrow, a ring filling
                  // while it downloads, green once every song is here.
                  const { held, busy } = dl;
                  const total = busy ? busy.total : tracks.length;
                  const have = busy ? busy.done : held?.have || 0;
                  const full = held && !busy && have >= tracks.length;
                  const label = busy ? t('Downloading {have} of {total}', { have, total }) : full ? t('Downloaded') : held ? t('Downloaded {have} of {total}', { have, total: tracks.length }) : t('Download for offline');
                  return (
                    <>
                      <span className="dlwrap">
                      <button className={`iconbtn dlbtn ${held ? 'on' : ''}`} onClick={busy ? undefined : full ? dl.remove : dl.download} title={full ? t('Remove download') : label} aria-label={label}>
                        <DownloadGlyph state={busy ? 'busy' : full ? 'done' : held ? 'part' : 'none'} progress={total ? have / total : 0} />
                      </button>
                      {/* Under the button, out of the row's flow: the buttons beside it never move. */}
                      {(busy || (held && !full)) && <span className="dl-status">{busy ? `${have}/${total}` : `${have}/${tracks.length}`}</span>}
                      </span>
                    </>
                  );
                })()}
                <button className="iconbtn more" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHeroMenu({ x: r.left, y: r.bottom + 4 }); }} title={t('More options for {name}', { name: item.Name })}>
                  <Dots />
                </button>
                {heroMenu && <ContextMenu x={heroMenu.x} y={heroMenu.y} items={offlineMode ? heroOffline(heroItems) : heroItems} onClose={() => setHeroMenu(null)} header={heroHeader} />}
                {!isArtist && tracks.length > 8 && (
                  <label className="within" title={t('Search in this list')}>
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M7 1.75a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5zM.25 7a6.75 6.75 0 1 1 12.096 4.12l3.184 3.185a.75.75 0 1 1-1.06 1.06L11.284 12.18A6.75 6.75 0 0 1 .25 7z" /></svg>
                    <input value={within} onChange={(e) => setWithin(e.target.value)} placeholder={phone ? (isPlaylist ? t('Find in playlist') : t('Find in album')) : (isPlaylist ? t('Search in playlist') : t('Search in album'))} spellCheck="false" />
                    {within && <button type="button" onClick={() => setWithin('')} aria-label={t('Clear')}>×</button>}
                  </label>
                )}
              </>
            );
          })()}
        </div>

        {editPl && (
          <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditPl(null); }}>
            <form className="modal editdetails" onSubmit={(e) => { e.preventDefault(); onEditPlaylist(item, { name: editPl.name.trim(), imageFile: editPl.file }); setEditPl(null); }}>
              <h3>{t('Edit details')}</h3>
              <div className="editdetails-body">
                <label className="editdetails-cover" title={t('Choose photo')}>
                  <img src={editPl.preview || jf.imageUrl(item.Id, { maxHeight: 360, full: true })} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                  <span>{t('Choose photo')}</span>
                  <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setEditPl((d) => ({ ...d, file: f, preview: URL.createObjectURL(f) })); }} />
                </label>
                <input value={editPl.name} onChange={(e) => setEditPl((d) => ({ ...d, name: e.target.value }))} placeholder={t('Add a name')} autoFocus spellCheck="false" />
              </div>
              <div className="modal-actions">
                <button type="submit" className="primary" disabled={!editPl.name.trim()}>{t('Save')}</button>
              </div>
            </form>
          </div>
        )}

        {isArtist ? (
          <div className="pad">
            <section>
              <div className="shelf-head"><h2>{t('Popular')}</h2></div>
              <div className="tracklist popular" style={{ padding: 0 }}>
                {/* Spotify's Popular rows: 40px cover next to the number
                    (chunk_xpui-routes-artist: flex:0 0 40px, radius 4px),
                    title only, no artist line. */}
                {tracks.slice(0, popularExpanded ? 10 : 5).map((x, i) => <TrackRow key={x.Id} {...rowProps(tracks, i, { showArt: true, hideArtists: true, subtitle: phone ? (x.UserData?.PlayCount > 0 ? (x.UserData.PlayCount === 1 ? t('1 play') : t('{n} plays', { n: x.UserData.PlayCount.toLocaleString() })) : x.Album || null) : null }, ctxOf(item))} />)}
              </div>
              {tracks.length > 5 && (
                <button className="seemore" onClick={() => setPopularExpanded((v) => !v)}>
                  {popularExpanded ? t('Show less') : t('See more')}
                </button>
              )}
            </section>
            {(() => {
              const dg = discog[item.Id];
              const rels = dg?.releases || [];
              // Library albums Jellyfin knows but the discography call has not (yet) covered.
              const libOnly = (detail.albums || []).filter((a) => !rels.some((r) => r.inLibrary === a.Id));
              const all = [
                ...rels.map((r, i) => ({ key: `${r.inLibrary || r.album_id || r.title}-${i}`, r, type: r.rtype || 'Album', year: r.year, inLib: r.inLibrary })),
                ...libOnly.map((a) => ({ key: a.Id, r: { title: a.Name, inLibrary: a.Id, image: null }, type: releaseType(a), year: a.ProductionYear ? String(a.ProductionYear) : '', inLib: a.Id })),
              ];
              if (!all.length && dg !== null && !dg?.failed) return null;
              const counts = all.reduce((m, x) => ({ ...m, [x.type]: (m[x.type] || 0) + 1 }), {});
              const pills = [
                ['all', t('All')],
                counts.Album ? ['album', t('Albums')] : null,
                counts.Single ? ['single', t('Singles')] : null,
                counts.EP ? ['ep', t('EPs')] : null,
                counts.Compilation ? ['compilation', t('Compilations')] : null,
              ].filter(Boolean);
              const libPills = [['all', t('Everything')], ['have', t('In your library')], ['missing', t('Not in library')]];
              // Newest first, one timeline; library releases stand out, the rest are dimmed with Request.
              const yearOf = (x) => Number(String(x.r.date || x.year || '').slice(0, 4)) || 0;
              const shown = all.filter((x) =>
                discoFilter === 'all' ? true
                  : discoFilter === 'album' ? x.type === 'Album'
                  : discoFilter === 'single' ? x.type === 'Single'
                  : discoFilter === 'ep' ? x.type === 'EP'
                  : x.type === 'Compilation')
                .filter((x) => discoLib === 'all' ? true : discoLib === 'have' ? Boolean(x.inLib) : !x.inLib)
                .sort((a, b) => (yearOf(b) - yearOf(a)) || String(b.r.date || '').localeCompare(String(a.r.date || '')));
              const have = all.filter((x) => x.inLib).length;
              const requestBtn = (r) => {
                const { label, busy } = requestUi(stateOf(r));
                return (
                  <button className={`card-request ${busy ? 'busy' : ''}`} disabled={busy || !r.album_id} onClick={(e) => { e.stopPropagation(); requestRelease(item.Id, r); }} title={t('Download this release into your library')}>
                    {label}
                  </button>
                );
              };
              // Phone: Spotify's "Popular releases" -- five rows, newest first,
              // then "See discography" reveals the full grid with its filters.
              if (phone && !discoOpen) {
                const top = [...all].sort((a, b) => (yearOf(b) - yearOf(a)) || String(b.r.date || '').localeCompare(String(a.r.date || ''))).slice(0, 5);
                return (
                  <section className="releases">
                    <div className="shelf-head"><h2>{t('Popular releases')}</h2></div>
                    {dg === null && !top.length && <p className="placeholder-note">{t('Loading…')}</p>}
                    {dg?.failed && <p className="placeholder-note">{offlineMode ? t('Not available offline.') : <>{t('Couldn’t load the full discography.')} <button className="rowlink" onClick={() => loadDiscog(item)}>{t('Retry')}</button></>}</p>}
                    {top.map(({ key, r, type, year, inLib }) => (
                      <div key={key} className={`release ${inLib ? '' : 'missing'}`} role="button" tabIndex={0}
                        onClick={inLib ? () => openAlbum({ Id: inLib, Name: r.localName || r.title }) : undefined}
                        onKeyDown={inLib ? (e) => e.key === 'Enter' && openAlbum({ Id: inLib, Name: r.localName || r.title }) : undefined}>
                        {inLib ? <img src={jf.imageUrl(inLib, { maxHeight: 160 })} alt="" loading="lazy" /> : r.image ? <img src={r.image} alt="" loading="lazy" /> : <span className="release-ph"><svg viewBox="0 0 16 16" width="28" height="28" fill="currentColor"><path d="M6 3v7.4A2.5 2.5 0 1 0 7.5 12.7V5.2l6-1.5v5.7A2.5 2.5 0 1 0 15 11.7V1.5L6 3z" /></svg></span>}
                        <span className="release-text">
                          <span className="release-name">{r.localName || r.title}</span>
                          <span className="release-sub">{[year, type && t(type)].filter(Boolean).join(' • ')}</span>
                        </span>
                        {!inLib && requestBtn(r)}
                      </div>
                    ))}
                    {all.length > 0 && (
                      <button className="btn-secondary seedisco" onClick={() => setDiscoOpen(true)}>{t('See discography')}</button>
                    )}
                  </section>
                );
              }
              return (
                <section ref={discoRef} style={discoMinH ? { minHeight: discoMinH } : undefined}>
                  <div className="shelf-head">
                    <h2>{t('Discography')}</h2>
                    {dg === null ? <span className="settings-hint">{t('Loading…')}</span> : all.length ? <span className="settings-hint">{t('{have} of {total} in your library', { have, total: all.length })}</span> : null}
                  </div>
                  {dg?.failed && <p className="placeholder-note">{offlineMode ? t('Not available offline.') : <>{t('Couldn’t load the full discography.')} <button className="rowlink" onClick={() => loadDiscog(item)}>{t('Retry')}</button></>}</p>}
                  <div className="disco-filters">
                    <div className="pills">
                      {libPills.map(([k, label]) => (
                        <button key={k} className={`pill ${discoLib === k ? 'on' : ''}`} onClick={() => setDiscoLib(k)}>{label}</button>
                      ))}
                    </div>
                    {pills.length > 2 && (
                      <div className="pills">
                        {pills.map(([k, label]) => (
                          <button key={k} className={`pill ${discoFilter === k ? 'on' : ''}`} onClick={() => setDiscoFilter(k)}>{label}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid">
                    {shown.map(({ key, r, type, year, inLib }) => inLib ? (
                      <Card key={key} title={r.localName || r.title} subtitle={year ? `${year} • ${t(type)}` : t(type)}
                        image={jf.imageUrl(inLib, { maxHeight: 320 })} onOpen={() => openAlbum({ Id: inLib, Name: r.localName || r.title })} onPlay={() => playItem({ Id: inLib, Type: 'MusicAlbum' })} />
                    ) : (
                      <div key={key} className="card missing" role="group">
                        <div className="card-art">
                          {r.image ? <img src={r.image} alt="" loading="lazy" /> : <div className="ph note" />}
                          {requestBtn(r)}
                        </div>
                        <div className="card-title">{r.title}</div>
                        <div className="card-sub">{year ? `${year} • ${t(type)}` : t(type)}{!phone && r.total_tracks ? ` • ${r.total_tracks === 1 ? t('1 track') : t('{n} tracks', { n: r.total_tracks })}` : ''}</div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })()}
            {(detail.appearsOn || []).length > 0 && (
              <section>
                <div className="shelf-head"><h2>{t('Appears On')}</h2></div>
                <div className="shelf">
                  {detail.appearsOn.map((a) => (
                    <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist || (a.AlbumArtists || [])[0]?.Name} image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                      onOpen={() => openAlbum(a)} onPlay={() => playItem(a)} />
                  ))}
                </div>
              </section>
            )}
            {(simil[item.Id] || []).length > 0 && (
              <section>
                <div className="shelf-head"><h2>{t('Fans also like')}</h2></div>
                <div className="shelf">
                  {simil[item.Id].map((a) => (
                    <Card key={a.id} title={a.name} subtitle={t('Artist')} round image={jf.imageUrl(a.id, { maxHeight: 320 })} onOpen={() => onOpenArtistById(a.id)} onPlay={() => startMix({ Id: a.id })} />
                  ))}
                </div>
              </section>
            )}
            {item.Overview && (
              <section>
                <div className="shelf-head"><h2>{t('About')}</h2></div>
                <p className="placeholder-note">{item.Overview}</p>
              </section>
            )}
          </div>
        ) : (
          <div className="tracklist">
            {tracks.length > 0 && <div ref={headSentinelRef} style={{ height: 1 }} />}
            {tracks.length > 0 && (
              <div className={`trackhead ${isPlaylist ? 'with-art' : ''} ${headStuck ? 'stuck' : ''}`}>
                <span className="th-n">#</span>
                {isPlaylist && <span />}
                <span>{t('Title')}</span>
                <span>{isPlaylist ? t('Album') : ''}</span>
                <span />
                <span className="th-dur"><Clock /></span>
                <span />
              </div>
            )}
            {tracks.length === 0 && !detail.loading && (
              <p className="placeholder-note">
                {detail.loadFailed ? (offlineMode ? t('Not available offline. Open it once with a connection, or download it.') : t('Couldn’t load this — try again.'))
                  : isLiked ? t('Songs you like will appear here. Save songs by tapping the heart icon.')
                  : isPlaylist ? t('This playlist is empty.')
                  : kind === 'Album' ? t('This album is empty.')
                  : t('Nothing here yet.')}
              </p>
            )}
            {/* Rows still on their way: grey placeholders the page is laid out on, like Spotify's. */}
            {tracks.length === 0 && detail.loading && (
              <div className="skeleton-rows" aria-hidden="true">
                {Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton-row">{isPlaylist && <i className="sk-art" />}<span><i className="sk-line w1" /><i className="sk-line w2" /></span></div>)}
              </div>
            )}
            {within.trim() && withinRes && withinRes.length === 0 && (
              <p className="placeholder-note">{t('No matches for “{query}” in here.', { query: within })}</p>
            )}
            {tracks.length > 0 && (() => {
              let shown = within.trim() && withinRes ? withinRes : tracks;
              if (phone && isLiked && likedSort !== 'recent') {
                const key = (t) => (likedSort === 'title' ? t.Name : likedSort === 'artist' ? (t.Artists || [])[0] || t.AlbumArtist : t.Album) || '';
                shown = [...shown].sort((a, b) => key(a).localeCompare(key(b), undefined, { sensitivity: 'base' }));
              }
              const filtered = shown !== tracks; return (
              <VirtualList
                items={shown}
                rowHeight={filtered && shown.some((t) => t._snippet) ? (phone ? 84 : 76) : phone ? 64 : 56}
                getKey={(t, i) => t.PlaylistItemId || `${t.Id}-${i}`}
                renderRow={(t, i) => (
                  <div className={overIdx === i && dragIdx != null && !filtered ? 'dropbefore' : ''}>
                    <TrackRow
                      {...rowProps(shown, i, {
                        showArt: isPlaylist,
                        hideAlbum: kind === 'Album',
                        onRemove: isPlaylist && !isLiked && !item._mix ? () => onRemoveFromPlaylist(item, t) : undefined,
                        ...(filtered ? {} : dnd(i)),
                      }, item.Id)}
                    />
                  </div>
                )}
              />
            ); })()}
            {isPlaylist && !isLiked && !item._mix && !detail.loading && !within.trim() && !offlineMode && (() => {
              const rec = reco[item.Id];
              if (!rec || (rec.items && rec.items.length === 0)) return null;
              return (
                <section className="reco">
                  <div className="reco-head">
                    <div>
                      <h2>{t('Recommended')}</h2>
                      <p>{t('Based on what’s in this playlist')}</p>
                    </div>
                  </div>
                  {rec.items === null ? <p className="placeholder-note">{t('Finding songs…')}</p> : rec.items.map((x, i) => (
                    <div key={x.Id} className="reco-row">
                      <TrackRow
                        {...rowProps(rec.items, i, { showArt: true }, null)}
                        n=""
                      />
                      <button className="reco-add" onClick={() => addRecommended(item, x)}>{t('Add')}</button>
                    </div>
                  ))}
                  {rec.items !== null && (
                    <button className="reco-refresh" onClick={() => setRecoGen((g) => ({ ...g, [item.Id]: (g[item.Id] || 0) + 1 }))}>{t('Refresh')}</button>
                  )}
                </section>
              );
            })()}
          </div>
        )}
      </div>
    );
  }

  // --- see-all grid -------------------------------------------------------
  if (seeAll) {
    const items = seeAll === 'artists' ? artists : albums;
    return (
      <div className="content">
        <div className="contentbar">
          <FilterPills where={seeAll} setSeeAll={setSeeAll} goHome={() => onView('home')} />
        </div>
        <div className="pad">
          <h2 style={{ margin: '0 0 16px', fontSize: 24 }}>{seeAll === 'artists' ? t('Artists') : t('Albums')}</h2>
          <div className="grid">
            {items.map((it) => (
              <Card key={it.Id} title={it.Name} subtitle={seeAll === 'artists' ? t('Artist') : it.AlbumArtist}
                image={jf.imageUrl(it.Id, { maxHeight: 320 })} round={seeAll === 'artists'}
                onOpen={() => open(it)} onPlay={() => playItem(it)} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // --- search -------------------------------------------------------------
  if (view === 'search') {
    const r = results;
    // Top result comes from the engine (exact artist > exact album > best score).
    const top = r?.top || null;
    const show = (t) => searchType === 'All' || searchType === t;
    const subOf = (kind, item) => kind === 'Artist' ? t('Artist')
      : kind === 'Album' ? [t('Album'), item.ProductionYear || '', item.AlbumArtist || ''].filter(Boolean).join(' • ')
      : kind === 'Playlist' ? t('Playlist')
      : [t('Song'), item.Artists?.join(', ') || item.AlbumArtist || ''].filter(Boolean).join(' • ');
    const kindLabel = (k) => ({ Artist: t('Artist'), Album: t('Album'), Song: t('Song'), Playlist: t('Playlist') })[k] || k;
    const hit = (kind, item) => ({ kind, item, sub: subOf(kind, item) });
    const actOn = (kind, item) => {
      remember(query, hit(kind, item));
      // A song opens its album (its single's page): playing stays on the
      // explicit play affordances, like the top result card.
      if (kind === 'Song') openAlbum({ Id: item.AlbumId, Name: item.Album });
      else if (kind === 'Playlist') onOpenPlaylist(item);
      else open(item);
    };
    // Rows on the search page: any way of playing one records the query.
    const searchRow = (i, extra = {}) => rowProps(r.tracks, i, {
      showArt: true,
      onPlay: () => { remember(query, hit('Song', r.tracks[i])); player.playQueue(r.tracks, i, null); },
      onRowOpen: () => { remember(query, hit('Song', r.tracks[i])); openAlbum({ Id: r.tracks[i].AlbumId, Name: r.tracks[i].Album }); },
      onPlayAt: (t, at) => { remember(query, hit('Song', r.tracks[i])); player.playQueue(r.tracks, i, null, at); },
      ...extra,
    });
    const onSearchKey = (e) => {
      if (!r) return;
      const n = (top ? 1 : 0) + Math.min(r.tracks.length, 4);
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(n - 1, h + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(-1, h - 1)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (hi <= 0) { if (top) actOn(top.kind, top.item, 0); else if (r.tracks[0]) actOn('Song', r.tracks[0], 0); }
        else { const idx = hi - (top ? 1 : 0); actOn('Song', r.tracks[idx], idx); }
      } else if (e.key === 'Escape') { setQuery(''); }
    };

    // Phone: Spotify's flat result list. The engine's per-type lists are each
    // in score order, so the top result leads and the types take turns, then
    // the tail of each. No headings, no Top result card.
    const phoneRows = (() => {
      if (!phone || !r || r.scoped || searchType === 'Everywhere') return null;
      const rows = [], seen = new Set();
      const push = (kind, item, i = -1) => { const k = `${kind}:${item.Id}`; if (seen.has(k)) return; seen.add(k); rows.push({ kind, item, i }); };
      const songs = show('Songs') ? r.tracks : [], ars = show('Artists') ? r.artists : [], als = show('Albums') ? r.albums : [], pls = show('Playlists') ? r.playlists : [];
      if (top && show(`${top.kind}s`)) push(top.kind, top.item, top.kind === 'Song' ? r.tracks.findIndex((t) => t.Id === top.item.Id) : -1);
      const take = (kind, list, n) => list.slice(0, n).forEach((x, i) => push(kind, x, kind === 'Song' ? i : -1));
      take('Song', songs, 4); take('Artist', ars, 2); take('Album', als, 2); take('Playlist', pls, 1);
      songs.forEach((x, i) => push('Song', x, i)); ars.forEach((x) => push('Artist', x)); als.forEach((x) => push('Album', x)); pls.forEach((x) => push('Playlist', x));
      return rows;
    })();
    const actOnPhone = (kind, item) => {
      remember(query, hit(kind, item));
      if (kind === 'Song') openAlbum({ Id: item.AlbumId, Name: item.Album });
      else if (kind === 'Playlist') onOpenPlaylist(item);
      else open(item);
    };
    // A tapped recent search: reopen the artist / album / playlist; a song
    // opens its album (the play button on its card still replays it).
    const recentItem = (x) => ({ Id: x.id, Name: x.name, AlbumId: x.art, Type: x.kind === 'Artist' ? 'MusicArtist' : x.kind === 'Playlist' ? 'Playlist' : x.kind === 'Album' ? 'MusicAlbum' : 'Audio' });
    const playRecent = async (x) => {
      if (x.kind === 'Song') { try { const t = await jf.itemById(x.id); if (t) player.playQueue([t], 0, null); } catch (e) { setErr(e.message); } }
      else playItem(recentItem(x));
    };
    const openRecent = async (x) => {
      if (x.kind === 'Song') {
        if (x.art) openAlbum({ Id: x.art, Name: '' });
        else try { const t = await jf.itemById(x.id); if (t?.AlbumId) openAlbum({ Id: t.AlbumId, Name: t.Album }); } catch (e) { setErr(e.message); }
      } else if (x.kind === 'Artist') openArtist({ Id: x.id, Name: x.name, Type: 'MusicArtist' });
      else if (x.kind === 'Playlist') onOpenPlaylist({ Id: x.id, Name: x.name, Type: 'Playlist' });
      else openAlbum({ Id: x.id, Name: x.name, Type: 'MusicAlbum' });
      remember(x.q, { kind: x.kind, item: { Id: x.id, Name: x.name, AlbumId: x.art }, sub: x.sub });
    };
    const typeChips = (r || (searchType === 'Everywhere' && query.trim())) && (
      <div className="searchtypes">
        {SEARCH_TYPES.map((ty) => (
          <button key={ty} className={`pill ${searchType === ty ? 'on' : ''}`} onClick={(e) => { setSearchType(ty); e.currentTarget.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); }}>{t(ty)}</button>
        ))}
      </div>
    );
    const browseTiles = (tiles || []).map((t, i) => (
      <button key={t.id} className="tile" style={{ '--tile': t.color || TILE_COLORS[i % TILE_COLORS.length] }} onClick={() => openBrowse(t)}>
        <span>{t.name}</span>{t.coverId && <img src={jf.imageUrl(t.coverId, { maxHeight: 200 })} alt="" />}
      </button>
    ));
    // Phone: recents only in focus mode; the browse page is field + tiles.
    const focusMode = phone && (searchFocus || Boolean(query.trim()));
    const mixCover = (jf.persisted('home.topArtists') || [])[0]?.Id || artists[0]?.Id || null;
    const newestCover = (jf.persisted('home.added') || [])[0]?.Id || albums[0]?.Id || null;
    const chartsCover = chartsTop || (jf.persisted('home.recent') || [])[0]?.Id || albums[1]?.Id || null;
    const startTiles = (
      <>
        {/* Covers: Daily Mix 1's seed artist, the newest album, the most
            played track's album (Home persists the first two). */}
        <button className="tile" style={{ '--tile': '#1e3264' }} onClick={() => onView('home')}>
          <span>{t('Made For You')}</span>{mixCover && <img src={jf.imageUrl(mixCover, { maxHeight: 200 })} alt="" />}
        </button>
        <button className="tile" style={{ '--tile': '#e13300' }} onClick={() => setSeeAll('albums')}>
          <span>{t('New Releases')}</span>{newestCover && <img src={jf.imageUrl(newestCover, { maxHeight: 200 })} alt="" />}
        </button>
        <button className="tile" style={{ '--tile': '#8d67ab' }} onClick={() => openBrowse({ id: 'charts', name: t('Charts'), color: '#8d67ab', filter: 'plays > 0' })}>
          <span>{t('Charts')}</span>{chartsCover && <img src={jf.imageUrl(chartsCover, { maxHeight: 200 })} alt="" />}
        </button>
        <button className="tile" style={{ '--tile': '#5038a0' }} onClick={onOpenLiked}>
          <span>{t('Liked Songs')}</span><LikedCover className="tile-liked" heart={50} />
        </button>
      </>
    );

    return (
      <div className="content">
        <div className="contentbar">
          <input ref={searchRef} className="search" autoFocus={!phone} placeholder={phone ? t('What do you want to listen to?') : t('What do you want to play?')}
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} spellCheck="false"
            onFocus={() => setSearchFocus(true)} />
          {phone && focusMode && (
            <button className="search-cancel" onClick={() => { setQuery(''); setSearchFocus(false); searchRef.current?.blur(); }}>{t('Cancel')}</button>
          )}
          {/* Invisible marker for the tests: which engine answered and how fast. */}
          {r?.tookMs != null && <span className="search-took" hidden>{r.engine === 'meili' ? `${r.tookMs} ms` : 'basic search'}</span>}
          {/* On the phone the filter chips stick with the bar. */}
          {phone && typeChips}
        </div>
        {!phone && typeChips}
        <div className="pad">
          {err && <div className="banner error">{err}</div>}
          {!query.trim() && recents.length > 0 && (!phone || focusMode) && (phone ? (
            <section className="recentlist">
              <div className="shelf-head"><h2>{t('Recent searches')}</h2></div>
              {recents.map((x) => (
                <SearchRow key={recentKey(x)} name={x.name} sub={x.sub || kindLabel(x.kind)} round={x.kind === 'Artist'}
                  image={jf.imageUrl(x.art || x.id, { maxHeight: 96 })}
                  onClick={() => openRecent(x)} onRemove={() => forgetRecent(x)} />
              ))}
              <button className="pill clear-recents" onClick={() => onUpdatePrefs?.({ recentSearches: [] })}>{t('Clear recent searches')}</button>
            </section>
          ) : (
            <section>
              <div className="shelf-head"><h2>{t('Recent searches')}</h2><button onClick={() => onUpdatePrefs?.({ recentSearches: [] })}>{t('Clear recent searches')}</button></div>
              <div className="grid recents">
                {recents.map((x) => (
                  <div key={recentKey(x)} className="recentcard">
                    <Card title={x.name} subtitle={x.sub || kindLabel(x.kind)} round={x.kind === 'Artist'}
                      image={jf.imageUrl(x.art || x.id, { maxHeight: 320 })} onOpen={() => openRecent(x)} onPlay={() => playRecent(x)} />
                    <button className="recent-x" onClick={() => forgetRecent(x)} title={t('Remove')} aria-label={t('Remove')}><CloseGlyph /></button>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {!query.trim() && phone && !focusMode && (
            <section className="startbrowse">
              <div className="shelf-head"><h2>{t('Start browsing')}</h2></div>
              <div className="tilegrid">{startTiles}</div>
            </section>
          )}
          {!query.trim() && !focusMode && (
            <section className="browseall">
              <div className="shelf-head"><h2>{t('Browse all')}</h2></div>
              <div className="tilegrid">
                {!phone && startTiles}
                {browseTiles}
              </div>
            </section>
          )}
          {!query.trim() && !phone && (
            <section>
              <div className="shelf-head"><h2>{t('Tips')}</h2></div>
              <p className="placeholder-note">{rich(t('Type a lyric you remember. Narrow with {artist}, {album}, {year}, {years}, {genre} or {liked}. Typos are fine. Press {slash} anywhere to get here, arrows and Enter to open.'), { artist: <code>artist:</code>, album: <code>album:</code>, year: <code>year:2013</code>, years: <code>year:2010-2015</code>, genre: <code>genre:house</code>, liked: <code>liked:</code>, slash: <code>/</code> })}</p>
            </section>
          )}
          {r?.chips?.length > 0 && (
            <div className="pills chips">
              {r.chips.map((c, i) => <span key={i} className="pill on">{c.key}: {c.label}</span>)}
            </div>
          )}

          {r && r.scoped && r.tracks.length > 0 && (
            <section>
              <div className="shelf-head"><h2>{t('Songs')}</h2></div>
              <div className="tracklist" style={{ padding: 0 }}>
                {r.tracks.map((t, i) => <TrackRow key={t.Id} {...searchRow(i, { highlight: hi === i })} />)}
              </div>
            </section>
          )}

          {searchType === 'Everywhere' && query.trim() && (() => {
            const btn = (a) => {
              const { label, busy } = requestUi(stateOf(a));
              return (
                <button className={`card-request ${busy ? 'busy' : ''}`} disabled={busy} onClick={(e) => { e.stopPropagation(); requestRelease(a.artistId, a); }} title={t('Download this release into your library')}>{label}</button>
              );
            };
            const openOrRequest = (a) => { if (a.inLibrary) openAlbum({ Id: a.inLibrary, Name: a.title }); else if (!stateOf(a)) requestRelease(a.artistId, a); };
            // A release that is in the library plays straight from its result.
            const playBtn = (a) => (
              <button className="card-play" onClick={(e) => { e.stopPropagation(); playItem({ Id: a.inLibrary, Type: 'MusicAlbum', Name: a.title }); }} title={t('Play')}><PlayGlyph /></button>
            );
            const sub = (a) => [a.rtype && t(a.rtype), a.year, a.artist].filter(Boolean).join(' • ');
            if (!gres) return <p className="placeholder-note gsearch-note">{t('Searching everywhere…')}</p>;
            if (gres.failed) return <p className="placeholder-note gsearch-note">{t('Couldn’t search everywhere right now.')}</p>;
            if (!gres.albums?.length) return (
              <div className="search-empty"><b>{t('Couldn’t find “{query}” anywhere', { query: query.trim() })}</b><span>{t('Try a different spelling, or the artist and album together.')}</span></div>
            );
            return (
              <section className="gsearch">
                <div className="shelf-head"><h2>{t('Everywhere')}</h2><span className="settings-hint">{t('{have} of {total} in your library', { have: gres.albums.filter((a) => a.inLibrary).length, total: gres.albums.length })}</span></div>
                {phone ? (
                  <div className="searchlist">
                    {gres.albums.map((a) => (
                      <SearchRow key={a.album_id} image={a.inLibrary ? jf.imageUrl(a.inLibrary, { maxHeight: 96 }) : a.image} name={a.title} sub={sub(a)}
                        className={a.inLibrary ? '' : 'missing'} onClick={() => openOrRequest(a)} action={a.inLibrary ? playBtn(a) : btn(a)} />
                    ))}
                  </div>
                ) : (
                  <div className="grid">
                    {gres.albums.map((a) => (
                      <div key={a.album_id} className={`card ${a.inLibrary ? '' : 'missing'}`} role="button" tabIndex={0} onClick={() => openOrRequest(a)} onKeyDown={(e) => e.key === 'Enter' && openOrRequest(a)}>
                        <div className="card-art">
                          {a.inLibrary ? <img src={jf.imageUrl(a.inLibrary, { maxHeight: 320 })} alt="" loading="lazy" /> : a.image ? <img src={a.image} alt="" loading="lazy" /> : <div className="ph" />}
                          {a.inLibrary ? playBtn(a) : btn(a)}
                        </div>
                        <div className="card-title">{a.title}</div>
                        <div className="card-sub">{sub(a)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })()}

          {phoneRows && phoneRows.length > 0 && (
            <div className="searchlist">
              {phoneRows.map(({ kind, item, i }, n) => kind === 'Song' ? (
                <div key={`s${item.Id}`} className={`srow-song ${n === 0 ? 'topresult' : ''}`}>
                  <TrackRow {...(i >= 0 ? searchRow(i) : rowProps([item], 0, { showArt: true, onPlay: () => actOnPhone('Song', item, -1) }))} />
                </div>
              ) : (
                <SearchRow key={`${kind}${item.Id}`} className={n === 0 ? 'topresult' : ''} round={kind === 'Artist'}
                  image={jf.imageUrl(item.Id, { maxHeight: 96 })} name={item.Name} sub={subOf(kind, item)}
                  onClick={() => actOnPhone(kind, item, i)} />
              ))}
            </div>
          )}

          {!phone && r && !r.scoped && searchType === 'All' && top && (
            <div className="searchgrid">
              <section>
                <div className="shelf-head"><h2>{t('Top result')}</h2></div>
                <div className={`topresult ${top.kind === 'Artist' ? 'round' : ''} ${hi === 0 ? 'hi' : ''}`}
                  onClick={() => { remember(query, hit(top.kind, top.item)); top.kind === 'Song' ? openAlbum({ Id: top.item.AlbumId, Name: top.item.Album }) : top.kind === 'Playlist' ? onOpenPlaylist(top.item) : open(top.item); }}>
                  <img src={jf.imageUrl(top.kind === 'Song' ? (top.item.AlbumId || top.item.Id) : top.item.Id, { maxHeight: 200 })} alt="" />
                  <div>
                    <h3>{top.item.Name}</h3>
                    {/* The round portrait already says "artist"; the pill only
                        earns its place on the square kinds. */}
                    {top.kind !== 'Artist' && (
                      <div className="kind">
                        {top.kind === 'Song' ? (top.item.Artists?.join(', ') || '') : (top.item.AlbumArtist || '')}
                        <b>{kindLabel(top.kind)}</b>
                      </div>
                    )}
                  </div>
                  <button className="card-play" onClick={(e) => { e.stopPropagation(); remember(query, hit(top.kind, top.item)); top.kind === 'Song' ? player.playQueue(r.tracks, Math.max(0, r.tracks.findIndex((t) => t.Id === top.item.Id))) : playItem(top.item); }}>
                    <PlayGlyph />
                  </button>
                </div>
              </section>
              <section>
                <div className="shelf-head"><h2>{t('Songs')}</h2></div>
                <div className="tracklist" style={{ padding: 0 }}>
                  {r.tracks.slice(0, 4).map((t, i) => <TrackRow key={t.Id} {...searchRow(i, { highlight: hi === i + (top ? 1 : 0) })} />)}
                </div>
              </section>
            </div>
          )}

          {!phone && r && !r.scoped && show('Songs') && searchType !== 'All' && r.tracks.length > 0 && (
            <section>
              <div className="shelf-head"><h2>{t('Songs')}</h2></div>
              <div className="tracklist" style={{ padding: 0 }}>
                {r.tracks.map((t, i) => <TrackRow key={t.Id} {...searchRow(i)} />)}
              </div>
            </section>
          )}
          {!phone && r && show('Artists') && r.artists.length > 0 && (
            <section>
              <div className="shelf-head"><h2>{t('Artists')}</h2></div>
              <div className="grid">
                {r.artists.map((a) => (
                  <Card key={a.Id} title={a.Name} subtitle={t('Artist')} round
                    image={jf.imageUrl(a.Id, { maxHeight: 320 })} onOpen={() => { remember(query, hit('Artist', a)); openArtist(a); }} onPlay={() => { remember(query, hit('Artist', a)); startMix(a); }} />
                ))}
              </div>
            </section>
          )}
          {!phone && r && show('Albums') && r.albums.length > 0 && (
            <section>
              <div className="shelf-head"><h2>{t('Albums')}</h2></div>
              <div className="grid">
                {r.albums.map((a) => (
                  <Card key={a.Id} title={a.Name} subtitle={`${a.ProductionYear ? a.ProductionYear + ' • ' : ''}${a.AlbumArtist || t('Album')}`}
                    image={jf.imageUrl(a.Id, { maxHeight: 320 })} onOpen={() => { remember(query, hit('Album', a)); openAlbum(a); }} onPlay={() => { remember(query, hit('Album', a)); playItem(a); }} />
                ))}
              </div>
            </section>
          )}
          {!phone && r && show('Playlists') && r.playlists.length > 0 && (
            <section>
              <div className="shelf-head"><h2>{t('Playlists')}</h2></div>
              <div className="grid">
                {r.playlists.map((p) => (
                  <Card key={p.Id} title={p.Name} subtitle={t('Playlist')}
                    image={jf.imageUrl(p.Id, { maxHeight: 320 })} onOpen={() => { remember(query, hit('Playlist', p)); onOpenPlaylist(p); }} onPlay={() => { remember(query, hit('Playlist', p)); playItem(p); }} />
                ))}
              </div>
            </section>
          )}
          {phoneRows && phoneRows.length === 0 && searchType !== 'Everywhere' && (
            <div className="search-empty">
              <b>{t('Couldn’t find “{query}”', { query: query.trim() })}</b>
              <span>{t('Try searching again using a different spelling or keyword.')}</span>
            </div>
          )}
          {!phone && r && searchType !== 'Everywhere' && !r.tracks.length && !r.albums.length && !r.artists.length && !r.playlists.length && (
            <div className="banner">{t('No results found for “{query}”. Check the spelling, or try a different search.', { query })}</div>
          )}
        </div>
      </div>
    );
  }

  // --- home ---------------------------------------------------------------
  return (
    <Home
      jf={jf} player={player} albums={albums} artists={artists} playlists={playlists}
      likedCount={likedCount}
      onOpen={open} onOpenLiked={onOpenLiked} onOpenPlaylist={onOpenPlaylist}
      onSeeAll={setSeeAll}
      bar={<FilterPills where="all" setSeeAll={setSeeAll} goHome={() => onView('home')} />}
      onOpenArtist={onOpenArtistById}
      onOpenRadar={openRadar}
      onOpenMix={openMix}
      onOpenTopSongs={openTopSongs}
    />
  );
}

// A list's menu offline: what works without the server (queueing, going to
// the artist, the download itself: removing it, or saving it for later).
// Marked with offline: true (labels are translated, so not matched by text).
const heroOffline = (items) => {
  const kept = items.filter((it) => it && (it.sep || it.offline));
  return kept.filter((it, i) => !it.sep || (i > 0 && i < kept.length - 1 && !kept[i - 1].sep));
};

// The header's download button: an outline circle with an arrow; a ring
// that fills as songs arrive; a filled green circle once all are here.
function DownloadGlyph({ state, progress = 0 }) {
  const r = 10.5, c = 2 * Math.PI * r;
  if (state === 'done' || state === 'part') {
    return (
      <svg viewBox="0 0 24 24" width="28" height="28" className={`dlglyph ${state}`}>
        <circle cx="12" cy="12" r="12" fill="currentColor" />
        <path d="M12 6v9m0 0-3.5-3.5M12 15l3.5-3.5M7.5 18h9" stroke="#000" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" className={`dlglyph ${state}`}>
      <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" opacity={state === 'busy' ? 0.3 : 1} />
      {state === 'busy' && <circle cx="12" cy="12" r={r} fill="none" stroke="var(--green, #1ed760)" strokeWidth="1.5" strokeDasharray={`${c * Math.max(0.03, progress)} ${c}`} transform="rotate(-90 12 12)" />}
      <path d="M12 7v8m0 0-3-3m3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
