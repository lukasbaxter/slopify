import React, { useEffect, useRef, useState } from 'react';
import DevicePicker from './DevicePicker.jsx';
import { usePhone, Heart, ShuffleGlyph, ArtistLinks } from './TrackRow.jsx';
import { vibrantColor } from '../api/colors.js';
import { seekHover } from '../api/seekHover.js';
import { useLiked } from '../api/likes.js';
import { ctxItemId } from '../api/context.js';

// usePhone() lives in TrackRow.jsx; re-exported so the player screens keep their import.
export { usePhone };

/**
 * Spotify's "PLAYING FROM <KIND>" / "<name>" pair for the session's context,
 * shared by the now-playing header and the queue page. Always both lines:
 * a context we cannot name falls back to "PLAYING FROM" / "Your Library".
 */
export function usePlayingFrom(player, jf) {
  const ctx = player.contextId;
  const [from, setFrom] = useState({ kind: 'PLAYING FROM', name: 'Your Library' });
  useEffect(() => {
    let alive = true;
    const fallback = { kind: 'PLAYING FROM', name: 'Your Library' };
    const set = (v) => { if (alive) setFrom(v || fallback); };
    const id = String(ctx || '');
    if (!ctx) { set(null); return undefined; }
    if (ctx === 'liked' || ctx === '__liked__') { set({ kind: 'PLAYING FROM PLAYLIST', name: 'Liked Songs' }); return undefined; }
    if (ctx === 'radar') { set({ kind: 'PLAYING FROM PLAYLIST', name: 'Release Radar' }); return undefined; }
    if (id.startsWith('browse:')) {
      // Genre tiles are cached by the search page; the id is the tile's.
      let tiles = null; try { tiles = JSON.parse(localStorage.getItem('slopify.browse') || 'null'); } catch {}
      const tile = Array.isArray(tiles) ? tiles.find((t) => t.id === id.slice(7)) : null;
      set({ kind: 'PLAYING FROM GENRE', name: tile?.name || 'Genre' });
      return undefined;
    }
    if (id.startsWith('mix:')) {
      // Daily Mix N is numbered by its seed's place in the home page's top
      // artists (persisted per user); otherwise "<Artist> Mix".
      const seedId = id.slice(4);
      const top = jf?.persisted?.('home.topArtists');
      const n = Array.isArray(top) ? top.findIndex((a) => a?.Id === seedId) : -1;
      if (n >= 0) { set({ kind: 'PLAYING FROM PLAYLIST', name: `Daily Mix ${n + 1}` }); return undefined; }
      jf.itemById(seedId).then((it) => set({ kind: 'PLAYING FROM PLAYLIST', name: it?.Name ? `${it.Name} Mix` : 'Daily Mix' })).catch(() => set({ kind: 'PLAYING FROM PLAYLIST', name: 'Daily Mix' }));
      return () => { alive = false; };
    }
    jf.itemById(ctxItemId(ctx)).then((it) => {
      if (!it) { set(null); return; }
      const kind = it.Type === 'MusicArtist' ? 'ARTIST' : it.Type === 'MusicAlbum' ? 'ALBUM' : 'PLAYLIST';
      set({ kind: `PLAYING FROM ${kind}`, name: it.Name });
    }).catch(() => set(null));
    return () => { alive = false; };
  }, [ctx, jf]);
  return from;
}

/**
 * Slide a sheet / page out before it unmounts: adds `closing` to the element(s)
 * (the phone CSS animates translateY(100%) over 250ms), then runs `done`.
 * Off the phone it just runs `done`.
 */
