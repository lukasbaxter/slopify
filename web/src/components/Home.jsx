import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PlayGlyph, Heart, LikedCover, usePhone } from './TrackRow.jsx';
import { t } from '../i18n.js';

// The whole ranking, most played first: Show all lists it, Home's shelf the first 16.
export function rankTopArtists(tracks) {
  const score = new Map();
  for (const tr of tracks) {
    for (const a of tr.ArtistItems || []) score.set(a.Id, { Id: a.Id, Name: a.Name, n: (score.get(a.Id)?.n || 0) + 1 + (tr.UserData?.PlayCount || 0) });
  }
  return [...score.values()].sort((a, b) => b.n - a.n);
}

// Cover art that fades in once it has loaded (no pop). A cached image can be
// complete before onLoad is wired, so the ref checks too.
export function FadeImg({ className = '', ...props }) {
  const [ok, setOk] = useState(false);
  return (
    <img {...props} className={`fade ${className} ${ok ? 'loaded' : ''}`.trim()} alt="" loading="lazy"
      ref={(el) => { if (el?.complete && el.naturalWidth && !ok) setOk(true); }} onLoad={() => setOk(true)} />
  );
}

// Shortcut tile labels: Spotify drops "(Radio Edit)", "(feat. …)", "- Remaster"
// style suffixes on the small tiles. Only the label changes, never the item.
export function tileTitle(name) {
  return String(name || '')
    .replace(/\s*[([](?:feat|ft|with|featuring|radio edit|remaster|remastered|deluxe|version|edit|mix|live|bonus)[^)\]]*[)\]]/gi, '')
    .replace(/\s+[-–]\s+(?:\d{4}\s+)?(?:remaster|remastered|radio edit|single version|deluxe|live|edit|version|mix).*$/i, '')
    .trim() || name;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return t('Good morning');
  if (h < 18) return t('Good afternoon');
  return t('Good evening');
}

// Spotify's Daily Mix tiles: artist photo up top, a solid colour band with the
// label at the bottom. One palette entry per mix, rotating.
const MIX_COLORS = ['#e8115b', '#1e3264', '#8d67ab', '#e13300', '#148a08', '#0d73ec', '#7d4b32', '#ba5d07'];

export const topSongsSub = (year) => year === new Date().getFullYear() ? t('Your most played songs of {year} so far', { year }) : t('The songs you played most in {year}', { year });

function MixTile({ label, sub, image, color, onOpen, onPlay, placeholder }) {
  return (
    <div className="card mixcard" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      <div className="card-art mixart" style={{ '--mix': color }}>
        {image ? <FadeImg src={image} /> : <div className="ph" />}
        <div className="mixband">{label}</div>
        {!placeholder && (
          <button className="card-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title={t('Play')}>
            <PlayGlyph />
          </button>
        )}
      </div>
      <div className="card-title">{label}</div>
      <div className="card-sub">{sub}</div>
    </div>
  );
}

function Shortcut({ title, image, onOpen, onPlay, liked }) {
  return (
    <div className="shortcut" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      {liked ? (
        <LikedCover className="shortcut-art" />
      ) : image ? (
        <FadeImg className="shortcut-art" src={image} />
      ) : (
        <div className="shortcut-art ph" />
      )}
      <span className="shortcut-title">{tileTitle(title)}</span>
      <button className="card-play shortcut-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title={t('Play')}>
        <PlayGlyph />
      </button>
    </div>
  );
}

function Shelf({ title, children, onSeeAll }) {
  return (
    <section className="homeshelf">
      <div className="shelf-head">
        <h2 onClick={onSeeAll}>{title}</h2>
        {onSeeAll && <button onClick={onSeeAll}>{t('Show all')}</button>}
      </div>
      <div className="shelf">{children}</div>
    </section>
  );
}

function Card({ title, subtitle, image, round, onOpen, onPlay }) {
  return (
    <div className={`card ${round ? 'round' : ''}`} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      <div className="card-art">
        {image ? <FadeImg src={image} /> : <div className="ph" />}
        <button className="card-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title={t('Play')}>
          <PlayGlyph />
        </button>
      </div>
      <div className="card-title">{title}</div>
      {subtitle && <div className="card-sub">{subtitle}</div>}
    </div>
  );
}

/**
 * Home. Structure follows Spotify's: greeting + 8 shortcuts, then Made For You,
 * Recently played, Jump back in, New releases, Your top artists.
 *
 * Daily Mixes are real: each is the server's mix seeded from one of your
 * most-played artists, which is functionally what Spotify's artist-clustered
 * mixes are, kept for your local day (server: dailymix.ts). Made For You
 * is the Daily Mixes and nothing else: no weekly or daily playlists.
 */
