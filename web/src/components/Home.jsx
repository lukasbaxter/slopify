import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlayGlyph, Heart, LikedCover, usePhone } from './TrackRow.jsx';
import { t } from '../i18n.js';
import { radar as relayRadar } from '../api/search.js';
import { localDay } from '../api/slopify.js';

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
export const MIX_COLORS = ['#e8115b', '#1e3264', '#8d67ab', '#e13300', '#148a08', '#0d73ec', '#7d4b32', '#ba5d07'];
// A radio's colour: the same for a seed on every device (API.md 14.4).
// Your Top Songs has a scheme of its own: bright, starting cyan then yellow.
export const TOP_COLORS = ['#22d3ee', '#fde047', '#f472b6', '#a3e635', '#fb923c', '#a78bfa', '#34d399', '#f87171'];
// The label colour that reads on a band of this colour: dark on the bright ones.
export const inkOn = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#fff';
  const n = parseInt(m[1], 16), lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) > 0.28 ? '#121212' : '#fff';
};
export const radioColor = (seedId) => { let n = 0; for (let i = 0; i < String(seedId).length; i++) n += String(seedId).charCodeAt(i); return MIX_COLORS[n % MIX_COLORS.length]; };
// "Drake, Future, Travis Scott and more": who is in today's mix or a radio.
export const mixSub = (artists, fallback) => (artists?.length ? t('{name} and more', { name: artists.map((a) => a.name).join(', ') }) : fallback ? t('{name} and more', { name: fallback }) : null);

export const topSongsSub = (year) => year === new Date().getFullYear() ? t('Your most played songs of {year} so far', { year }) : t('The songs you played most in {year}', { year });

