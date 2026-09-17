import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PlayGlyph, Heart, LikedCover, usePhone } from './TrackRow.jsx';

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
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// Spotify's Daily Mix tiles: artist photo up top, a solid colour band with the
// label at the bottom. One palette entry per mix, rotating.
const MIX_COLORS = ['#e8115b', '#1e3264', '#8d67ab', '#e13300', '#148a08', '#0d73ec', '#7d4b32', '#ba5d07'];

function MixTile({ label, sub, image, color, onOpen, onPlay, placeholder }) {
  return (
    <div className="card mixcard" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      <div className="card-art mixart" style={{ '--mix': color }}>
        {image ? <FadeImg src={image} /> : <div className="ph" />}
        <div className="mixband">{label}</div>
        {!placeholder && (
          <button className="card-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title="Play">
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
      <button className="card-play shortcut-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title="Play">
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
        {onSeeAll && <button onClick={onSeeAll}>Show all</button>}
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
        <button className="card-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title="Play">
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
 * Daily Mixes are real: each is Jellyfin's Instant Mix seeded from one of your
 * most-played artists, which is functionally what Spotify's artist-clustered
 * mixes are. Discover Weekly and Release Radar need listening data we do not
 * have and are labelled placeholders.
 */
export default function Home({ jf, player, albums, artists, playlists, onOpen, onOpenLiked, onOpenPlaylist, onSeeAll, likedCount, bar, onOpenArtist, onOpenRadar, onOpenMix }) {
  const [recent, setRecent] = useState(() => jf?.persisted('home.recent') || []);
  const [added, setAdded] = useState(() => jf?.persisted('home.added') || []);
  const [topArtists, setTopArtists] = useState(() => jf?.persisted('home.topArtists') || []);
  const [recentArtists, setRecentArtists] = useState(() => jf?.persisted('home.recentArtists') || []);

  // All of this is the account's real history (Jellyfin play counts and last
  // played dates), nothing sampled from the library.
  useEffect(() => {
    if (!jf) return;
    jf.recentlyPlayedAlbums({ limit: 16 }).then((r) => { setRecent(r.items); jf._persist('home.recent', r.items); }).catch(() => {});
    jf.recentlyAddedAlbums({ limit: 16 }).then((r) => { setAdded(r.items); jf._persist('home.added', r.items); }).catch(() => {});
    jf.topTracks({ limit: 200 }).then((top) => {
      const score = new Map(), last = new Map();
      for (const t of top) {
        for (const a of t.ArtistItems || []) {
          score.set(a.Id, { Id: a.Id, Name: a.Name, n: (score.get(a.Id)?.n || 0) + 1 + (t.UserData?.PlayCount || 0) });
          const lp = t.UserData?.LastPlayedDate || '';
          if (lp > (last.get(a.Id)?.lp || '')) last.set(a.Id, { Id: a.Id, Name: a.Name, lp });
        }
      }
      const ta = [...score.values()].sort((a, b) => b.n - a.n).slice(0, 16);
      const ra = [...last.values()].sort((a, b) => b.lp.localeCompare(a.lp)).slice(0, 16);
      setTopArtists(ta); jf._persist('home.topArtists', ta);
      setRecentArtists(ra); jf._persist('home.recentArtists', ra);
    }).catch(() => {});
  }, [jf]);

  const playAlbum = async (a) => {
    const { items } = await jf.tracks({ albumId: a.Id });
    if (items.length) player.playQueue(items, 0, a.Id);
  };
  const playMix = async (seed) => {
    const items = await jf.instantMix(seed.Id);
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
  // Explo (ListenBrainz) playlists land in Jellyfin as Weekly-Exploration-…,
  // Weekly-Jams-…, Daily-Jams-…; the newest of each becomes a tile here.
  const explo = useMemo(() => {
    const pick = (re) => [...playlists].filter((p) => re.test(p.Name)).sort((a, b) => b.Name.localeCompare(a.Name))[0] || null;
    return [
      { key: 'dw', label: 'Discover Weekly', sub: 'New music picked from your listening, every Monday.', color: '#1e3264', pl: pick(/^Weekly.?Exploration/i) },
      { key: 'wj', label: 'Weekly Jams', sub: 'Songs you love, refreshed weekly.', color: '#8d67ab', pl: pick(/^Weekly.?Jams/i) },
      { key: 'dj', label: 'Daily Jams', sub: 'A fresh mix every day.', color: '#e8115b', pl: pick(/^Daily.?Jams/i) },
    ];
  }, [playlists]);

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
      {[['all', 'All'], ['music', 'Music'], ['artists', 'Artists']].map(([k, label]) => (
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
            <Shortcut key="liked" title="Liked Songs" liked onOpen={onOpenLiked} onPlay={playLiked} />
          ) : s.kind === 'playlist' ? (
            <Shortcut key={s.item.Id} title={s.item.Name} image={jf.imageUrl(s.item.Id, { maxHeight: 128 })}
              onOpen={() => onOpenPlaylist(s.item)} onPlay={() => playPlaylist(s.item)} />
          ) : (
            <Shortcut key={s.item.Id} title={s.item.Name} image={jf.imageUrl(s.item.Id, { maxHeight: 128 })}
              onOpen={() => onOpen(s.item)} onPlay={() => playAlbum(s.item)} />
          ))}
        </div>}

        {showMusic && <Shelf title="Made For You">
          {mixSeeds.map((a, i) => (
            <MixTile key={a.Id} label={`Daily Mix ${i + 1}`} sub={`${a.Name} and more`}
              image={jf.imageUrl(a.Id, { maxHeight: 320 })} color={MIX_COLORS[i % MIX_COLORS.length]}
              onOpen={() => onOpenMix(a, i + 1, MIX_COLORS[i % MIX_COLORS.length])} onPlay={() => playMix(a)} />
          ))}
          {explo.map((e) => e.pl ? (
            <MixTile key={e.key} label={e.label} sub={e.sub} color={e.color} image={jf.imageUrl(e.pl.Id, { maxHeight: 320 })}
              onOpen={() => onOpenPlaylist(e.pl)} onPlay={() => playPlaylist(e.pl)} />
          ) : null)}
          <MixTile label="Release Radar" sub="New releases from the artists you play most." color="#8d67ab"
            image={topArtists[0] ? jf.imageUrl(topArtists[0].Id, { maxHeight: 320 }) : null} onOpen={onOpenRadar} onPlay={onOpenRadar} />
        </Shelf>}

        {showMusic && recent.length > 0 && (
          <Shelf title="Recently played" onSeeAll={() => onSeeAll('albums')}>
            {recent.map((a) => (
              <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist || 'Album'} image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                onOpen={() => onOpen(a)} onPlay={() => playAlbum(a)} />
            ))}
          </Shelf>
        )}

        {showArtists && recentArtists.length > 0 && (
          <Shelf title="Jump back in" onSeeAll={() => onSeeAll('artists')}>
            {recentArtists.map((a) => (
              <Card key={a.Id} title={a.Name} subtitle="Artist" round image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                onOpen={() => onOpenArtist(a.Id)} onPlay={() => playMix(a)} />
            ))}
          </Shelf>
        )}

        {showMusic && added.length > 0 && (
          <Shelf title="Recently added" onSeeAll={() => onSeeAll('albums')}>
            {added.map((a) => (
              <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist || 'Album'} image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                onOpen={() => onOpen(a)} onPlay={() => playAlbum(a)} />
            ))}
          </Shelf>
        )}

        {showArtists && topArtists.length > 0 && (
          <Shelf title="Your top artists" onSeeAll={() => onSeeAll('artists')}>
            {topArtists.map((a) => (
              <Card key={a.Id} title={a.Name} subtitle="Artist" round image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                onOpen={() => onOpenArtist(a.Id)} onPlay={() => playMix(a)} />
            ))}
          </Shelf>
        )}
      </div>
    </div>
  );
}
