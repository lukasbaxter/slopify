import { useEffect, useState } from 'react';
import { fmtTime, type Track } from '../api/client';
import { lyrics } from '../api/library';
import { app } from '../state/app';
import { Cover } from './ui';
import { current, player, setRepeat, setShuffle } from '../state/player';
import { actions, displayPosition, session } from '../state/session';
import { toggleLike, useLiked } from '../state/likes';

// What the bar shows: the session when someone else is playing it, else the local player.
function useShown() {
  const local = player.use((x) => x);
  const s = session.use((x) => x);
  const mirror = !!(s.session?.active && s.session.active !== s.clientId && s.session.trackId);
  const track: Track | null = mirror ? s.track : current();
  const state = mirror ? (s.session!.playing ? 'playing' : 'paused') : local.state;
  const positionMs = mirror ? displayPosition() : local.positionMs;
  const durationMs = mirror ? track?.durationMs ?? 0 : local.durationMs;
  const where = mirror ? s.clients.find((c) => c.id === s.session!.active)?.name ?? 'another device' : null;
  return { track, state, positionMs, durationMs, mirror, where, local, error: local.error };
}

export function PlayerBar() {
  const v = useShown();
  const liked = useLiked(v.track?.id);
  if (!v.track) return null;
  const t = v.track;
  const pct = v.durationMs ? (v.positionMs / v.durationMs) * 100 : 0;
  return (
    <footer className={`player ${v.mirror ? 'mirror' : ''}`} data-testid="player" data-state={v.state}>
      {v.where && <div className="playing-on" role="status">Playing on {v.where}</div>}
      <button className="player-meta" onClick={() => app.set({ nowPlayingOpen: true })} aria-label="Open now playing">
        <Cover hash={t.cover} size={64} className="player-art" />
        <span className="row-main"><span className="row-title">{t.title}</span><span className="row-sub">{t.artist}</span></span>
      </button>
      <div className="player-mid">
        <div className="transport">
          <button className={`icon ${v.local.shuffle ? 'on' : ''}`} onClick={() => setShuffle(!v.local.shuffle)} aria-label="Shuffle" aria-pressed={v.local.shuffle}>⇄</button>
          <button className="icon" onClick={actions.previous} aria-label="Previous">⏮</button>
          <button className="icon big" onClick={actions.toggle} aria-label={v.state === 'playing' ? 'Pause' : 'Play'} data-testid="toggle">{v.state === 'loading' ? '…' : v.state === 'playing' ? '❚❚' : '▶'}</button>
          <button className="icon" onClick={actions.next} aria-label="Next">⏭</button>
          <button className={`icon ${v.local.repeat !== 'off' ? 'on' : ''}`} onClick={() => setRepeat(v.local.repeat === 'off' ? 'all' : v.local.repeat === 'all' ? 'one' : 'off')} aria-label={`Repeat ${v.local.repeat}`}>{v.local.repeat === 'one' ? '↻1' : '↻'}</button>
        </div>
        <div className="seek"><span data-testid="position">{fmtTime(v.positionMs)}</span>
          <input type="range" min={0} max={Math.max(1, v.durationMs)} value={Math.min(v.positionMs, v.durationMs || 0)} onChange={(e) => actions.seek(Number(e.target.value))} aria-label="Seek" style={{ '--pct': `${pct}%` } as any} />
          <span>{fmtTime(v.durationMs)}</span></div>
      </div>
      <div className="player-right"><Devices /><button className={`icon like ${liked ? 'on' : ''}`} onClick={() => toggleLike(t.id)} aria-label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}>{liked ? '♥' : '♡'}</button></div>
      {v.error && <span className="player-error" role="status">{v.error}</span>}
    </footer>
  );
}

// The account's connected clients; picking one hands the session over.
export function Devices() {
  const s = session.use((x) => x);
  const [open, setOpen] = useState(false);
  const others = s.clients.filter((c) => c.id !== s.clientId && c.canPlay);
  return (
    <span className="devices">
      <button className={`icon ${s.session?.active && s.session.active !== s.clientId ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-label="Connect to a device" aria-expanded={open}>▤</button>
      {open && (
        <div className="devicemenu" role="menu">
          <div className="muted small">Connected as you</div>
          <button role="menuitem" className={`devitem ${s.session?.active === s.clientId || !s.session?.active ? 'on' : ''}`} onClick={() => { if (s.clientId) actions.transferTo(s.clientId); setOpen(false); }}>This device</button>
          {others.map((c) => <button key={c.id} role="menuitem" className={`devitem ${s.session?.active === c.id ? 'on' : ''}`} onClick={() => { actions.transferTo(c.id); setOpen(false); }}>{c.name} <span className="muted small">{c.kind}</span></button>)}
          {!others.length && <div className="muted small">No other devices online.</div>}
        </div>
      )}
    </span>
  );
}

export function NowPlaying() {
  const open = app.use((x) => x.nowPlayingOpen);
  const v = useShown();
  const t = v.track;
  const [lines, setLines] = useState<{ start: number | null; text: string }[] | null>(null);
  useEffect(() => { if (!t || !open) return; setLines(null); lyrics(t.id).then((l) => setLines(l?.lines ?? [])); }, [t?.id, open]);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') app.set({ nowPlayingOpen: false }); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
  if (!open || !t) return null;
  const active = lines ? lines.reduce((acc, l, i) => (l.start != null && v.positionMs + 250 >= l.start ? i : acc), -1) : -1;
  return (
    <div className="np" role="dialog" aria-label="Now playing">
      <button className="icon np-close" onClick={() => app.set({ nowPlayingOpen: false })} aria-label="Close">⌄</button>
      {v.where && <div className="playing-on" role="status">Playing on {v.where}</div>}
      <Cover hash={t.cover} size={640} className="np-art" />
      <h2>{t.title}</h2><p className="muted">{t.artist}</p>
      <div className="np-lyrics" aria-live="off">
        {lines === null ? <p className="muted">Loading lyrics…</p> : lines.length === 0 ? <p className="muted">No lyrics for this song yet.</p> : lines.map((l, i) => <p key={i} className={i === active ? 'now' : i < active ? 'sung' : ''} onClick={() => l.start != null && actions.seek(l.start)}>{l.text}</p>)}
      </div>
      <div className="transport big"><button className="icon" onClick={actions.previous} aria-label="Previous">⏮</button><button className="icon big" onClick={actions.toggle} aria-label={v.state === 'playing' ? 'Pause' : 'Play'}>{v.state === 'playing' ? '❚❚' : '▶'}</button><button className="icon" onClick={actions.next} aria-label="Next">⏭</button></div>
    </div>
  );
}
