import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ContextMenu from './ContextMenu.jsx';
import { Heart, LikedCover, usePhone, I as MI } from './TrackRow.jsx';

const ICONS = {
  home: 'M12 3 3 10v11h6v-6h6v6h6V10z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
  library: 'M4 4v16M9 4v16M14 5l5 15',
  plus: 'M12 5v14M5 12h14',
  // Phone Library tab: sort arrows, grid / list view toggle.
  sort: 'M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  list: 'M4 6h16M4 12h16M4 18h16',
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
 * playlists -- Spotify's layout. Albums and artists live under Home and Search.
 */
// Spotify's green thumbtack, shown before the subtitle of pinned entries.
const Pin = () => (
  <svg className="libpin" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-label="Pinned">
    <path d="M8.822.797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337L8.822.797z" />
  </svg>
);

export default function Sidebar({ view, onView, playlists, likedCount, onOpen, onOpenLiked, onCreate, jf, loading,
  savedAlbums = [], onOpenAlbum, player, prefs, onUpdatePrefs, onEditPlaylist, onDeletePlaylist, onFollowAlbum, onOpenArtist }) {
  const [menu, setMenu] = useState(null); // { x, y, entry }
  const [dragId, setDragId] = useState(null);
  const dragRef = useRef(null); // the drop handler must not depend on a re-render having happened
  const [overId, setOverId] = useState(null);

  // Your Library = playlists + saved albums, in the order you dragged them
  // into (kept in account prefs, so every device shows the same order and
  // follows a change live). New things go to the top, like Spotify.
  const entries = useMemo(() => {
    const all = [
      ...playlists.map((p) => ({ id: p.Id, kind: 'playlist', item: p })),
      ...savedAlbums.map((a) => ({ id: a.Id, kind: 'album', item: a })),
    ];
    const order = Array.isArray(prefs?.libraryOrder) ? prefs.libraryOrder : [];
    const pos = new Map(order.map((id, i) => [id, i]));
    const known = all.filter((e) => pos.has(e.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    const fresh = all.filter((e) => !pos.has(e.id));
    // Pinned entries float to the top (in their own dragged order), like Spotify's pins.
    const pinned = new Set(Array.isArray(prefs?.libraryPinned) ? prefs.libraryPinned : []);
    const list = [...fresh, ...known];
    return [...list.filter((e) => pinned.has(e.id)), ...list.filter((e) => !pinned.has(e.id))];
  }, [playlists, savedAlbums, prefs?.libraryOrder, prefs?.libraryPinned]);
  // Phone "Artists" chip: the artists behind the saved albums (Conduit has no
  // separate follow list), one row each, like Spotify's followed artists.
  const artistEntries = useMemo(() => {
    const seen = new Map();
    for (const a of savedAlbums) for (const ar of a.AlbumArtists || []) if (ar?.Id && !seen.has(ar.Id)) seen.set(ar.Id, { id: ar.Id, kind: 'artist', item: { Id: ar.Id, Name: ar.Name } });
    return [...seen.values()].sort((x, y) => x.item.Name.localeCompare(y.item.Name));
  }, [savedAlbums]);
  const pinned = new Set(Array.isArray(prefs?.libraryPinned) ? prefs.libraryPinned : []);
  const togglePin = (id) => {
    const next = pinned.has(id) ? [...pinned].filter((x) => x !== id) : [...pinned, id];
    onUpdatePrefs?.({ libraryPinned: next });
  };

  const reorder = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    const ids = entries.map((e) => e.id);
    const from = ids.indexOf(fromId), to = ids.indexOf(toId);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    onUpdatePrefs?.({ libraryOrder: ids });
  };

  const playEntry = async (e, enqueue = false) => {
    const { items } = e.kind === 'album' ? await jf.tracks({ albumId: e.id }) : await jf.playlistTracks(e.id);
    if (!items.length) return;
    if (enqueue) player.addToQueue(items); else player.playQueue(items, 0, e.id);
  };
  const menuItems = (e) => e.kind === 'liked' ? [
    { label: 'Play', onClick: async () => { const { items } = await jf.favoriteTracks(); if (items.length) player.playQueue(items, 0, 'liked'); } },
    { label: 'Add to queue', onClick: async () => { const { items } = await jf.favoriteTracks(); player.addToQueue(items); } },
  ] : e.kind === 'album' ? [
    { label: 'Play', onClick: () => playEntry(e) },
    { label: 'Add to queue', onClick: () => playEntry(e, true) },
    { sep: true },
    { label: pinned.has(e.id) ? 'Unpin album' : 'Pin album', onClick: () => togglePin(e.id) },
    e.item.AlbumArtists?.[0]?.Id ? { label: 'Go to artist', onClick: () => onOpenArtist?.(e.item.AlbumArtists[0].Id) } : null,
    { label: 'Remove from Your Library', onClick: () => onFollowAlbum?.(e.item, false) },
  ] : [
    { label: 'Play', onClick: () => playEntry(e) },
    { label: 'Add to queue', onClick: () => playEntry(e, true) },
    { sep: true },
    { label: pinned.has(e.id) ? 'Unpin playlist' : 'Pin playlist', onClick: () => togglePin(e.id) },
    { label: 'Edit details', onClick: () => onEditPlaylist?.(e.item) },
    { label: 'Delete', danger: true, onClick: () => { if (window.confirm(`Delete "${e.item.Name}"?`)) onDeletePlaylist?.(e.item); } },
  ];
  const openMenu = (ev, entry) => { ev.preventDefault(); ev.stopPropagation(); setMenu({ x: ev.clientX, y: ev.clientY, entry }); };

  // Phone Library tab: Spotify's filter chips + "Recents" sort row (CSS shows them only there).
  const [libFilter, setLibFilter] = useState(null); // null | 'playlist' | 'album' | 'artist'
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const phone = usePhone();
  // Phone: the magnifier in the header opens "Find in Your Library"; the
  // grid / list toggle at the right of the sort row.
  const [searching, setSearching] = useState(false);
  const [libQuery, setLibQuery] = useState('');
  const [gridView, setGridView] = useState(false);
  // Phone "+": a sheet with "Playlist", then a full-screen "Give your playlist a name".
  const [createSheet, setCreateSheet] = useState(null); // { x, y }
  const [naming, setNaming] = useState(false);
  // The empty state waits for the library to have actually arrived (the
  // playlists request has no flag of its own, so also let the first paint settle).
  const [settled, setSettled] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSettled(true), 1500); return () => clearTimeout(t); }, []);
  const openCreate = (e) => {
    if (!phone) { setCreating((v) => !v); return; }
    const r = e?.currentTarget?.getBoundingClientRect?.();
    setCreateSheet({ x: r ? r.left : 0, y: r ? r.bottom : 0 });
  };
  const q = libQuery.trim().toLowerCase();
  const matches = (n) => !q || (n || '').toLowerCase().includes(q);
  const showLiked = (!libFilter || libFilter === 'playlist') && matches('Liked Songs');
  const shownArtists = libFilter === 'artist' ? artistEntries.filter((e) => matches(e.item.Name)) : [];
  const shownEntries = entries.filter((e) => (!libFilter || e.kind === libFilter) && matches(e.item.Name));

  const submit = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    onCreate(n);
    setName('');
    setCreating(false);
  };

  return (
    <aside className="sidebar">
      <nav className="nav">
        <button className={`navitem ${view === 'home' ? 'on' : ''}`} onClick={() => onView('home')}>
          <Icon name="home" /><span>Home</span>
        </button>
        <button className={`navitem ${view === 'search' ? 'on' : ''}`} onClick={() => onView('search')}>
          <Icon name="search" /><span>Search</span>
        </button>
      </nav>

      <div className="libpanel">
        <div className="libhead">
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Icon name="library" /> Your Library
          </span>
          <span className="libhead-actions">
            {phone && (
              <button className={`icon-btn ${searching ? 'on' : ''}`} onClick={() => { setSearching((v) => !v); setLibQuery(''); }} title="Find in Your Library" aria-label="Find in Your Library">
                <Icon name="search" size={24} />
              </button>
            )}
            <button className="icon-btn" onClick={openCreate} title="Create playlist" aria-label="Create playlist">
              <Icon name="plus" size={phone ? 24 : 18} />
            </button>
          </span>
        </div>

        <div className="libchips">
          {libFilter && <button className="pill x" onClick={() => setLibFilter(null)} aria-label="Clear filter">×</button>}
          {[['playlist', 'Playlists'], ['album', 'Albums'], ['artist', 'Artists']].map(([k, label]) => (!libFilter || libFilter === k) && (
            <button key={k} className={`pill ${libFilter === k ? 'on' : ''}`} onClick={() => setLibFilter(libFilter === k ? null : k)}>{label}</button>
          ))}
        </div>
        {searching && phone ? (
          <div className="libsearch">
            <Icon name="search" size={20} />
            <input autoFocus value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder="Find in Your Library" spellCheck="false"
              onKeyDown={(e) => e.key === 'Escape' && (setSearching(false), setLibQuery(''))} />
            <button type="button" onClick={() => { setSearching(false); setLibQuery(''); }}>Cancel</button>
          </div>
        ) : (
          <div className="libsort">
            <span><Icon name="sort" size={16} /> Recents</span>
            <button className="libview" onClick={() => setGridView((v) => !v)} title={gridView ? 'List view' : 'Grid view'} aria-label={gridView ? 'List view' : 'Grid view'}>
              <Icon name={gridView ? 'list' : 'grid'} size={20} />
            </button>
          </div>
        )}
        <div className={`liblist ${gridView ? 'grid' : ''}`}>
          {creating && (
            <form onSubmit={submit} style={{ padding: '4px 8px 10px' }}>
              <input
                className="newplaylist-input"
                autoFocus
                placeholder="Playlist name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
              />
            </form>
          )}

          {showLiked && <button className="libitem" onClick={onOpenLiked} onContextMenu={(ev) => openMenu(ev, { id: 'liked', kind: 'liked' })} title="Liked Songs">
            <LikedCover />
            <span className="libitem-text">
              <span className="libitem-name">Liked Songs</span>
              <span className="libitem-sub"><Pin />Playlist{likedCount != null ? ` • ${likedCount} songs` : ''}</span>
            </span>
          </button>}

          {shownArtists.map((e) => (
            <button key={e.id} className="libitem round" onClick={() => onOpenArtist?.(e.id)} title={e.item.Name}>
              {jf.imageUrl(e.id, { maxHeight: 84 }) ? <img src={jf.imageUrl(e.id, { maxHeight: 84 })} alt="" loading="lazy" draggable={false} /> : <div className="ph" />}
              <span className="libitem-text">
                <span className="libitem-name">{e.item.Name}</span>
                <span className="libitem-sub">Artist</span>
              </span>
            </button>
          ))}
          {shownEntries.map((e) => {
            const it = e.item;
            const art = jf.imageUrl(it.Id, { maxHeight: 84 });
            const sub = e.kind === 'album'
              ? `Album • ${it.AlbumArtist || it.AlbumArtists?.[0]?.Name || ''}`
              : `Playlist${it.ChildCount ? ` • ${it.ChildCount} songs` : ''}`;
            return (
              <button
                key={e.id}
                className={`libitem ${overId === e.id && dragId && dragId !== e.id ? 'dropbefore' : ''} ${dragId === e.id ? 'dragging' : ''}`}
                onClick={() => (e.kind === 'album' ? onOpenAlbum?.(it.Id) : onOpen(it))}
                onContextMenu={(ev) => openMenu(ev, e)}
                title={it.Name}
                draggable
                onDragStart={() => { dragRef.current = e.id; setDragId(e.id); }}
                onDragOver={(ev) => { ev.preventDefault(); setOverId(e.id); }}
                onDragLeave={() => setOverId((o) => (o === e.id ? null : o))}
                onDrop={(ev) => { ev.preventDefault(); reorder(dragRef.current, e.id); dragRef.current = null; setDragId(null); setOverId(null); }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
              >
                {art ? <img src={art} alt="" loading="lazy" draggable={false} /> : <div className="ph" />}
                <span className="libitem-text">
                  <span className="libitem-name">{it.Name}</span>
                  <span className="libitem-sub">{pinned.has(e.id) && <Pin />}{sub}</span>
                </span>
              </button>
            );
          })}
          {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
          {createSheet && (
            <ContextMenu x={createSheet.x} y={createSheet.y} onClose={() => setCreateSheet(null)}
              items={[{ label: 'Playlist', icon: MI.playlist, onClick: () => { setName(''); setNaming(true); } }]} />
          )}
          {naming && createPortal(
            <form className="newpl" onSubmit={(e) => { submit(e); setNaming(false); }}>
              <h2>Give your playlist a name</h2>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="My playlist #1" spellCheck="false"
                onKeyDown={(e) => e.key === 'Escape' && setNaming(false)} />
              <div className="newpl-actions">
                <button type="button" className="newpl-cancel" onClick={() => setNaming(false)}>Cancel</button>
                <button type="submit" className="newpl-create" disabled={!name.trim()}>Create</button>
              </div>
            </form>,
            document.body,
          )}

          {!shownEntries.length && !loading && settled && likedCount != null && !q && (!libFilter || libFilter === 'playlist') && (phone ? (
            <div className="libempty">
              <b>Create your first playlist</b>
              <p>It's easy, we'll help you.</p>
              <button onClick={openCreate}>Create playlist</button>
            </div>
          ) : (
            <p className="devicemenu-empty">
              Create your first playlist with the + button.
            </p>
          ))}
          {q && !showLiked && !shownArtists.length && !shownEntries.length && (
            <div className="libempty">
              <b>Couldn&rsquo;t find &ldquo;{libQuery.trim()}&rdquo;</b>
              <p>Try a different playlist, album or artist name.</p>
            </div>
          )}
          {!q && phone && libFilter === 'artist' && !shownArtists.length && !loading && (
            <div className="libempty">
              <b>No artists yet</b>
              <p>Save an album and its artist shows up here.</p>
            </div>
          )}
          {!q && phone && libFilter === 'album' && !shownEntries.length && !loading && (
            <div className="libempty">
              <b>Save your first album</b>
              <p>Add an album to Your Library and it shows up here.</p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
