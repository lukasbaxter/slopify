import React, { useEffect, useRef, useState } from 'react';
import { useOffset } from '../api/offsets.js';
import { ArtistLinks, PlayGlyph, PauseGlyph, ShuffleGlyph } from './TrackRow.jsx';
import ContextMenu from './ContextMenu.jsx';
import { isLiked } from '../api/likes.js';
import { usePhone, usePlayingFrom, slideOut } from './Player.jsx';

const Close = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" />
  </svg>
);

// Phone: the queue page closes with a chevron-down, like Spotify's.
const ChevronDown = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
    <path d="M2.793 8.043a1 1 0 0 1 1.414 0L12 15.836l7.793-7.793a1 1 0 1 1 1.414 1.414L12 18.664 2.793 9.457a1 1 0 0 1 0-1.414z" />
  </svg>
);
const Handle = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
    <path d="M3 8.25h18v1.5H3v-1.5zm0 6h18v1.5H3v-1.5z" />
  </svg>
);

function secs(ticks) {
  return ticks ? ticks / 10_000_000 : 0;
}

function QueueRow({ track, jf, active, onPlay, onOpenArtist, onOpenAlbum, menuItems, draggable, onDragStart, onDragOver, onDrop, onDragEnd, over, dragging, pos, onHandleDown, phone = false, lift = null }) {
  const [menu, setMenu] = useState(null);
  const art = jf.imageUrl(track.AlbumId || track.Id, { maxHeight: 80 });
  const artists = track.ArtistItems?.length ? track.ArtistItems : (track.Artists || []).map((n) => ({ Name: n }));
  // A long-press opens the sheet while the finger is still down; the release
  // then synthesizes a mousedown that would count as an outside tap and close
  // it at once, so closes in the first half second are ignored.
  const openedAt = useRef(0);
  const closeMenu = () => { if (Date.now() - openedAt.current < 500) return; slideOut('.ctxmenu-fixed', () => setMenu(null)); };
  const openMenu = (at) => { openedAt.current = Date.now(); setMenu(at); };
  const header = { image: art, title: track.Name, sub: artists.map((a) => a.Name).join(', ') || track.AlbumArtist || '' };
  // Phone drag: the lifted row follows the finger, the rows it passes shift out of its way.
  const liftStyle = lift ? (lift.dragging ? { transform: `translateY(${lift.dy}px)` } : lift.shift ? { transform: `translateY(${lift.shift}px)` } : undefined) : undefined;
  return (
    <div
      className={`qrow ${active ? 'active' : ''} ${over && !phone ? 'dropbefore' : ''} ${dragging && !phone ? 'dragging' : ''} ${lift?.dragging ? 'lifted' : ''} ${lift && !lift.dragging ? 'shifting' : ''}`}
      data-pos={pos}
      style={liftStyle}
      draggable={draggable}
      onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}
      onContextMenu={menuItems ? (e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }); } : undefined}
      onDoubleClick={onPlay}
    >
      <button className="qrow-art" onClick={onPlay} title="Play">
        {art ? <img src={art} alt="" loading="lazy" draggable={false} /> : <div className="ph" />}
        <span className="qrow-play"><PlayGlyph size={14} /></span>
      </button>
      <span className="qrow-text">
        <span className="qrow-title" role="button" onClick={() => track.AlbumId && onOpenAlbum?.(track.AlbumId)}>{track.Name}</span>
        <span className="qrow-sub"><ArtistLinks artists={artists} fallback={track.AlbumArtist || ''} onOpen={onOpenArtist} className="rowlink" /></span>
      </span>
      {/* Phone rows open their sheet on a long-press (Spotify); the ⋯ is desktop only. */}
      {menuItems && !phone && (
        <button className="qrow-more" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openMenu({ x: r.right, y: r.bottom + 4, fromButton: true }); }} title="More options">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M3 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM16 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" /></svg>
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} anchorRight={Boolean(menu.fromButton)} items={menuItems} onClose={closeMenu} header={phone ? header : null} />}
      {/* Phone: Spotify's drag handle at the right; HTML5 drag does not fire on touch. */}
      {onHandleDown && (
        <span className="qrow-handle" onPointerDown={onHandleDown} title="Drag to reorder" aria-label="Drag to reorder"><Handle /></span>
      )}
    </div>
  );
}