function MixTile({ label, sub, image, color, onOpen, onPlay, placeholder }) {
  return (
    <div className="card mixcard" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      <div className="card-art mixart" style={{ '--mix': color, '--mix-ink': inkOn(color) }}>
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

// round: an artist. Artists are circles everywhere, on these tiles too.
function Shortcut({ title, image, onOpen, onPlay, liked, round }) {
  return (
    <div className="shortcut" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      {liked ? (
        <LikedCover className="shortcut-art" />
      ) : image ? (
        <FadeImg className={`shortcut-art${round ? ' round' : ''}`} src={image} />
      ) : (
        <div className={`shortcut-art ph${round ? ' round' : ''}`} />
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

function Card({ title, subtitle, image, round, onOpen, onPlay, noPlay }) {
  return (
    <div className={`card ${round ? 'round' : ''}`} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      <div className="card-art">
        {image ? <FadeImg src={image} /> : <div className="ph" />}
        {!noPlay && <button className="card-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title={t('Play')}>
          <PlayGlyph />
        </button>}
      </div>
      <div className="card-title">{title}</div>
      {subtitle && <div className="card-sub">{subtitle}</div>}
    </div>
  );
}

/**
 * Home. Structure follows Spotify's: greeting + 8 shortcuts, then Made For You,
 * Recently played, Jump back in, Release Radar, Your top artists.
 *
 * Daily Mixes are real: each is the server's mix seeded from one of your
 * most-played artists, which is functionally what Spotify's artist-clustered
 * mixes are, kept for your local day (server: dailymix.ts). Made For You
 * is the Daily Mixes and nothing else: no weekly or daily playlists.
 */
export default function Home({ jf, player, albums, artists, playlists, onOpen, onOpenLiked, onOpenPlaylist, onSeeAll, likedCount, bar, onOpenArtist, onOpenRadar, onOpenMix, onOpenTopSongs }) {
  const [recent, setRecent] = useState(() => jf?.persisted('home.recent') || []);
  const [picks, setPicks] = useState(() => jf?.persisted('home.picks') || []);
  const [radar, setRadar] = useState(() => jf?.persisted('home.radar') || []);
  const [topArtists, setTopArtists] = useState(() => jf?.persisted('home.topArtists') || []);
  const [recentArtists, setRecentArtists] = useState(() => jf?.persisted('home.recentArtists') || []);
  const [topYears, setTopYears] = useState(() => jf?.persisted('home.topYears') || []);
  const [fresh, setFresh] = useState(0);

  // All of this is the account's real history (Jellyfin play counts and last
  // played dates), nothing sampled from the library.
  useEffect(() => {
    if (!jf) return;
    jf.recentlyPlayedAlbums({ limit: 16 }).then((r) => { setRecent(r.items); jf._persist('home.recent', r.items); }).catch(() => {});
    jf.recentPicks().then((r) => { setPicks(r); jf._persist('home.picks', r); }).catch(() => {});
    jf.topSongYears().then((y) => { setTopYears(y); jf._persist('home.topYears', y); }).catch(() => {});
    // Release Radar: new albums, EPs and singles from the artists you like (server: discover.ts).
    relayRadar(jf).then((r) => { const rel = (r.releases || []).slice(0, 16); setRadar(rel); jf._persist('home.radar', rel); }).catch(() => {});
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
  // Load again, at most once every 5 s however many reasons arrive: a kept
  // answer that changed is announced to every open window, and each window
  // asking again used to set the next round off (11-14: 200 requests a minute
  // for /api/home, the whole server waiting behind them).
  const againRef = useRef({ at: 0, timer: null, missed: false });
  const loadAgain = useCallback(() => {
    const a = againRef.current;
    // Only the window in front asks; one behind asks when it is looked at again.
    if (document.visibilityState !== 'visible') { a.missed = true; return; }
    if (a.timer) return;
    a.timer = setTimeout(() => { a.timer = null; a.at = Date.now(); jf?._evict('home'); setFresh((n) => n + 1); }, Math.max(0, a.at + 5000 - Date.now()));
  }, [jf]);
  useEffect(() => () => { clearTimeout(againRef.current.timer); againRef.current.timer = null; }, []);
  // A song that has played 8 s is in the play log: the shortcuts (what was
  // picked last) are asked for again, so the pick shows without a reload.
  // One ask per song, 10 s after it shows as playing here; a later song does
  // not put it off (short songs would never get there).
  const playingId = player?.nowPlayingId, isPlaying = !!player?.playing;
  const askedRef = useRef(new Map());
  useEffect(() => {
    const asked = askedRef.current;
    if (!jf || !playingId || !isPlaying || asked.has(playingId)) return;
    asked.set(playingId, setTimeout(() => { asked.delete(playingId); loadAgain(); }, 10000));
  }, [jf, playingId, isPlaying, loadAgain]);
  useEffect(() => () => { for (const tm of askedRef.current.values()) clearTimeout(tm); askedRef.current.clear(); }, []);
  useEffect(() => {
    const on = () => { const a = againRef.current; if (document.visibilityState === 'visible' && a.missed) { a.missed = false; loadAgain(); } };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [loadAgain]);
  // A newer answer than the kept one Home opened with (sw.js 'api-fresh'): load again.
  useEffect(() => {
    const on = (e) => { if (/^\/api\/(home|top-songs|tracks\/top)/.test(e.detail)) loadAgain(); };
    window.addEventListener('slopify:fresh', on);
    return () => window.removeEventListener('slopify:fresh', on);
  }, [loadAgain]);

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

  const playArtist = async (a) => {
    const { items } = await jf.tracks({ artistId: a.Id, limit: 200 });
    if (items.length) player.playQueue(items, 0, `artist:${a.Id}`);
  };

  // Shortcuts: Liked Songs first, then the latest album, playlist and artist
  // you picked and played from (not what autoplay went on to), to 8; a new
  // account's are filled up from its playlists and the library.
  const shortcuts = useMemo(() => {
    const out = [{ kind: 'liked' }];
    const add = (kind, item) => { if (out.length < 8 && item?.Id && !out.some((o) => o.item?.Id === item.Id)) out.push({ kind, item }); };
    for (const p of picks) add(p.kind, p.kind === 'playlist' ? playlists.find((x) => x.Id === p.item.Id) || p.item : p.item);
    for (const p of playlists) add('playlist', p);
    for (const a of albums) add('album', a);
    return out;
  }, [picks, playlists, albums]);

  // Daily Mixes are seeded from the artists you actually play most.
  const mixSeeds = (topArtists.length ? topArtists : artists).slice(0, 6);
  // Who is in each seed's mix today (the server makes a new day's mixes on
  // this ask), so the tiles change with the day like the mixes do.
  const [mixInfo, setMixInfo] = useState(() => jf?.persisted('home.mixInfo') || {});
  const seedKey = mixSeeds.map((a) => a.Id).join(',');
  useEffect(() => {
    if (!jf || !seedKey) return undefined;
    let alive = true;
    jf.dailyMixes(seedKey.split(',')).then((items) => {
      if (!alive) return;
      const next = Object.fromEntries(items.map((m) => [m.artistId, { day: m.day, artists: m.artists || [], cover: m.cover?.id || null }]));
      setMixInfo(next); jf._persist('home.mixInfo', next);
    }).catch(() => {});
    return () => { alive = false; };
  }, [jf, seedKey, fresh]);
  // A kept answer from an earlier day says nothing about today's mix.
  const mixSubOf = (a) => mixSub(mixInfo[a.Id]?.day >= localDay() ? mixInfo[a.Id].artists : null, a.Name);
  // Today's cover: a photo of someone in today's mix (the server picks, a new
  // one each day); the seed's own until today's answer is in.
  const mixCoverOf = (a) => (mixInfo[a.Id]?.day >= localDay() && mixInfo[a.Id].cover) || a.Id;

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
          ) : s.kind === 'artist' ? (
            <Shortcut key={s.item.Id} round title={s.item.Name} image={jf.imageUrl(s.item.Id, { maxHeight: 128 })}
              onOpen={() => onOpenArtist(s.item.Id)} onPlay={() => playArtist(s.item)} />
          ) : (
            <Shortcut key={s.item.Id} title={s.item.Name} image={jf.imageUrl(s.item.Id, { maxHeight: 128 })}
              onOpen={() => onOpen(s.item)} onPlay={() => playAlbum(s.item)} />
          ))}
        </div>}

        {showMusic && <Shelf title={t('Made For You')}>
          {mixSeeds.map((a, i) => (
            <MixTile key={a.Id} label={t('Daily Mix {n}', { n: i + 1 })} sub={mixSubOf(a)}
              image={jf.imageUrl(mixCoverOf(a), { maxHeight: 320 })} color={MIX_COLORS[i % MIX_COLORS.length]}
              onOpen={() => onOpenMix(a, i + 1, MIX_COLORS[i % MIX_COLORS.length], mixSubOf(a), mixCoverOf(a))} onPlay={() => playMix(a)} />
          ))}
        </Shelf>}

        {showMusic && topYears.length > 0 && (
          <Shelf title={t('Your Top Songs')}>
            {topYears.map((y, i) => (
              <MixTile key={y.year} label={t('Top Songs {year}', { year: y.year })} sub={topSongsSub(y.year)}
                image={y.top ? jf.imageUrl(y.top.AlbumId, { maxHeight: 320 }) : null} color={TOP_COLORS[i % TOP_COLORS.length]}
                onOpen={() => onOpenTopSongs(y, TOP_COLORS[i % TOP_COLORS.length])} onPlay={() => playTopSongs(y.year)} />
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

        {showMusic && radar.length > 0 && (
          <Shelf title={t('Release Radar')} onSeeAll={onOpenRadar}>
            {/* In the library: opens and plays. Not yet: the artist's page, where it can be requested. */}
            {radar.map((r) => r.inLibrary ? (
              <Card key={r.album_id} title={r.title} subtitle={`${r.artistName} • ${r.rtype ? t(r.rtype) : t('Album')}`} image={jf.imageUrl(r.inLibrary, { maxHeight: 320 })}
                onOpen={() => onOpen({ Id: r.inLibrary, Name: r.title })} onPlay={() => playAlbum({ Id: r.inLibrary })} />
            ) : (
              <Card key={r.album_id} title={r.title} subtitle={`${r.artistName} • ${r.rtype ? t(r.rtype) : t('Album')}`} image={r.image} noPlay
                onOpen={() => onOpenArtist(r.artistId)} />
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