// The lyrics glyph, traced from the icon Lukas picked (icons8 "mic", measured
// along its axis): ball head cut flat at the neck, a short gap, a tapered
// handle with a flat end and a pill slot near the neck, at 45 degrees. Filled
// like the original. One drawing everywhere.
export const LyricsGlyph = ({ size = 24 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule="evenodd" aria-hidden="true">
    <g transform="rotate(45 12 12)">
      <path d="M8.2 9.6A5 5 0 1 1 15.8 9.6Z" />
      <path d="M8.62 11.5H15.38L14.19 23.6A1 1 0 0 1 13.19 24.5H10.81A1 1 0 0 1 9.81 23.6Z M11 14.9a1 1 0 0 1 2 0v1.3a1 1 0 0 1-2 0Z" />
    </g>
  </svg>
);

export function slideOut(target, done) {
  const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches;
  const els = typeof target === 'string' ? [...document.querySelectorAll(target)] : target ? [target] : [];
  if (!phone || !els.length) { done(); return; }
  for (const el of els) el.classList.add('closing');
  setTimeout(done, 250);
}

/**
 * Keep a cover colour visibly tinted: dark art extracts near-black, so the
 * lightness is clamped into an 18-30% band before the card mixes it.
 */
export function clampLightness(rgb, lo = 0.18, hi = 0.30) {
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const nl = Math.min(hi, Math.max(lo, l));
  if (nl === l) return rgb;
  const c = (1 - Math.abs(2 * nl - 1)) * sat, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = nl - c / 2;
  const [r2, g2, b2] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r2, g2, b2].map((v) => Math.round((v + m) * 255));
}

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "Playing on X" when the sound is not coming out of this client, else null. */
export function elsewhereLabel(player) {
  const { roster, relay, device } = player;
  // Where the sound is coming out, if not this client's own output:
  //  - the session is on another of my clients -> that client's name, unless
  //    that client is itself driving a speaker -> the speaker's name;
  //  - this client is the player but the sound is on a speaker (Node, TV) ->
  //    the speaker's name. Every client then shows the same "Playing on Node".
  const myId = relay?.id;
  const activeId = roster?.activeClientId;
  const active = activeId && activeId !== myId
    ? (roster.players || []).find((p) => p.id === activeId)
    : null;
  const isSpeaker = (d) => d && d.kind !== 'local' && d.kind !== 'relay';
  let label = null;
  if (active) label = isSpeaker(active.nowPlaying?.device) ? active.nowPlaying.device.name : active.name;
  else if (isSpeaker(device)) label = device.name;
  return label;
}

const CastGlyph = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
    <path d="M2 12a9 9 0 0 1 8 8" />
    <path d="M2 16a5 5 0 0 1 4 4" />
    <path d="M2 20h.01" />
  </svg>
);

export function PlayingElsewhereBar({ player }) {
  const label = elsewhereLabel(player);
  if (!label) return null;
  return (
    <div className="playing-elsewhere">
      <CastGlyph />
      <span>Playing on {label}</span>
    </div>
  );
}

// The device the SESSION is on, not just this client's local selection. When
// another of my clients is the active player, the picker must point at that
// client (matching the green bar) instead of falsely marking "This Computer"
// as active -- the contradictory state where the app claimed both at once.
// Shared with the now-playing view's picker.
export function sessionDeviceOf(player, devices) {
  const { nowPlaying, device, roster, relay } = player;
  const activeId = roster?.activeClientId;
  const activeSpeaker = nowPlaying?.device && nowPlaying.device.kind !== 'local' && nowPlaying.device.kind !== 'relay'
    ? nowPlaying.device : null;
  return activeId && activeId !== relay?.id
    ? (activeSpeaker
        // The other client is driving a speaker: the session is ON the speaker.
        ? (devices.find((d) => d.id === activeSpeaker.id) || { ...activeSpeaker, model: '' })
        : devices.find((d) => d.kind === 'relay' && d.relayClientId === activeId)
          || { id: `relay:${activeId}`, kind: 'relay', name: (roster.players || []).find((p) => p.id === activeId)?.name || 'Conduit' })
    : device;
}

