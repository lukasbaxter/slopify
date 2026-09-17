import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Slopify, loadSession, persistSession, clearSession } from './api/slopify.js';
import { usePlayer } from './player/usePlayer.js';
import { SessionLink } from './api/session.js';
import Sidebar from './components/Sidebar.jsx';
import Library, { LIKED_ID } from './components/Library.jsx';
import Player, { PlayingElsewhereBar, sessionDeviceOf } from './components/Player.jsx';
import RightPanel from './components/RightPanel.jsx';
import FullScreen from './components/FullScreen.jsx';
import { downloadTrack } from './api/download.js';
import { applyTheme, DEFAULT_THEME } from './api/prefs.js';
import { search as relaySearch, popular as relayPopular, likes as relayLikes, playlistTracks as relayPlaylist, likedFast } from './api/search.js';
import { likesLoad, likesSet, likesSnapshot, likedIds, likesReady, isLiked, useLikesVersion } from './api/likes.js';
import { offsetsMerge } from './api/offsets.js';

// Everything goes through music.baxtergroup.io (Let's Encrypt on the origin,
// Cloudflare proxy deliberately off -- it throttles the audio). The browser
// build is same-origin; the desktop uses the same host, so it works off the
// LAN, and speakers stream from a URL with a real certificate.
const IS_DESKTOP = typeof window !== 'undefined' && !!window.conduit;
const DEFAULT_SERVER = IS_DESKTOP
  ? 'https://music.baxtergroup.io'
  : window.location.origin;

