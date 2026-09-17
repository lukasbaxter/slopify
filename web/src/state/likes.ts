// Liked tracks: ids -> liked-at, optimistic, mirrored to the server.
import { createStore } from './store';
import { del, put, get } from '../api/client';
export const likes = createStore<{ at: Record<string, number>; loaded: boolean }>({ at: {}, loaded: false });
export async function loadLikes() { const r = await get<{ at: Record<string, number> }>('/likes'); likes.set({ at: r.at, loaded: true }); }
export function toggleLike(id: string) {
  const liked = !!likes.get().at[id];
  likes.set((s) => { const at = { ...s.at }; if (liked) delete at[id]; else at[id] = Date.now(); return { at }; });
  (liked ? del(`/likes/${id}`) : put(`/likes/${id}`, { at: Date.now() })).catch(() => loadLikes());
}
export const useLiked = (id: string | null | undefined) => likes.use((s) => !!(id && s.at[id]));
