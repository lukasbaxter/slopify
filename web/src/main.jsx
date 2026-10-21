// Desktop on macOS: the header must clear the traffic lights (hiddenInset title bar).
if (typeof window !== 'undefined' && window.conduit?.platform === 'darwin') document.documentElement.classList.add('desktop-mac');
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/app.css';
import './styles/mobile-nowplaying.css';
import './styles/mobile-home-search.css';
import './styles/mobile-library.css';

// A throw inside React used to unmount everything: a black page with no
// word of why, and nothing in the breadcrumbs. Now the error is kept for the
// diag report and the page offers a reload.
class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { crumb(`render error: ${error?.message || error}`); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: '24px', color: '#fff', background: '#000', minHeight: '100vh', fontFamily: 'system-ui, sans-serif' }}>
        <h2 style={{ margin: '0 0 8px' }}>Slopify stopped</h2>
        <p style={{ opacity: .8, margin: '0 0 16px' }}>{String(this.state.error?.message || this.state.error)}</p>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: '10px 18px', borderRadius: 999, border: 0, background: '#1db954', color: '#000', fontWeight: 700 }}>Reload</button>
      </div>
    );
  }
}
const crumb = (m) => { try { (window.__slopifyMediaLog ||= []).push(`${new Date().toISOString().slice(11, 19)} ${m}`); } catch { /* ignore */ } };
window.addEventListener('error', (e) => crumb(`error: ${e.message || e.error?.message || 'script'} ${e.filename ? `@${e.filename.split('/').pop()}:${e.lineno}` : ''}`));
window.addEventListener('unhandledrejection', (e) => crumb(`unhandled: ${e.reason?.message || e.reason}`));

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>
);
