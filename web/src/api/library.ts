import { get, type Album, type Artist, type Track, type LyricLine, type Playlist } from './client';
import { cacheGet, cacheSet } from './cache';

let version = '';
export async function libraryInfo() { const info = await get<{ version: string; tracks: number; albums: number; artists: number }>('/library'); version = info.version; return info; }

async function cachedList<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!version) await libraryInfo();
  const hit = await cacheGet<T>(key, version); if (hit) return hit;
  const v = await load(); await cacheSet(key, version, v); return v;
}
export const allAlbums = () => cachedList<Album[]>('albums', async () => (await get<{ items: Album[] }>('/albums?limit=1000&offset=0')).items);
export const allArtists = () => cachedList<Artist[]>('artists', async () => (await get<{ items: Artist[] }>('/artists?limit=1000&offset=0')).items);
export const album = (id: string) => get<Album & { tracks: Track[] }>(`/albums/${id}`);
export const artist = (id: string) => get<Artist & { albums: Album[]; appearsOn: Album[]; tracks: Track[] }>(`/artists/${id}`);
export const search = (q: string) => get<{ tracks: Track[]; albums: Album[]; artists: Artist[] }>(`/search?q=${encodeURIComponent(q)}`);
export const lyrics = (id: string) => get<{ kind: string; lines: LyricLine[] }>(`/lyrics/${id}`).catch(() => null);
export const home = () => get<{ recentAlbums: Album[]; topTracks: Track[]; newestAlbums: Album[] }>('/home');
export const likes = () => get<{ at: Record<string, number>; items: Track[] }>('/likes?full=1');
export const playlists = () => get<{ items: Playlist[] }>('/playlists');
export const playlist = (id: string) => get<Playlist & { tracks: Track[] }>(`/playlists/${id}`);
