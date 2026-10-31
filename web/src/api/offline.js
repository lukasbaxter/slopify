// Songs downloaded for listening with no connection, Spotify's way: the app
// itself keeps working offline (sw.js keeps a copy of it and of what the
// server last answered), downloaded songs always play from the device
// (offline/local.js), and whatever is not downloaded greys out while
// offline (offline/net.js). This module is what the screens use: save or
// remove a playlist/album/Liked Songs, what is kept, and the plays made
// offline (reported once back online).
import { useEffect, useState, useSyncExternalStore } from 'react';
import * as store from '../offline/store.js';
import { isOffline } from '../offline/net.js';
import { t } from '../i18n.js';

// The desktop app loads the build from disk (no service worker); the old
// phone app's WebView has none either.
export const canSaveOffline = () => typeof window !== 'undefined' && !window.conduit && store.supported()
  && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

let last = { collections: [], bytes: 0, active: null, plays: [] };
let kept = new Set(); // ids of downloaded songs
const subs = new Set();
const emit = (detail) => {
  last = { ...last, ...detail };
  if (Array.isArray(detail?.ids)) kept = new Set(detail.ids);
  subs.forEach((f) => f(last, detail));
};
export const isKept = (id) => kept.has(id);

if (typeof window !== 'undefined' && canSaveOffline()) {
  const refresh = async (extra) => {
    const lib = await store.readLib();
    emit({ ...store.summary(lib), ids: Object.keys(lib.tracks).filter((id) => lib.tracks[id].file), active: store.getActive(), plays: lib.plays, ...(extra || {}) });
  };
  store.subscribe(refresh);
  refresh();
}

/** What is kept: { collections: [{ id, name, kind, total, have }], bytes, active }. */
export function useOffline() {
  const [s, set] = useState(last);
  useEffect(() => { const f = (v) => set(v); subs.add(f); set(last); return () => { subs.delete(f); }; }, []);
  return s;
}
export const subscribeOffline = (f) => { subs.add(f); return () => subs.delete(f); };
/** Is this song downloaded? */
export function useDownloaded(id) { return useSyncExternalStore(subscribeOffline, () => (id ? kept.has(id) : false), () => false); }

// About what a song takes: AAC 320 (the 'whole' file) is 40 kB a second;
// an original FLAC averages about 3x that (much more for hi-res).
export const estimateBytes = (tracks, lossless = false) => tracks.reduce((n, t) => n + ((t.RunTimeTicks || 0) / 1e7) * (lossless ? 120000 : 40000), 0);
// What Safari can play from the original file; anything else is saved as AAC.
const PLAYS_ORIGINAL = /flac|layer 3|mp3|aac|alac|pcm|wav|aiff/i;
/** Downloads follow the streaming quality: Lossless keeps the original files. */
export const savesLossless = (jf) => jf?.quality === 'original';

const songUrl = (jf, id, q, norm = null) => (q === 'original' ? jf.downloadUrl(id, 'original') : jf._url(`/api/stream/${id}/whole/${q}`, norm ? { norm } : {}));
// Covers are kept small (320 px): enough for rows, the lock screen and the
// player offline; online the server's sharp ones are shown.
const coverUrl = (jf, albumId) => jf._url(`/api/image/${albumId}`, { size: '320' });

/**
 * Save a collection. kind: 'playlist' | 'album' | 'liked'. Lossless keeps
 * the file itself (bit-perfect, so no normalization baked in); otherwise
 * AAC at the chosen quality with the gain baked in as the player would
 * (album gain for an album, track gain otherwise).
 */
