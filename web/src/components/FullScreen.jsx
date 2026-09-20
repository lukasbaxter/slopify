import React, { useEffect, useRef, useState } from 'react';
import { Lyrics } from './RightPanel.jsx';
import Visualizer, { EQ_STYLES, GRADIENTS, DEFAULT_VIZ, loadVizSettings, unlockShadowAudio } from './Visualizer.jsx';
import ContextMenu from './ContextMenu.jsx';
import DevicePicker from './DevicePicker.jsx';
import { seekHover } from '../api/seekHover.js';
import { useLiked } from '../api/likes.js';
import { useOffset } from '../api/offsets.js';
import { ArtistLinks, PlayGlyph, PauseGlyph, ShuffleGlyph, I } from './TrackRow.jsx';
import { usePhone, usePlayingFrom, slideOut, LyricsGlyph } from './Player.jsx';
import { vibrantColor } from '../api/colors.js';

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Spotify's 24pt line glyphs for the phone's bottom row and the ⋯ sheet.
const G = {
  dots: <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M4.5 13.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm7.5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm7.5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" /></svg>,
  share: <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M12 2.25 7.47 6.78l1.06 1.06 2.72-2.72V15h1.5V5.12l2.72 2.72 1.06-1.06L12 2.25z" /><path d="M4.5 10.5h4V12h-2.5v8.25h12V12h-2.5v-1.5h4v11.25h-15V10.5z" /></svg>,
  queue: <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M22.5 21.75h-21v-1.5h21v1.5zm0-6.75h-21v-1.5h21V15zM1.5 5.25A3 3 0 0 1 4.5 2.25h15a3 3 0 0 1 0 6h-15a3 3 0 0 1-3-3zm3-1.5a1.5 1.5 0 0 0 0 3h15a1.5 1.5 0 0 0 0-3h-15z" /></svg>,
  lyrics: <LyricsGlyph />,
  viz: <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 12h1.5M6.5 8v8M10 4.5v15M13.5 8v8M17 6v12M20.5 10v4" /></svg>,
  plus: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M15.25 8a.75.75 0 0 1-.75.75H8.75v5.75a.75.75 0 0 1-1.5 0V8.75H1.5a.75.75 0 0 1 0-1.5h5.75V1.5a.75.75 0 0 1 1.5 0v5.75h5.75a.75.75 0 0 1 .75.75z" /></svg>,
  artist: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M6.233.371a4.388 4.388 0 0 1 5.002 1.052c.421.459.713.992.904 1.554.143.421.263 1.173.22 1.894-.078 1.322-.638 2.408-1.399 3.316l-.127.152a.75.75 0 0 0 .201 1.13l2.209 1.275a4.75 4.75 0 0 1 2.375 4.114V16H0v-1.142a4.75 4.75 0 0 1 2.375-4.114l2.209-1.275a.75.75 0 0 0 .201-1.13l-.126-.152c-.761-.908-1.322-1.994-1.4-3.316-.043-.721.077-1.473.22-1.894a4.346 4.346 0 0 1 .904-1.554c.411-.448.91-.807 1.85-1.052zM8 1.5a2.9 2.9 0 0 0-2.8 2.087 5.53 5.53 0 0 0-.131 1.293c.055.934.44 1.717 1.062 2.459l.126.152a2.25 2.25 0 0 1-.603 3.39L3.445 12.156A3.25 3.25 0 0 0 1.5 14.5h13a3.25 3.25 0 0 0-1.945-2.344L10.346 10.88a2.25 2.25 0 0 1-.603-3.39l.127-.152c.62-.742 1.006-1.525 1.061-2.46a5.53 5.53 0 0 0-.13-1.292A2.9 2.9 0 0 0 8 1.5z" /></svg>,
  album: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z" /></svg>,
};
// Spotify's save control on the phone: a circled plus, a green disc with a
// black check once saved.
const PlusCircle = ({ on }) => (on
  ? <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="var(--accent, #1ed760)" /><path d="M6.5 12.3l3.4 3.4 7.6-7.6" fill="none" stroke="#000" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  : <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10.1" /><path d="M12 7.5v9M7.5 12h9" /></svg>);
const G16 = {
  queue: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9z" /></svg>,
  radio: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z" /><path d="M3.05 3.05a7 7 0 0 0 0 9.9l1.06-1.06a5.5 5.5 0 0 1 0-7.78L3.05 3.05zm9.9 0-1.06 1.06a5.5 5.5 0 0 1 0 7.78l1.06 1.06a7 7 0 0 0 0-9.9z" /></svg>,
  share: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5 5 4.5l1.06 1.06L7.25 4.37V10h1.5V4.37l1.19 1.19L11 4.5 8 1.5z" /><path d="M3 7h3v1.5H4.5v5h7v-5H10V7h3v8H3V7z" /></svg>,
};
/**
 * A single line that marquee-scrolls when its text overflows (Spotify's
 * long-title treatment): measured once per text/width change, then a pure
 * CSS animation with a 2s pause at each end and a fade at the right edge.
 */
function Marquee({ text, className }) {
  const box = useRef(null), inner = useRef(null);
  const [dist, setDist] = useState(0);
  useEffect(() => {
    const b = box.current, i = inner.current; if (!b || !i) return undefined;
    const measure = () => setDist(Math.max(0, i.scrollWidth - b.clientWidth));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(b);
    return () => ro?.disconnect();
  }, [text]);
  const dur = 4 + dist / 30; // 30px/s plus the two pauses
  return (
    <div ref={box} className={`${className} marquee ${dist > 0 ? 'overflow' : ''}`} style={dist > 0 ? { '--marquee-dist': `-${dist + 24}px`, '--marquee-dur': `${dur}s` } : undefined}>
      <span ref={inner} className="marquee-inner">{text}</span>
    </div>
  );
}
const HeartPath = ({ on }) => (on
  ? <path d="M15.724 4.22A4.313 4.313 0 0 0 12.192.814a4.269 4.269 0 0 0-3.622 1.13.837.837 0 0 1-1.14 0 4.272 4.272 0 0 0-6.21 5.855l5.916 7.05a1.128 1.128 0 0 0 1.727 0l5.916-7.05a4.228 4.228 0 0 0 .945-3.577z" />
  : <path d="M1.69 2A4.582 4.582 0 0 1 8 2.023 4.583 4.583 0 0 1 11.88.817h.002a4.618 4.618 0 0 1 3.782 3.65v.003a4.543 4.543 0 0 1-1.011 3.84L9.35 14.629a1.765 1.765 0 0 1-2.093.464 1.762 1.762 0 0 1-.605-.463L1.348 8.309A4.582 4.582 0 0 1 1.689 2zm3.158.252A3.082 3.082 0 0 0 2.49 7.337l.005.005L7.8 13.664a.264.264 0 0 0 .311.069.262.262 0 0 0 .09-.069l5.312-6.33a3.043 3.043 0 0 0 .68-2.573 3.118 3.118 0 0 0-2.551-2.463 3.079 3.079 0 0 0-2.612.816l-.007.007a1.501 1.501 0 0 1-2.045 0l-.009-.008a3.082 3.082 0 0 0-2.121-.861z" />);

/**
 * Spotify's full-screen player: blurred cover behind, tabs up top (Album /
 * Visualizer / Lyrics), the track and transport along the bottom.
 */
// Show `lo` at once, `hi` as soon as it has loaded; `hi` alone when there is
// no `lo`. A new `hi` (next track) starts over from its `lo`.
function useProgressiveSrc(lo, hi) {
  const [src, setSrc] = useState(hi);
  useEffect(() => {
    if (!hi || !lo) { setSrc(hi); return undefined; }
    let alive = true;
    setSrc(lo);
    const img = new Image();
    img.onload = () => { if (alive) setSrc(hi); };
    img.src = hi;
    return () => { alive = false; };
  }, [lo, hi]);
  return src;
}

export default function FullScreen({ player, jf, onClose, onOpenArtist, onOpenAlbum, onLike, onAddTo, onNewPlaylist, playlists = [], prefs, onUpdatePrefs, onPanel, devices = [], sessionDevice = null }) {
  // Phone: the mini bar always opens on the album view (Spotify); lyrics and
  // the visualizer are a tap away. Desktop remembers the last tab.
  const [tab, setTab] = useState(() => (typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches) ? 'album' : (localStorage.getItem('conduit.fsTab') || 'album'));
  const phone = usePhone();
  // Phone: the ⋯ up top opens the track's menu as a bottom sheet (the track
  // row's menu: header, playlist, queue, like, artist, album, radio, share).
  const [more, setMore] = useState(false);
  // Scrubbing: while the finger is on the seek bar the thumb follows it, not
  // the playhead the relay mirrors from another device (that made the thumb
  // snap back every tick). The seek is sent on release; the local value is
  // held until the mirrored position has caught up.
  const [scrub, setScrub] = useState(null);
  const scrubHold = useRef(null);
  const onScrubStart = () => { clearTimeout(scrubHold.current); setScrub((s) => (s == null ? Math.min(player.position || 0, player.duration || 0) : s)); };
  const onScrubMove = (e) => setScrub(Number(e.target.value));
  // Touch: the finger's own x drives the value. iOS's native range drag only
  // sometimes follows a finger that started on the thumb (it lit up, the
  // thumb stayed), so the position is taken from the touch itself and the
  // seek uses the last touched value, never the input's possibly stale one.
  const touchVal = useRef(null);
  const valueAtTouch = (e) => {
    const t = e.touches?.[0] || e.changedTouches?.[0]; if (!t) return null;
    const r = e.currentTarget.getBoundingClientRect(); const max = player.duration || 0;
    return r.width > 0 ? Math.max(0, Math.min(max, ((t.clientX - r.left) / r.width) * max)) : null;
  };
  const onScrubTouchStart = (e) => { onScrubStart(); const v = valueAtTouch(e); if (v != null) { touchVal.current = v; setScrub(v); } };
  const onScrubTouchMove = (e) => { const v = valueAtTouch(e); if (v != null) { touchVal.current = v; setScrub(v); } };
  const onScrubEnd = (e) => {
    const v = touchVal.current ?? Number(e.target.value);
    touchVal.current = null;
    setScrub(v); player.seek(v);
    clearTimeout(scrubHold.current);
    scrubHold.current = setTimeout(() => setScrub(null), player.mirroring ? 1500 : 250);
  };
  const rootRef = useRef(null);
  // Phone: slide the page down before App unmounts it (the desktop closes at once).
  const close = () => slideOut(rootRef.current, onClose);
  const closeMore = () => slideOut('.ctxmenu-fixed', () => setMore(false));
  const closeVizMenu = () => slideOut('.ctxmenu-fixed', () => setVizMenu(null));
  // Visualizer settings (style, colours) behind the tab's ⋯ menu. They live
  // in the account's prefs, so a change here shows up on every signed-in
  // client and survives a fresh machine; localStorage only carries a copy for
  // the first paint.
  const viz = { ...DEFAULT_VIZ, ...(prefs?.viz || loadVizSettings()) };
  const [vizMenu, setVizMenu] = useState(null);
  const setV = (patch) => { const n = { ...viz, ...patch }; try { localStorage.setItem('conduit.viz', JSON.stringify(n)); } catch {} onUpdatePrefs?.({ viz: n }); };
  // Speaker timing: the session device's measured output delay (relay-wide,
  // per speaker). Calibrating needs the clock of the client that drives the
  // speaker, so a mirroring client is told to do it from the player.
  const speaker = sessionDevice && sessionDevice.kind !== 'local' && sessionDevice.kind !== 'relay' ? sessionDevice : null;
  const driving = !!speaker && !player.mirroring && player.device?.id === speaker.id;
  const offset = useOffset(speaker?.id);
  const [calibrating, setCalibrating] = useState(null);
  const saveOffset = (v) => { if (speaker) player.relay?.sendOffset(speaker.id, v); };
  const vizItems = [
    // Phone sheets get a right-aligned check glyph; the desktop menu keeps its text tick.
    { label: 'Style', sub: EQ_STYLES.map((s2) => ({ key: s2.id, label: `${s2.name}${!phone && viz.style === s2.id ? '  ✓' : ''}`, checked: phone && viz.style === s2.id, onClick: () => setV({ style: s2.id }) })) },
    { label: 'Colours', sub: GRADIENTS.map((g) => ({ key: g, label: `${g === 'album' ? 'Match album art' : g[0].toUpperCase() + g.slice(1)}${!phone && viz.gradient === g ? '  ✓' : ''}`, checked: phone && viz.gradient === g, onClick: () => setV({ gradient: g }) })) },
    { sep: true },
    // 0 = raw every frame (real time); 0.95 = very calm.
    { slider: true, key: 'smoothing', label: 'Smoothing', min: 0, max: 0.95, step: 0.05, value: viz.smoothing ?? 0.6, format: (v) => (v === 0 ? 'Real time' : `${Math.round(v * 100)}%`), onChange: (v) => setV({ smoothing: v }) },
    ...(speaker ? [
      { sep: true },
      { label: `Timing on ${speaker.name}${offset != null ? ` (${offset > 0 ? '+' : ''}${Math.round(offset * 1000)} ms)` : ''}` },
      { key: 'cal', label: driving ? 'Calibrate by tapping…' : 'Calibrate from the client that is playing', disabled: !driving, onClick: () => { setTab('viz'); setCalibrating(speaker); } },
      ...(offset != null ? [{ key: 'cal-reset', label: 'Forget calibration', onClick: () => saveOffset(null) }] : []),
    ] : []),
  ];
  const { nowPlaying, playing, position, duration, shuffle, repeat, volume } = player;
  const liked = useLiked(nowPlaying?.itemId);
  // The big cover paints from the 320px copy the lists already fetched (it is
  // in the cache), while the full-size one (640 on the phone: 3x of the 24pt
  // gutter width, 1000 on the desktop) loads behind it and swaps in.
  const artHi = nowPlaying?.artId ? jf.imageUrl(nowPlaying.artId, { maxHeight: phone ? 640 : 1000 }) : nowPlaying?.artUrl || null;
  const artLo = nowPlaying?.artId ? jf.imageUrl(nowPlaying.artId, { maxHeight: 320 }) : null;
  const art = useProgressiveSrc(artLo, artHi);
  // The row-menu shape of the playing track (onLike / onAddTo want a track
  // object with an Id).
  const asTrack = nowPlaying?.itemId ? { Id: nowPlaying.itemId, Name: nowPlaying.title, Artists: [nowPlaying.artist], AlbumId: nowPlaying.albumId, _partial: true } : null;
  const toggleLike = () => asTrack && onLike(asTrack, !liked);
  const artistsOf = (nowPlaying?.artists || []).filter((a) => a && a.Id);
  // The full row object when the track is in our own queue (richer than the
  // session summary: ArtistItems, Album, ticks), else the summary shape.
  const fullTrack = player.current?.Id === nowPlaying?.itemId ? player.current : asTrack;
  const share = async () => {
    if (!nowPlaying) return;
    const text = `${nowPlaying.title}${nowPlaying.artist ? ` — ${nowPlaying.artist}` : ''}`;
    try {
      if (navigator.share) await navigator.share({ title: nowPlaying.title, text });
      else await navigator.clipboard?.writeText(text);
    } catch { /* the user dismissed the share sheet */ }
  };
  const goArtist = (id) => { close(); onOpenArtist(id); };
  const moreItems = asTrack ? [
    onAddTo ? { label: 'Add to playlist', icon: G.plus, sub: [
      onNewPlaylist ? { label: 'New playlist', icon: G.plus, onClick: () => { close(); onNewPlaylist(fullTrack); } } : null,
      onNewPlaylist && playlists.length ? { sep: true } : null,
      ...playlists.map((p) => ({ key: p.Id, label: p.Name, onClick: () => onAddTo(p, fullTrack) })),
    ] } : null,
    player.addToQueue ? { label: 'Add to queue', icon: G16.queue, onClick: () => player.addToQueue([fullTrack]) } : null,
    { label: liked ? 'Remove from Liked Songs' : 'Add to Liked Songs', icon: liked ? I.checkCircle : I.plusCircle, onClick: toggleLike },
    { sep: true },
    { label: 'Go to song radio', icon: G16.radio, onClick: () => { jf.instantMix(nowPlaying.itemId).then((items) => { if (items?.length) player.playQueue(items, 0); }).catch(() => {}); } },
    artistsOf.length > 1
      ? { label: 'Go to artist', icon: G.artist, sub: artistsOf.map((a) => ({ key: a.Id, label: a.Name, onClick: () => goArtist(a.Id) })) }
      : (artistsOf[0] || nowPlaying?.artistId) ? { label: 'Go to artist', icon: G.artist, onClick: () => goArtist(artistsOf[0]?.Id || nowPlaying.artistId) } : null,
    nowPlaying?.albumId && onOpenAlbum ? { label: 'Go to album', icon: G.album, onClick: () => { close(); onOpenAlbum(nowPlaying.albumId); } } : null,
    { sep: true },
    { label: 'Share', icon: G16.share, onClick: share },
  ] : [];
  const moreHeader = nowPlaying ? { image: nowPlaying.artId ? jf.imageUrl(nowPlaying.artId, { maxHeight: 120 }) : nowPlaying.artUrl || null, title: nowPlaying.title, sub: nowPlaying.artist || '' } : null;
  useEffect(() => { try { localStorage.setItem('conduit.fsTab', tab); } catch {} }, [tab]);
  // Phone: Spotify's now-playing is a gradient of the cover's colour (no
  // blur) with "PLAYING FROM PLAYLIST / name" up top. Both read here; the
  // desktop CSS ignores them.
  const [np, setNp] = useState(null);
  useEffect(() => { let alive = true; if (!art) { setNp(null); return undefined; } vibrantColor(art).then((rgb) => { if (alive) setNp(rgb ? `rgb(${rgb.join(',')})` : null); }); return () => { alive = false; }; }, [art]);
  const from = usePlayingFrom(player, jf); // { kind, name }, always both lines
  const vizEl = (
    <Visualizer player={player} jf={jf} active={tab === 'viz'} settings={viz} offset={offset || 0}
      calibrate={calibrating} onCalibrated={saveOffset} onCalibrateClose={() => setCalibrating(null)} />
  );
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div ref={rootRef} className={`fs fs-tab-${tab} ${more || vizMenu ? 'sheet' : ''}`} style={np ? { '--np': np } : undefined}>
      {art && <div className={`fs-bg ${tab === 'viz' ? 'dim' : ''}`} style={{ backgroundImage: `url("${art}")` }} />}
      <div className="fs-top">
        {/* Phone: on the lyrics page the chevron goes back to the cover, like Spotify's. */}
        <button className="fs-chevron" onClick={phone && tab === 'lyrics' ? () => setTab('album') : close} title="Close" aria-label="Close">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M2.793 8.043a1 1 0 0 1 1.414 0L12 15.836l7.793-7.793a1 1 0 1 1 1.414 1.414L12 18.664 2.793 9.457a1 1 0 0 1 0-1.414z" /></svg>
        </button>
        <div className="fs-from">
          {phone && tab === 'lyrics'
            ? <span className="fs-from-phone"><b>{nowPlaying?.title || ''}</b><small className="fs-from-artist">{nowPlaying?.artist || ''}</small></span>
            : <span className="fs-from-phone"><small>{from.kind}</small><b>{from.name}</b></span>}
        </div>
        <div className="fs-tabs">
          {/* Flat icon tabs: vinyl = album, note = lyrics, wave = visualizer. */}
          {[
            ['album', 'Album', <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.25" /><circle cx="12" cy="12" r="5.75" strokeOpacity=".55" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /></svg>],
            ['lyrics', 'Lyrics', <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M20 2.5a1 1 0 0 0-1.2-1L9.3 3.6A1 1 0 0 0 8.5 4.6v10.2A3.7 3.7 0 0 0 6.5 14a3.5 3.5 0 1 0 3.5 3.5V8.3l8-1.7v6.2a3.7 3.7 0 0 0-2-.8 3.5 3.5 0 1 0 3.5 3.5V2.5z" /></svg>],
            ['viz', 'Visualizer', <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 12h1.5M6.5 8v8M10 4.5v15M13.5 8v8M17 6v12M20.5 10v4" /></svg>],
          ].map(([k, label, icon]) => (
            <span key={k} className={`fs-tab ${tab === k ? 'on' : ''}`}>
              {/* Visualizer: a second click on the active icon (or right-click) opens its settings. */}
              <button
                onClick={(e) => { if (k === 'viz' && tab === 'viz') { const r = e.currentTarget.getBoundingClientRect(); setVizMenu({ x: r.left - 8, y: r.bottom + 8 }); } else { if (k === 'viz') unlockShadowAudio(); setTab(k); } }}
                onContextMenu={k === 'viz' ? (e) => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setVizMenu({ x: r.left - 8, y: r.bottom + 8 }); } : undefined}
                title={k === 'viz' && tab === 'viz' ? 'Visualizer settings' : label} aria-label={label} aria-pressed={tab === k}
              >{icon}</button>
            </span>
          ))}
          {vizMenu && <ContextMenu x={vizMenu.x} y={vizMenu.y} items={vizItems} onClose={closeVizMenu} header={phone ? { icon: G.viz, title: 'Visualizer', sub: 'Style, colours and smoothing' } : null} />}
          <span className="fs-divider" aria-hidden="true" />
        </div>
        {phone ? (
          <button className="fs-more" onClick={() => setMore(true)} title="More options" aria-label="More options" disabled={!moreItems.length}>{G.dots}</button>
        ) : (
          /* Arrows pointing IN (collapse), the mirror of the footer's expand glyph. */
          <button className="fs-close" onClick={onClose} title="Exit now playing view">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14.5 1.5 9.5 6.5M9.5 2.75V6.5h3.75M1.5 14.5l5-5M6.5 13.25V9.5H2.75" />
            </svg>
          </button>
        )}
        {more && <ContextMenu x={0} y={window.innerHeight} items={moreItems} onClose={closeMore} header={moreHeader} />}
      </div>

      <div className="fs-stage">
        {tab === 'album' && (art ? <img className="fs-art" src={art} alt="" /> : <div className="fs-art ph" />)}
        {tab === 'viz' && vizEl}
        {/* Phone, visualizer: a cue while paused, and the cover behind any sheet (the CSS shows it). */}
        {phone && tab === 'viz' && !playing && <div className="fs-viz-hint">Play to start the visualizer</div>}
        {phone && tab === 'viz' && art && <img className="fs-art fs-art-behind" src={art} alt="" />}
        {tab === 'lyrics' && <div className="fs-lyrics"><Lyrics player={player} jf={jf} /></div>}
      </div>

      <div className="fs-bottom">
        {/* Progress across the top of the block, above the album thumb and the controls. */}
        <div className="fs-seek">
          <span>{fmt(scrub ?? (position || 0))}</span>
          <input type="range" min="0" max={Math.max(1, duration || 0)} value={Math.min(scrub ?? (position || 0), duration || 0)}
            onChange={onScrubMove} onInput={onScrubMove} onPointerDown={onScrubStart} onTouchStart={onScrubTouchStart} onTouchMove={onScrubTouchMove} onKeyDown={onScrubStart}
            onPointerUp={onScrubEnd} onTouchEnd={onScrubEnd} onKeyUp={onScrubEnd}
            style={{ '--pct': `${duration ? ((scrub ?? position) / duration) * 100 : 0}%` }} {...seekHover} />
          <span>{phone ? `-${fmt(Math.max(0, (duration || 0) - (scrub ?? (position || 0))))}` : fmt(duration || 0)}</span>
        </div>
        <div className="fs-meta">
          {art && <img className="fs-thumb" src={art} alt="" />}
          <div style={{ minWidth: 0 }}>
            {phone
              ? <Marquee className="fs-title" text={nowPlaying?.title || 'Nothing playing'} />
              : <div className="fs-title">{nowPlaying?.title || 'Nothing playing'}</div>}
            <div className="fs-artist"><ArtistLinks artists={nowPlaying?.artists} fallback={nowPlaying?.artist || ''} onOpen={goArtist} className="linkish" /></div>
          </div>
          {nowPlaying?.itemId && (
            <button className={`fs-like ${liked ? 'on' : ''}`} onClick={toggleLike} title={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}>
              {phone
                ? <PlusCircle on={liked} />
                : <svg viewBox="0 0 16 16" width="20" height="20" fill={liked ? 'var(--seek-accent)' : 'currentColor'}><HeartPath on={liked} /></svg>}
            </button>
          )}
        </div>
        <div className="fs-controls">
          <button className={`ctl-mode ${shuffle && shuffle !== 'off' ? 'on' : ''}`} onClick={player.cycleShuffle} title="Shuffle"><ShuffleGlyph size={18} /></button>
          <button onClick={player.previous} title="Previous"><svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z" /></svg></button>
          <button className="fs-play" onClick={player.toggle} title={playing ? 'Pause' : 'Play'}>{playing ? <PauseGlyph size={26} /> : <PlayGlyph size={26} />}</button>
          <button onClick={player.next} title="Next"><svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.107A.7.7 0 0 0 1 1.712v12.575a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6z" /></svg></button>
          <button className={`ctl-mode ${repeat && repeat !== 'off' ? 'on' : ''}`} onClick={player.cycleRepeat} title="Repeat"><svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5z" /></svg></button>
        </div>
        {/* Bottom-right: the speaker picker with the device it is on as green text, and the volume. */}
        <div className="fs-output">
          {sessionDevice && <DevicePicker devices={devices} active={sessionDevice} onSelect={player.setDevice} showName volume={volume} onVolume={player.setVolume} />}
          <div className="fs-volume" title={`Volume ${volume}%`}>
            <button onClick={() => player.setVolume(volume > 0 ? 0 : 60)} title={volume > 0 ? 'Mute' : 'Unmute'}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
                {volume === 0 ? (
                  <><path d="M13.86 5.47a.75.75 0 0 0-1.061 0l-1.47 1.47-1.47-1.47A.75.75 0 0 0 8.8 6.53L10.269 8l-1.47 1.47a.75.75 0 1 0 1.06 1.06l1.47-1.47 1.47 1.47a.75.75 0 0 0 1.06-1.06L12.39 8l1.47-1.47a.75.75 0 0 0 0-1.06z" /><path d="M10.116 1.5A.75.75 0 0 0 8.991.85l-6.925 4a3.642 3.642 0 0 0-1.33 4.967 3.639 3.639 0 0 0 1.33 1.332l6.925 4a.75.75 0 0 0 1.125-.649v-1.906a4.73 4.73 0 0 1-1.5-.694v1.3L2.817 9.852a2.141 2.141 0 0 1-.781-2.92c.187-.324.456-.594.78-.782l5.8-3.35v1.3c.45-.313.956-.55 1.5-.694V1.5z" /></>
                ) : (
                  <><path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.139 2.139 0 0 0 0 3.7l5.8 3.35V2.8l-5.8 3.35zm8.683 4.29V5.56a2.75 2.75 0 0 1 0 4.88z" />{volume > 40 && <path d="M11.5 13.614a5.752 5.752 0 0 0 0-11.228v1.55a4.252 4.252 0 0 1 0 8.127v1.55z" />}</>
                )}
              </svg>
            </button>
            <input type="range" min="0" max="100" value={volume} onChange={(e) => player.setVolume(Number(e.target.value))} style={{ '--pct': `${volume}%` }} />
          </div>
        </div>
        {/* Phone-only bottom row (Spotify: devices bottom-left, share / queue
            bottom-right; Conduit adds lyrics and the visualizer beside them). */}
        {phone && (
          <div className="fs-phone-row">
            <div className="fs-phone-device">
              {sessionDevice && <DevicePicker devices={devices} active={sessionDevice} onSelect={player.setDevice} showName volume={volume} onVolume={player.setVolume} />}
            </div>
            <button className={tab === 'lyrics' ? 'on' : ''} onClick={() => setTab(tab === 'lyrics' ? 'album' : 'lyrics')} title="Lyrics" aria-label="Lyrics">{G.lyrics}</button>
            <button onClick={() => { close(); onPanel?.('queue'); }} title="Queue" aria-label="Queue">{G.queue}</button>
          </div>
        )}
      </div>
    </div>
  );
}
