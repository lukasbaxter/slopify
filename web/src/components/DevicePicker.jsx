import React, { useEffect, useRef, useState } from 'react';
import { LOCAL_DEVICE } from '../player/usePlayer.js';
import { usePhone, slideOut } from './Player.jsx';

// Filled paths (Material-style) rather than strokes: the Cast glyph in
// particular is unreadable as an outline at 18px.
const ICONS = {
  local: 'M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6v2h6v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18v12z',
  cast:
    'M21 3H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z' +
    'M1 18v3h3c0-1.66-1.34-3-3-3z' +
    'M1 14v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7z' +
    'M1 10v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10z',
  bluos: 'M17 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-5 3.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm0 13a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  relay: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm6 15a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
};

// Phone sheet: Spotify's device glyphs by kind (this phone, a TV for Cast, a
// speaker for Bluesound, a laptop for another Conduit).
const PHONE_ICONS = {
  local: 'M16 1H8a3 3 0 0 0-3 3v16a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V4a3 3 0 0 0-3-3zm1.5 19a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5h8A1.5 1.5 0 0 1 17.5 4v16zM12 17.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5z',
  cast: 'M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v-1.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h18a.5.5 0 0 1 .5.5v12a.5.5 0 0 1-.5.5h-5V19h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8 21.5h8V23H8v-1.5z',
  bluos: 'M17 1H7a3 3 0 0 0-3 3v16a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V4a3 3 0 0 0-3-3zm1.5 19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V4A1.5 1.5 0 0 1 7 2.5h10A1.5 1.5 0 0 1 18.5 4v16zM12 5a1.75 1.75 0 1 0 0 3.5A1.75 1.75 0 0 0 12 5zm0 5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 7.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6z',
  relay: 'M4 4.5A2.5 2.5 0 0 1 6.5 2h11A2.5 2.5 0 0 1 20 4.5v10a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 14.5v-10zm2.5-1a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-10a1 1 0 0 0-1-1h-11zM1 19.25h22v1.5H1v-1.5z',
};

function DeviceIcon({ kind, phone = false, size = 18 }) {
  const set = phone ? PHONE_ICONS : ICONS;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d={set[kind] || set.cast} />
    </svg>
  );
}
// Spotify's "Connect to a device" glyph for the footer button: a speaker box
// with a bracket for the laptop beside it (matches their 16px icon set).
const ConnectIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="M6 2.75C6 1.784 6.784 1 7.75 1h6.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15h-6.5A1.75 1.75 0 0 1 6 13.25V2.75zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h6.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25h-6.5zm3.25 2.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zM11 12a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zm0-1.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z" />
    <path d="M1.5 4.5A.75.75 0 0 1 2.25 3.75H4.5v1.5H3v6h1.5v1.5H2.25a.75.75 0 0 1-.75-.75v-7.5z" />
  </svg>
);

// Bottom of the phone sheet while the session is on a speaker: Spotify's green
// Connect volume slider. The phone's own buttons only move the phone, and a
// PWA never sees them, so this is the one place a phone can set a speaker's
// level. The bar follows the finger locally and sends at most one level every
// 120 ms (plus the final one), so a drag is not a command per pixel.
function SheetVolume({ volume, onChange }) {
  const [drag, setDrag] = useState(null);
  const timer = useRef(null); const pending = useRef(null); const last = useRef(0);
  const send = (v) => { last.current = Date.now(); pending.current = null; onChange(v); };
  const move = (v) => {
    setDrag(v);
    if (Date.now() - last.current >= 120) { send(v); return; }
    pending.current = v;
    if (!timer.current) timer.current = setTimeout(() => { timer.current = null; if (pending.current != null) send(pending.current); }, 120);
  };
  const end = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } if (pending.current != null) send(pending.current); setDrag(null); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const shown = drag != null ? drag : volume;
  return (
    <div className="dm-volume" title={`Volume ${shown}%`}>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.139 2.139 0 0 0 0 3.7l5.8 3.35V2.8l-5.8 3.35z" /></svg>
      <input
        type="range" min="0" max="100" value={shown} aria-label="Speaker volume"
        onChange={(e) => move(Number(e.target.value))}
        onPointerUp={end} onPointerCancel={end} onTouchEnd={end} onTouchCancel={end} onKeyUp={end}
        style={{ '--pct': `${shown}%` }}
      />
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.139 2.139 0 0 0 0 3.7l5.8 3.35V2.8l-5.8 3.35zm8.683 4.29V5.56a2.75 2.75 0 0 1 0 4.88z" /><path d="M11.5 13.614a5.752 5.752 0 0 0 0-11.228v1.55a4.252 4.252 0 0 1 0 8.127v1.55z" /></svg>
    </div>
  );
}

/**
 * The device selector. Groups discovered players by family so the Bluesound gear
 * and the Cast gear read as distinct things rather than one flat list.
 */