export default function Player({ player, jf, devices, onOpenAlbum, onOpenArtist, panel, onPanel, onLike, onFullScreen }) {
  const phone = usePhone();
  const elsewhere = elsewhereLabel(player);
  const { current, nowPlaying, playing, position, duration, volume, device, error, roster, relay, repeat, shuffle } = player;
  const sessionDevice = sessionDeviceOf(player, devices);
  const liked = useLiked(nowPlaying?.itemId);
  // nowPlaying covers both our own queue and a session adopted from a speaker
  // that was already playing when the app opened.
  // artId is our own library item; artUrl is a ready URL from a mirrored relay
  // target. Either yields the cover.
  const art = nowPlaying?.artId ? jf.imageUrl(nowPlaying.artId, { maxHeight: 128 }) : (nowPlaying?.artUrl || null);
  // While dragging, the bar follows the thumb locally and commits ONE seek on
  // release. Committing on every change event fired a seek per pixel of drag,
  // which thrashed the speaker and made scrubbing unusable.
  const [scrub, setScrub] = useState(null);
  // Spotify's mini player is a card tinted with the cover's colour; the desktop
  // footer ignores this (black), the phone CSS reads --mini.
  const [mini, setMini] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!art) { setMini(null); return undefined; }
    vibrantColor(art).then((rgb) => { if (alive) setMini(rgb ? `rgb(${clampLightness(rgb).join(',')})` : null); });
    return () => { alive = false; };
  }, [art]);
  // Phone swipe-to-skip: the gesture itself lives in App (touch listeners on
  // .player-row); this only moves the art + text with the finger, clamped to
  // ±80px, then snaps back or flies out. No React state: direct style writes.
  const nowRef = useRef(null);
  const swipe = useRef(null);
  const onTouchStart = (e) => { const t = e.touches?.[0]; swipe.current = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: Date.now(), moving: false } : null; };
  const onTouchMove = (e) => {
    const s = swipe.current, el = nowRef.current; if (!s || !el) return;
    const t = e.touches[0]; const dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (!s.moving && Math.abs(dy) > Math.abs(dx)) { swipe.current = null; return; } // vertical: not ours
    if (Math.abs(dx) > 6) s.moving = true;
    if (!s.moving) return;
    el.style.transition = 'none';
    el.style.transform = `translateX(${Math.max(-80, Math.min(80, dx))}px)`;
    el.style.opacity = String(1 - Math.min(80, Math.abs(dx)) / 200);
  };
  const onTouchEnd = (e) => {
    const s = swipe.current, el = nowRef.current; swipe.current = null; if (!s || !el || !s.moving) return;
    const t = e.changedTouches?.[0]; const dx = t ? t.clientX - s.x : 0;
    const skip = Math.abs(dx) > 60 && Math.abs(t.clientY - s.y) < 40 && Date.now() - s.at < 600; // App's threshold
    el.style.transition = 'transform .18s ease-out, opacity .18s ease-out';
    if (skip) {
      el.style.transform = `translateX(${dx < 0 ? -120 : 120}%)`; el.style.opacity = '0';
      setTimeout(() => { el.style.transition = 'none'; el.style.transform = `translateX(${dx < 0 ? 40 : -40}px)`; requestAnimationFrame(() => { el.style.transition = 'transform .2s ease-out, opacity .2s ease-out'; el.style.transform = ''; el.style.opacity = ''; }); }, 180);
    } else { el.style.transform = ''; el.style.opacity = ''; }
  };
  const shown = scrub != null ? scrub : position;
  const pct = duration > 0 ? (shown / duration) * 100 : 0;

  const commitScrub = () => {
    if (scrub == null) return;
    player.seek(scrub);
    setScrub(null);
  };

  return (
    <footer className="player">
      {error && (
        <div className="player-error" onClick={player.clearError} title="Dismiss">
          {error}
        </div>
      )}

      <div
        className="player-row"
        style={mini ? { '--mini': mini } : undefined}
        // Phone: the bar is one big button into the now-playing view; its own
        // controls (play, heart, links) still win.
        onClick={(e) => { if (e.target.closest('button, input, a, [role=button]')) return; if (window.matchMedia('(max-width: 760px)').matches) onFullScreen?.(); }}
        onTouchStart={phone ? onTouchStart : undefined} onTouchMove={phone ? onTouchMove : undefined} onTouchEnd={phone ? onTouchEnd : undefined} onTouchCancel={phone ? onTouchEnd : undefined}
      >
        <div className="player-now" ref={nowRef}>
          {art ? (
            <img
              // Keyed by the image so a track change never shows the previous cover next to the new title.
              key={art}
              className={`player-art ${nowPlaying?.albumId ? 'clickable' : ''}`}
              src={art}
              alt=""
              title="Go to album"
              onClick={phone ? undefined : () => nowPlaying?.albumId && onOpenAlbum?.(nowPlaying.albumId)}
            />
          ) : (
            <div className="player-art placeholder" />
          )}
          <div className="player-meta">
            <div className="player-title">{nowPlaying?.title || 'Nothing playing'}</div>
            {/* Phone, sound elsewhere: Spotify puts the device line inside the card, in green. */}
            {phone && elsewhere ? (
              <div className="player-artist player-elsewhere"><CastGlyph /><span>Playing on {elsewhere}</span></div>
            ) : (
            <div className="player-artist">
              {/* Phone: plain text, so a tap anywhere on the card opens now
                  playing (Spotify); the artist link lives on that screen. */}
              {phone ? (
                nowPlaying?.artist || (nowPlaying?.artists || []).map((a) => a.Name).join(', ') || ''
              ) : nowPlaying?.artists?.length ? (
                <ArtistLinks artists={nowPlaying.artists} onOpen={onOpenArtist} className="linkish" />
              ) : nowPlaying?.artistId ? (
                <button className="linkish" onClick={() => onOpenArtist(nowPlaying.artistId)}>{nowPlaying.artist}</button>
              ) : (
                nowPlaying?.artist || ''
              )}
            </div>
            )}
          </div>
          {nowPlaying?.itemId && (
            // Follows the SESSION track (mirrored liked state included), so the
            // heart works on a client that is only controlling another one.
            <button
              className={`trackrow-like ${liked ? 'on' : ''}`}
              style={{ opacity: 1 }}
              onClick={() => onLike?.(current || { Id: nowPlaying.itemId, Name: nowPlaying.title, _partial: true }, !liked)}
              title={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
            >
              <Heart on={liked} />
            </button>
          )}
        </div>

        <div className="player-controls">
          <div className="player-buttons">
            <button
              className={`ctl-mode ${shuffle && shuffle !== 'off' ? 'on' : ''}`}
              onClick={player.cycleShuffle}
              title={shuffle === 'smart' ? 'Smart shuffle' : shuffle === 'on' ? 'Shuffle' : 'Enable shuffle'}
            >
              <ShuffleGlyph size={16} />
              {shuffle === 'smart' && (
                <svg className="ctl-spark" viewBox="0 0 24 24" width="9" height="9" fill="currentColor" aria-hidden="true">
                  <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
                </svg>
              )}
            </button>
            <button onClick={player.previous} disabled={!nowPlaying} title="Previous">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                <path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z" />
              </svg>
            </button>
            <button className="play" onClick={player.toggle} disabled={!nowPlaying}
              title={playing ? 'Pause' : 'Play'}>
              {playing ? (
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z" />
                </svg>
              )}
            </button>
            <button onClick={player.next} disabled={!nowPlaying} title="Next">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                <path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.107A.7.7 0 0 0 1 1.712v12.575a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6z" />
              </svg>
            </button>
            <button
              className={`ctl-mode ${repeat && repeat !== 'off' ? 'on' : ''}`}
              onClick={player.cycleRepeat}
              title={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat' : 'Enable repeat'}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m17 2 4 4-4 4" />
                <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
                <path d="m7 22-4-4 4-4" />
                <path d="M21 13v1a4 4 0 0 1-4 4H3" />
                {repeat === 'one' && <path d="M11 10h1v4" />}
              </svg>
            </button>
          </div>

          <div className="player-seek">
            <span className="t">{fmt(shown)}</span>
            <input
              type="range"
              min="0"
              max={Math.max(1, Math.floor(duration))}
              value={Math.floor(shown)}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={commitScrub}
              onKeyUp={commitScrub}
              onBlur={commitScrub}
              disabled={!nowPlaying || !duration}
              style={{ '--pct': `${pct}%` }}
              {...seekHover}
            />
            <span className="t">{fmt(duration)}</span>
          </div>
        </div>

        <div className="player-right">
          <button
            className={`icon-btn ${panel === 'lyrics' ? 'on' : ''}`}
            onClick={() => onPanel(panel === 'lyrics' ? null : 'lyrics')}
            title="Lyrics"
          >
            <LyricsGlyph size={18} />
          </button>
          <button
            className={`icon-btn ${panel === 'queue' ? 'on' : ''}`}
            onClick={() => onPanel(panel === 'queue' ? null : 'queue')}
            title="Queue"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9z" />
            </svg>
          </button>
          <DevicePicker devices={devices} active={sessionDevice} onSelect={player.setDevice} />
          <div className="player-volume" title={`Volume ${volume}%`}>
            {/* Spotify's speaker glyph, one arc per volume band; click = mute toggle. */}
            <button className="vol-ico" onClick={() => player.setVolume(volume > 0 ? 0 : 60)} title={volume > 0 ? 'Mute' : 'Unmute'}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
                {volume === 0 ? (
                  <>
                    <path d="M13.86 5.47a.75.75 0 0 0-1.061 0l-1.47 1.47-1.47-1.47A.75.75 0 0 0 8.8 6.53L10.269 8l-1.47 1.47a.75.75 0 1 0 1.06 1.06l1.47-1.47 1.47 1.47a.75.75 0 0 0 1.06-1.06L12.39 8l1.47-1.47a.75.75 0 0 0 0-1.06z" />
                    <path d="M10.116 1.5A.75.75 0 0 0 8.991.85l-6.925 4a3.642 3.642 0 0 0-1.33 4.967 3.639 3.639 0 0 0 1.33 1.332l6.925 4a.75.75 0 0 0 1.125-.649v-1.906a4.73 4.73 0 0 1-1.5-.694v1.3L2.817 9.852a2.141 2.141 0 0 1-.781-2.92c.187-.324.456-.594.78-.782l5.8-3.35v1.3c.45-.313.956-.55 1.5-.694V1.5z" />
                  </>
                ) : (
                  <>
                    <path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.139 2.139 0 0 0 0 3.7l5.8 3.35V2.8l-5.8 3.35zm8.683 4.29V5.56a2.75 2.75 0 0 1 0 4.88z" />
                    {volume > 40 && <path d="M11.5 13.614a5.752 5.752 0 0 0 0-11.228v1.55a4.252 4.252 0 0 1 0 8.127v1.55z" />}
                  </>
                )}
              </svg>
            </button>
            <input
              type="range" min="0" max="100" value={volume}
              onChange={(e) => player.setVolume(Number(e.target.value))}
              style={{ '--pct': `${volume}%` }}
            />
          </div>
          <button className="icon-btn" onClick={onFullScreen} title="Now playing view">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M6.53 9.47a.75.75 0 0 1 0 1.06l-2.72 2.72h1.018a.75.75 0 0 1 0 1.5H1.25v-3.579a.75.75 0 0 1 1.5 0v1.018l2.72-2.72a.75.75 0 0 1 1.06 0zm2.94-2.94a.75.75 0 0 1 0-1.06l2.72-2.72h-1.018a.75.75 0 1 1 0-1.5h3.578v3.579a.75.75 0 0 1-1.5 0V3.81l-2.72 2.72a.75.75 0 0 1-1.06 0z" /></svg>
          </button>
        </div>
      </div>
    </footer>
  );
}
