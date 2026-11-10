import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import ContextMenu from './ContextMenu.jsx';
import { LikedCover, usePhone, I as MI, shareItem, DownloadedMark } from './TrackRow.jsx';
import { LIKED_ID } from './Library.jsx';
import { useLibraryDrag } from './libraryDrag.js';
import { useOffline } from '../api/offline.js';
import { useOfflineMode } from '../offline/net.js';
import { t } from '../i18n.js';

const ICONS = {
  home: 'M12 3 3 10v11h6v-6h6v6h6V10z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
  library: 'M4 4v16M9 4v16M14 5l5 15',
  plus: 'M12 5v14M5 12h14',
  // Phone Library tab: sort arrows, grid / list view toggle.
  sort: 'M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  list: 'M4 6h16M4 12h16M4 18h16',
  // Folders: shut, and open (its things showing under it).
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  folderOpen: 'M3 18.5V6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h7.8A1.5 1.5 0 0 1 20 8.7V10M3 18.5 5.6 11a1.5 1.5 0 0 1 1.4-1h13.4a1 1 0 0 1 .95 1.3L19 18.9a1.5 1.5 0 0 1-1.4 1.1H4.5A1.5 1.5 0 0 1 3 18.5z',
};

function Icon({ name, size = 22 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

/**
 * Left rail. "Your Library" is Liked Songs pinned first, then the user's own
 * playlists, saved albums and followed artists, in the order they dragged
 * them into, some of them in folders (one level) -- Spotify's layout.
 */
// Spotify's green thumbtack, shown before the subtitle of pinned entries.
const Pin = () => (
  <svg className="libpin" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-label={t('Pinned')}>
    <path d="M8.822.797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337L8.822.797z" />
  </svg>
);
const toast = (m) => window.dispatchEvent(new CustomEvent('slopify:toast', { detail: m }));
const newRev = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
// Which folders are open is this device's own (like the grid / list view).
const OPEN_KEY = 'slopify.libOpenFolders';
const readOpen = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch { return new Set(); } };

export default function Sidebar({ view, onView, playlists, likedCount, onOpen, onOpenLiked, onCreate, jf, loading,
  savedAlbums = [], followedArtists = [], onOpenAlbum, player, prefs, onUpdatePrefs, onEditPlaylist, onDeletePlaylist, onFollowAlbum, onOpenArtist, onGenerate, onRegeneratePlaylist }) {
  const [menu, setMenu] = useState(null); // { x, y, entry }

  // Your Library's folders and order live on the server (libraryLayout.ts),
  // so every device shows the same; a change shows here at once and goes up
  // after (rolled back if the server says no). Another device's change
  // arrives as a ping over the session socket (prefs._libraryLayout).
  const [layout, setLayoutState] = useState(() => jf?.persisted('libraryLayout') || null);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const setLayout = useCallback((l) => { layoutRef.current = l; setLayoutState(l); jf?._persist('libraryLayout', l); }, [jf]);
  const seq = useRef(0), inflight = useRef(0), mine = useRef(new Set());
  const load = useCallback(() => {
    if (!jf) return;
    const at = seq.current;
    jf.libraryLayout().then((l) => { if (l?.order && !inflight.current && at === seq.current) setLayout(l); }).catch(() => {});
  }, [jf, setLayout]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const rev = prefs?._libraryLayout;
    if (rev && !mine.current.has(rev)) load();
  }, [prefs?._libraryLayout, load]);
  useEffect(() => {
    const on = (e) => { if (e.detail === '/api/library/layout') load(); };
    window.addEventListener('slopify:fresh', on);
    return () => window.removeEventListener('slopify:fresh', on);
  }, [load]);
  // next: the layout to show now; call(rev): the server change, answering
  // with the layout as the server has it (or nothing, then it is read again).
  const commit = (next, call) => {
    const prev = layoutRef.current; const my = ++seq.current; const rev = newRev();
    mine.current.add(rev);
    setLayout(next);
    inflight.current++;
    Promise.resolve().then(() => call(rev))
      .then((res) => { if (my !== seq.current) return; if (res?.order) setLayout(res); else jf.libraryLayout().then((l) => { if (my === seq.current && l?.order) setLayout(l); }).catch(() => {}); })
      .catch((e) => { if (my === seq.current) setLayout(prev); toast(t('Could not save Your Library: {error}', { error: e.message })); })
      .finally(() => { inflight.current--; });
  };

  const [openFolders, setOpenFolders] = useState(readOpen);
  const toggleFolder = (id) => setOpenFolders((cur) => {
    const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...n])); } catch { /* private mode */ }
    return n;
  });
  // While a folder is being dragged every folder shows shut (one level: it can only go between things).
  const [shut, setShut] = useState(false);

  // The library: what is saved, in the server's order. New things (no place
  // yet) go to the top, like Spotify; pinned entries float above the rest.
  const pinnedIds = Array.isArray(prefs?.libraryPinned) ? prefs.libraryPinned : [];
  const { top, folderKids, byId } = useMemo(() => {
    const all = [
      ...playlists.map((p) => ({ id: p.Id, kind: 'playlist', item: p })),
      ...savedAlbums.map((a) => ({ id: a.Id, kind: 'album', item: a })),
      ...followedArtists.map((a) => ({ id: a.Id, kind: 'artist', item: a })),
    ];
    const by = new Map(all.map((e) => [e.id, e]));
    const lay = layout || { order: Array.isArray(prefs?.libraryOrder) ? prefs.libraryOrder : [], folders: [] };
    const kids = new Map();
    const placed = new Set();
    for (const f of lay.folders || []) {
      const list = (f.items || []).filter((id) => by.has(id) && !placed.has(id));
      list.forEach((id) => placed.add(id));
      kids.set(f.id, list.map((id) => by.get(id)));
      by.set(f.id, { id: f.id, kind: 'folder', item: { Id: f.id, Name: f.name, Cover: f.cover || null } });
    }
    const known = [];
    for (const id of lay.order || []) if (by.has(id) && !placed.has(id)) { placed.add(id); known.push(by.get(id)); }
    for (const f of lay.folders || []) if (!placed.has(f.id)) { placed.add(f.id); known.unshift(by.get(f.id)); }
    const fresh = all.filter((e) => !placed.has(e.id));
    const pinned = new Set(pinnedIds);
    const list = [...fresh, ...known];
    return { top: [...list.filter((e) => pinned.has(e.id)), ...list.filter((e) => !pinned.has(e.id))], folderKids: kids, byId: by };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, savedAlbums, followedArtists, layout, prefs?.libraryOrder, prefs?.libraryPinned]);
  // The arrangement as shown, ready to change and send: every folder's
  // things (shown or not), and ids the server had that are not shown (yet).
  const current = () => {
    const lay = layoutRef.current || { order: [], folders: [] };
    const order = top.map((e) => e.id);
    for (const id of lay.order || []) if (!order.includes(id) && !byId.has(id)) order.push(id);
    const folders = {};
    for (const f of lay.folders || []) {
      const list = (folderKids.get(f.id) || []).map((e) => e.id);
      for (const id of f.items || []) if (!list.includes(id) && !byId.has(id)) list.push(id);
      folders[f.id] = list;
    }
    return { order, folders, names: Object.fromEntries((lay.folders || []).map((f) => [f.id, f.name])), covers: Object.fromEntries((lay.folders || []).filter((f) => f.cover).map((f) => [f.id, f.cover])) };
  };
  const asLayout = (c) => ({ order: c.order, folders: Object.entries(c.folders).map(([id, items]) => ({ id, name: c.names[id] ?? '', ...(c.covers?.[id] ? { cover: c.covers[id] } : {}), items })) });
  const save = (c) => commit(asLayout(c), (rev) => jf.saveLibraryLayout({ order: c.order, folders: c.folders }, rev));

  // Downloaded lists (api/offline.js): Spotify's green mark on one kept
  // whole, and with no connection the Library is only what is downloaded,
  // since anything else would open to nothing that plays.
  const offlineLib = useOffline();
  const offlineMode = useOfflineMode();
  const downloaded = useMemo(() => new Map((offlineLib.collections || []).filter((c) => c.have > 0).map((c) => [c.id, c])), [offlineLib.collections]);
  const dlSub = (id) => {
    const d = downloaded.get(id);
    if (!d) return null;
    if (d.have >= d.total) return <DownloadedMark />;
    return offlineMode ? <span className="libitem-partial">{t('{have} of {total} downloaded', { have: d.have, total: d.total })} • </span> : null;
  };
  const pinned = new Set(pinnedIds);
  const togglePin = (id) => {
    const next = pinned.has(id) ? [...pinned].filter((x) => x !== id) : [...pinned, id];
    onUpdatePrefs?.({ libraryPinned: next });
  };

  const playEntry = async (e, enqueue = false) => {
    const { items } = e.kind === 'album' ? await jf.tracks({ albumId: e.id }) : e.kind === 'artist' ? { items: await jf.instantMix(e.id) } : await jf.playlistTracks(e.id);
    if (!items.length) return;
    if (enqueue) player.addToQueue(items); else player.playQueue(items, 0, e.id);
  };

  // --- folders -------------------------------------------------------------
  const createFolder = (name) => {
    const c = current(); const tmp = `fd_new${Date.now().toString(36)}`;
    c.order.unshift(tmp); c.folders[tmp] = []; c.names[tmp] = name;
    commit(asLayout(c), (rev) => jf.createFolder(name, rev).then(() => null));
  };
  const renameFolder = (id, name) => {
    const c = current(); c.names[id] = name;
    commit(asLayout(c), (rev) => jf.renameFolder(id, name, rev).then(() => null));
  };
  // A picture of its own, like a playlist's: picked from the device.
  const coverPick = useRef(null);
  const chooseFolderPhoto = (id) => { const el = coverPick.current; if (!el) return; el.dataset.folder = id; el.value = ''; el.click(); };
  const onFolderPhoto = (ev) => {
    const file = ev.target.files?.[0]; const id = ev.target.dataset.folder;
    if (!file || !id) return;
    commit(layoutRef.current, (rev) => jf.uploadFolderCover(id, file, rev).then(() => null));
  };
  // What it held goes back where the folder was; none of it is deleted.
  const deleteFolder = (id) => {
    const c = current(); const kids = c.folders[id] || [];
    c.order = c.order.flatMap((x) => (x === id ? kids : [x])); delete c.folders[id];
    commit(asLayout(c), (rev) => jf.deleteFolder(id, rev).then(() => null));
  };

  const menuItems = (e) => e.kind === 'liked' ? [
    { label: t('Add to queue'), onClick: async () => { const { items } = await jf.favoriteTracks(); player.addToQueue(items); } },
    { label: t('Play'), onClick: async () => { const { items } = await jf.favoriteTracks(); if (items.length) player.playQueue(items, 0, 'liked'); } },
  ] : e.kind === 'folder' ? [
    { label: t('Rename'), icon: MI.edit, onClick: () => startNaming({ kind: 'rename', id: e.id, name: e.item.Name }) },
    { label: t('Choose photo'), icon: MI.photo, onClick: () => chooseFolderPhoto(e.id) },
    { label: t('Delete'), icon: MI.trash, danger: true, onClick: () => { if (window.confirm(t('Delete "{name}"?', { name: e.item.Name }))) deleteFolder(e.id); } },
  ] : e.kind === 'album' ? [
    { label: t('Add to queue'), onClick: () => playEntry(e, true) },
    { label: t('Play'), onClick: () => playEntry(e) },
    { sep: true },
    { label: pinned.has(e.id) ? t('Unpin album') : t('Pin album'), onClick: () => togglePin(e.id) },
    e.item.AlbumArtists?.[0]?.Id ? { label: t('Go to artist'), onClick: () => onOpenArtist?.(e.item.AlbumArtists[0].Id) } : null,
    { label: t('Share'), onClick: () => shareItem({ kind: 'album', id: e.id, title: e.item.Name, by: e.item.AlbumArtists?.[0]?.Name || e.item.AlbumArtist }) },
    { label: t('Remove from Your Library'), onClick: () => onFollowAlbum?.(e.item, false) },
  ] : e.kind === 'artist' ? [
    { label: t('Add to queue'), onClick: () => playEntry(e, true) },
    { label: t('Play'), onClick: () => playEntry(e) },
    { sep: true },
    { label: pinned.has(e.id) ? t('Unpin artist') : t('Pin artist'), onClick: () => togglePin(e.id) },
    { label: t('Share'), onClick: () => shareItem({ kind: 'artist', id: e.id, title: e.item.Name }) },
    { label: t('Unfollow'), onClick: async () => { await jf.setFavorite(e.id, false).catch(() => {}); window.dispatchEvent(new CustomEvent('slopify:librarychanged')); } },
  ] : [
    { label: t('Add to queue'), onClick: () => playEntry(e, true) },
    { label: t('Play'), onClick: () => playEntry(e) },
    { sep: true },
    { label: pinned.has(e.id) ? t('Unpin playlist') : t('Pin playlist'), onClick: () => togglePin(e.id) },
    ...(e.item.AiPrompt ? [{ label: t('Regenerate'), onClick: () => onRegeneratePlaylist?.(e.item) }] : []),
    { label: t('Edit details'), onClick: () => onEditPlaylist?.(e.item) },
    { label: t('Delete'), icon: MI.trash, danger: true, onClick: () => { if (window.confirm(t('Delete "{name}"?', { name: e.item.Name }))) onDeletePlaylist?.(e.item); } },
  ];
  const openMenu = (ev, entry) => {
    ev.preventDefault(); ev.stopPropagation();
    // A finger held on a row: the menu comes when it lifts without moving (a drag otherwise).
    if (drag.pending()) return;
    setMenu({ x: ev.clientX, y: ev.clientY, entry });
  };

  // Phone Library tab: Spotify's filter chips + "Recents" sort row (CSS shows them only there).
  const [libFilter, setLibFilter] = useState(null); // null | 'playlist' | 'album' | 'artist'
  // Naming inline on the desktop (playlist / folder / a folder's new name),
  // full screen on the phone: { kind: 'playlist' | 'folder' | 'rename', id? }.
  const [creating, setCreating] = useState(null);
  const [name, setName] = useState('');
  const phone = usePhone();
  // Phone: the magnifier in the header opens "Find in Your Library"; the
  // grid / list toggle at the right of the sort row.
  const [searching, setSearching] = useState(false);
  const [libQuery, setLibQuery] = useState('');
  const [gridView, setGridView] = useState(false);
  // Phone "+": a sheet with "Playlist", then a full-screen "Give your playlist a name".
  const [createSheet, setCreateSheet] = useState(null); // { x, y }
  const [naming, setNaming] = useState(null);
  const startNaming = (what) => { setName(what.name || ''); if (phone) setNaming(what); else setCreating(what); };
  // The empty state waits for the library to have actually arrived (the
  // playlists request has no flag of its own, so also let the first paint settle).
  const [settled, setSettled] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSettled(true), 1500); return () => clearTimeout(timer); }, []);
  // "+": Spotify's create menu: a plain playlist (named inline on the
  // desktop, full screen on the phone), one the local model generates from a
  // description, or a folder to put things in.
  const openCreate = (e) => {
    if (creating) { setCreating(null); return; }
    const r = e?.currentTarget?.getBoundingClientRect?.();
    setCreateSheet({ x: r ? r.left : 0, y: r ? r.bottom + 4 : 0 });
  };
  const createItems = [
    { label: t('Playlist'), desc: phone ? null : t('Build a playlist with songs'), icon: MI.playlist, onClick: () => startNaming({ kind: 'playlist' }) },
    onGenerate && { label: t('Generated playlist (AI)'), desc: phone ? null : t('Describe it, get 25 songs from your library'), icon: MI.sparkle, onClick: () => onGenerate() },
    { label: t('Folder'), desc: phone ? null : t('Organize your library'), icon: <Icon name="folder" size={16} />, onClick: () => startNaming({ kind: 'folder' }) },
  ].filter(Boolean);
  const q = libQuery.trim().toLowerCase();
  const matches = (n) => !q || (n || '').toLowerCase().includes(q);
  const showLiked = (!libFilter || libFilter === 'playlist') && matches(t('Liked Songs')) && (!offlineMode || downloaded.has(LIKED_ID));
  // A filter, a search or no connection: one flat list, what is in folders
  // included (and no dragging: the order shown is not the whole library).
  const flat = Boolean(libFilter || q || offlineMode);
  const flatEntries = useMemo(() => top.flatMap((e) => (e.kind === 'folder' ? folderKids.get(e.id) || [] : [e])), [top, folderKids]);
  const shownEntries = flat
    ? flatEntries.filter((e) => (!libFilter || e.kind === libFilter) && matches(e.item.Name) && (!offlineMode || downloaded.has(e.id)))
    : top.flatMap((e) => (e.kind === 'folder' && openFolders.has(e.id) && !shut ? [e, ...(folderKids.get(e.id) || []).map((k) => ({ ...k, parent: e.id }))] : [e]));
  // Artists cannot be downloaded: offline the chip goes, and a filter on it with it.
  useEffect(() => { if (offlineMode && libFilter === 'artist') setLibFilter(null); }, [offlineMode, libFilter]);

  // --- dragging ------------------------------------------------------------
  const listRef = useRef(null);
  const shownRef = useRef(shownEntries); shownRef.current = shownEntries;
  const onDrop = ({ id, to, into, rows }) => {
    const meta = new Map(shownRef.current.map((e) => [e.id, e]));
    const c = current();
    const dragged = meta.get(id);
    c.order = c.order.filter((x) => x !== id);
    for (const f of Object.keys(c.folders)) c.folders[f] = c.folders[f].filter((x) => x !== id);
    if (into) {
      // Onto a folder: first in it.
      c.folders[into] = [id, ...(c.folders[into] || [])];
    } else {
      const others = rows.filter((x) => x !== id);
      const prev = others[to - 1], next = others[to];
      const pm = prev && meta.get(prev), nm = next && meta.get(next);
      if (nm?.parent && dragged?.kind !== 'folder') {
        // Between two of a folder's things (or before its first): in the folder.
        const list = c.folders[nm.parent]; list.splice(list.indexOf(next), 0, id);
      } else if (pm?.kind === 'folder' && openFolders.has(pm.id) && !shut && dragged?.kind !== 'folder' && !nm?.parent && !(folderKids.get(pm.id) || []).length) {
        // Right under an open, empty folder: in it.
        c.folders[pm.id] = [id];
      } else {
        // At the top level, after the thing above it (or the folder that holds it).
        const anchor = pm ? (pm.parent || pm.id) : null;
        c.order.splice(anchor ? c.order.indexOf(anchor) + 1 : 0, 0, id);
      }
    }
    flushSync(() => { setShut(false); save(c); });
  };
  const drag = useLibraryDrag({
    listRef, enabled: !flat && !creating, onDrop,
    canEnter: (id) => byId.get(id)?.kind !== 'folder',
    onLift: (id) => { if (byId.get(id)?.kind === 'folder' && openFolders.size) flushSync(() => setShut(true)); },
    onEnd: () => setShut(false),
    onHold: ({ id, x, y }) => { const e = shownRef.current.find((r) => r.id === id); if (e) setMenu({ x, y, entry: e }); },
  });

  const submit = (e) => {
    e.preventDefault();
    const n = name.trim();
    const what = creating || naming;
    if (!n || !what) return;
    if (what.kind === 'folder') createFolder(n);
    else if (what.kind === 'rename') { if (n !== byId.get(what.id)?.item.Name) renameFolder(what.id, n); }
    else onCreate(n);
    setName('');
    setCreating(null);
  };
  const placeholder = creating?.kind === 'playlist' ? t('Playlist name') : t('Folder name');

  const nameForm = (
    <form onSubmit={submit} style={{ padding: '4px 8px 10px' }}>
      <input className="newplaylist-input" autoFocus placeholder={placeholder} value={name}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setCreating(null)}
        onBlur={() => { if (creating?.kind === 'rename') setCreating(null); }} />
    </form>
  );

  return (
    <aside className="sidebar">
      <input ref={coverPick} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={onFolderPhoto} />
      <nav className="nav">
        <button className={`navitem ${view === 'home' ? 'on' : ''}`} onClick={() => onView('home')}>
          <Icon name="home" /><span>{t('Home')}</span>
        </button>
        <button className={`navitem ${view === 'search' ? 'on' : ''}`} onClick={() => onView('search')}>
          <Icon name="search" /><span>{t('Search')}</span>
        </button>
      </nav>

      <div className="libpanel">
        <div className="libhead">
          <span className="libhead-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }} title={t('Your Library')}>
            <Icon name="library" /> <span className="libhead-label">{t('Your Library')}</span>
          </span>
          <span className="libhead-actions">
            {phone && (
              <button className={`icon-btn ${searching ? 'on' : ''}`} onClick={() => { setSearching((v) => !v); setLibQuery(''); }} title={t('Find in Your Library')} aria-label={t('Find in Your Library')}>
                <Icon name="search" size={24} />
              </button>
            )}
            <button className="icon-btn" onClick={openCreate} title={t('Create playlist')} aria-label={t('Create playlist')}>
              <Icon name="plus" size={phone ? 24 : 18} />
            </button>
          </span>
        </div>

        <div className="libchips">
          {libFilter && <button className="pill x" onClick={() => setLibFilter(null)} aria-label={t('Clear filter')}>×</button>}
          {[['playlist', t('Playlists')], ['album', t('Albums')], ['artist', t('Artists')]].filter(([k]) => !(offlineMode && k === 'artist')).map(([k, label]) => (!libFilter || libFilter === k) && (
            <button key={k} className={`pill ${libFilter === k ? 'on' : ''}`} onClick={() => setLibFilter(libFilter === k ? null : k)}>{label}</button>
          ))}
        </div>
        {searching && phone ? (
          <div className="libsearch">
            <Icon name="search" size={20} />
            <input autoFocus value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder={t('Find in Your Library')} spellCheck="false"
              onKeyDown={(e) => e.key === 'Escape' && (setSearching(false), setLibQuery(''))} />
            <button type="button" onClick={() => { setSearching(false); setLibQuery(''); }}>{t('Cancel')}</button>
          </div>
        ) : (
          <div className="libsort">
            <span><Icon name="sort" size={16} /> {t('Recents')}</span>
            <button className="libview" onClick={() => setGridView((v) => !v)} title={gridView ? t('List view') : t('Grid view')} aria-label={gridView ? t('List view') : t('Grid view')}>
              <Icon name={gridView ? 'list' : 'grid'} size={20} />
            </button>
          </div>
        )}
        <div className={`liblist ${gridView ? 'grid' : ''}`} ref={listRef} data-own-press={!flat ? '' : undefined}>
          {creating && creating.kind !== 'rename' && nameForm}
          {/* Where a dragged row lands (libraryDrag.js moves it). */}
          <div className="libdrop" aria-hidden="true" />

          {showLiked && <button className="libitem" onClick={onOpenLiked} onContextMenu={(ev) => openMenu(ev, { id: 'liked', kind: 'liked' })} title={t('Liked Songs')}>
            <LikedCover />
            <span className="libitem-text">
              <span className="libitem-name">{t('Liked Songs')}</span>
              <span className="libitem-sub"><Pin />{dlSub(LIKED_ID)}{t('Playlist')}{likedCount != null ? ` • ${t('{n} songs', { n: likedCount })}` : ''}</span>
            </span>
          </button>}

          {shownEntries.map((e) => {
            const it = e.item;
            if (creating?.kind === 'rename' && creating.id === e.id) return <React.Fragment key={e.id}>{nameForm}</React.Fragment>;
            if (e.kind === 'folder') {
              const open = openFolders.has(e.id) && !shut;
              const n = (folderKids.get(e.id) || []).length;
              return (
                <button key={e.id} className={`libitem libfolder ${open ? 'open' : ''}`} data-lib-row={e.id} data-lib-folder=""
                  onClick={() => toggleFolder(e.id)} onContextMenu={(ev) => openMenu(ev, e)} onPointerDown={drag.onPointerDown(e.id)}
                  title={it.Name} aria-expanded={open}>
                  {it.Cover
                    ? <img className="libfolder-art" src={jf.imageUrl(it.Id, { maxHeight: 84 }) + `&c=${String(it.Cover).slice(0, 10)}`} alt="" loading="lazy" draggable={false} />
                    : <span className="ph libfolder-art"><Icon name={open ? 'folderOpen' : 'folder'} size={phone ? 28 : 24} /></span>}
                  <span className="libitem-text">
                    <span className="libitem-name">{it.Name}</span>
                    <span className="libitem-sub">{`${t('Folder')} • ${t('{n} items', { n })}`}</span>
                  </span>
                </button>
              );
            }
            const art = jf.imageUrl(it.Id, { maxHeight: 84 });
            const sub = e.kind === 'album'
              ? `${t('Album')} • ${it.AlbumArtist || it.AlbumArtists?.[0]?.Name || ''}`
              : e.kind === 'artist' ? t('Artist')
              : `${t('Playlist')}${it.ChildCount ? ` • ${t('{n} songs', { n: it.ChildCount })}` : ''}`;
            return (
              <button
                key={e.id}
                className={`libitem ${e.kind === 'artist' ? 'round' : ''} ${e.parent ? 'infolder' : ''}`}
                data-lib-row={e.id}
                onClick={() => (e.kind === 'album' ? onOpenAlbum?.(it.Id) : e.kind === 'artist' ? onOpenArtist?.(it.Id) : onOpen(it))}
                onContextMenu={(ev) => openMenu(ev, e)}
                onPointerDown={drag.onPointerDown(e.id)}
                title={it.Name}
              >
                {art ? <img src={art} alt="" loading="lazy" draggable={false} /> : <div className="ph" />}
                <span className="libitem-text">
                  <span className="libitem-name">{it.Name}</span>
                  <span className="libitem-sub">{pinned.has(e.id) && <Pin />}{e.kind !== 'artist' && dlSub(e.id)}{sub}</span>
                </span>
              </button>
            );
          })}
          {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
          {createSheet && (
            <ContextMenu x={createSheet.x} y={createSheet.y} onClose={() => setCreateSheet(null)}
              items={createItems} />
          )}
          {naming && createPortal(
            <form className="newpl" onSubmit={(e) => { setCreating(null); const what = naming; e.preventDefault(); const n = name.trim(); if (n) { if (what.kind === 'folder') createFolder(n); else if (what.kind === 'rename') renameFolder(what.id, n); else onCreate(n); } setName(''); setNaming(null); }}>
              <h2>{naming.kind === 'playlist' ? t('Give your playlist a name') : naming.kind === 'folder' ? t('Give your folder a name') : t('Rename folder')}</h2>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={naming.kind === 'playlist' ? t('My playlist #1') : t('My folder')} spellCheck="false"
                onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
              <div className="newpl-actions">
                <button type="button" className="newpl-cancel" onClick={() => setNaming(null)}>{t('Cancel')}</button>
                <button type="submit" className="newpl-create" disabled={!name.trim()}>{naming.kind === 'rename' ? t('Save') : t('Create')}</button>
              </div>
            </form>,
            document.body,
          )}

          {offlineMode && !showLiked && !shownEntries.length && !q && (
            <div className="libempty">
              <b>{t('Nothing downloaded')}</b>
              <p>{t('Download a playlist or album while you have a connection and it shows here.')}</p>
            </div>
          )}
          {!offlineMode && !shownEntries.length && !loading && settled && likedCount != null && !q && (!libFilter || libFilter === 'playlist') && (phone ? (
            <div className="libempty">
              <b>{t('Create your first playlist')}</b>
              <p>{t("It's easy, we'll help you.")}</p>
              <button onClick={openCreate}>{t('Create playlist')}</button>
            </div>
          ) : (
            <p className="devicemenu-empty">
              {t('Create your first playlist with the + button.')}
            </p>
          ))}
          {q && !showLiked && !shownEntries.length && (
            <div className="libempty">
              <b>{t('Couldn’t find “{query}”', { query: libQuery.trim() })}</b>
              <p>{t('Try a different playlist, album or artist name.')}</p>
            </div>
          )}
          {!q && !offlineMode && phone && libFilter === 'artist' && !shownEntries.length && !loading && (
            <div className="libempty">
              <b>{t('No artists yet')}</b>
              <p>{t('Follow an artist and they show up here.')}</p>
            </div>
          )}
          {!q && !offlineMode && phone && libFilter === 'album' && !shownEntries.length && !loading && (
            <div className="libempty">
              <b>{t('Save your first album')}</b>
              <p>{t('Add an album to Your Library and it shows up here.')}</p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
