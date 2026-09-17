// Desktop on macOS: the header must clear the traffic lights (hiddenInset title bar).
if (typeof window !== 'undefined' && window.conduit?.platform === 'darwin') document.documentElement.classList.add('desktop-mac');
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/app.css';
import './styles/mobile-nowplaying.css';
import './styles/mobile-home-search.css';
import './styles/mobile-library.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