/** Now Playing view: cover, track, then stacked section cards. */
function NowPlaying({ player, jf, onOpenArtist, onOpenAlbum, onShowQueue }) {
  const { current, nowPlaying, queue, index } = player;
  const art = nowPlaying?.artId ? jf.imageUrl(nowPlaying.artId, { maxHeight: 640 }) : null;
  const upNext = index >= 0 ? queue[index + 1] : null;

  return (
    <>
      {art ? <img className="npv-art" src={art} alt="" /> : <div className="npv-art" />}

      <div className="npv-track">
        <div style={{ minWidth: 0 }}>
          <div
            className="npv-title"
            role={nowPlaying?.albumId ? 'button' : undefined}
            onClick={() => nowPlaying?.albumId && onOpenAlbum(nowPlaying.albumId)}
            style={{ cursor: nowPlaying?.albumId ? 'pointer' : 'default' }}
          >
            {nowPlaying?.title || 'Nothing playing'}
          </div>
          <div className="npv-artist" style={{ cursor: 'default' }}>
            {nowPlaying?.artists?.length
              ? <ArtistLinks artists={nowPlaying.artists} onOpen={onOpenArtist} className="npv-artist-link" />
              : nowPlaying?.artistId
                ? <button className="npv-artist-link" onClick={() => onOpenArtist(nowPlaying.artistId)}>{nowPlaying.artist}</button>
                : nowPlaying?.artist}
          </div>
        </div>
      </div>

      <section className="section">
        <div className="section-head"><h2>About the artist</h2></div>
        <p className="placeholder-note">
          Artist images, monthly listeners and bios need a metadata provider.
          Not wired up yet.
        </p>
      </section>

      <section className="section">
        <div className="section-head"><h2>Credits</h2></div>
        <p className="placeholder-note">
          Performer and writer credits come from MusicBrainz. They will fill in
          as the retag completes.
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Next in queue</h2>
          <button onClick={onShowQueue}>Open queue</button>
        </div>
        {upNext ? (
          <QueueRow track={upNext} jf={jf} onPlay={() => player.skipTo(index + 1)} />
        ) : (
          <p className="placeholder-note" style={{ margin: 0 }}>
            {current ? 'Nothing queued after this track.' : 'Your queue is empty.'}
          </p>
        )}
      </section>
    </>
  );
}

