import { useEffect, useState } from 'react';
import { fmtTime } from '../api/client';
import { lyrics } from '../api/library';
import { app } from '../state/app';
import { Cover } from './ui';
import { current, next, player, previous, seek, setRepeat, setShuffle, toggle } from '../state/player';
import { toggleLike, useLiked } from '../state/likes';

export function PlayerBar() {
  const s = player.use((x) => x);
  const t = current();
  const liked = useLiked(t?.id);
  if (!t) return null;
  const pct = s.durationMs ? (s.positionMs / s.durationMs) * 100 : 0;
  return (
    <footer className="player" data-testid="player" data-state={s.state}>
      <button className="player-meta" onClick={() => app.set({ nowPlayingOpen: true })} aria-label="Open now playing">
        <Cover hash={t.cover} size={64} className="player-art" />
        <span className="row-main"><span className="row-title">{t.title}</span><span className="row-sub">{t.artist}</span></span>
      </button>
      <div className="player-mid">
        <div className="transport">
          <button className={`icon ${s.shuffle ? 'on' : ''}`} onClick={() => setShuffle(!s.shuffle)} aria-label="Shuffle" aria-pressed={s.shuffle}>⇄</button>
          <button className="icon" onClick={previous} aria-label="Previous">⏮</button>
          <button className="icon big" onClick={toggle} aria-label={s.state === 'playing' ? 'Pause' : 'Play'} data-testid="toggle">{s.state === 'loading' ? '…' : s.state === 'playing' ? '❚❚' : '▶'}</button>
          <button className="icon" onClick={() => next()} aria-label="Next">⏭</button>
          <button className={`icon ${s.repeat !== 'off' ? 'on' : ''}`} onClick={() => setRepeat(s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off')} aria-label={`Repeat ${s.repeat}`}>{s.repeat === 'one' ? '↻1' : '↻'}</button>
        </div>
        <div className="seek"><span data-testid="position">{fmtTime(s.positionMs)}</span>
          <input type="range" min={0} max={Math.max(1, s.durationMs)} value={Math.min(s.positionMs, s.durationMs || 0)} onChange={(e) => seek(Number(e.target.value))} aria-label="Seek" style={{ '--pct': `${pct}%` } as any} />
          <span>{fmtTime(s.durationMs)}</span></div>
      </div>
      <div className="player-right"><button className={`icon like ${liked ? 'on' : ''}`} onClick={() => toggleLike(t.id)} aria-label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}>{liked ? '♥' : '♡'}</button></div>
      {s.error && <span className="player-error" role="status">{s.error}</span>}
    </footer>
  );
}

export function NowPlaying() {
  const open = app.use((x) => x.nowPlayingOpen);
  const s = player.use((x) => x);
  const t = current();
  const [lines, setLines] = useState<{ start: number | null; text: string }[] | null>(null);
  useEffect(() => { if (!t || !open) return; setLines(null); lyrics(t.id).then((l) => setLines(l?.lines ?? [])); }, [t?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') app.set({ nowPlayingOpen: false }); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
  if (!open || !t) return null;
  const active = lines ? lines.reduce((acc, l, i) => (l.start != null && s.positionMs + 250 >= l.start ? i : acc), -1) : -1;
  return (
    <div className="np" role="dialog" aria-label="Now playing">
      <button className="icon np-close" onClick={() => app.set({ nowPlayingOpen: false })} aria-label="Close">⌄</button>
      <Cover hash={t.cover} size={640} className="np-art" />
      <h2>{t.title}</h2><p className="muted">{t.artist}</p>
      <div className="np-lyrics" aria-live="off">
        {lines === null ? <p className="muted">Loading lyrics…</p> : lines.length === 0 ? <p className="muted">No lyrics for this song yet.</p> : lines.map((l, i) => <p key={i} className={i === active ? 'now' : i < active ? 'sung' : ''} onClick={() => l.start != null && seek(l.start)}>{l.text}</p>)}
      </div>
      <div className="transport big"><button className="icon" onClick={previous} aria-label="Previous">⏮</button><button className="icon big" onClick={toggle} aria-label={s.state === 'playing' ? 'Pause' : 'Play'}>{s.state === 'playing' ? '❚❚' : '▶'}</button><button className="icon" onClick={() => next()} aria-label="Next">⏭</button></div>
    </div>
  );
}
