import { artUrl, fmtTime, type Album, type Artist, type Track } from '../api/client';
import { navigate } from '../state/app';
import { player, current } from '../state/player';
import { actions, mirroring, session } from '../state/session';
import { toggleLike, useLiked } from '../state/likes';

export const Cover = ({ hash, size = 160, className = '', round = false }: { hash: string | null | undefined; size?: 64 | 160 | 320 | 640; className?: string; round?: boolean }) => (
  hash ? <img className={`cover ${round ? 'round' : ''} ${className}`} src={artUrl(hash, size)} alt="" loading="lazy" decoding="async" /> : <div className={`cover ph ${round ? 'round' : ''} ${className}`} aria-hidden="true">♪</div>
);

export function AlbumCard({ a }: { a: Album }) {
  return (
    <button className="card" onClick={() => navigate({ view: 'album', id: a.id })} aria-label={`${a.name} by ${a.artist}`}>
      <Cover hash={a.cover} size={320} />
      <span className="card-title">{a.name}</span>
      <span className="card-sub">{a.year ? `${a.year} · ` : ''}{a.artist}</span>
    </button>
  );
}
export function ArtistCard({ a }: { a: Artist }) {
  return (
    <button className="card" onClick={() => navigate({ view: 'artist', id: a.id })} aria-label={a.name}>
      <Cover hash={a.image} size={320} round />
      <span className="card-title">{a.name}</span>
      <span className="card-sub">Artist</span>
    </button>
  );
}
export function Shelf({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="shelf"><h2>{title}</h2><div className="shelf-row">{children}</div></section>;
}

export function TrackRow({ t, i, all, contextId, showArt = true }: { t: Track; i: number; all: Track[]; contextId?: string; showArt?: boolean }) {
  const localCur = player.use(() => current()?.id);
  const localState = player.use((s) => s.state);
  const mirror = session.use((s) => (s.session?.active && s.session.active !== s.clientId ? s.session : null));
  const liked = useLiked(t.id);
  const active = mirror ? mirror.trackId === t.id : localCur === t.id;
  const state = mirror ? (mirror.playing ? 'playing' : 'paused') : localState;
  const play = () => (active ? actions.toggle() : actions.playQueue(all, i, contextId ?? null));
  void mirroring;
  return (
    <div className={`row ${active ? 'active' : ''}`} role="button" tabIndex={0} onClick={play} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); } }} aria-label={`${active && state === 'playing' ? 'Pause' : 'Play'} ${t.title}`} data-testid="track-row">
      <span className="row-n">{active && state === 'playing' ? '▮▮' : i + 1}</span>
      {showArt && <Cover hash={t.cover} size={64} className="row-art" />}
      <span className="row-main"><span className="row-title">{t.title}</span><span className="row-sub">{t.artists.map((a, k) => <a key={a} href={`#/artist/${t.artistIds[k] || ''}`} onClick={(e) => e.stopPropagation()}>{a}{k < t.artists.length - 1 ? ', ' : ''}</a>)}</span></span>
      <button className={`icon like ${liked ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); toggleLike(t.id); }} aria-label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'} aria-pressed={liked}>{liked ? '♥' : '♡'}</button>
      <span className="row-time">{fmtTime(t.durationMs)}</span>
    </div>
  );
}
export const Skeleton = ({ rows = 6 }: { rows?: number }) => <div className="skeleton" aria-busy="true">{Array.from({ length: rows }, (_, i) => <div key={i} className="sk-row" />)}</div>;
