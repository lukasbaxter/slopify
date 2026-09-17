import { useEffect, useRef, useState } from 'react';
import { search } from '../api/library';
import type { Album, Artist, Track } from '../api/client';
import { app, navigate } from '../state/app';
import { AlbumCard, ArtistCard, Shelf, TrackRow } from '../components/ui';
export function Search() {
  const q = app.use((s) => s.route.q || '');
  const [text, setText] = useState(q);
  const [res, setRes] = useState<{ tracks: Track[]; albums: Album[]; artists: Artist[] } | null>(null);
  const timer = useRef<number>();
  useEffect(() => { setText(q); }, [q]);
  useEffect(() => {
    if (!q.trim()) { setRes(null); return; }
    let alive = true; search(q).then((r) => alive && setRes(r)).catch(() => alive && setRes({ tracks: [], albums: [], artists: [] }));
    return () => { alive = false; };
  }, [q]);
  const onChange = (v: string) => { setText(v); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => navigate({ view: 'search', q: v.trim() || undefined }, true), 250); };
  return (
    <div className="page">
      <h1>Search</h1>
      <input className="search" type="search" placeholder="What do you want to listen to?" value={text} onChange={(e) => onChange(e.target.value)} aria-label="Search" autoFocus />
      {res && (
        <>
          {res.tracks.length > 0 && <section><h2>Songs</h2>{res.tracks.map((t, i) => <TrackRow key={t.id} t={t} i={i} all={res.tracks} contextId={`search:${q}`} />)}</section>}
          {res.artists.length > 0 && <Shelf title="Artists">{res.artists.map((a) => <ArtistCard key={a.id} a={a} />)}</Shelf>}
          {res.albums.length > 0 && <Shelf title="Albums">{res.albums.map((a) => <AlbumCard key={a.id} a={a} />)}</Shelf>}
          {!res.tracks.length && !res.albums.length && !res.artists.length && <p className="muted">Nothing for “{q}”.</p>}
        </>
      )}
    </div>
  );
}