/** Queue: Now playing / Next in queue, matching Spotify's sectioning. */
function Queue({ player, jf, onOpenArtist, onOpenAlbum, onLike, onAddTo, playlists = [] }) {
  // `queue`/`index` are the SESSION's (the active player's, mirrored) so the
  // panel is the same on every client; every edit routes to whoever is playing.
  const { queue, index, contextId } = player;
  const current = index >= 0 ? queue[index] || null : null;
  const upcoming = index >= 0 ? queue.slice(index + 1) : queue;
  const base = index >= 0 ? index + 1 : 0;
  // Spotify splits what you queued by hand from the rest of the context.
  let split = 0;
  while (split < upcoming.length && upcoming[split]?._queued) split += 1;
  const queued = upcoming.slice(0, split), fromCtx = upcoming.slice(split);
  const from = usePlayingFrom(player, jf);
  const ctxName = contextId ? from.name : null;
  const [drag, setDrag] = useState(null); // absolute queue index being dragged
  const [over, setOver] = useState(null);
  const [dy, setDy] = useState(0); // phone: how far the lifted row has moved
  const phone = usePhone();
  // Phone reorder: the handle captures the pointer; the lifted row follows the
  // finger, the rows it passes shift aside, release moves the track.
  const handleDown = (pos) => (e) => {
    e.preventDefault();
    const el = e.currentTarget; let target = pos; const y0 = e.clientY; let raf = 0, lastY = y0;
    try { el.setPointerCapture(e.pointerId); } catch {}
    const rowH = el.closest('.qrow')?.getBoundingClientRect().height || 64;
    setDrag(pos); setOver(pos); setDy(0);
    const move = (ev) => {
      lastY = ev.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const d = lastY - y0;
        setDy(d);
        // Target = the slot the row's centre is over, one row per rowH of travel.
        const p = pos + Math.round(d / rowH);
        const min = index >= 0 ? index + 1 : 0, max = queue.length - 1;
        const clamped = Math.max(min, Math.min(max, p));
        if (clamped !== target) { target = clamped; setOver(clamped); }
      });
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (raf) cancelAnimationFrame(raf);
      if (target !== pos) player.moveInQueue(pos, target);
      setDrag(null); setOver(null); setDy(0);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  // Per-row lift state for the phone drag: the dragged row carries dy, rows
  // between it and the target slot shift one row the other way.
  const liftFor = (pos) => {
    if (!phone || drag == null) return null;
    if (pos === drag) return { dragging: true, dy };
    const rowH = 64;
    if (over != null && over > drag && pos > drag && pos <= over) return { shift: -rowH };
    if (over != null && over < drag && pos < drag && pos >= over) return { shift: rowH };
    return { shift: 0 };
  };

  if (!queue.length) {
    return (
      <div style={{ padding: '32px 0', textAlign: 'center' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>Add to your queue</h2>
        <p className="qrow-sub" style={{ margin: 0 }}>Play an album or playlist, or use “Add to queue” on any song.</p>
      </div>
    );
  }
  const items = (t, pos) => [
    { label: 'Remove from queue', onClick: () => player.removeFromQueue(pos) },
    { label: isLiked(t.Id) ? 'Remove from Liked Songs' : 'Add to Liked Songs', onClick: () => onLike?.(t, !isLiked(t.Id)) },
    playlists.length ? { label: 'Add to playlist', sub: playlists.map((p) => ({ key: p.Id, label: p.Name, onClick: () => onAddTo?.(p, t) })) } : null,
    { sep: true },
    t.ArtistItems?.[0]?.Id ? { label: 'Go to artist', onClick: () => onOpenArtist?.(t.ArtistItems[0].Id) } : null,
    t.AlbumId ? { label: 'Go to album', onClick: () => onOpenAlbum?.(t.AlbumId) } : null,
  ];
  const row = (t, pos, key) => (
    <QueueRow key={key} track={t} jf={jf} onPlay={() => player.skipTo(pos)} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum}
      menuItems={items(t, pos)} draggable={!phone} pos={pos} onHandleDown={phone ? handleDown(pos) : undefined} phone={phone} lift={liftFor(pos)}
      onDragStart={() => setDrag(pos)} onDragOver={(e) => { e.preventDefault(); setOver(pos); }}
      onDrop={(e) => { e.preventDefault(); if (drag != null && drag !== pos) player.moveInQueue(drag, pos); setDrag(null); setOver(null); }}
      onDragEnd={() => { setDrag(null); setOver(null); }} over={over === pos && drag != null && drag !== pos} dragging={drag === pos} />
  );
  return (
    <>
      {current && (
        <section>
          <div className="section-head" style={{ marginBottom: 8 }}><h2>Now playing</h2></div>
          <QueueRow track={current} jf={jf} active onPlay={() => player.skipTo(index)} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum}
            menuItems={items(current, index).filter((x) => x && x.label !== 'Remove from queue')} phone={phone} />
        </section>
      )}
      {queued.length > 0 && (
        <section>
          <div className="section-head" style={{ marginBottom: 8 }}>
            <h2>Next in queue</h2>
            <button className="linkish" onClick={() => player.clearQueued()}>Clear queue</button>
          </div>
          {queued.map((t, i) => row(t, base + i, `q-${t.Id}-${i}`))}
        </section>
      )}
      {fromCtx.length > 0 && (
        <section>
          <div className="section-head" style={{ marginBottom: 8 }}>
            <h2>{ctxName ? `Next from: ${ctxName}` : 'Next up'}</h2>
            {!phone && <span className="qrow-sub">{fromCtx.length}</span>}
          </div>
          {fromCtx.slice(0, 80).map((t, i) => row(t, base + split + i, `c-${t.Id}-${i}`))}
        </section>
      )}
      {!queued.length && !fromCtx.length && <p className="qrow-sub" style={{ padding: '12px 0' }}>End of the queue.</p>}
    </>
  );
}

// Phone lyrics never show empty lines (Spotify): blanks are dropped, and a
// synced gap becomes a "♪" line so an instrumental break still has something
// to follow. A gap counts when it is over 5s AND well over the song's usual
// line spacing (2.5x the median), so slow songs do not fill up with notes.
const GAP = 5;
function phoneLines(lines) {
  if (!Array.isArray(lines)) return lines;
  const kept = lines.filter((l) => l && String(l.text || '').trim());
  const synced = kept.some((l) => l.start != null);
  if (!synced) return kept;
  const spacings = kept.slice(1).map((l, i) => l.start - kept[i].start).filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  const median = spacings.length ? spacings[Math.floor(spacings.length / 2)] : GAP;
  const threshold = Math.max(GAP, 2.5 * median);
  const out = [];
  if (kept.length && kept[0].start > threshold) out.push({ text: '♪', start: 0, gap: true });
  kept.forEach((l, i) => {
    out.push(l);
    const next = kept[i + 1];
    if (next && l.start != null && next.start != null && next.start - l.start > threshold) out.push({ text: '♪', start: l.start + Math.min(5, (next.start - l.start) / 2), gap: true });
  });
  return out;
}

