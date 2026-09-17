// App-level state: who is logged in, where we are (a tiny router: view +
// params kept in the URL hash so Back works on every platform).
import { createStore } from './store';
import type { User } from '../api/client';

export type Route = { view: 'home' | 'search' | 'library' | 'album' | 'artist' | 'playlist' | 'liked' | 'settings' | 'admin'; id?: string; q?: string };
type S = { user: User | null; route: Route; ready: boolean; nowPlayingOpen: boolean };
export const app = createStore<S>({ user: null, route: parse(location.hash), ready: false, nowPlayingOpen: false });

export function parse(hash: string): Route {
  const [path, qs] = hash.replace(/^#\/?/, '').split('?');
  const [view = 'home', id] = path.split('/');
  const q = new URLSearchParams(qs || '').get('q') || undefined;
  return { view: (['home', 'search', 'library', 'album', 'artist', 'playlist', 'liked', 'settings', 'admin'].includes(view) ? view : 'home') as Route['view'], id, q };
}
export function navigate(r: Route, replace = false) {
  const h = `#/${r.view}${r.id ? `/${r.id}` : ''}${r.q ? `?q=${encodeURIComponent(r.q)}` : ''}`;
  if (replace) history.replaceState(null, '', h); else location.hash = h;
  app.set({ route: r });
}
window.addEventListener('hashchange', () => app.set({ route: parse(location.hash) }));
window.addEventListener('slopify:logout', () => app.set({ user: null }));