export async function saveOffline(jf, item, kind, tracks) {
  const norm = jf.normalize === false ? null : kind === 'album' ? 'album' : 'track';
  const lossless = savesLossless(jf);
  const profile = jf._profile();
  const seen = new Set();
  const list = tracks.filter((t) => t?.Id && !seen.has(t.Id) && seen.add(t.Id)).map((t) => ({
    id: t.Id,
    title: t.Name,
    artist: (t.Artists || []).join(', ') || t.AlbumArtist || '',
    album: t.Album || '',
    albumId: t.AlbumId || null,
    durationMs: Math.round((t.RunTimeTicks || 0) / 1e4),
    ...(lossless && PLAYS_ORIGINAL.test(t.Container || '')
      ? { q: 'original', url: songUrl(jf, t.Id, 'original') }
      : { q: profile, norm, url: songUrl(jf, t.Id, profile, norm) }),
    coverUrl: t.AlbumId ? coverUrl(jf, t.AlbumId) : null,
    lyricsUrl: jf._url(`/api/lyrics/${t.Id}`),
  }));
  const collection = { id: item.Id, name: item.Name, kind, coverUrl: kind === 'liked' || kind === 'album' ? null : jf.imageUrl(item.Id, { maxHeight: 320, full: true }) };
  // Room for it? (Safari gives an installed app a large share of the disk.)
  try {
    const est = await navigator.storage?.estimate?.();
    const need = estimateBytes(tracks, lossless);
    if (est?.quota && est.quota - (est.usage || 0) < need) throw Object.assign(new Error(t('Not enough room: needs about {need} GB, {free} GB free', { need: (need / 1e9).toFixed(1), free: ((est.quota - (est.usage || 0)) / 1e9).toFixed(1) })), { noRoom: true });
  } catch (e) { if (e.noRoom) throw e; }
  // Offline: remembered now, downloaded once the server answers (resumeOffline).
  const defer = isOffline();
  await store.save(collection, list, { defer });
  return defer ? 'later' : 'now';
}

export const removeOffline = (id) => store.removeCollection(id);

/**
 * Search with no connection: the downloaded songs whose title, artist or
 * album has every word typed, in the shape the search page shows (songs only).
 */
export async function searchOffline(q) {
  const lib = await store.readLib();
  const words = String(q).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter(Boolean);
  const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const tracks = Object.entries(lib.tracks)
    .filter(([, t]) => t.file)
    .filter(([, t]) => { const hay = fold(`${t.title} ${t.artist} ${t.album}`); return words.every((w) => hay.includes(w)); })
    .slice(0, 50)
    .map(([id, t]) => ({
      Id: id, Name: t.title, Type: 'Audio', Artists: String(t.artist || '').split(', ').filter(Boolean), ArtistItems: [],
      Album: t.album, AlbumId: t.albumId, AlbumArtist: t.artist, RunTimeTicks: (t.durationMs || 0) * 1e4, ImageTags: {}, UserData: { IsFavorite: false },
    }));
  return { engine: 'offline', tookMs: 0, chips: [], scoped: false, top: tracks[0] ? { kind: 'Song', item: tracks[0] } : null, tracks, albums: [], artists: [], playlists: [] };
}

/**
 * Once the server answers (app start, back online): finish downloads that
 * were cut short, and fetch the album cover of any downloaded song that
 * lacks one.
 */
let resuming = false;
export async function resumeOffline(jf) {
  if (resuming || !canSaveOffline() || !jf?.token) return;
  resuming = true;
  try {
    await store.resume((id, t) => ({ song: songUrl(jf, id, t.q || 'aac-320', t.norm), cover: t.albumId ? coverUrl(jf, t.albumId) : null, lyrics: jf._url(`/api/lyrics/${id}`) }));
    await store.backfillCovers((albumId) => coverUrl(jf, albumId));
  } catch { /* next time */ } finally { resuming = false; }
}

/** Is a download running (keeps the app awake in the background: usePlayer)? */
export const useDownloadActive = () => useSyncExternalStore(subscribeOffline, () => last.active, () => null);

// Plays made offline, sent once the server answers again (it keeps their time).
let flushing = false;
export async function flushOfflinePlays(jf, plays) {
  if (flushing || !plays?.length || !jf?.token) return;
  flushing = true;
  try {
    let upTo = 0;
    for (const p of [...plays].sort((a, b) => a.at - b.at)) {
      const r = await jf._fetch('/api/plays', { method: 'POST', body: JSON.stringify({ trackId: p.id, at: p.at, client: 'offline' }) }).catch(() => null);
      if (!r) break;
      upTo = p.at;
    }
    if (!upTo) return;
    await store.dropPlays(upTo);
    last = { ...last, plays: (last.plays || []).filter((p) => p.at > upTo) };
  } finally { flushing = false; }
}