/**
 * Lyrics. Sung lines dim to 50%, the active line takes full colour, upcoming
 * lines stay full opacity -- Spotify's actual treatment, which is the opposite
 * of what most clones do.
 */
export function Lyrics({ player, jf }) {
  const { position } = player;
  // Follow the session-wide track, not just this client's own queue item, so
  // lyrics load and stay in sync even when we are mirroring another device
  // (where `current` is null but nowPlayingId still points at the song).
  const trackId = player.nowPlayingId;
  const [lines, setLines] = useState(null);
  const [state, setState] = useState('idle');
  const activeRef = useRef(null);
  const phone = usePhone();

  useEffect(() => {
    if (!trackId) { setLines(null); setState('idle'); return; }
    let cancelled = false;
    setState('loading');
    jf.lyrics(trackId)
      .then((l) => {
        if (cancelled) return;
        setLines(phone ? phoneLines(l) : l);
        setState(l && l.length ? 'ok' : 'none');
      })
      .catch(() => { if (!cancelled) setState('none'); });
    return () => { cancelled = true; };
  }, [trackId, jf]);

  // Nudge the playhead forward slightly when choosing the active line. Human
  // perception is asymmetric here: a lyric arriving a hair early reads as in
  // time, while the same error late reads as lagging.
  const LEAD_SECONDS = 0.25;
  // A speaker reports the position it is decoding; the sound leaves it its
  // measured delay later (the calibration in the full-screen visualizer).
  const speakerDelay = useOffset(player.nowPlaying?.device?.id) || 0;
  const at = position - speakerDelay + LEAD_SECONDS;
  const activeIndex = lines
    ? lines.reduce((acc, l, i) => (l.start != null && at >= l.start ? i : acc), -1)
    : -1;

  // Following stops the moment the user scrolls (wheel / touch), so reading
  // ahead is not yanked back; a Sync button brings the view back to the song.
  const [manual, setManual] = useState(false);
  const listRef = useRef(null);
  const follow = () => {
    // Scroll the lyrics' OWN container, not every scrollable ancestor:
    // scrollIntoView also nudged the app shell and slid the footer up.
    const el = activeRef.current; if (!el) return;
    const box = el.closest('.panel-body, .fs-lyrics'); if (!box) return;
    const er = el.getBoundingClientRect(), br = box.getBoundingClientRect();
    box.scrollTo({ top: box.scrollTop + (er.top - br.top) - br.height / 2 + er.height / 2, behavior: 'smooth' });
  };
  useEffect(() => { if (!manual) follow(); }, [activeIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setManual(false); }, [trackId]);
  useEffect(() => {
    const box = listRef.current?.closest('.panel-body, .fs-lyrics'); if (!box) return undefined;
    const stop = () => setManual(true);
    box.addEventListener('wheel', stop, { passive: true }); box.addEventListener('touchmove', stop, { passive: true });
    return () => { box.removeEventListener('wheel', stop); box.removeEventListener('touchmove', stop); };
  }, [state]);

  // Breadcrumb every ~2s: what the lyrics view believes.
  useEffect(() => {
    const t = setInterval(() => {
      window.conduit?.debug?.(
        `lyrics track=${trackId?.slice(0, 8) || '-'} state=${state} lines=${lines?.length ?? 0} ` +
        `pos=${position.toFixed(1)} active=${activeIndex} ` +
        `activeStart=${activeIndex >= 0 ? lines[activeIndex]?.start : '-'}`
      );
    }, 2000);
    return () => clearInterval(t);
  }, [trackId, state, lines, position, activeIndex]);

  if (state === 'loading') return <p className="placeholder-note">Loading lyrics...</p>;
  if (state === 'idle') return <p className="placeholder-note">Play something to see lyrics.</p>;
  if (state === 'none') {
    return (
      <p className="placeholder-note">
        Looks like we don&rsquo;t have the lyrics for this song.
      </p>
    );
  }

  const synced = lines.some((l) => l.start != null);

  return (
    <div className={`lyrics ${synced ? 'synced' : 'unsynced'}`} ref={listRef}>
      {!synced && (
        <p className="qrow-sub" style={{ margin: '0 0 12px' }}>
          These lyrics aren&rsquo;t synced to the song yet.
        </p>
      )}
      {lines.map((l, i) => (
        <button
          key={i}
          ref={i === activeIndex ? activeRef : null}
          className={`lyric-line ${synced && i < activeIndex ? 'sung' : ''} ${i === activeIndex ? 'now' : ''} ${l.gap ? 'gap' : ''}`}
          onClick={() => { if (l.start == null) return; player.seek(l.start); setManual(false); }}
          style={{ cursor: l.start != null ? 'pointer' : 'default' }}
        >
          {l.text || ' '}
        </button>
      ))}
      {manual && synced && (
        <button className="lyrics-sync" onClick={() => { setManual(false); follow(); }}>Sync</button>
      )}
    </div>
  );
}

