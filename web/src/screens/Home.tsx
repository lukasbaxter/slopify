import { useEffect, useState } from 'react';
import { home } from '../api/library';
import type { Album, Track } from '../api/client';
import { AlbumCard, Shelf, Skeleton, TrackRow } from '../components/ui';
export function Home() {
  const [d, setD] = useState<{ recentAlbums: Album[]; topTracks: Track[]; newestAlbums: Album[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { home().then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <p role="alert" className="error">{err}</p>;
  if (!d) return <Skeleton />;
  return (
    <div className="page">
      <h1>Home</h1>
      {d.recentAlbums.length > 0 && <Shelf title="Recently played">{d.recentAlbums.map((a) => <AlbumCard key={a.id} a={a} />)}</Shelf>}
      <Shelf title="New in your library">{d.newestAlbums.map((a) => <AlbumCard key={a.id} a={a} />)}</Shelf>
      {d.topTracks.length > 0 && <section><h2>Your top tracks</h2>{d.topTracks.slice(0, 10).map((t, i) => <TrackRow key={t.id} t={t} i={i} all={d.topTracks} contextId="top" />)}</section>}
    </div>
  );
}