function Login({ onConnected }) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_SERVER);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // An invite link (/?invite=code) makes this the sign-up form.
  const invite = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('invite') : null;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (invite) {
        const r = await fetch(`${baseUrl.trim().replace(/\/+$/, '')}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite, username: username.trim(), password }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
        window.history.replaceState(null, '', window.location.pathname);
      }
      const jf = await Slopify.login(baseUrl.trim(), username.trim(), password);
      persistSession({ baseUrl: jf.baseUrl, token: jf.token, userId: jf.userId });
      onConnected(jf);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={submit}>
        <div className="login-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.62.62 0 0 1-.86.2c-2.35-1.43-5.3-1.76-8.78-.96a.62.62 0 1 1-.28-1.22c3.8-.87 7.07-.5 9.7 1.12.3.18.4.57.22.86zm1.23-2.73a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 1 1-.45-1.5c3.64-1.1 8.16-.57 11.24 1.33.37.23.48.71.25 1.08zm.1-2.85C14.7 9.16 9.4 8.98 6.32 9.92a.94.94 0 1 1-.55-1.8c3.54-1.07 9.41-.87 13.13 1.34a.94.94 0 0 1-.96 1.62z" /></svg>
        </div>
        <h1>Conduit</h1>
        <p className="login-sub">Your library, on any speaker in the house.</p>
        {IS_DESKTOP && (
          <label>
            Server
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck="false" />
          </label>
        )}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus spellCheck="false" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <div className="banner error" style={{ margin: 0 }}>{err}</div>}
        {invite && <p className="login-hint">You have been invited. Pick a username and a password (8 characters or more).</p>}
        <button className="primary" disabled={busy || !username}>
          {busy ? (invite ? 'Creating account…' : 'Logging in…') : invite ? 'Create account' : 'Log in'}
        </button>
        {IS_DESKTOP && (
          <p className="login-hint">
            Default is the public address, which works at home and away. Speakers fetch
            audio themselves, so whatever you enter must be reachable from them too.
          </p>
        )}
      </form>
    </div>
  );
}

// Bottom tab glyphs (Spotify's home / search / library outlines; filled when on).
const TabHome = ({ on }) => on
  ? <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M13.5 1.515a3 3 0 0 0-3 0L3 5.845a2 2 0 0 0-1 1.732V21a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6h4v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7.577a2 2 0 0 0-1-1.732l-7.5-4.33z" /></svg>
  : <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12.5 3.247a1 1 0 0 0-1 0L4 7.577V20h4.5v-6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6H20V7.577l-7.5-4.33zm-2-1.732a3 3 0 0 1 3 0l7.5 4.33a2 2 0 0 1 1 1.732V21a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6h-3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.577a2 2 0 0 1 1-1.732l7.5-4.33z" /></svg>;
const TabSearch = ({ on }) => on
  ? <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M15.356 10.558c0 2.623-2.16 4.75-4.823 4.75-2.664 0-4.824-2.127-4.824-4.75s2.16-4.75 4.824-4.75c2.664 0 4.823 2.127 4.823 4.75z" /><path d="M1.126 10.558c0-5.14 4.226-9.28 9.407-9.28 5.18 0 9.407 4.14 9.407 9.28a9.157 9.157 0 0 1-2.077 5.816l4.344 4.344a1 1 0 0 1-1.414 1.414l-4.353-4.353a9.454 9.454 0 0 1-5.907 2.058c-5.18 0-9.407-4.14-9.407-9.28zm9.407-7.28c-4.105 0-7.407 3.274-7.407 7.28s3.302 7.279 7.407 7.279 7.407-3.273 7.407-7.28c0-4.005-3.302-7.278-7.407-7.278z" /></svg>
  : <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z" /></svg>;
const TabLib = ({ on }) => on
  ? <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zM15.5 2.134A1 1 0 0 0 14 3v18a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6.464a1 1 0 0 0-.5-.866l-6-3.464zM9 2a1 1 0 0 0-1 1v18a1 1 0 1 0 2 0V3a1 1 0 0 0-1-1z" /></svg>
  : <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M14.5 2.134a1 1 0 0 1 1 0l6 3.464a1 1 0 0 1 .5.866V21a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3a1 1 0 0 1 .5-.866zM16 4.732V20h4V7.041l-4-2.309zM3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1z" /></svg>;

// Line icon for the account drawer rows (24pt, current colour). Hidden on desktop.
function MenuIco({ d }) {
  return <svg className="menu-ico" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

export default function App() {
  const [jf, setJf] = useState(null);
  const [devices, setDevices] = useState([]);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState('home');
  const [playlists, setPlaylists] = useState([]);
  const [savedAlbums, setSavedAlbums] = useState([]);
  // Liked Songs count follows the like store; likedCacheRef holds the fetched
  // rows by id so the page paints instantly and in the store's order.
  const likesVersion = useLikesVersion();
  const likedCount = likesReady() ? likedIds().length : null;
  const likedCacheRef = useRef(new Map()); // itemId -> track row
  const setLikedCount = () => {};
  const [toast, setToast] = useState(null);
  const [me, setMe] = useState(null);
  const [avatarOk, setAvatarOk] = useState(true);
  const [userMenu, setUserMenu] = useState(false);
  const [appMenu, setAppMenu] = useState(false);
  useEffect(() => {
    if (!appMenu) return undefined;
    const h = (e) => { if (!e.target.closest('.appmenuwrap')) setAppMenu(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [appMenu]);
  // Closes on a click anywhere outside (not on mouse-leave: the pointer
  // crossing the gap between the avatar and the menu used to dismiss it).
  useEffect(() => {
    if (!userMenu) return undefined;
    const down = (e) => { if (!e.target.closest?.('.avatarwrap')) setUserMenu(false); };
    const key = (e) => { if (e.key === 'Escape') setUserMenu(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [userMenu]);
  // "New playlist" dialog: {track} while open. window.prompt() does not exist
  // in Electron, which is why creating a playlist from a row did nothing there.
  const [namePrompt, setNamePrompt] = useState(null);
  // Now-playing view (Spotify's expand button): Album / Visualizer / Lyrics
  // filling the app window. It never asks the OS for full screen itself; if
  // the window is already full screen it fills that.
  const [fullScreen, setFullScreen] = useState(false);
  // Phone layout (<= 760px): no sidebar; bottom tabs Home / Search / Library,
  // where Library shows the sidebar's list as a page until the next navigation.
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  const isMobileRef = useRef(isMobile); isMobileRef.current = isMobile;
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const h = () => setIsMobile(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  const [mobileLib, setMobileLib] = useState(false);
  // The now-playing view is its own step in the browser history: Android's
  // back button (and the phone's edge swipe) closes it and lands on the page
  // it was opened from, instead of walking that page's stack while the
  // player stays open (which read as "back goes to Home every time").
  const fullScreenRef = useRef(false);
  const openFullScreen = () => {
    setFullScreen(true); fullScreenRef.current = true;
    try { window.history.pushState({ conduit: histRef.current.idx, np: true }, ''); } catch { /* sandboxed */ }
  };
  const closeFullScreen = () => {
    setFullScreen(false); fullScreenRef.current = false;
    // Closed from the UI: drop the history step so Back does not reopen it.
    try { if (window.history.state?.np) window.history.back(); } catch { /* ignore */ }
  };
  // Account settings: theme + playback quality. Loaded from Jellyfin, applied
  // to the CSS variables, kept in sync across clients over the relay.
  const [prefs, setPrefs] = useState({ theme: DEFAULT_THEME, quality: 'original' });
  // What THIS device streams at: the phone has its own setting (default 320
  // kbps MP3: a third of the data of the FLACs, starts faster on cellular),
  // everything else uses the account's quality.
  const deviceQuality = (p) => (isMobileRef.current ? (p.phoneQuality || 'high') : (p.quality || 'original'));
  const [avatarV, setAvatarV] = useState(0);
  const [nameDraft, setNameDraft] = useState('');

  // Left rail width. Spotify: drag the gap; below a threshold it snaps to an
  // icon-only rail; the chosen width survives restarts.
  const RAIL_MIN = 280, RAIL_MAX = 420, RAIL_COLLAPSED = 72, RAIL_SNAP = 200;
  const [railW, setRailW] = useState(() => {
    try { const v = Number(localStorage.getItem('conduit.railW')); return v >= RAIL_COLLAPSED ? v : 280; }
    catch { return 280; }
  });
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef(null);

  const clampRail = (w) => (w < RAIL_SNAP ? RAIL_COLLAPSED : Math.min(RAIL_MAX, Math.max(RAIL_MIN, w)));

  const onRailDown = useCallback((e) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: railW };
    setResizing(true);
    const move = (ev) => {
      const d = dragRef.current; if (!d) return;
      setRailW(clampRail(d.startW + (ev.clientX - d.startX)));
    };
    const up = () => {
      dragRef.current = null; setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setRailW((w) => { try { localStorage.setItem('conduit.railW', String(w)); } catch {} return w; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [railW]);

  // Right panel (queue / lyrics) width: drag the gap between content and panel.
  const PANEL_MIN = 280, PANEL_MAX = 560;
  const [panelW, setPanelW] = useState(() => { try { const v = Number(localStorage.getItem('conduit.panelW')); return v >= PANEL_MIN ? Math.min(PANEL_MAX, v) : 340; } catch { return 340; } });
  const onPanelDown = useCallback((e) => {
    e.preventDefault();
    const start = { x: e.clientX, w: panelW };
    setResizing(true);
    const move = (ev) => setPanelW(Math.min(PANEL_MAX, Math.max(PANEL_MIN, start.w - (ev.clientX - start.x))));
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setPanelW((w) => { try { localStorage.setItem('conduit.panelW', String(w)); } catch {} return w; });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [panelW]);

  // Double-click toggles between collapsed and the default width.
  const onRailDouble = () => {
    setRailW((w) => { const n = w <= RAIL_COLLAPSED ? 280 : RAIL_COLLAPSED; try { localStorage.setItem('conduit.railW', String(n)); } catch {} return n; });
  };
  const [libLoading, setLibLoading] = useState(true);
  const [albums, setAlbums] = useState([]);
  const [artists, setArtists] = useState([]);
  const [detail, setDetailRaw] = useState(null);
  const [seeAll, setSeeAllRaw] = useState(null); // 'albums' | 'artists' | null
  // Any navigation leaves the phone's Library tab, except a history walk that
  // lands back on it (applyEntry restores it and raises the flag).
  const restoringRef = useRef(false);
  useEffect(() => { if (restoringRef.current) { restoringRef.current = false; return; } setMobileLib(false); }, [view, detail?.item?.Id, seeAll]);
  // Which tab's stack the phone is in: a detail opened from Your Library keeps
  // the Library tab lit (Spotify's per-tab navigation stacks); Home/Search
  // follow the view.
  const [mobileTab, setMobileTab] = useState('home');
  const mobileTabRef = useRef('home'); mobileTabRef.current = mobileTab;
  // Detail pages set view='home' for the desktop model; only a ROOT page moves the lit tab.
  useEffect(() => { if (!detail && !seeAll && (view === 'home' || view === 'search')) setMobileTab(view); }, [view, detail, seeAll]);
  useEffect(() => { if (mobileLib) setMobileTab('library'); }, [mobileLib]);
  const [query, setQuery] = useState('');

  // Back / forward like Spotify's header arrows. One entry per place you can
  // be: {view, detail, seeAll}. A detail that merely refreshes (a playlist
  // streaming its tracks in) updates the current entry instead of pushing.
  const histRef = useRef({ stack: [{ view: 'home', detail: null, seeAll: null }], idx: 0 });
  const [histTick, setHistTick] = useState(0);
  const applyEntry = (e) => {
    setView(e.view); setDetailRaw(e.detail); setSeeAllRaw(e.seeAll);
    // The tab this page was opened from stays lit (per-tab stacks).
    if (e.tab) { setMobileTab(e.tab); const lib = e.tab === 'library' && !e.detail && !e.seeAll; if (lib) restoringRef.current = true; setMobileLib(lib); }
  };
  const pushEntry = (e) => {
    const h = histRef.current;
    h.stack = h.stack.slice(0, h.idx + 1); h.stack.push({ tab: mobileTabRef.current, ...e }); h.idx = h.stack.length - 1;
    setHistTick((t) => t + 1);
    // Mirror into the browser's history so the phone's back gesture / Android
    // back / browser Back walk the in-app stack instead of leaving the app.
    try { window.history.pushState({ conduit: h.idx }, ''); } catch { /* sandboxed */ }
  };
  const currentEntry = () => histRef.current.stack[histRef.current.idx];
  // Browser Back/Forward -> our stack. The state carries the target index, so
  // a jump of several entries lands on the right one.
  useEffect(() => {
    try { window.history.replaceState({ conduit: 0 }, ''); } catch { /* ignore */ }
    const onPop = (ev) => {
      const h = histRef.current;
      // Leaving the now-playing step closes the player and nothing else.
      if (fullScreenRef.current && !ev.state?.np) { setFullScreen(false); fullScreenRef.current = false; }
      if (ev.state?.np && !fullScreenRef.current) { setFullScreen(true); fullScreenRef.current = true; }
      const to = ev.state && typeof ev.state.conduit === 'number' ? ev.state.conduit : 0;
      if (to === h.idx || to < 0 || to >= h.stack.length) return;
      h.idx = to; applyEntry(h.stack[to]); setHistTick((t) => t + 1);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setDetail = (next) => {
    setDetailRaw((prev) => {
      const d = typeof next === 'function' ? next(prev) : next;
      const cur = currentEntry();
      if ((d?.item?.Id || null) === (cur.detail?.item?.Id || null)) {
        histRef.current.stack[histRef.current.idx] = { ...cur, detail: d };
      } else {
        pushEntry({ view: cur.view, detail: d, seeAll: d ? null : cur.seeAll });
        if (d) setSeeAllRaw(null);
      }
      return d;
    });
  };
  const setSeeAll = (v) => { setSeeAllRaw(v); setDetailRaw(null); pushEntry({ view: 'home', detail: null, seeAll: v }); setView('home'); };
  // When the browser history is in step with ours, let it drive (so its own
  // Back/Forward and ours stay consistent); otherwise walk the stack directly.
  const inStep = () => { try { return window.history.state?.conduit === histRef.current.idx; } catch { return false; } };
  const goBack = () => { const h = histRef.current; if (h.idx <= 0) return; if (inStep()) { window.history.back(); return; } h.idx -= 1; applyEntry(h.stack[h.idx]); setHistTick((t) => t + 1); };
  const goForward = () => { const h = histRef.current; if (h.idx >= h.stack.length - 1) return; if (inStep()) { window.history.forward(); return; } h.idx += 1; applyEntry(h.stack[h.idx]); setHistTick((t) => t + 1); };
  const canBack = histRef.current.idx > 0;
  // Mouse back / forward buttons (buttons 3 and 4) drive the in-app history in
  // the browser and on the desktop; the browser's own navigation is suppressed.
  // Electron on macOS also delivers them as app-command events via the main process.
  const navRef = useRef({ goBack, goForward }); navRef.current = { goBack, goForward };
  useEffect(() => {
    const onMouse = (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) navRef.current.goBack(); else navRef.current.goForward();
    };
    window.addEventListener('mouseup', onMouse);
    // Chromium fires the page navigation on mousedown/auxclick too; swallow both.
    const swallow = (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); };
    window.addEventListener('mousedown', swallow);
    window.addEventListener('auxclick', swallow);
    const off = window.conduit?.onNavigate?.((dir) => (dir === 'back' ? navRef.current.goBack() : navRef.current.goForward()));
    return () => { window.removeEventListener('mouseup', onMouse); window.removeEventListener('mousedown', swallow); window.removeEventListener('auxclick', swallow); off?.(); };
  }, []); // registered once; the ref always points at the current history
  const canForward = histRef.current.idx < histRef.current.stack.length - 1;
  // null | 'npv' | 'queue' | 'lyrics'
  const [panel, setPanel] = useState(null);
  const player = usePlayer(jf);

  // Restore a saved session, but only if the token still works.
  useEffect(() => {
    const saved = loadSession();
    if (saved) {
      const client = new Slopify(saved);
      setJf(client);
      // Paint instantly from the last run's data; the fetch below refreshes it.
      const alb = client.persisted('albums'); if (alb) setAlbums(alb);
      const art = client.persisted('artists'); if (art) setArtists(art);
      const pls = client.persisted('playlists'); if (pls) setPlaylists(pls);
      const sal = client.persisted('savedAlbums'); if (sal) setSavedAlbums(sal);
      const lk = client.persisted('liked'); if (Array.isArray(lk)) likedCacheRef.current = new Map(lk.map((t) => [t.Id, t]));
      if (alb) setLibLoading(false);
    }
    setBooting(false);
  }, []);

  useEffect(() => {
    if (!jf) return;
    jf.me().then(setMe).catch(() => {});
    setAvatarOk(true);
    // Paint the last known theme instantly, then the account's saved one.
    const cached = jf.persisted('prefs');
    if (cached) { setPrefs((p) => ({ ...p, ...cached })); applyTheme(cached.theme); jf.quality = deviceQuality(cached); }
    jf.getPrefs().then((p) => {
      const next = { ...p, theme: { ...DEFAULT_THEME, ...(p.theme || {}) }, quality: p.quality || 'original' };
      setPrefs(next); applyTheme(next.theme); jf.quality = deviceQuality(next); jf._persist('prefs', next);
    }).catch(() => {});
  }, [jf]);

  // The like store: loaded from the relay (which seeds/reconciles with
  // Jellyfin's favourites). The old prefs-blob timestamps are sent once so
  // they keep their dates, then never touched again.
  useEffect(() => {
    if (!jf) return;
    const seed = prefs.likedAt && Object.keys(prefs.likedAt).length ? prefs.likedAt : null;
    relayLikes(jf, seed).then((m) => { likesLoad(m); jf.likedAt = m; }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jf, prefs.likedAt ? 1 : 0]);
  useEffect(() => { if (jf) jf.likedAt = likesSnapshot(); }, [jf, likesVersion]);

  // Change a setting: apply here, save to the account, nudge the other clients.
  const updatePrefs = async (patch) => {
    // Only the PATCH travels (to Jellyfin and over the relay); every client
    // merges it. Broadcasting whole prefs objects let a stale client overwrite
    // what another had just saved.
    setPrefs((cur) => { const next = { ...cur, ...patch }; applyTheme(next.theme); jf.quality = deviceQuality(next); jf._persist('prefs', next); return next; });
    player.relay?.sendPrefs?.(patch);
    try { await jf.setPrefs(patch); } catch (e) { notify(`Could not save settings: ${e.message}`); }
  };
  const onUploadAvatar = async (file) => {
    try { await jf.uploadUserImage(file); setAvatarOk(true); setAvatarV(Date.now()); notify('Profile picture updated'); }
    catch (e) { notify(`Could not upload: ${e.message}`); }
  };
  const openSettings = () => {
    setView('home');
    setDetail({ item: { Id: 'settings', Name: 'Settings', Type: 'Settings' }, tracks: [], kind: 'Settings' });
  };

  // Load the library once connected. Albums/artists feed Home and Search;
  // playlists are what "Your Library" shows.
  useEffect(() => {
    if (!jf) return;
    // The album and artist lists cost Jellyfin 7 s and 2.4 s of a saturated
    // core tonight, per app launch, per device. The persisted copies are used
    // for 6 h; a library change (relay ping) or a stale copy refetches.
    const fresh = (key) => { const at = Number(jf.persisted(`${key}At`) || 0); return Date.now() - at < 6 * 3600 * 1000 && Array.isArray(jf.persisted(key)); };
    if (fresh('albums')) setLibLoading(false);
    else jf.albums({ limit: 500 }).then((a) => { setAlbums(a.items); jf._persist('albums', a.items); jf._persist('albumsAt', Date.now()); })
      .catch((e) => { if (String(e).includes('401')) { clearSession(); setJf(null); } })
      .finally(() => setLibLoading(false));
    if (!fresh('artists')) jf.artists({ limit: 500 }).then((r) => { setArtists(r.items); jf._persist('artists', r.items); jf._persist('artistsAt', Date.now()); }).catch(() => {});
    jf.playlists().then((p) => { setPlaylists(p.items); jf._persist('playlists', p.items); }).catch(() => {});
    jf.favoriteAlbums().then((a) => { setSavedAlbums(a.items); jf._persist('savedAlbums', a.items); }).catch(() => {});
  }, [jf]);

  const notify = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  const refreshPlaylists = async () => {
    try {
      const [p, n, a] = await Promise.all([jf.playlists(), jf.favoriteCount(), jf.favoriteAlbums()]);
      setPlaylists(p.items); setLikedCount(n); setSavedAlbums(a.items);
      jf._persist('playlists', p.items); jf._persist('likedCount', n); jf._persist('savedAlbums', a.items);
    } catch { /* ignore */ }
  };

  // Update a track's liked state everywhere it is currently shown.
  const patchLiked = () => {}; // hearts read the like store now
  const reconcile = (tracks) => tracks;

  // Device list is pushed from the main process as mDNS finds things.
  useEffect(() => {
    const api = window.conduit?.devices;
    if (!api) return undefined;
    api.list().then(setDevices).catch(() => {});
    return api.onChanged(setDevices);
  }, []);

  // Relay: register this client, surface the user's other clients as players,
  // and execute commands routed to us. Audio never touches the relay.
  // The relay lives for the whole login, so its callbacks must reach the
  // CURRENT player functions, not the ones of the render that opened it
  // (a hot reload of usePlayer left the desktop running the old command
  // handler until a restart).
  const playerRef = useRef(player); playerRef.current = player;
  useEffect(() => {
    if (!jf) return undefined;
    const relay = new SessionLink({
      baseUrl: jf.baseUrl,
      token: jf.token,
      name: (typeof window !== 'undefined' && window.conduit?.deviceName) || (window.conduit ? 'Slopify Desktop' : 'This Browser'),
      kind: window.conduit ? 'desktop' : 'web',
      canPlay: true,
      onRoster: (r) => playerRef.current.applyRoster(r),
      onCommand: (cmd) => playerRef.current.executeCommand(cmd),
      onQueue: (from, q) => playerRef.current.applyRemoteQueue(from, q),
      onSession: (s) => playerRef.current.applySession(s),
      onPrefs: (p) => {
        const patch = { ...p }; delete patch._libraryChanged;
        setPrefs((cur) => {
          const next = { ...cur, ...patch };
          if (patch.theme) next.theme = { ...DEFAULT_THEME, ...patch.theme };
          applyTheme(next.theme); jf.quality = deviceQuality(next); jf._persist('prefs', next);
          return next;
        });
        if (p._libraryChanged && p._libraryChanged !== relayLibraryPing.current) { relayLibraryPing.current = p._libraryChanged; refreshPlaylists(); jf._persist('albumsAt', 0); jf._persist('artistsAt', 0); }
      },
      // Another client liked / unliked: keep the timestamp map and the hearts in step.
      onLike: ({ itemId, liked, at }) => { likesSet(itemId, liked, at); },
      // Speaker timing offsets measured by anyone on this relay.
      onOffsets: offsetsMerge,
    });
    player.attachRelay(relay);
    return () => { relay.close(); player.attachRelay(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jf]);

  // The player needs the raw speaker list to resolve a transfer that names a
  // device id (a browser picking one of this desktop's speakers).
  const { registerDevices } = player;
  useEffect(() => { registerDevices(devices); }, [devices, registerDevices]);

  // The desktop app tells the relay which LAN speakers it can see, so the
  // user's other clients on the same network can target them.
  useEffect(() => {
    const relay = player.relay;
    if (!window.conduit || !relay) return;
    relay.reportDevices(devices.map((d) => ({ id: d.id, name: d.name, kind: d.kind })));
  }, [devices, player.relay]);

  // Once speakers are known, show whatever the house is already playing rather
  // than reporting nothing. Runs once and never steals a session started here.
  //
  // Depend on the stable callback, NOT on `player`: usePlayer returns a memo
  // keyed partly on `position`, so `player` gets a fresh identity on every
  // 200ms tick. Depending on it re-ran this five times a second and buried
  // every speaker in status requests.
  const { adoptActive } = player;
  useEffect(() => {
    // Needs BOTH the speakers and a live Jellyfin session: the speaker says
    // what is playing, Jellyfin turns its stream URL into a real track.
    if (!devices.length || !jf) return;
    adoptActive(devices).catch(() => {});
  }, [devices, jf, adoptActive]);

  const signOut = () => { clearSession(); setJf(null); };

  const goView = (v) => { setDetailRaw(null); setSeeAllRaw(null); setView(v); pushEntry({ view: v, detail: null, seeAll: null }); };

  // Space anywhere = play/pause, unless you are typing. Only text fields
  // swallow it; a focused slider/button/link (the last thing you clicked)
  // must not eat the key, and a focused button must not fire its own click
  // on keyup as well (that would toggle twice and look like nothing happened).
  useEffect(() => {
    const typing = (t) => {
      if (!t) return false;
      if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
      if (t.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file'].includes((t.type || 'text').toLowerCase());
      return false;
    };
    const onKey = (e) => {
      if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      player.toggle();
    };
    const onUp = (e) => { if (e.code === 'Space' && !typing(e.target)) e.preventDefault(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); };
  }, [player.toggle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playlist "Edit details": rename and/or a new cover.
  const onEditPlaylist = async (pl, { name, imageFile }) => {
    try {
      if (name && name !== pl.Name) await jf.renameItem(pl.Id, name);
      if (imageFile) { await jf.uploadPrimaryImage(pl.Id, imageFile); jf.bustImage(pl.Id); }
      // New playlists array + new detail item => sidebar, home shortcuts and
      // the hero all re-render with the busted image URL right away.
      await refreshPlaylists();
      setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, item: { ...d.item, Name: name || d.item.Name, _v: Date.now() } } : d));
      notify('Playlist updated');
    } catch (e) { notify(`Could not update playlist: ${e.message}`); }
  };
  const onDeletePlaylist = async (pl) => {
    try {
      await jf.deleteItem(pl.Id);
      await refreshPlaylists();
      player.relay?.sendPrefs?.({ _libraryChanged: Date.now() });
      setDetail(null);
      notify(`Deleted ${pl.Name}`);
    } catch (e) { notify(`Could not delete: ${e.message}`); }
  };

  // Footer links: art -> album, artist name -> artist page.
  // Navigation is instant: the page opens in its loading state on the click
  // and fills in as data lands, instead of the click doing nothing for the
  // seconds Jellyfin takes.
  const openAlbumById = async (albumId, known = null) => {
    setView('home');
    setDetail({ item: known || { Id: albumId, Name: '' }, tracks: [], kind: 'Album', loading: true });
    try {
      const [meta, trackList] = await Promise.all([jf.itemById(albumId), jf.tracks({ albumId })]);
      setDetail((d) => (d && d.item?.Id === albumId ? { ...d, item: meta || d.item, tracks: trackList.items, loading: false } : d));
    } catch { setDetail((d) => (d && d.item?.Id === albumId ? { ...d, loading: false } : d)); }
  };

  const openArtistById = async (artistId, known = null) => {
    setView('home');
    setDetail({ item: known || { Id: artistId, Name: '' }, tracks: [], albums: [], kind: 'Artist', loading: true });
    const alive = () => true;
    // Jellyfin's ArtistIds join takes ~1.7 s here; the search index answers the
    // same question (this artist's tracks, most played first) in ~20 ms.
    const fast = relaySearch(jf, '', { filter: `artistIds = "${artistId}"`, limit: 150 }).then((r) => r.tracks).catch(() => null);
    const metaP = jf.itemById(artistId).then((meta) => { if (alive() && meta) setDetail((d) => (d && d.item?.Id === artistId ? { ...d, item: meta } : d)); return meta; }).catch(() => null);
    jf.artistAlbums(artistId).then((a) => setDetail((d) => (d && d.item?.Id === artistId ? { ...d, albums: a.items } : d))).catch(() => {});
    try {
      let tracks = await fast;
      if (!tracks || !tracks.length) tracks = (await jf.tracks({ artistId, limit: 200 })).items;
      setDetail((d) => (d && d.item?.Id === artistId ? { ...d, tracks, loading: false } : d));
      // Popular = real-world order (Deezer top tracks matched to the library),
      // one row per title; the rest of the artist's tracks follow by plays.
      const name = known?.Name || (await metaP)?.Name;
      if (name) {
        const pop = await relayPopular(jf, artistId, name).catch(() => null);
        if (pop?.ids?.length) {
          const pos = new Map(pop.ids.map((id, i) => [id, i]));
          const known2 = tracks.filter((t) => pos.has(t.Id)).sort((a, b) => pos.get(a.Id) - pos.get(b.Id));
          const seen = new Set(known2.map((t) => t.Id));
          const rest = tracks.filter((t) => !seen.has(t.Id));
          const ordered = [...known2, ...rest];
          setDetail((d) => (d && d.item?.Id === artistId ? { ...d, tracks: ordered, popular: pop.ranked } : d));
        }
      }
    } catch { setDetail((d) => (d && d.item?.Id === artistId ? { ...d, loading: false } : d)); }
  };

  const openPlaylist = async (pl) => {
    setView('home');
    // Paint instantly from the last session's copy if we have one.
    const cached = jf.persisted(`pl.${pl.Id}`);
    setDetail({ item: pl, tracks: reconcile(cached || [], 0), kind: 'Playlist', loading: !cached });
    const since = Date.now();
    // Fast path: the relay reads Jellyfin's playlist.xml and answers from the
    // search index in ~20 ms (Jellyfin itself takes ~0.5 s per 100 tracks).
    // Jellyfin's own copy (the truth for liked / played state) follows behind.
    let fast = null;
    try {
      const r = await relayPlaylist(jf, pl.Id);
      if (r?.items?.length) { fast = r.items; setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, tracks: reconcile(fast, since), loading: false } : d)); }
    } catch { /* relay down or a playlist it cannot read: Jellyfin below */ }
    try {
      // First page renders fast; the rest streams in behind. Virtualized, so the
      // visible rows are ready at once. Every result is persisted for next time.
      const first = await jf.playlistTracks(pl.Id, { startIndex: 0, limit: 100 });
      if (fast && first.total > first.items.length) {
        // Already showing the whole list from the relay: wait for the full copy
        // rather than flashing a 100-row version in between.
        const rest = await jf.playlistTracks(pl.Id);
        setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, tracks: reconcile(rest.items, since), loading: false } : d));
        jf._persist(`pl.${pl.Id}`, rest.items);
        return;
      }
      setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, tracks: reconcile(first.items, since), loading: false } : d));
      jf._persist(`pl.${pl.Id}`, first.items);
      if (first.total > first.items.length) {
        const rest = await jf.playlistTracks(pl.Id);
        setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, tracks: reconcile(rest.items, since) } : d));
        jf._persist(`pl.${pl.Id}`, rest.items);
      }
    } catch { /* keep the cached copy on screen */ }
  };

  // Spotify's profile page: avatar, top artists / tracks this month, playlists.
  const openProfile = async () => {
    const item = { Id: 'profile', Name: me?.Name || 'You', Type: 'Profile' };
    setView('home');
    setDetail({ item, tracks: [], kind: 'Profile', topArtists: [], loading: true });
    try {
      const top = await jf.topTracks({ limit: 60 });
      const score = new Map();
      for (const t of top) {
        const w = 1 + (t.UserData?.PlayCount || 0);
        for (const a of t.ArtistItems || []) {
          const e = score.get(a.Id) || { Id: a.Id, Name: a.Name, n: 0 };
          e.n += w; score.set(a.Id, e);
        }
      }
      const topArtists = [...score.values()].sort((a, b) => b.n - a.n).slice(0, 16);
      setDetail((d) => (d && d.item?.Id === 'profile' ? { ...d, tracks: top.slice(0, 10), topArtists, loading: false } : d));
    } catch { setDetail((d) => (d && d.item?.Id === 'profile' ? { ...d, loading: false } : d)); }
  };

  const openHistory = () => {
    setView('home');
    setDetail({ item: { Id: 'history', Name: 'Listening history', Type: 'History' }, tracks: [], kind: 'History', loading: false });
  };

  // Liked Songs = the store's ids, newest first; rows fetched by id (chunks of
  // 150) and cached so a reopen paints at once. No Filters=IsFavorite query,
  // so nothing can "vanish" between an optimistic row and a server list.
  const likedRows = (ids) => ids.map((id) => likedCacheRef.current.get(id)).filter(Boolean);
  const openLiked = async () => {
    const item = { Id: LIKED_ID, Name: 'Liked Songs', Type: 'Playlist' };
    setView('home');
    const ids = likedIds();
    setDetail({ item, tracks: likedRows(ids), kind: 'Playlist', loading: ids.some((id) => !likedCacheRef.current.has(id)) });
    let missing = ids.filter((id) => !likedCacheRef.current.has(id));
    try {
      // One relay call fills nearly everything (the index has every track);
      // Jellyfin is asked by id only for what the index lacks.
      if (missing.length) {
        try {
          const fast = await likedFast(jf);
          for (const r of fast?.items || []) if (!likedCacheRef.current.has(r.Id)) likedCacheRef.current.set(r.Id, r);
          setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, tracks: likedRows(likedIds()) } : d));
          missing = likedIds().filter((id) => !likedCacheRef.current.has(id));
        } catch { /* relay down: the chunked path below still works */ }
      }
      for (let i = 0; i < missing.length; i += 150) {
        const rows = await jf.itemsByIds(missing.slice(i, i + 150));
        for (const r of rows) likedCacheRef.current.set(r.Id, r);
        setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, tracks: likedRows(likedIds()), loading: i + 150 < missing.length } : d));
      }
      setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, tracks: likedRows(likedIds()), loading: false } : d));
      // Cache every row (slimmed: blurhashes and media sources are dead weight
      // here) so the next open needs no fetch at all; a 1,500-row cap meant a
      // bigger library refetched the tail on every open. Serialised off the
      // tap so a phone does not stall on the JSON.
      if (missing.length) setTimeout(() => {
        const slim = ({ ImageBlurHashes, MediaSources, MediaStreams, Chapters, People, ...t }) => t; // eslint-disable-line no-unused-vars
        jf._persist('liked', likedRows(likedIds()).slice(0, 6000).map(slim));
      }, 250);
    } catch { setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, loading: false } : d)); }
  };
  // Keep the open Liked Songs page in step with the store (likes from any client).
  useEffect(() => {
    setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, tracks: likedRows(likedIds()) } : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [likesVersion]);

  const onLike = async (track, liked) => {
    likesSet(track.Id, liked);
    // The relay stores it, writes the Jellyfin favourite through, and echoes it
    // to every client (this one included, with the server's timestamp).
    if (player.relay?.connected) player.relay.sendLike(track.Id, liked);
    else { try { await jf.setFavorite(track.Id, liked); } catch (e) { likesSet(track.Id, !liked); notify(`Not saved: ${e.message.slice(0, 60)}`); return; } }
    notify(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
    // Keep the row so Liked Songs can show it without a fetch.
    if (liked) {
      let row = track;
      if (track._partial) { try { const full = await jf.itemById(track.Id); if (full) row = full; } catch { /* partial is fine */ } }
      likedCacheRef.current.set(track.Id, row);
      setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, tracks: likedRows(likedIds()) } : d));
    }
  };

  // "Save to Your Library" for an album: a Jellyfin favourite on the album.
  const onFollowAlbum = async (album, on) => {
    setDetail((d) => (d && d.item?.Id === album.Id ? { ...d, item: { ...d.item, UserData: { ...(d.item.UserData || {}), IsFavorite: on } } } : d));
    setSavedAlbums((list) => (on ? [album, ...list.filter((a) => a.Id !== album.Id)] : list.filter((a) => a.Id !== album.Id)));
    try {
      await jf.setFavorite(album.Id, on);
      notify(on ? 'Added to Your Library' : 'Removed from Your Library');
      const a = await jf.favoriteAlbums(); setSavedAlbums(a.items); jf._persist('savedAlbums', a.items);
      player.relay?.sendPrefs?.({ _libraryChanged: Date.now() });
    } catch (e) { notify(`Could not update: ${e.message}`); }
  };
  // Another client changed the library (saved an album, made a playlist).
  const relayLibraryPing = useRef(0);

  const onCreatePlaylist = async (name, firstTrack = null) => {
    try {
      await jf.createPlaylist(name, firstTrack ? [firstTrack.Id] : []);
      await refreshPlaylists();
      player.relay?.sendPrefs?.({ _libraryChanged: Date.now() });
      notify(firstTrack ? `Added to ${name}` : `Created ${name}`);
    } catch (e) { notify(`Could not create playlist: ${e.message}`); }
  };

  const onNewPlaylistWithTrack = (track) => {
    setNameDraft(track.Album || 'My Playlist');
    setNamePrompt({ track });
  };
  const submitNamePrompt = (e) => {
    e?.preventDefault?.();
    const name = nameDraft.trim();
    const track = namePrompt?.track;
    setNamePrompt(null);
    if (name) onCreatePlaylist(name, track || null);
  };

  // Thumbs-down in Jellyfin terms: instant mixes and smart shuffle skip it.
  const onExclude = async (track, excluded) => {
    const patch = (t) => t.Id === track.Id ? { ...t, UserData: { ...(t.UserData || {}), Likes: excluded ? false : null } } : t;
    setDetail((d) => d ? { ...d, tracks: d.tracks.map(patch) } : d);
    player.patchQueue?.(patch);
    try {
      await jf.setDislike(track.Id, excluded);
      notify(excluded ? 'Excluded from your taste profile' : 'Included in your taste profile');
    } catch (e) { notify(`Could not update: ${e.message}`); }
  };

  const onDownload = async (track, fmt) => {
    notify(fmt === 'wav' ? 'Converting to WAV...' : 'Downloading...');
    try { await downloadTrack(jf, track, fmt); }
    catch (e) { notify(`Download failed: ${e.message}`); }
  };

  const onAddTo = async (pl, track) => {
    try {
      await jf.addToPlaylist(pl.Id, [track.Id]);
      notify(`Added to ${pl.Name}`);
      refreshPlaylists();
      // If that playlist is open, show the new row.
      if (detail?.item?.Id === pl.Id) {
        const { items } = await jf.playlistTracks(pl.Id);
        setDetail((d) => d ? { ...d, tracks: items } : d);
      }
    } catch (e) { notify(`Could not add: ${e.message}`); }
  };

  const onRemoveFromPlaylist = async (pl, track) => {
    if (!track.PlaylistItemId) return;
    try {
      await jf.removeFromPlaylist(pl.Id, [track.PlaylistItemId]);
      setDetail((d) => d ? { ...d, tracks: d.tracks.filter((t) => t.PlaylistItemId !== track.PlaylistItemId) } : d);
      notify('Removed from playlist');
      refreshPlaylists();
    } catch (e) { notify(`Could not remove: ${e.message}`); }
  };

  const onReorder = async (pl, track, from, to) => {
    // Optimistic: move in the UI first, then tell Jellyfin.
    setDetail((d) => {
      if (!d) return d;
      const next = [...d.tracks];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...d, tracks: next };
    });
    try {
      await jf.movePlaylistItem(pl.Id, track.PlaylistItemId, to);
    } catch (e) {
      notify(`Could not reorder: ${e.message}`);
      const { items } = await jf.playlistTracks(pl.Id).catch(() => ({ items: null }));
      if (items) setDetail((d) => d ? { ...d, tracks: items } : d);
    }
  };

  // iOS 18 installed web app with a translucent status bar: the layout
  // viewport is one status bar shorter than the screen (852 -> 793) while the
  // web view is still full screen, so anything fixed to `bottom: 0` stops a
  // status-bar height above the edge and a bare strip shows below it. The gap
  // is exposed as --ios-shim + html.ios-shim and mobile-nowplaying.css turns
  // the page screen-height (--ios-screen-h, an absolute number: once the page
  // is taller than the short viewport WebKit may grow the viewport to the
  // full screen, and a height relative to that would overshoot) with body as
  // the containing block of the fixed chrome. Only ever non-zero when the
  // page really does sit under the status bar (safe-area-inset-top > 0): an
  // opaque status bar shrinks the web view for real, and then the gap must
  // stay at 0. The page may then be 59px taller than its viewport, so it is
  // pinned at scroll 0.
  //
  // Latched: applying the fix changes innerHeight, which fires resize, and
  // re-measuring on that took the fix away again (viewport 852 -> gap 0), which
  // shrank the viewport back, which... the phone flickered. Once on, the fix
  // stays until the width changes (rotation). iOS also fires resize with a
  // 1x1 / 4x4 web view around app switching; those are ignored.
  useEffect(() => {
    let latched = null;
    const measure = () => {
      if (window.innerWidth < 200 || window.screen.height < 200) return;
      if (latched && latched.shim > 0 && latched.w === window.innerWidth) return;
      let shim = 0;
      try {
        const standalone = window.navigator.standalone ?? window.matchMedia('(display-mode: standalone)').matches;
        const gap = window.screen.height - window.innerHeight;
        if (standalone && gap > 0 && gap <= 120) {
          const probe = document.createElement('div'); probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top);'; document.body.appendChild(probe);
          const sat = parseFloat(getComputedStyle(probe).height) || 0; probe.remove();
          if (sat > 0) shim = gap;
        }
      } catch { /* measurement only */ }
      latched = { w: window.innerWidth, shim };
      document.documentElement.style.setProperty('--ios-shim', `${shim}px`);
      document.documentElement.style.setProperty('--ios-screen-h', `${window.screen.height}px`);
      document.documentElement.classList.toggle('ios-shim', shim > 0);
    };
    const pin = () => { if (window.scrollY !== 0 && document.documentElement.classList.contains('ios-shim')) window.scrollTo(0, 0); };
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.addEventListener('scroll', pin, { passive: true });
    return () => { window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); window.removeEventListener('scroll', pin); };
  }, []);

  // Native shell bridge (mobile/App.js, react-native-webview). The page tells
  // the shell whether the sound is on THIS phone or elsewhere and the current
  // session volume; the shell turns hardware volume presses into steps here
  // while the sound is elsewhere (the phone's own buttons already control its
  // own output natively). setVolume routes to the active device.
  const remoteSession = !!player.mirroring || (player.device?.kind && player.device.kind !== 'local');
  useEffect(() => {
    const rn = window.ReactNativeWebView;
    if (!rn) return undefined;
    try { rn.postMessage(JSON.stringify({ type: 'session', remote: remoteSession, volume: Math.round(player.volume ?? 0), device: player.nowPlaying?.device?.name || null })); } catch { /* shell gone */ }
    return undefined;
  }, [remoteSession, Math.round(player.volume ?? 0), player.nowPlaying?.device?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!window.ReactNativeWebView) return undefined;
    const onStep = (e) => {
      const step = Number(e.detail?.step) || 0; if (!step) return;
      const next = Math.max(0, Math.min(100, Math.round(player.volume ?? 0) + step * 5));
      player.setVolume(next);
    };
    window.addEventListener('conduit:volumestep', onStep);
    return () => window.removeEventListener('conduit:volumestep', onStep);
  }, [player.volume, player.setVolume]); // eslint-disable-line react-hooks/exhaustive-deps

  // Phone viewport diagnostics, logged by the relay (installed web app layout
  // issues cannot be reproduced in a simulator).
  useEffect(() => {
    if (!isMobile || !player.relay?._send) return undefined;
    const report = () => {
      try {
        const tb = document.querySelector('.tabbar')?.getBoundingClientRect();
        const inset = (side) => { const probe = document.createElement('div'); probe.style.cssText = `position:fixed;${side}:0;height:env(safe-area-inset-${side});`; document.body.appendChild(probe); const v = getComputedStyle(probe).height; probe.remove(); return v; };
        const sab = inset('bottom'); const sat = inset('top');
        const shim = document.documentElement.style.getPropertyValue('--ios-shim') || '0px';
        player.relay._send({ type: 'diag', data: { standalone: window.navigator.standalone ?? window.matchMedia('(display-mode: standalone)').matches, inner: [window.innerWidth, window.innerHeight], visual: [Math.round(window.visualViewport?.width || 0), Math.round(window.visualViewport?.height || 0), Math.round(window.visualViewport?.offsetTop || 0)], screen: [window.screen.width, window.screen.height], docH: document.documentElement.clientHeight, bodyH: document.body.getBoundingClientRect().height, sab, sat, shim, keepAlive: window.__conduitKeepAliveState?.() || null, tabbar: tb ? [Math.round(tb.top), Math.round(tb.bottom), Math.round(tb.height)] : null, ua: navigator.userAgent.slice(0, 80) } });
      } catch { /* diagnostics only */ }
    };
    const t = setTimeout(report, 3000), t2 = setTimeout(report, 30000);
    // Back from the lock screen / another app: what the keep-alive did meanwhile.
    const vis = () => { if (document.visibilityState === 'visible') report(); };
    window.addEventListener('resize', report);
    document.addEventListener('visibilitychange', vis);
    return () => { clearTimeout(t); clearTimeout(t2); window.removeEventListener('resize', report); document.removeEventListener('visibilitychange', vis); };
  }, [isMobile, player.relay]);

  // Test hook: drive playback/transfer from the headless test. Gated on ?debug.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('debug')) {
      window.__jf = jf; window.__player = player; window.__onLike = onLike; window.__updatePrefs = updatePrefs;
    }
  }, [jf, player]);

  // Phone detail pages: how far the page has scrolled (0..1 over the hero) drives
  // the top bar's opacity, and its tint comes from the page's --hero colour.
  // Scroll events do not bubble, so the shell listens in the capture phase.
  const shellRef = useRef(null);
  const [topbar, setTopbar] = useState(0);
  const [topbarBg, setTopbarBg] = useState('#121212');
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !isMobile) return undefined;
    const onScroll = (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.classList.contains('content')) return;
      const hero = el.querySelector('.hero');
      const span = hero ? Math.max(120, hero.offsetHeight - 60) : 160;
      setTopbar(Math.max(0, Math.min(1, (el.scrollTop - 40) / span)));
      setTopbarBg(getComputedStyle(el).getPropertyValue('--hero').trim() || '#121212');
    };
    shell.addEventListener('scroll', onScroll, true);
    return () => shell.removeEventListener('scroll', onScroll, true);
  }, [isMobile, booting, jf]); // the shell only exists once signed in
  useEffect(() => { setTopbar(0); const el = shellRef.current?.querySelector('.content'); if (el) setTopbarBg(getComputedStyle(el).getPropertyValue('--hero').trim() || '#121212'); }, [detail?.item?.Id, seeAll]);
  // Long-press = right-click on the phone: iOS never fires `contextmenu` for a
  // touch, so a still 450 ms press dispatches one at the same spot and every
  // row/card that opens a menu on right-click gets Spotify's long-press sheet.
  useEffect(() => {
    if (!isMobile) return undefined;
    let timer = null, start = null;
    const cancel = () => { clearTimeout(timer); timer = null; start = null; };
    const down = (e) => {
      const t = e.touches?.[0]; if (!t || e.touches.length !== 1) return;
      // Holding the seek thumb (or any slider / field) is not a long-press.
      if (e.target.closest?.('input, textarea, [contenteditable]')) return;
      start = { x: t.clientX, y: t.clientY, target: e.target };
      timer = setTimeout(() => {
        const s = start; if (!s) return;
        s.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: s.x, clientY: s.y }));
        try { navigator.vibrate?.(10); } catch { /* not supported */ }
        // The finger lifting still produces the browser's synthesized
        // mousedown/click, which would close the sheet (outside click) or
        // play the row. Swallow them until the touch ends.
        const swallow = (ev) => { ev.stopImmediatePropagation(); ev.preventDefault(); };
        for (const type of ['mousedown', 'mouseup', 'click']) document.addEventListener(type, swallow, true);
        const release = () => { setTimeout(() => { for (const type of ['mousedown', 'mouseup', 'click']) document.removeEventListener(type, swallow, true); }, 400); window.removeEventListener('touchend', release); window.removeEventListener('touchcancel', release); };
        window.addEventListener('touchend', release, { passive: true });
        window.addEventListener('touchcancel', release, { passive: true });
        cancel();
      }, 450);
    };
    const move = (e) => { const t = e.touches?.[0]; if (start && t && (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10)) cancel(); };
    // Capture phase: a React handler that stops propagation on touchend (the
    // sheet scrim does) must not hide the lift from us, or the timer fires
    // after the finger is gone and the swallow eats the NEXT tap.
    window.addEventListener('touchstart', down, { passive: true, capture: true });
    window.addEventListener('touchmove', move, { passive: true, capture: true });
    window.addEventListener('touchend', cancel, { passive: true, capture: true });
    window.addEventListener('touchcancel', cancel, { passive: true, capture: true });
    return () => { window.removeEventListener('touchstart', down, true); window.removeEventListener('touchmove', move, true); window.removeEventListener('touchend', cancel, true); window.removeEventListener('touchcancel', cancel, true); };
  }, [isMobile]);
  // Swipe the mini player sideways to skip (Spotify): left = next, right = previous.
  useEffect(() => {
    if (!isMobile) return undefined;
    let start = null;
    const down = (e) => { const t = e.touches?.[0]; start = t && e.target.closest?.('.player-row') ? { x: t.clientX, y: t.clientY, at: Date.now() } : null; };
    const up = (e) => {
      if (!start) return; const t = e.changedTouches?.[0]; if (!t) { start = null; return; }
      const dx = t.clientX - start.x, dy = Math.abs(t.clientY - start.y);
      if (Math.abs(dx) > 60 && dy < 40 && Date.now() - start.at < 600) { if (dx < 0) player.next(); else player.previous(); }
      start = null;
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchend', up, { passive: true });
    return () => { window.removeEventListener('touchstart', down); window.removeEventListener('touchend', up); };
  }, [isMobile, player.next, player.previous]);
  // Swipe down on the now-playing screen closes it (Spotify). The sheet follows
  // the finger, then either snaps back or drops away.
  useEffect(() => {
    if (!isMobile || !fullScreen) return undefined;
    let start = null, el = null;
    // Sheets over the player (device picker, ⋯ menu), the visualizer, inputs and
    // a scrolled lyrics pane own their touches; only the player itself drags.
    const scrolledInside = (t) => { const sc = t.closest?.('.fs-lyrics, .viz, .ctxmenu, .devicemenu, .rightpanel, input'); return sc && (sc.scrollTop > 0 || !sc.classList.contains('fs-lyrics')); };
    const down = (e) => {
      const t = e.touches?.[0]; el = document.querySelector('.fs');
      if (!t || !el || e.touches.length !== 1 || scrolledInside(e.target)) { start = null; return; }
      start = { x: t.clientX, y: t.clientY, at: Date.now() };
    };
    const move = (e) => {
      if (!start || !el) return;
      const t = e.touches[0]; const dy = t.clientY - start.y;
      if (dy > 0 && Math.abs(t.clientX - start.x) < dy) { el.style.transform = `translateY(${dy}px)`; el.style.transition = 'none'; }
    };
    const up = (e) => {
      if (!start || !el) return;
      const t = e.changedTouches?.[0]; const dy = t ? t.clientY - start.y : 0; const fast = Date.now() - start.at < 300;
      el.style.transition = 'transform .25s cubic-bezier(.2,.7,.2,1)';
      if (dy > 140 || (fast && dy > 60)) { el.style.transform = 'translateY(100%)'; setTimeout(closeFullScreen, 200); }
      else el.style.transform = '';
      start = null;
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', up, { passive: true });
    return () => { window.removeEventListener('touchstart', down); window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up); };
  }, [isMobile, fullScreen]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bottom sheets (device picker, ⋯ menu) follow a downward drag and close
  // when it is released far or fast enough, like Spotify's.
  useEffect(() => {
    if (!isMobile) return undefined;
    let start = null, sheet = null;
    const down = (e) => {
      const t = e.touches?.[0];
      sheet = t && e.touches.length === 1 ? e.target.closest?.('.devicemenu, .ctxmenu-fixed:not(.ctxmenu-sub)') : null;
      start = sheet && sheet.scrollTop <= 0 ? { y: t.clientY, at: Date.now() } : null;
    };
    const move = (e) => {
      if (!start || !sheet) return;
      const dy = e.touches[0].clientY - start.y;
      // Non-passive: while the sheet follows the finger the browser must not
      // also scroll / rubber-band its contents (they would race ahead of it).
      if (dy > 0) { if (e.cancelable) e.preventDefault(); sheet.style.transform = `translateY(${dy}px)`; sheet.style.transition = 'none'; }
    };
    const up = (e) => {
      if (!start || !sheet) return;
      const t = e.changedTouches?.[0]; const dy = t ? t.clientY - start.y : 0; const fast = Date.now() - start.at < 300;
      sheet.style.transition = 'transform .2s ease-out';
      // Both sheets close on a mousedown outside themselves (Escape would
      // also close the full-screen player underneath).
      if (dy > 100 || (fast && dy > 40)) document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      else sheet.style.transform = '';
      start = null; sheet = null;
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', up, { passive: true });
    return () => { window.removeEventListener('touchstart', down); window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up); };
  }, [isMobile]);
  // iOS-style edge swipe: a drag that starts on the left edge goes back.
  useEffect(() => {
    if (!isMobile) return undefined;
    let start = null;
    const down = (e) => { const t = e.touches?.[0]; start = t && t.clientX < 28 ? { x: t.clientX, y: t.clientY, at: Date.now() } : null; };
    const up = (e) => {
      if (!start) return;
      const t = e.changedTouches?.[0]; if (!t) return;
      const dx = t.clientX - start.x, dy = Math.abs(t.clientY - start.y);
      if (dx > 70 && dy < 60 && Date.now() - start.at < 700 && !fullScreen && !panel) goBack();
      start = null;
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchend', up, { passive: true });
    return () => { window.removeEventListener('touchstart', down); window.removeEventListener('touchend', up); };
  }, [isMobile, fullScreen, panel]); // eslint-disable-line react-hooks/exhaustive-deps

  if (booting) return <div className="boot">Starting Conduit...</div>;
  if (!jf) return <Login onConnected={setJf} />;

  // Phone chrome: root tabs show avatar + page title (Spotify's Home/Search/
  // Library headers); detail pages hide the bar and float a back chevron.
  const mobileDetail = isMobile && !mobileLib && (detail || seeAll);
  const mobileTitle = mobileLib ? 'Your Library' : view === 'search' ? 'Search' : '';
  const detailTitle = detail?.item?.Name || (seeAll === 'albums' ? 'Albums' : seeAll === 'artists' ? 'Artists' : '');
  return (
    <div className={`app ${isMobile ? 'mobile' : ''} ${mobileDetail ? 'mobile-detail' : ''} ${isMobile ? (mobileLib ? 'tab-library' : mobileDetail ? 'tab-detail' : `tab-${view}`) : ''}`}>
      {mobileDetail && (
        // Spotify's detail header: a round back chevron floating over the hero
        // that becomes a solid bar carrying the title once the hero scrolls away.
        <div className="mobile-topbar" style={{ '--topbar': topbar, '--topbar-bg': topbarBg }}>
          <button className="mobile-back" onClick={goBack} title="Go back" aria-label="Go back">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M15.957 2.793a1 1 0 0 1 0 1.414L8.164 12l7.793 7.793a1 1 0 1 1-1.414 1.414L5.336 12l9.207-9.207a1 1 0 0 1 1.414 0z" /></svg>
          </button>
          <div className="mobile-topbar-title">{detailTitle}</div>
        </div>
      )}
      <header className="navbar">
        {/* App menu (the ⋯ Spotify keeps at the top-left), then history arrows. */}
        <div className="appmenuwrap">
          <button className="appmenu-btn" onClick={() => setAppMenu((v) => !v)} title="Menu" aria-label="Menu">
            <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><circle cx="2.25" cy="8" r="2" /><circle cx="8" cy="8" r="2" /><circle cx="13.75" cy="8" r="2" /></svg>
          </button>
          {appMenu && (
            <div className="avatarmenu appmenu">
              <button onClick={() => { setAppMenu(false); goView('home'); }}>Home</button>
              <button onClick={() => { setAppMenu(false); goView('search'); }}>Search</button>
              <div className="ctxmenu-sep" />
              <button onClick={() => { setAppMenu(false); openProfile(); }}>Profile</button>
              <button onClick={() => { setAppMenu(false); openHistory(); }}>History</button>
              <button onClick={() => { setAppMenu(false); openSettings(); }}>Settings</button>
              <div className="ctxmenu-sep" />
              <button onClick={() => { setAppMenu(false); window.location.reload(); }}>Reload</button>
              <button onClick={signOut}>Log out</button>
            </div>
          )}
        </div>
        {isMobile && <div className="mobile-title">{mobileTitle}</div>}
        <div className="navarrows">
          <button className="navarrow" onClick={goBack} disabled={!canBack} title="Go back">
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 1.5 4 8l6.5 6.5" /></svg>
          </button>
          <button className="navarrow" onClick={goForward} disabled={!canForward} title="Go forward">
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5.5 1.5 6.5 6.5-6.5 6.5" /></svg>
          </button>
        </div>
        <div className="navbar-right">
          <div className="avatarwrap">
            <button className="avatar" onClick={() => setUserMenu((v) => !v)} title={me?.Name || 'Account'}>
              {avatarOk ? (
                <img key={avatarV} src={jf.userImageUrl()} alt="" onError={() => setAvatarOk(false)} />
              ) : (
                (me?.Name || '?').slice(0, 1).toUpperCase()
              )}
            </button>
            {userMenu && (
              // Desktop: a dropdown. Phone: Spotify's left drawer (avatar + name
              // up top, then rows with icons); the CSS does the reshaping.
              <div className="avatarmenu">
                <button className="who" onClick={() => { setUserMenu(false); openProfile(); }}>
                  <span className="who-avatar">{avatarOk ? <img src={jf.userImageUrl()} alt="" /> : (me?.Name || '?').slice(0, 1).toUpperCase()}</span>
                  <span className="who-text"><b>{me?.Name || 'Signed in'}</b><small>View profile</small></span>
                </button>
                <div className="sub">{jf.baseUrl.replace(/^https?:\/\//, '')}</div>
                <button className="desktop-only" onClick={() => { setUserMenu(false); openProfile(); }}><MenuIco d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0" />Profile</button>
                <button onClick={() => { setUserMenu(false); openHistory(); }}><MenuIco d="M12 8v4l3 2M21 12a9 9 0 1 1-3-6.7M21 3v5h-5" /><span className="phone-only">Listening history</span><span className="desktop-only">History</span></button>
                <button onClick={() => { setUserMenu(false); openSettings(); }}><MenuIco d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />Settings</button>
                <button onClick={signOut}><MenuIco d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />Log out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div
        ref={shellRef}
        className={`shell ${panel ? 'with-panel' : ''} ${railW <= RAIL_COLLAPSED ? 'rail-collapsed' : ''} ${resizing ? 'resizing' : ''} ${isMobile && mobileLib ? 'show-lib' : ''}`}
        style={{ '--rail-w': `${railW}px`, '--panel-w': `${panelW}px` }}
      >
        <Sidebar
          view={view}
          onView={goView}
          playlists={playlists}
          savedAlbums={savedAlbums}
          onOpenAlbum={openAlbumById}
          player={player}
          prefs={prefs}
          onUpdatePrefs={updatePrefs}
          onEditPlaylist={(pl) => { setDetail(null); openPlaylist(pl).then(() => setTimeout(() => window.dispatchEvent(new CustomEvent('conduit:editdetails')), 300)); }}
          onDeletePlaylist={onDeletePlaylist}
          onFollowAlbum={onFollowAlbum}
          notify={notify}
          onOpenArtist={openArtistById}
          likedCount={likedCount}
          loading={libLoading}
          onOpen={openPlaylist}
          onOpenLiked={openLiked}
          onCreate={(name) => onCreatePlaylist(name)}
          jf={jf}
        />
        <div
          className="rail-resizer"
          onPointerDown={onRailDown}
          onDoubleClick={onRailDouble}
          title="Drag to resize. Double-click to collapse."
          role="separator"
          aria-orientation="vertical"
        />
        <Library
          jf={jf}
          player={player}
          view={view}
          onView={goView}
          albums={albums}
          artists={artists}
          playlists={playlists}
          detail={detail}
          setDetail={setDetail}
          query={query}
          setQuery={setQuery}
          onLike={onLike}
          onAddTo={onAddTo}
          onNewPlaylist={onNewPlaylistWithTrack}
          onRemoveFromPlaylist={onRemoveFromPlaylist}
          onReorder={onReorder}
          onOpenPlaylist={openPlaylist}
          onOpenLiked={openLiked}
          likedCount={likedCount}
          onOpenArtistById={openArtistById}
          onOpenAlbumById={openAlbumById}
          onExclude={onExclude}
          onDownload={onDownload}
          seeAll={seeAll}
          setSeeAll={setSeeAll}
          onEditPlaylist={onEditPlaylist}
          onDeletePlaylist={onDeletePlaylist}
          me={me}
          onOpenProfile={openProfile}
          onOpenSettings={openSettings}
          prefs={prefs}
          onUpdatePrefs={updatePrefs}
          onUploadAvatar={onUploadAvatar}
          avatarV={avatarV}
          onFollowAlbum={onFollowAlbum}
          notify={notify}
        />
        {panel && <div className="panel-spacer rail-resizer" onPointerDown={onPanelDown} title="Drag to resize" role="separator" aria-orientation="vertical" />}
        {panel && (
          <RightPanel
            mode={panel}
            onMode={setPanel}
            onClose={() => setPanel(null)}
            player={player}
            jf={jf}
            onOpenArtist={openArtistById}
            onOpenAlbum={openAlbumById}
            onLike={onLike}
            onAddTo={onAddTo}
            playlists={playlists}
          />
        )}
      </div>

      {typeof window !== 'undefined' && window.location.search.includes('debug') && (
        <div style={{position:'fixed',top:60,right:8,zIndex:200,background:'#000',color:'#0f0',font:'11px monospace',padding:8,borderRadius:6,maxWidth:280,lineHeight:1.4,whiteSpace:'pre-wrap'}}>
          {`myId=${player.relay?.id?.slice(-4) || '?'}
active=${player.roster?.activeClientId?.slice(-4) || 'none'}
players=${(player.roster?.players||[]).map(p=>p.name.slice(0,10)+':'+p.id.slice(-4)).join(', ')}
SHOWING: ${player.nowPlaying?.title?.slice(0,24) || 'nothing'}
pos=${Math.round(player.position)} playing=${player.playing} vol=${player.volume}`}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {namePrompt && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setNamePrompt(null); }}>
          <form className="modal" onSubmit={submitNamePrompt}>
            <h3>New playlist</h3>
            <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onFocus={(e) => e.target.select()} spellCheck="false" />
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setNamePrompt(null)}>Cancel</button>
              <button type="submit" className="primary" disabled={!nameDraft.trim()}>Create</button>
            </div>
          </form>
        </div>
      )}

      {isMobile && (
        <nav className="tabbar">
          {[['home', 'Home', TabHome], ['search', 'Search', TabSearch], ['library', 'Your Library', TabLib]].map(([k, label, Icon]) => {
            const on = mobileTab === k;
            // Tapping the lit tab pops its stack to the root, or scrolls a root page to the top.
            const tap = () => {
              if (on && !mobileDetail) { document.querySelector('.shell .content')?.scrollTo({ top: 0, behavior: 'smooth' }); return; }
              setMobileTab(k); mobileTabRef.current = k; // the entry goView pushes must carry the NEW tab
              if (k === 'library') setMobileLib(true); else { setMobileLib(false); goView(k); }
            };
            return (
              <button key={k} className={on ? 'on' : ''} onClick={tap}>
                <Icon on={on} /><span>{label}</span>
              </button>
            );
          })}
        </nav>
      )}
      <Player
        player={player}
        jf={jf}
        devices={[...devices, ...player.relayDevices, ...player.lanDevices]}
        onOpenAlbum={openAlbumById}
        onOpenArtist={openArtistById}
        panel={panel}
        onPanel={setPanel}
        onLike={onLike}
        onFullScreen={openFullScreen}
      />
      <PlayingElsewhereBar player={player} />
      {fullScreen && <FullScreen player={player} jf={jf} onClose={closeFullScreen} onOpenArtist={openArtistById} onOpenAlbum={openAlbumById} onLike={onLike} onAddTo={onAddTo} onNewPlaylist={onNewPlaylistWithTrack} playlists={playlists} prefs={prefs} onUpdatePrefs={updatePrefs} onPanel={setPanel} devices={[...devices, ...player.relayDevices, ...player.lanDevices]} sessionDevice={sessionDeviceOf(player, [...devices, ...player.relayDevices, ...player.lanDevices])} />}
    </div>
  );
}
