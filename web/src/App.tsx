import { useEffect } from 'react';
import { auth, get, type User } from './api/client';
import { app, navigate } from './state/app';
import { loadLikes } from './state/likes';
import { connect } from './state/session';
import { Login, ChangePassword } from './screens/Login';
import { Home } from './screens/Home';
import { Search } from './screens/Search';
import { Library } from './screens/Library';
import { AlbumPage, ArtistPage, PlaylistPage, LikedPage } from './screens/Detail';
import { Settings, Admin } from './screens/Settings';
import { PlayerBar, NowPlaying } from './components/Player';
import './styles.css';

function deviceName() { const ua = navigator.userAgent; return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Macintosh/.test(ua) ? 'Mac browser' : /Windows/.test(ua) ? 'Windows browser' : 'Browser'; }

const TABS: { view: 'home' | 'search' | 'library'; label: string; icon: string }[] = [{ view: 'home', label: 'Home', icon: '⌂' }, { view: 'search', label: 'Search', icon: '⌕' }, { view: 'library', label: 'Library', icon: '≡' }];

export function App() {
  const { user, route, ready } = app.use((s) => s);
  useEffect(() => {
    if (!auth.token) { app.set({ ready: true }); return; }
    get<User>('/auth/me').then((u) => app.set({ user: u, ready: true })).catch(() => { auth.token = ''; app.set({ ready: true }); });
  }, []);
  useEffect(() => { if (user) { loadLikes().catch(() => {}); connect(deviceName(), window.matchMedia('(max-width: 760px)').matches ? 'phone' : 'web'); } }, [user]);
  if (!ready) return <main className="center"><p className="muted">Loading…</p></main>;
  if (!user) return <Login />;
  if (user.mustChangePassword) return <main className="center"><ChangePassword forced /></main>;
  const screen = route.view === 'home' ? <Home /> : route.view === 'search' ? <Search /> : route.view === 'library' ? <Library /> : route.view === 'album' ? <AlbumPage id={route.id!} /> : route.view === 'artist' ? <ArtistPage id={route.id!} /> : route.view === 'playlist' ? <PlaylistPage id={route.id!} /> : route.view === 'liked' ? <LikedPage /> : route.view === 'settings' ? <Settings /> : route.view === 'admin' && user.role === 'admin' ? <Admin /> : <Home />;
  const tab = ['home', 'search', 'library'].includes(route.view) ? route.view : route.view === 'album' || route.view === 'artist' ? 'search' : 'library';
  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="brand">Slopify</div>
        {TABS.map((t) => <button key={t.view} className={`nav ${tab === t.view ? 'on' : ''}`} onClick={() => navigate({ view: t.view })} aria-current={tab === t.view ? 'page' : undefined}><span aria-hidden="true">{t.icon}</span>{t.label}</button>)}
        <button className={`nav ${route.view === 'settings' || route.view === 'admin' ? 'on' : ''}`} onClick={() => navigate({ view: 'settings' })}><span aria-hidden="true">⚙</span>Settings</button>
      </nav>
      <main className="content">{screen}</main>
      <PlayerBar />
      <nav className="tabbar" aria-label="Main">{TABS.map((t) => <button key={t.view} className={tab === t.view ? 'on' : ''} onClick={() => navigate({ view: t.view })} aria-current={tab === t.view ? 'page' : undefined}><span aria-hidden="true">{t.icon}</span>{t.label}</button>)}<button className={route.view === 'settings' ? 'on' : ''} onClick={() => navigate({ view: 'settings' })}><span aria-hidden="true">⚙</span>You</button></nav>
      <NowPlaying />
    </div>
  );
}
