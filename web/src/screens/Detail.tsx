import { useEffect, useState } from 'react';
import { album, artist, playlist, likes as loadLikes } from '../api/library';
import { del, fmtTime, patch, type Album, type Artist, type Playlist, type Track } from '../api/client';
import { app, navigate } from '../state/app';
import { likes } from '../state/likes';
import { AlbumCard, Cover, Shelf, Skeleton, TrackRow } from '../components/ui';
import { playQueue } from '../state/player';

function Hero({ cover, kind, title, sub, tracks, contextId, round = false, actions }: { cover: string | null; kind: string; title: string; sub: string; tracks: Track[]; contextId: string; round?: boolean; actions?: React.ReactNode }) {
  return (
    <header className="hero">
      <Cover hash={cover} size={320} round={round} className="hero-art" />
      <div className="hero-text"><span className="kind">{kind}</span><h1>{title}</h1><p>{sub}</p>
        <div className="hero-actions"><button className="primary" onClick={() => tracks.length && playQueue(tracks, 0, contextId)} disabled={!tracks.length} aria-label={`Play ${title}`}>▶ Play</button>{actions}</div>
      </div>
    </header>
  );
}

export function AlbumPage({ id }: { id: string }) {
  const [d, setD] = useState<(Album & { tracks: Track[] }) | null>(null); const [err, setErr] = useState('');
  useEffect(() => { setD(null); album(id).then(setD).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <p role="alert" className="error">{err}</p>;
  if (!d) return <Skeleton />;
  const total = d.tracks.reduce((a, t) => a + t.durationMs, 0);
  return (
    <div className="page">
      <Hero cover={d.cover} kind="Album" title={d.name} sub={`${d.artist}${d.year ? ` · ${d.year}` : ''} · ${d.tracks.length} songs, ${fmtTime(total)}`} tracks={d.tracks} contextId={`album:${d.id}`} actions={<button className="secondary" onClick={() => navigate({ view: 'artist', id: d.artistId })}>Artist</button>} />
      <section>{d.tracks.map((t, i) => <TrackRow key={t.id} t={t} i={i} all={d.tracks} contextId={`album:${d.id}`} showArt={false} />)}</section>
    </div>
  );
}

export function ArtistPage({ id }: { id: string }) {
  const [d, setD] = useState<(Artist & { albums: Album[]; appearsOn: Album[]; tracks: Track[] }) | null>(null); const [err, setErr] = useState('');
  useEffect(() => { setD(null); artist(id).then(setD).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <p role="alert" className="error">{err}</p>;
  if (!d) return <Skeleton />;
  return (
    <div className="page">
      <Hero cover={d.image} kind="Artist" title={d.name} sub={`${d.albumCount} albums · ${d.trackCount} songs`} tracks={d.tracks} contextId={`artist:${d.id}`} round />
      <section><h2>Songs</h2>{d.tracks.slice(0, 10).map((t, i) => <TrackRow key={t.id} t={t} i={i} all={d.tracks} contextId={`artist:${d.id}`} />)}</section>
      {d.albums.length > 0 && <Shelf title="Albums">{d.albums.map((a) => <AlbumCard key={a.id} a={a} />)}</Shelf>}
      {d.appearsOn.length > 0 && <Shelf title="Appears on">{d.appearsOn.map((a) => <AlbumCard key={a.id} a={a} />)}</Shelf>}
    </div>
  );
}

export function PlaylistPage({ id }: { id: string }) {
  const [d, setD] = useState<(Playlist & { tracks: Track[] }) | null>(null); const [err, setErr] = useState('');
  const me = app.use((s) => s.user?.id);
  const reload = () => playlist(id).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); reload(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <p role="alert" className="error">{err}</p>;
  if (!d) return <Skeleton />;
  const rename = async () => { const name = prompt('Rename playlist', d.name); if (name && name !== d.name) { await patch(`/playlists/${d.id}`, { name }); reload(); } };
  const remove = async () => { if (confirm(`Delete “${d.name}”?`)) { await del(`/playlists/${d.id}`); navigate({ view: 'library' }); } };
  return (
    <div className="page">
      <Hero cover={d.cover} kind="Playlist" title={d.name} sub={`${d.tracks.length} songs`} tracks={d.tracks} contextId={`playlist:${d.id}`} actions={d.userId === me ? <><button className="secondary" onClick={rename}>Rename</button><button className="secondary" onClick={remove}>Delete</button></> : null} />
      <section>{d.tracks.map((t, i) => <TrackRow key={`${t.id}-${i}`} t={t} i={i} all={d.tracks} contextId={`playlist:${d.id}`} />)}{!d.tracks.length && <p className="muted">Empty. Add songs from any album or search.</p>}</section>
    </div>
  );
}

export function LikedPage() {
  const [items, setItems] = useState<Track[] | null>(null);
  const at = likes.use((s) => s.at);
  useEffect(() => { loadLikes().then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  if (!items) return <Skeleton />;
  const rows = items.filter((t) => at[t.id]).sort((a, b) => at[b.id] - at[a.id]);
  return (
    <div className="page">
      <Hero cover={null} kind="Playlist" title="Liked Songs" sub={`${rows.length} songs`} tracks={rows} contextId="liked" />
      <section>{rows.map((t, i) => <TrackRow key={t.id} t={t} i={i} all={rows} contextId="liked" />)}</section>
    </div>
  );
}