export default function DevicePicker({ devices, active, onSelect, showName = false, volume = null, onVolume = null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const phone = usePhone();
  // Phone: the sheet slides down before it unmounts.
  const close = () => slideOut(ref.current?.querySelector('.devicemenu'), () => setOpen(false));

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) close();
    };
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // A BluOS sync group plays as one speaker: commands to any member drive every
  // member. Listing members separately implies you can pick one, which is false
  // -- choosing either starts both. Collapse each group onto its master and
  // label it with everyone in it.
  const slaveHosts = new Set(
    devices.flatMap((d) => (d.slaves || []).map((s) => s.host))
  );
  const visible = devices.filter((d) => !(d.kind === 'bluos' && (d.isSlave || slaveHosts.has(d.host))));
  const labelFor = (d) => {
    if (d.kind !== 'bluos' || !d.slaves?.length) return d.name;
    return [d.name, ...d.slaves.map((s) => s.name)].join(' + ');
  };
  const subtitleFor = (d) => {
    if (d.kind === 'bluos' && d.slaves?.length) {
      return `Grouped • ${d.slaves.length + 1} speakers`;
    }
    return d.model;
  };

  const all = [LOCAL_DEVICE, ...visible];
  const groups = [
    { label: 'This device', items: all.filter((d) => d.kind === 'local') },
    { label: 'Your devices', items: all.filter((d) => d.kind === 'relay') },
    { label: 'Speakers & TVs', items: all.filter((d) => d.kind === 'cast') },
    { label: 'Bluesound', items: all.filter((d) => d.kind === 'bluos') },
  ].filter((g) => g.items.length);

  const remoteCount = visible.length;
  const isBrowser = typeof window !== 'undefined' && !window.conduit;
  const kindLabel = (d) => (d.kind === 'local' ? 'This phone' : d.kind === 'cast' ? 'Google Cast' : d.kind === 'bluos' ? 'Bluesound' : 'Conduit');
  const others = all.filter((d) => d.id !== active.id);

  return (
    <div className="devicepicker" ref={ref}>
      <button
        className={`devicebtn ${active.kind !== 'local' ? 'casting' : ''} ${showName ? 'with-name' : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        title={`Playing on ${active.name}`}
      >
        <ConnectIcon />
        <span className="devicebtn-name">{labelFor(active)}</span>
      </button>

      {open && phone && <div className="ctxmenu-scrim" onClick={(e) => { e.stopPropagation(); close(); }} onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); close(); }} />}
      {open && phone && (
        /* Spotify's "Connect to a device" sheet: the current device up top in
           green, then the others, then a line on where speakers come from. */
        <div className="devicemenu" role="menu">
          <div className="devicemenu-head">
            <strong>Connect to a device</strong>
            <span>{remoteCount ? `${remoteCount} on your network` : (isBrowser ? '' : 'Searching your network...')}</span>
          </div>
          <div className="dm-current">
            <DeviceIcon kind={active.kind} phone size={32} />
            <span className="dm-current-text">
              <span className="dm-current-label">Current device</span>
              <span className="dm-current-name">{labelFor(active)}</span>
              <span className="dm-current-sub">{subtitleFor(active) || kindLabel(active)}</span>
            </span>
          </div>
          {others.length > 0 && <div className="dm-others">Select another device</div>}
          {others.map((d) => (
            <button key={d.id} className="deviceitem" onClick={() => { onSelect(d); close(); }} role="menuitem">
              <DeviceIcon kind={d.kind} phone size={24} />
              <span className="deviceitem-text">
                <span className="deviceitem-name">{labelFor(d)}</span>
                <span className="deviceitem-model">{subtitleFor(d) || kindLabel(d)}</span>
              </span>
            </button>
          ))}
          <p className="dm-note">
            {isBrowser
              ? 'Speakers and TVs show up in the Conduit app. In the browser, playback stays on this device.'
              : 'Chromecast and Bluesound players on this network appear here automatically once they are awake.'}
          </p>
          {active.kind !== 'local' && onVolume && typeof volume === 'number' && <SheetVolume volume={volume} onChange={onVolume} />}
        </div>
      )}
      {open && !phone && (
        <div className="devicemenu" role="menu">
          <div className="devicemenu-head">
            <strong>Play on</strong>
            <span>{remoteCount ? `${remoteCount} found` : (isBrowser ? '' : 'searching...')}</span>
          </div>

          {groups.map((g) => (
            <div className="devicegroup" key={g.label}>
              <div className="devicegroup-label">{g.label}</div>
              {g.items.map((d) => (
                <button
                  key={d.id}
                  className={`deviceitem ${d.id === active.id ? 'active' : ''}`}
                  onClick={() => { onSelect(d); setOpen(false); }}
                  role="menuitem"
                >
                  <DeviceIcon kind={d.kind} />
                  <span className="deviceitem-text">
                    <span className="deviceitem-name">{labelFor(d)}</span>
                    <span className="deviceitem-model">{subtitleFor(d)}</span>
                  </span>
                  {d.id === active.id && <span className="deviceitem-dot" />}
                </button>
              ))}
            </div>
          ))}

          {!remoteCount && isBrowser && (
            <p className="devicemenu-empty">
              Speaker control lives in the Conduit desktop app for now. In your
              browser you can play through this device.
            </p>
          )}
          {!remoteCount && !isBrowser && (
            <p className="devicemenu-empty">
              No speakers found yet. Chromecast and Bluesound players appear here
              automatically once they are awake on the same network.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
