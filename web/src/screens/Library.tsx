import { useEffect, useState } from 'react';
import { allAlbums, allArtists, playlists as loadPlaylists } from '../api/library';
import { post, type Album, type Artist, type Playlist } from '../api/client';
import { navigate } from '../state/app';
import { AlbumCard, ArtistCard, Cover, Skeleton } from '../components/ui';

type Tab = 'playlists' | 'albums' | 'artists';
export function Library() {
  const [tab, setTab] = useState<Tab>('playlists');
  const [albums, setAlbums] = useState<Album[] | null>(null); const [artists, setArtists] = useState<Artist[] | null>(null); const [pls, setPls] = useState<Playlist[] | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => { loadPlaylists().then((p) => setPls(p.items)).catch(() => setPls([])); allAlbums().then(setAlbums).catch(() => setAlbums([])); allArtists().then(setArtists).catch(() => setArtists([])); }, []);
  const f = filter.trim().toLowerCase();
  const createPl = async () => { const name = prompt('Playlist name'); if (!name) return; const r = await post<{ id: string }>('/playlists', { name }); navigate({ view: 'playlist', id: r.id }); };
  return (
    <div className="page">
      <div className="page-head"><h1>Your Library</h1><button className="secondary" onClick={createPl}>+ Playlist</button></div>
      <div className="chips" role="tablist">{(['playlists', 'albums', 'artists'] as Tab[]).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={`chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
      <input className="search small" type="search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter library" />
      {tab === 'playlists' && (pls ? (
        <div className="list">
          <button className="libitem" onClick={() => navigate({ view: 'liked' })}><div className="cover liked-cover">♥</div><span className="row-main"><span className="row-title">Liked Songs</span><span className="row-sub">Playlist</span></span></button>
          {pls.filter((p) => !f || p.name.toLowerCase().includes(f)).map((p) => <button key={p.id} className="libitem" onClick={() => navigate({ view: 'playlist', id: p.id })}><Cover hash={p.cover} size={64} /><span className="row-main"><span className="row-title">{p.name}</span><span className="row-sub">Playlist · {p.trackCount} songs</span></span></button>)}
        </div>) : <Skeleton />)}
      {tab === 'albums' && (albums ? <div className="grid">{albums.filter((a) => !f || a.name.toLowerCase().includes(f) || a.artist.toLowerCase().includes(f)).slice(0, 400).map((a) => <AlbumCard key={a.id} a={a} />)}</div> : <Skeleton />)}
      {tab === 'artists' && (artists ? <div className="grid">{artists.filter((a) => !f || a.name.toLowerCase().includes(f)).slice(0, 400).map((a) => <ArtistCard key={a.id} a={a} />)}</div> : <Skeleton />)}
    </div>
  );
}