export default function Home({ jf, player, albums, artists, playlists, onOpen, onOpenLiked, onOpenPlaylist, onSeeAll, likedCount, bar, onOpenArtist, onOpenMix, onOpenTopSongs }) {
  const [recent, setRecent] = useState(() => jf?.persisted('home.recent') || []);
  const [added, setAdded] = useState(() => jf?.persisted('home.added') || []);
  const [topArtists, setTopArtists] = useState(() => jf?.persisted('home.topArtists') || []);
  const [recentArtists, setRecentArtists] = useState(() => jf?.persisted('home.recentArtists') || []);
  const [topYears, setTopYears] = useState(() => jf?.persisted('home.topYears') || []);
  const [fresh, setFresh] = useState(0);

  // All of this is the account's real history (Jellyfin play counts and last
  // played dates), nothing sampled from the library.
  useEffect(() => {
    if (!jf) return;
    jf.recentlyPlayedAlbums({ limit: 16 }).then((r) => { setRecent(r.items); jf._persist('home.recent', r.items); }).catch(() => {});
    jf.topSongYears().then((y) => { setTopYears(y); jf._persist('home.topYears', y); }).catch(() => {});
    jf.recentlyAddedAlbums({ limit: 16 }).then((r) => { setAdded(r.items); jf._persist('home.added', r.items); }).catch(() => {});
    jf.topTracks({ limit: 200 }).then((top) => {
      const last = new Map();
      for (const tr of top) {
        for (const a of tr.ArtistItems || []) {
          const lp = tr.UserData?.LastPlayedDate || '';
          if (lp > (last.get(a.Id)?.lp || '')) last.set(a.Id, { Id: a.Id, Name: a.Name, lp });
        }
      }
      const ta = rankTopArtists(top);
      const ra = [...last.values()].sort((a, b) => b.lp.localeCompare(a.lp)).slice(0, 16);
      setTopArtists(ta); jf._persist('home.topArtists', ta);
      setRecentArtists(ra); jf._persist('home.recentArtists', ra);
    }).catch(() => {});
  }, [jf, fresh]);
  // A newer answer than the kept one Home opened with (sw.js 'api-fresh'): load again.
  useEffect(() => {
    const on = (e) => { if (/^\/api\/(home|top-songs|tracks\/top)/.test(e.detail)) { jf?._evict('home'); setFresh((n) => n + 1); } };
    window.addEventListener('slopify:fresh', on);
    return () => window.removeEventListener('slopify:fresh', on);
  }, [jf]);

  const playAlbum = async (a) => {
    const { items } = await jf.tracks({ albumId: a.Id });
    if (items.length) player.playQueue(items, 0, a.Id);
  };
  const playMix = async (seed) => {
    const items = await jf.instantMix(seed.Id);
    if (items.length) player.playQueue(items, 0);
  };
  const playTopSongs = async (year) => {
    const items = await jf.topSongs(year);
    if (items.length) player.playQueue(items, 0);
  };
  const playLiked = async () => {
    const { items } = await jf.favoriteTracks();
    if (items.length) player.playQueue(items, 0, 'liked');
  };
  const playPlaylist = async (p) => {
    const { items } = await jf.playlistTracks(p.Id);
    if (items.length) player.playQueue(items, 0, p.Id);
  };

  // Shortcuts: Liked Songs first, then recent albums and playlists, to 8.
  const shortcuts = useMemo(() => {
    const out = [{ kind: 'liked' }];
    for (const a of recent) { if (out.length >= 8) break; out.push({ kind: 'album', item: a }); }
    for (const p of playlists) { if (out.length >= 8) break; out.push({ kind: 'playlist', item: p }); }
    for (const a of albums) { if (out.length >= 8) break; if (!out.some((o) => o.item?.Id === a.Id)) out.push({ kind: 'album', item: a }); }
    return out;
  }, [recent, playlists, albums]);

  // Daily Mixes are seeded from the artists you actually play most.
  const mixSeeds = (topArtists.length ? topArtists : artists).slice(0, 6);

  // Phone: the chip row sticks to the top; once the page has scrolled it gets
  // a solid background (the home gradient scrolls away underneath). A class
  // toggle from a passive scroll listener, no state, no re-render.
  // Phone: the All / Music / Artists chips filter the feed in place (Spotify's
  // behaviour); the desktop chips still open the Albums / Artists pages.
  const phone = usePhone();
  const [filter, setFilter] = useState('all'); // 'all' | 'music' | 'artists'
  const showMusic = !phone || filter !== 'artists';
  const showArtists = !phone || filter !== 'music';
  const phoneBar = (
    <div className="pills">
      {[['all', t('All')], ['music', t('Music')], ['artists', t('Artists')]].map(([k, label]) => (
        <button key={k} className={`pill ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
      ))}
    </div>
  );
  const barRef = useRef(null);
  useEffect(() => {
    const bar = barRef.current, scroller = bar?.closest('.content');
    if (!bar || !scroller) return undefined;
    const on = () => bar.classList.toggle('stuck', scroller.scrollTop > 8);
    scroller.addEventListener('scroll', on, { passive: true });
    on();
    return () => scroller.removeEventListener('scroll', on);
  }, []);

  return (
    <div className="content">
      <div className="contentbar" ref={barRef}>{phone ? phoneBar : bar}</div>

      <div className="pad home">
        <h1 className="greeting">{greeting()}</h1>

        {showMusic && <div className="shortcuts">
          {shortcuts.map((s, i) => s.kind === 'liked' ? (
            <Shortcut key="liked" title={t('Liked Songs')} liked onOpen={onOpenLiked} onPlay={playLiked} />
          ) : s.kind === 'playlist' ? (
            <Shortcut key={s.item.Id} title={s.item.Name} image={jf.imageUrl(s.item.Id, { maxHeight: 128 })}
              onOpen={() => onOpenPlaylist(s.item)} onPlay={() => playPlaylist(s.item)} />
          ) : (
            <Shortcut key={s.item.Id} title={s.item.Name} image={jf.imageUrl(s.item.Id, { maxHeight: 128 })}
              onOpen={() => onOpen(s.item)} onPlay={() => playAlbum(s.item)} />
          ))}
        </div>}

        {showMusic && <Shelf title={t('Made For You')}>
          {mixSeeds.map((a, i) => (
            <MixTile key={a.Id} label={t('Daily Mix {n}', { n: i + 1 })} sub={t('{name} and more', { name: a.Name })}
              image={jf.imageUrl(a.Id, { maxHeight: 320 })} color={MIX_COLORS[i % MIX_COLORS.length]}
              onOpen={() => onOpenMix(a, i + 1, MIX_COLORS[i % MIX_COLORS.length])} onPlay={() => playMix(a)} />
          ))}
        </Shelf>}

        {showMusic && topYears.length > 0 && (
          <Shelf title={t('Your Top Songs')}>
            {topYears.map((y, i) => (
              <MixTile key={y.year} label={t('Your Top Songs {year}', { year: y.year })} sub={topSongsSub(y.year)}
                image={y.top ? jf.imageUrl(y.top.AlbumId, { maxHeight: 320 }) : null} color={MIX_COLORS[i % MIX_COLORS.length]}
                onOpen={() => onOpenTopSongs(y, MIX_COLORS[i % MIX_COLORS.length])} onPlay={() => playTopSongs(y.year)} />
            ))}
          </Shelf>
        )}

        {showMusic && recent.length > 0 && (
          <Shelf title={t('Recently played')} onSeeAll={() => onSeeAll('albums')}>
            {recent.map((a) => (
              <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist || t('Album')} image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                onOpen={() => onOpen(a)} onPlay={() => playAlbum(a)} />
            ))}
          </Shelf>
        )}

        {showArtists && recentArtists.length > 0 && (
          <Shelf title={t('Jump back in')} onSeeAll={() => onSeeAll('artists')}>
            {recentArtists.map((a) => (
              <Card key={a.Id} title={a.Name} subtitle={t('Artist')} round image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                onOpen={() => onOpenArtist(a.Id)} onPlay={() => playMix(a)} />
            ))}
          </Shelf>
        )}

        {showMusic && added.length > 0 && (
          <Shelf title={t('Recently added')} onSeeAll={() => onSeeAll('albums')}>
            {added.map((a) => (
              <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist || t('Album')} image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                onOpen={() => onOpen(a)} onPlay={() => playAlbum(a)} />
            ))}
          </Shelf>
        )}

        {showArtists && topArtists.length > 0 && (
          <Shelf title={t('Your top artists')} onSeeAll={() => onSeeAll('topArtists')}>
            {topArtists.slice(0, 16).map((a) => (
              <Card key={a.Id} title={a.Name} subtitle={t('Artist')} round image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                onOpen={() => onOpenArtist(a.Id)} onPlay={() => playMix(a)} />
            ))}
          </Shelf>
        )}
      </div>
    </div>
  );
}