export default function RightPanel({ mode, onClose, onMode, player, jf, onOpenArtist, onOpenAlbum, onLike, onAddTo, playlists }) {
  const titles = { npv: 'Now playing', queue: 'Queue', lyrics: 'Lyrics' };
  const phone = usePhone();
  const from = usePlayingFrom(player, jf);
  const rootRef = useRef(null);
  const close = () => slideOut(rootRef.current, onClose);
  const { playing, position, duration, shuffle, repeat } = player;
  // Lyrics sit on the blurred cover, like the now-playing view does.
  const np = player.nowPlaying;
  const bg = mode === 'lyrics' ? (np?.artId ? jf.imageUrl(np.artId, { maxHeight: 640 }) : np?.artUrl || null) : null;
  return (
    <aside ref={rootRef} className={`rightpanel ${bg ? 'with-bg' : ''}`}>
      {bg && <div className="panel-bg" style={{ backgroundImage: `url("${bg}")` }} />}
      <div className="panel-header">
        <button className="icon-btn" onClick={close} title="Close panel">{phone ? <ChevronDown /> : <Close />}</button>
        {phone && mode === 'queue'
          ? <span className="title"><small>{from.kind}</small>{from.name}</span>
          : <span className="title">{titles[mode]}</span>}
      </div>
      {mode !== 'npv' && (
        <div className="tabs" style={{ gridRow: 'auto' }}>
          <button className={mode === 'queue' ? 'on' : ''} onClick={() => onMode('queue')}>Queue</button>
          <button className={mode === 'lyrics' ? 'on' : ''} onClick={() => onMode('lyrics')}>Lyrics</button>
        </div>
      )}
      <div className="panel-body">
        {mode === 'npv' && (
          <NowPlaying
            player={player} jf={jf}
            onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum}
            onShowQueue={() => onMode('queue')}
          />
        )}
        {mode === 'queue' && <Queue player={player} jf={jf} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} onLike={onLike} onAddTo={onAddTo} playlists={playlists} />}
        {mode === 'lyrics' && <Lyrics player={player} jf={jf} />}
      </div>
      {/* Phone queue page: Spotify pins the transport under the list. */}
      {phone && mode === 'queue' && player.nowPlaying && (
        <div className="panel-transport">
          <div className="panel-transport-row">
            <button className={`ctl-mode ${shuffle && shuffle !== 'off' ? 'on' : ''}`} onClick={player.cycleShuffle} title="Shuffle"><ShuffleGlyph size={24} /></button>
            <button onClick={player.previous} title="Previous"><svg viewBox="0 0 16 16" width="32" height="32" fill="currentColor"><path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z" /></svg></button>
            <button className="panel-play" onClick={player.toggle} title={playing ? 'Pause' : 'Play'}>{playing ? <PauseGlyph size={22} /> : <PlayGlyph size={22} />}</button>
            <button onClick={player.next} title="Next"><svg viewBox="0 0 16 16" width="32" height="32" fill="currentColor"><path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.107A.7.7 0 0 0 1 1.712v12.575a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6z" /></svg></button>
            <button className={`ctl-mode ${repeat && repeat !== 'off' ? 'on' : ''}`} onClick={player.cycleRepeat} title="Repeat"><svg viewBox="0 0 16 16" width="24" height="24" fill="currentColor"><path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5z" /></svg></button>
          </div>
          <div className="panel-progress"><span style={{ width: `${duration ? Math.min(100, (position / duration) * 100) : 0}%` }} /></div>
        </div>
      )}
    </aside>
  );
}
