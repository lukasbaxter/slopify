// The one API client. Token in localStorage; every call carries it. Lists
// are cached in IndexedDB keyed by the server's library version (see
// cache.ts), never refetched while that version stands.
export type User = { id: string; name: string; role: 'admin' | 'user'; mustChangePassword: boolean };
export type Track = { id: string; title: string; artist: string; artists: string[]; artistIds: string[]; albumId: string; album: string; albumArtist: string; trackNo: number | null; discNo: number | null; year: number | null; genres: string[]; durationMs: number; cover: string | null; identity: { state: string; score: number }; addedAt: number };
export type Album = { id: string; name: string; artist: string; artistId: string; year: number | null; trackCount: number; durationMs?: number; cover: string | null; addedAt?: number };
export type Artist = { id: string; name: string; trackCount: number; albumCount: number; image: string | null };
export type Playlist = { id: string; name: string; userId: string; created: number; updated: number; trackCount: number; cover: string | null };
export type LyricLine = { start: number | null; text: string };

const TOKEN_KEY = 'slopify.token';
export const auth = {
  get token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  set token(t: string) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && auth.token && !url.startsWith('/auth/login')) { auth.token = ''; window.dispatchEvent(new Event('slopify:logout')); }
  if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).error || msg; } catch { /* no body */ } throw new ApiError(res.status, msg); }
  return res.status === 204 ? (undefined as T) : res.json();
}
export const get = <T>(url: string) => call<T>('GET', url);
export const post = <T>(url: string, body?: unknown) => call<T>('POST', url, body);
export const put = <T>(url: string, body?: unknown) => call<T>('PUT', url, body);
export const patch = <T>(url: string, body?: unknown) => call<T>('PATCH', url, body);
export const del = <T>(url: string) => call<T>('DELETE', url);

export const artUrl = (hash: string | null | undefined, size: 64 | 160 | 320 | 640 = 320) => (hash ? `/api/art/${hash}/${size}.webp` : '');
export const streamUrl = (id: string, quality: string) => (quality === 'original' ? `/api/stream/${id}?token=${encodeURIComponent(auth.token)}` : `/api/stream/${id}/hls/${quality}/index.m3u8?token=${encodeURIComponent(auth.token)}`);
export const fmtTime = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
